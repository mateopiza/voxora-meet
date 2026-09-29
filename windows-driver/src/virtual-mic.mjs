// virtual-mic.mjs — Cliente Node del cable de audio virtual de VOXORA Meet.
//
// Abre el endpoint de render "VOXORA Meet Speaker" (lado de entrada del
// driver WaveRT) y escribe PCM s16le; el driver lo refleja en la captura
// "VOXORA Meet Microphone" que seleccionan Meet/Zoom/Discord.
//
// Node no expone WASAPI, así que el trabajo real lo hace el helper nativo
// native/bin/wasapi-render.exe (ver native/wasapi-render.cpp): se le pasa el
// PCM por stdin y él lo rinde en el endpoint. Este módulo solo orquesta el
// proceso, la contrapresión y el ciclo de vida.
//
// Contrato (docs/CONTRACTS.md, "entrega → Windows"):
//   VirtualMic.write(pcm)  → PCM s16le, 48 kHz, mono (o estéreo si channels=2)
//
// ESM, Node ≥ 22, sin dependencias. El `spawn` es inyectable para tests.

import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Nombre del endpoint de render que crea voxorameet.inf. */
export const RENDER_ENDPOINT_NAME = 'VOXORA Meet Speaker';
/** Nombre del endpoint de captura (informativo: es el que ve Meet). */
export const CAPTURE_ENDPOINT_NAME = 'VOXORA Meet Microphone';
/**
 * Ruta por defecto del helper: `VOXORA_MEET_BIN_DIR`, el compilado por native/build.cmd (desarrollo)
 * o, en la app instalada (motor empaquetado en <instalación>\engine\), junto a VoxoraMeet.exe.
 */
export function resolveHelperPath(name, { here = HERE, env = process.env, exists = existsSync } = {}) {
  const dev = path.join(here, '..', 'native', 'bin', name);
  const candidates = [env.VOXORA_MEET_BIN_DIR && path.join(env.VOXORA_MEET_BIN_DIR, name), dev, path.join(here, '..', name)];
  return candidates.find((p) => p && exists(p)) ?? dev;
}

export const DEFAULT_HELPER_PATH = resolveHelperPath('wasapi-render.exe');

const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_CHANNELS = 1;

/**
 * Ejecuta el helper con `--list` y devuelve los endpoints de render activos.
 * @returns {Promise<Array<{id:string,name:string,isDefault:boolean}>>}
 */
export async function listRenderEndpoints({ helperPath = DEFAULT_HELPER_PATH, spawn = nodeSpawn, timeoutMs = 5000 } = {}) {
  if (!existsSync(helperPath)) {
    throw new Error(`Helper WASAPI no encontrado: ${helperPath} (ejecuta native/build.cmd)`);
  }
  const child = spawn(helperPath, ['--list'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`--list no respondió en ${timeoutMs} ms`));
    }, timeoutMs);
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', (c) => { clearTimeout(timer); resolve(c); });
  });

  if (code !== 0) {
    throw new Error(`wasapi-render --list terminó con código ${code}: ${stderr.trim() || stdout.trim()}`);
  }
  // Solo la primera línea JSON válida (el helper emite eventos por línea).
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('[')) continue;
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  }
  throw new Error('wasapi-render --list no devolvió una lista JSON');
}

/**
 * Micrófono virtual: escribe PCM en "VOXORA Meet Speaker".
 *
 * Eventos: 'close' ({ code, signal }), 'error' (fallo inesperado del helper),
 * 'stderr' (línea de diagnóstico del helper).
 */
export class VirtualMic extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.helperPath]   ruta a wasapi-render.exe
   * @param {Function} [opts.spawn]      child_process.spawn inyectable (tests)
   * @param {string} [opts.deviceId]     id exacto del endpoint (de listRenderEndpoints)
   * @param {string} [opts.deviceName]   subcadena del nombre (defecto RENDER_ENDPOINT_NAME)
   * @param {number} [opts.sampleRate]   48000 por contrato
   * @param {number} [opts.channels]     1 (mono) o 2
   * @param {number} [opts.bufferMs]     buffer WASAPI del helper (defecto 100)
   * @param {number} [opts.readyTimeoutMs] espera máxima al evento "ready"
   */
  constructor({
    helperPath = DEFAULT_HELPER_PATH,
    spawn = nodeSpawn,
    deviceId = null,
    deviceName = RENDER_ENDPOINT_NAME,
    sampleRate = DEFAULT_SAMPLE_RATE,
    channels = DEFAULT_CHANNELS,
    bufferMs = 100,
    readyTimeoutMs = 5000,
  } = {}) {
    super();
    if (![1, 2].includes(channels)) throw new RangeError('channels debe ser 1 o 2');
    if (!Number.isInteger(sampleRate) || sampleRate < 8000) throw new RangeError('sampleRate inválido');

    this.helperPath = helperPath;
    this.spawn = spawn;
    this.deviceId = deviceId;
    this.deviceName = deviceName;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.bufferMs = bufferMs;
    this.readyTimeoutMs = readyTimeoutMs;

    /** Información del endpoint abierto (del evento "ready"). */
    this.device = null;
    this.bytesWritten = 0;

    this._child = null;
    this._open = false;
    this._closing = false;
    this._exitPromise = null;
  }

  /** ¿Hay un stream abierto? */
  get isOpen() {
    return this._open;
  }

  /** Bytes por frame del PCM que espera write(). */
  get blockAlign() {
    return this.channels * 2;
  }

  /**
   * ¿Está instalado el driver? (existe un endpoint de render cuyo nombre
   * contiene "VOXORA Meet Speaker").
   * @returns {Promise<boolean>}
   */
  static async isInstalled(opts = {}) {
    return (await VirtualMic.findEndpoint(opts)) !== null;
  }

  /**
   * Devuelve el endpoint de render del driver o null si no está instalado.
   * Si el helper no existe se propaga el error (es un problema de build, no
   * de instalación del driver).
   */
  static async findEndpoint({ deviceName = RENDER_ENDPOINT_NAME, ...opts } = {}) {
    const endpoints = await listRenderEndpoints(opts);
    const needle = deviceName.toLowerCase();
    return endpoints.find((e) => typeof e.name === 'string' && e.name.toLowerCase().includes(needle)) ?? null;
  }

  /**
   * Lanza el helper y espera a que el stream WASAPI esté rindiendo.
   * @returns {Promise<{id:string,name:string}>} endpoint abierto
   */
  async open() {
    if (this._open) return this.device;
    if (!existsSync(this.helperPath)) {
      throw new Error(`Helper WASAPI no encontrado: ${this.helperPath} (ejecuta native/build.cmd)`);
    }

    const args = [
      '--rate', String(this.sampleRate),
      '--channels', String(this.channels),
      '--buffer-ms', String(this.bufferMs),
    ];
    if (this.deviceId) args.push('--device', this.deviceId);
    else args.push('--name', this.deviceName);

    const child = this.spawn(this.helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this._child = child;
    this._closing = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    // stderr → evento de diagnóstico, nunca rompe el flujo.
    let stderrBuf = '';
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk;
      let idx;
      while ((idx = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, idx).trim();
        stderrBuf = stderrBuf.slice(idx + 1);
        if (line) this.emit('stderr', line);
      }
    });

    // stdin puede cerrarse por el otro lado (EPIPE) si el helper muere.
    child.stdin.on('error', (err) => {
      if (!this._closing) this.emit('error', err);
    });

    this._exitPromise = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });

    const ready = await this._waitForReady(child);
    this.device = ready.device ?? null;
    this._open = true;

    // Muerte inesperada del helper mientras está abierto.
    this._exitPromise.then(({ code, signal }) => {
      const wasOpen = this._open;
      this._open = false;
      this._child = null;
      if (wasOpen && !this._closing) {
        this.emit('error', new Error(`wasapi-render terminó inesperadamente (code=${code}, signal=${signal})`));
      }
      this.emit('close', { code, signal });
    });

    return this.device;
  }

  /**
   * Espera la línea {"event":"ready"} del helper; rechaza si sale antes, emite
   * {"event":"error"} o se agota readyTimeoutMs.
   */
  _waitForReady(child) {
    return new Promise((resolve, reject) => {
      let buf = '';
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.off('exit', onExit);
        child.off('error', onError);
        fn(value);
      };
      const onData = (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('{')) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.event === 'ready') {
            // Seguir consumiendo stdout para no bloquear el helper.
            child.stdout.on('data', (d) => this._onHelperLine(d));
            finish(resolve, msg);
            return;
          }
          if (msg.event === 'error') {
            finish(reject, new Error(`wasapi-render: ${msg.code} ${msg.hresult ?? ''} ${msg.detail ?? ''}`.trim()));
            return;
          }
        }
      };
      const onExit = (code) => finish(reject, new Error(`wasapi-render terminó antes de estar listo (code=${code})`));
      const onError = (err) => finish(reject, err);
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ya muerto */ }
        finish(reject, new Error(`wasapi-render no emitió "ready" en ${this.readyTimeoutMs} ms`));
      }, this.readyTimeoutMs);

      child.stdout.on('data', onData);
      child.once('exit', onExit);
      child.once('error', onError);
    });
  }

  /** Líneas del helper después de "ready" (eof/stopped/error). */
  _onHelperLine(chunk) {
    for (const raw of String(chunk).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line.startsWith('{')) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.event === 'error' && !this._closing) {
        this.emit('error', new Error(`wasapi-render: ${msg.code} ${msg.hresult ?? ''} ${msg.detail ?? ''}`.trim()));
      }
    }
  }

  /**
   * Escribe PCM s16le (sampleRate/channels configurados). Resuelve cuando el
   * helper ha aceptado los datos (respeta la contrapresión de stdin).
   * @param {Buffer|Uint8Array} pcm
   * @returns {Promise<void>}
   */
  write(pcm) {
    if (!this._open || !this._child) {
      return Promise.reject(new Error('VirtualMic no está abierto (llama a open())'));
    }
    if (!(pcm instanceof Uint8Array)) {
      return Promise.reject(new TypeError('write() espera Buffer/Uint8Array con PCM s16le'));
    }
    if (pcm.length === 0) return Promise.resolve();
    if (pcm.length % this.blockAlign !== 0) {
      return Promise.reject(new RangeError(`el PCM debe ser múltiplo de ${this.blockAlign} bytes (frame s16le x ${this.channels} ch)`));
    }
    const stdin = this._child.stdin;
    this.bytesWritten += pcm.length;
    return new Promise((resolve, reject) => {
      const ok = stdin.write(pcm, (err) => (err ? reject(err) : undefined));
      if (ok) resolve();
      else stdin.once('drain', resolve);
    });
  }

  /**
   * Cierra stdin (el helper vacía su cola y termina) y espera la salida.
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs] tras el cual se mata el proceso (defecto 3000)
   */
  async close({ timeoutMs = 3000 } = {}) {
    const child = this._child;
    if (!child) {
      this._open = false;
      return;
    }
    this._closing = true;
    this._open = false;
    try { child.stdin.end(); } catch { /* ya cerrado */ }

    const exit = this._exitPromise ?? Promise.resolve({ code: null, signal: null });
    const timer = new Promise((resolve) => {
      setTimeout(() => {
        try { child.kill(); } catch { /* ya muerto */ }
        resolve({ code: null, signal: 'SIGKILL' });
      }, timeoutMs).unref?.();
    });
    await Promise.race([exit, timer]);
    this._child = null;
    this.device = null;
  }
}

export default VirtualMic;
