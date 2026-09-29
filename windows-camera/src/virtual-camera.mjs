// VirtualCamera — control desde Node de la cámara virtual "VOXORA Meet Camera" (Media Foundation
// Virtual Camera API). Orquesta dos procesos nativos sin addon:
//   - VoxoraMeetVCamHost.exe    registra la cámara (MFCreateVirtualCamera) y la mantiene viva.
//   - VoxoraMeetFrameWriter.exe recibe frames RGBA por stdin y los publica en memoria compartida,
//                               de donde los lee VoxoraMeetVCam.dll dentro del FrameServer.
//
// Contrato (docs/CONTRACTS.md, "entrega → Windows"):
//   VirtualCamera.writeFrame(rgbaBuffer, width, height, timestamp) → shared memory → DLL MF Virtual Camera.
//
// ESM, Node >= 22, sin dependencias. Todos los procesos son inyectables para test (`spawn`, `execFile`).

import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLSID = '{7A1E5C3B-0F4D-4B8A-9C2E-3D6F1B8E5A70}';
export const FRIENDLY_NAME = 'VOXORA Meet Camera';
export const MIN_WINDOWS_BUILD = 19041; // Windows 10 2004: primera versión con MFCreateVirtualCamera
export const MAX_WIDTH = 1920;
export const MAX_HEIGHT = 1080;
export const FRAME_HEADER_BYTES = 16; // { uint32 width, uint32 height, uint64 timestampMs } LE

const HOST_EXE = 'VoxoraMeetVCamHost.exe';
const WRITER_EXE = 'VoxoraMeetFrameWriter.exe';
const DLL_NAME = 'VoxoraMeetVCam.dll';
// Árbol de desarrollo (native/bin) o, en la app instalada, la carpeta de VoxoraMeet.exe.
const HERE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BIN_DIR = [process.env.VOXORA_MEET_BIN_DIR, path.resolve(HERE_DIR, '..', 'native', 'bin'), path.resolve(HERE_DIR, '..')]
  .find((dir) => dir && existsSync(path.join(dir, HOST_EXE))) ?? path.resolve(HERE_DIR, '..', 'native', 'bin');

/** Códigos de salida del host (deben coincidir con vcam-host/main.cpp). */
export const HostExitCode = Object.freeze({
  OK: 0,
  USAGE: 2,
  NEEDS_ELEVATION: 3,
  NOT_SUPPORTED: 4,
  CREATE_FAILED: 5,
  START_FAILED: 6,
  REGISTER_FAILED: 7,
  DLL_LOAD_FAILED: 8,
  MF_STARTUP_FAILED: 9,
});

/** Parsea "10.0.22631" → { major, minor, build }. */
export function parseWindowsRelease(release) {
  const [major = 0, minor = 0, build = 0] = String(release ?? '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return { major, minor, build };
}

/**
 * Cámara virtual. Eventos:
 *   'status' → { state: 'idle'|'starting'|'running'|'stopping'|'stopped'|'error', detail? }
 *   'error'  → Error (fallos asíncronos de los procesos hijos)
 *   'log'    → { source: 'host'|'writer', line }
 */
export class VirtualCamera extends EventEmitter {
  #spawn;
  #execFile;
  #platform;
  #release;
  #binDir;
  #friendlyName;
  #host = null;
  #writer = null;
  #state = 'idle';
  #needDrain = false;
  #stats = { written: 0, dropped: 0 };
  #stopping = false;

  /**
   * @param {object} [options]
   * @param {string} [options.binDir]          carpeta con los binarios nativos (por defecto native/bin)
   * @param {string} [options.friendlyName]    nombre que verá Meet/Zoom
   * @param {Function} [options.spawn]         inyección para tests (firma de child_process.spawn)
   * @param {Function} [options.execFile]      inyección para tests (firma de child_process.execFile)
   * @param {string} [options.platform]        inyección (process.platform)
   * @param {string} [options.release]         inyección (os.release())
   */
  constructor(options = {}) {
    super();
    this.#spawn = options.spawn ?? nodeSpawn;
    this.#execFile = options.execFile ?? nodeExecFile;
    this.#platform = options.platform ?? process.platform;
    this.#release = options.release ?? os.release();
    this.#binDir = options.binDir ?? DEFAULT_BIN_DIR;
    this.#friendlyName = options.friendlyName ?? FRIENDLY_NAME;
  }

  get state() {
    return this.#state;
  }

  get stats() {
    return { ...this.#stats };
  }

  get hostPath() {
    return path.join(this.#binDir, HOST_EXE);
  }

  get writerPath() {
    return path.join(this.#binDir, WRITER_EXE);
  }

  get dllPath() {
    return path.join(this.#binDir, DLL_NAME);
  }

  /** true en Windows 10 2004 (build 19041) o superior. */
  isSupported() {
    if (this.#platform !== 'win32') return false;
    const { major, build } = parseWindowsRelease(this.#release);
    return major > 10 || (major === 10 && build >= MIN_WINDOWS_BUILD);
  }

  /** Consulta el registro (HKLM) sin elevación. */
  async isRegistered() {
    if (!this.isSupported()) return false;
    const key = `HKLM\\Software\\Classes\\CLSID\\${CLSID}\\InprocServer32`;
    const { code } = await this.#run('reg', ['query', key, '/ve']);
    return code === 0;
  }

  /**
   * Registra la DLL en HKLM ejecutando el host con `--register-dll` elevado vía UAC
   * (PowerShell Start-Process -Verb RunAs). Solo hace falta una vez por máquina.
   * Resuelve con el código de salida del host elevado; lanza si el usuario cancela el UAC.
   */
  async register({ dllPath = this.dllPath, unregister = false } = {}) {
    this.#assertSupported();
    if (!existsSync(dllPath)) throw new Error(`No existe la DLL de la cámara virtual: ${dllPath}`);
    const flag = unregister ? '--unregister-dll' : '--register-dll';
    const script = buildElevatedCommand(this.hostPath, [flag, dllPath]);
    const { code, stdout, stderr } = await this.#run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ]);
    const exitCode = Number.parseInt(String(stdout).trim().split(/\r?\n/).pop(), 10);
    if (code !== 0 || Number.isNaN(exitCode)) {
      throw new Error(`No se pudo elevar el registro de la cámara (UAC cancelado o PowerShell falló): ${stderr || stdout}`);
    }
    if (exitCode !== HostExitCode.OK) {
      throw new Error(`El registro de la cámara devolvió el código ${exitCode} (${describeExitCode(exitCode)})`);
    }
    return exitCode;
  }

  async unregister(options = {}) {
    return this.register({ ...options, unregister: true });
  }

  /** Arranca host + writer. Resuelve cuando ambos han emitido READY. */
  async start() {
    this.#assertSupported();
    if (this.#state === 'running' || this.#state === 'starting') return;
    if (!existsSync(this.hostPath) || !existsSync(this.writerPath)) {
      throw new Error(`Faltan binarios nativos en ${this.#binDir} (ejecute native/build.cmd)`);
    }
    this.#stopping = false;
    this.#stats = { written: 0, dropped: 0 };
    this.#setState('starting');
    try {
      this.#host = this.#spawnChild(this.hostPath, ['--name', this.#friendlyName], 'host');
      await this.#waitReady(this.#host, 'host', /^READY\b/);
      this.#writer = this.#spawnChild(this.writerPath, [], 'writer');
      this.#needDrain = false;
      this.#writer.stdin.on('drain', () => {
        this.#needDrain = false;
      });
      this.#writer.stdin.on('error', (err) => this.#onChildError('writer', err));
      await this.#waitReady(this.#writer, 'writer', /^READY\b/);
      this.#setState('running');
    } catch (err) {
      await this.#teardown();
      this.#setState('error', err.message);
      throw err;
    }
  }

  /**
   * Envía un frame RGBA (top-down, sin padding) al writer.
   * Devuelve true si se encoló, false si se descartó (cámara no activa, stdin saturado o frame inválido).
   * Con backpressure: si el stdin del writer no ha drenado, el frame se descarta para no acumular latencia.
   */
  writeFrame(rgba, width, height, timestampMs = performance.now()) {
    if (this.#state !== 'running' || !this.#writer) return false;
    const expected = width * height * 4;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 2 ||
      height < 2 ||
      width > MAX_WIDTH ||
      height > MAX_HEIGHT ||
      width % 2 !== 0 ||
      height % 2 !== 0 ||
      !rgba ||
      rgba.length !== expected
    ) {
      this.#stats.dropped += 1;
      return false;
    }
    const stdin = this.#writer.stdin;
    if (this.#needDrain || stdin.writableNeedDrain || stdin.destroyed || !stdin.writable) {
      this.#stats.dropped += 1;
      return false;
    }
    const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
    header.writeUInt32LE(width, 0);
    header.writeUInt32LE(height, 4);
    header.writeBigUInt64LE(BigInt(Math.max(0, Math.round(timestampMs))), 8);
    // Se escribe cabecera y píxeles como una unidad; el resultado del segundo write decide el drenado.
    stdin.write(header);
    const ok = stdin.write(rgba);
    if (!ok) this.#needDrain = true;
    this.#stats.written += 1;
    return true;
  }

  /** Para ambos procesos (stop cooperativo al host; cierre de stdin al writer). */
  async stop() {
    if (this.#state === 'idle' || this.#state === 'stopped') return;
    this.#stopping = true;
    this.#setState('stopping');
    await this.#teardown();
    this.#setState('stopped');
  }

  // ---- internos ---------------------------------------------------------------------------------

  #assertSupported() {
    if (!this.isSupported()) {
      throw new Error(
        `La cámara virtual requiere Windows 10 2004 (build ${MIN_WINDOWS_BUILD}) o superior; ` +
          `plataforma actual: ${this.#platform} ${this.#release}`,
      );
    }
  }

  #setState(state, detail) {
    this.#state = state;
    this.emit('status', detail === undefined ? { state } : { state, detail });
  }

  #spawnChild(file, args, source) {
    const child = this.#spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    attachLineReader(child.stdout, (line) => this.emit('log', { source, line }));
    attachLineReader(child.stderr, (line) => this.emit('log', { source, line, stderr: true }));
    child.on('error', (err) => this.#onChildError(source, err));
    child.on('exit', (code, signal) => this.#onChildExit(source, code, signal));
    return child;
  }

  #waitReady(child, source, pattern, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      let buffered = '';
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${source} no respondió READY en ${timeoutMs} ms`));
      }, timeoutMs);
      const onData = (chunk) => {
        buffered += chunk.toString('utf8');
        if (pattern.test(buffered.trimStart())) {
          cleanup();
          resolve();
        }
      };
      const onExit = (code) => {
        cleanup();
        reject(new Error(`${source} terminó con código ${code} antes de READY (${describeExitCode(code)})`));
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.off('exit', onExit);
        child.off('error', onError);
      };
      child.stdout.on('data', onData);
      child.on('exit', onExit);
      child.on('error', onError);
    });
  }

  #onChildError(source, err) {
    this.emit('error', Object.assign(new Error(`${source}: ${err.message}`), { cause: err, source }));
  }

  #onChildExit(source, code, signal) {
    if (this.#stopping) return;
    if (this.#state === 'running' || this.#state === 'starting') {
      // Se marca el apagado antes de desmontar para que la salida (esperada) del otro proceso durante
      // el teardown no se reporte como un segundo fallo.
      this.#stopping = true;
      const detail = `${source} terminó inesperadamente (code=${code}, signal=${signal})`;
      this.#host = source === 'host' ? null : this.#host;
      this.#writer = source === 'writer' ? null : this.#writer;
      this.#teardown().finally(() => this.#setState('error', detail));
    }
  }

  async #teardown() {
    const writer = this.#writer;
    const host = this.#host;
    this.#writer = null;
    this.#host = null;
    const waits = [];
    if (writer) {
      try {
        writer.stdin.end();
      } catch {
        /* ya cerrado */
      }
      waits.push(waitExit(writer, 3_000).catch(() => writer.kill()));
    }
    if (host) {
      try {
        host.stdin.write('stop\n');
        host.stdin.end();
      } catch {
        /* ya cerrado */
      }
      waits.push(waitExit(host, 5_000).catch(() => host.kill()));
    }
    await Promise.all(waits);
  }

  #run(file, args) {
    return new Promise((resolve) => {
      this.#execFile(file, args, { windowsHide: true, encoding: 'utf8' }, (err, stdout = '', stderr = '') => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }
}

/**
 * Comando PowerShell que lanza el host elevado (UAC), espera y devuelve su código de salida por stdout.
 * Se exporta para poder testearlo sin lanzar UAC.
 */
export function buildElevatedCommand(exePath, args) {
  const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const argumentList = args.map(psQuote).join(', ');
  return (
    `$p = Start-Process -FilePath ${psQuote(exePath)} -ArgumentList @(${argumentList}) ` +
    `-Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`
  );
}

export function describeExitCode(code) {
  switch (code) {
    case HostExitCode.OK:
      return 'ok';
    case HostExitCode.USAGE:
      return 'argumentos inválidos';
    case HostExitCode.NEEDS_ELEVATION:
      return 'requiere elevación (UAC)';
    case HostExitCode.NOT_SUPPORTED:
      return 'cámara virtual no soportada en este Windows';
    case HostExitCode.CREATE_FAILED:
      return 'MFCreateVirtualCamera falló (¿DLL no registrada?)';
    case HostExitCode.START_FAILED:
      return 'IMFVirtualCamera::Start falló';
    case HostExitCode.REGISTER_FAILED:
      return 'DllRegisterServer/DllUnregisterServer falló';
    case HostExitCode.DLL_LOAD_FAILED:
      return 'no se pudo cargar la DLL';
    case HostExitCode.MF_STARTUP_FAILED:
      return 'MFStartup falló';
    default:
      return `código ${code}`;
  }
}

function attachLineReader(stream, onLine) {
  if (!stream) return;
  let pending = '';
  stream.on('data', (chunk) => {
    pending += chunk.toString('utf8');
    let index;
    while ((index = pending.indexOf('\n')) >= 0) {
      onLine(pending.slice(0, index).replace(/\r$/, ''));
      pending = pending.slice(index + 1);
    }
  });
  stream.on('end', () => {
    if (pending) onLine(pending);
    pending = '';
  });
}

function waitExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null && child.exitCode !== undefined) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

export default VirtualCamera;
