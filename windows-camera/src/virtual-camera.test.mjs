// Tests de VirtualCamera con procesos mockeados (inyección de spawn/execFile). No requieren los
// binarios nativos ni Windows: la plataforma y la versión también se inyectan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  VirtualCamera,
  CLSID,
  HostExitCode,
  FRAME_HEADER_BYTES,
  buildElevatedCommand,
  parseWindowsRelease,
} from './virtual-camera.mjs';

// ---- utilidades de mock -------------------------------------------------------------------------

/** Proceso hijo falso: stdout/stderr son PassThrough, stdin es un Writable que guarda lo escrito. */
class FakeChild extends EventEmitter {
  constructor({ highWaterMark = 1 << 20 } = {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.chunks = [];
    this.stdinEnded = false;
    this.killed = false;
    this.exitCode = null;
    const self = this;
    this.stdin = new Writable({
      highWaterMark,
      write(chunk, _enc, cb) {
        self.chunks.push(Buffer.from(chunk));
        // Se difiere el callback para poder simular saturación (writableNeedDrain) en los tests.
        if (self.holdWrites) self.pendingCallbacks.push(cb);
        else cb();
      },
      final(cb) {
        self.stdinEnded = true;
        cb();
      },
    });
    this.holdWrites = false;
    this.pendingCallbacks = [];
  }

  /** Deja de retener escrituras y libera las pendientes (dispara 'drain' si procede). */
  flushWrites() {
    this.holdWrites = false;
    const callbacks = this.pendingCallbacks;
    this.pendingCallbacks = [];
    for (const cb of callbacks) cb();
  }

  say(line) {
    this.stdout.write(`${line}\n`);
  }

  exit(code) {
    this.exitCode = code;
    this.emit('exit', code, null);
  }

  kill() {
    this.killed = true;
    this.exit(null);
  }

  get stdinText() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/** Crea binarios vacíos para que existsSync() pase. */
function fakeBinDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'voxora-vcam-'));
  for (const name of ['VoxoraMeetVCamHost.exe', 'VoxoraMeetFrameWriter.exe', 'VoxoraMeetVCam.dll']) {
    writeFileSync(path.join(dir, name), '');
  }
  return dir;
}

/**
 * spawn mock: devuelve FakeChild por proceso y registra las invocaciones. Los hijos se auto-anuncian
 * READY en el siguiente tick; al recibir `stop` o cierre de stdin, salen con 0.
 */
function makeSpawn({ autoReady = true } = {}) {
  const calls = [];
  const children = [];
  const spawn = (file, args, options) => {
    const child = new FakeChild();
    calls.push({ file, args, options });
    children.push(child);
    const isHost = file.endsWith('VoxoraMeetVCamHost.exe');
    if (autoReady) setImmediate(() => child.say(isHost ? 'READY VOXORA Meet Camera' : 'READY'));
    // Simula el comportamiento real: el host sale al recibir `stop`, el writer al cerrar stdin.
    child.stdin.on('finish', () => setImmediate(() => child.exitCode === null && child.exit(0)));
    return child;
  };
  return { spawn, calls, children };
}

const win11 = { platform: 'win32', release: '10.0.22631' };

// ---- isSupported --------------------------------------------------------------------------------

test('parseWindowsRelease descompone la versión', () => {
  assert.deepEqual(parseWindowsRelease('10.0.19041'), { major: 10, minor: 0, build: 19041 });
  assert.deepEqual(parseWindowsRelease(''), { major: 0, minor: 0, build: 0 });
});

test('isSupported exige Windows >= 10.0.19041', () => {
  assert.equal(new VirtualCamera({ ...win11 }).isSupported(), true);
  assert.equal(new VirtualCamera({ platform: 'win32', release: '10.0.19041' }).isSupported(), true);
  assert.equal(new VirtualCamera({ platform: 'win32', release: '10.0.18363' }).isSupported(), false);
  assert.equal(new VirtualCamera({ platform: 'linux', release: '6.8.0' }).isSupported(), false);
  assert.equal(new VirtualCamera({ platform: 'win32', release: '11.0.0' }).isSupported(), true);
});

// ---- isRegistered -------------------------------------------------------------------------------

test('isRegistered consulta HKLM con reg query y devuelve true si existe la clave', async () => {
  const invocations = [];
  const execFile = (file, args, _opts, cb) => {
    invocations.push({ file, args });
    cb(null, `HKEY_LOCAL_MACHINE\\...\\InprocServer32\n    (Default)    REG_SZ    C:\\x\\VoxoraMeetVCam.dll\n`, '');
  };
  const cam = new VirtualCamera({ ...win11, execFile });
  assert.equal(await cam.isRegistered(), true);
  assert.equal(invocations[0].file, 'reg');
  assert.ok(invocations[0].args[1].includes(CLSID));
  assert.ok(invocations[0].args[1].endsWith('\\InprocServer32'));
});

test('isRegistered devuelve false cuando reg query falla o la plataforma no es Windows', async () => {
  const execFile = (_f, _a, _o, cb) => cb(Object.assign(new Error('fail'), { code: 1 }), '', 'ERROR');
  assert.equal(await new VirtualCamera({ ...win11, execFile }).isRegistered(), false);
  const neverCalled = () => assert.fail('no debe invocarse en plataformas no soportadas');
  assert.equal(await new VirtualCamera({ platform: 'darwin', release: '23.0.0', execFile: neverCalled }).isRegistered(), false);
});

// ---- register -----------------------------------------------------------------------------------

test('buildElevatedCommand usa Start-Process -Verb RunAs y escapa comillas simples', () => {
  const cmd = buildElevatedCommand("C:\\Program Files\\Vox'ora\\host.exe", ['--register-dll', 'C:\\a b\\x.dll']);
  assert.ok(cmd.includes('-Verb RunAs'));
  assert.ok(cmd.includes('-Wait'));
  assert.ok(cmd.includes("'C:\\Program Files\\Vox''ora\\host.exe'"));
  assert.ok(cmd.includes("@('--register-dll', 'C:\\a b\\x.dll')"));
  assert.ok(cmd.endsWith('exit $p.ExitCode'));
});

test('register lanza PowerShell elevado y resuelve con el código del host', async () => {
  const binDir = fakeBinDir();
  const invocations = [];
  const execFile = (file, args, _opts, cb) => {
    invocations.push({ file, args });
    cb(null, '0\n', '');
  };
  const cam = new VirtualCamera({ ...win11, binDir, execFile });
  assert.equal(await cam.register(), HostExitCode.OK);
  assert.equal(invocations[0].file, 'powershell.exe');
  const script = invocations[0].args.at(-1);
  assert.ok(script.includes('-Verb RunAs'));
  assert.ok(script.includes('--register-dll'));
  assert.ok(script.includes('VoxoraMeetVCam.dll'));
});

test('register propaga códigos de error del host y cancelación de UAC', async () => {
  const binDir = fakeBinDir();
  const needsElevation = (_f, _a, _o, cb) => cb(Object.assign(new Error('exit 3'), { code: 3 }), '3\n', '');
  await assert.rejects(new VirtualCamera({ ...win11, binDir, execFile: needsElevation }).register(), /elevar|UAC/);
  const hostFailed = (_f, _a, _o, cb) => cb(null, '7\n', '');
  await assert.rejects(new VirtualCamera({ ...win11, binDir, execFile: hostFailed }).register(), /código 7/);
  const missingDll = (_f, _a, _o, cb) => cb(null, '0\n', '');
  await assert.rejects(
    new VirtualCamera({ ...win11, binDir, execFile: missingDll }).register({ dllPath: path.join(binDir, 'nope.dll') }),
    /No existe la DLL/,
  );
});

// ---- start / writeFrame / stop -------------------------------------------------------------------

test('start lanza host y writer, espera READY y emite status running', async () => {
  const binDir = fakeBinDir();
  const { spawn, calls } = makeSpawn();
  const cam = new VirtualCamera({ ...win11, binDir, spawn, friendlyName: 'Cam Test' });
  const states = [];
  cam.on('status', (s) => states.push(s.state));
  await cam.start();
  assert.equal(cam.state, 'running');
  assert.deepEqual(states, ['starting', 'running']);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].file.endsWith('VoxoraMeetVCamHost.exe'));
  assert.deepEqual(calls[0].args, ['--name', 'Cam Test']);
  assert.ok(calls[1].file.endsWith('VoxoraMeetFrameWriter.exe'));
  await cam.stop();
});

test('start falla si el host sale antes de READY', async () => {
  const binDir = fakeBinDir();
  const { spawn, children } = makeSpawn({ autoReady: false });
  const cam = new VirtualCamera({ ...win11, binDir, spawn });
  setImmediate(() => children[0].exit(HostExitCode.CREATE_FAILED));
  await assert.rejects(cam.start(), /código 5/);
  assert.equal(cam.state, 'error');
});

test('start rechaza plataformas no soportadas sin lanzar procesos', async () => {
  const spawn = () => assert.fail('spawn no debe llamarse');
  const cam = new VirtualCamera({ platform: 'win32', release: '10.0.17763', spawn });
  await assert.rejects(cam.start(), /Windows 10 2004/);
});

test('writeFrame escribe cabecera de 16 bytes + RGBA al stdin del writer', async () => {
  const binDir = fakeBinDir();
  const { spawn, children } = makeSpawn();
  const cam = new VirtualCamera({ ...win11, binDir, spawn });
  await cam.start();
  const writer = children[1];
  const rgba = Buffer.alloc(4 * 2 * 4, 0xab); // 4x2
  assert.equal(cam.writeFrame(rgba, 4, 2, 1234.6), true);
  const data = Buffer.concat(writer.chunks);
  assert.equal(data.length, FRAME_HEADER_BYTES + rgba.length);
  assert.equal(data.readUInt32LE(0), 4);
  assert.equal(data.readUInt32LE(4), 2);
  assert.equal(data.readBigUInt64LE(8), 1235n);
  assert.ok(data.subarray(FRAME_HEADER_BYTES).equals(rgba));
  assert.equal(cam.stats.written, 1);
  await cam.stop();
});

test('writeFrame descarta frames inválidos y cuando la cámara no está activa', async () => {
  const binDir = fakeBinDir();
  const { spawn } = makeSpawn();
  const cam = new VirtualCamera({ ...win11, binDir, spawn });
  assert.equal(cam.writeFrame(Buffer.alloc(16), 2, 2), false); // no arrancada
  await cam.start();
  assert.equal(cam.writeFrame(Buffer.alloc(15), 2, 2), false); // tamaño incorrecto
  assert.equal(cam.writeFrame(Buffer.alloc(3 * 2 * 4), 3, 2), false); // ancho impar
  assert.equal(cam.writeFrame(Buffer.alloc(1922 * 2 * 4), 1922, 2), false); // supera máximo
  assert.equal(cam.stats.dropped, 3);
  await cam.stop();
});

test('writeFrame aplica backpressure: descarta mientras el stdin no drena', async () => {
  const binDir = fakeBinDir();
  const { spawn, children } = makeSpawn();
  const cam = new VirtualCamera({ ...win11, binDir, spawn });
  await cam.start();
  const writer = children[1];
  // highWaterMark de 1 MiB: un frame 640x480 (1.2 MB) satura el buffer si las escrituras se retienen.
  writer.holdWrites = true;
  const frame = Buffer.alloc(640 * 480 * 4);
  assert.equal(cam.writeFrame(frame, 640, 480, 1), true);
  assert.equal(cam.writeFrame(frame, 640, 480, 2), false); // saturado → descartado
  assert.equal(cam.writeFrame(frame, 640, 480, 3), false);
  assert.deepEqual(cam.stats, { written: 1, dropped: 2 });
  // 'drain' puede emitirse de forma síncrona al liberar las escrituras: se escucha antes de liberar.
  const drained = new Promise((r) => writer.stdin.once('drain', r));
  writer.flushWrites();
  await drained;
  assert.equal(cam.writeFrame(frame, 640, 480, 4), true); // tras drain vuelve a aceptar
  assert.equal(cam.stats.written, 2);
  await cam.stop();
});

test('stop envía `stop` al host, cierra stdin del writer y emite stopped', async () => {
  const binDir = fakeBinDir();
  const { spawn, children } = makeSpawn();
  const cam = new VirtualCamera({ ...win11, binDir, spawn });
  const states = [];
  cam.on('status', (s) => states.push(s.state));
  await cam.start();
  await cam.stop();
  const [host, writer] = children;
  assert.ok(host.stdinText.includes('stop\n'));
  assert.equal(host.stdinEnded, true);
  assert.equal(writer.stdinEnded, true);
  assert.equal(host.exitCode, 0);
  assert.equal(writer.exitCode, 0);
  assert.equal(cam.state, 'stopped');
  assert.deepEqual(states, ['starting', 'running', 'stopping', 'stopped']);
  assert.equal(cam.writeFrame(Buffer.alloc(16), 2, 2), false);
});

test('la salida inesperada del host pasa la cámara a error y apaga el writer', async () => {
  const binDir = fakeBinDir();
  const { spawn, children } = makeSpawn();
  const cam = new VirtualCamera({ ...win11, binDir, spawn });
  await cam.start();
  const errorStatus = new Promise((resolve) => {
    cam.on('status', (s) => {
      if (s.state === 'error') resolve(s);
    });
  });
  children[0].exit(1);
  const status = await errorStatus;
  assert.match(status.detail, /host terminó inesperadamente/);
  assert.equal(children[1].stdinEnded, true);
  assert.equal(cam.state, 'error');
});

test('las líneas de stdout/stderr de los hijos se reemiten como log', async () => {
  const binDir = fakeBinDir();
  const { spawn, children } = makeSpawn();
  const cam = new VirtualCamera({ ...win11, binDir, spawn });
  const logs = [];
  cam.on('log', (l) => logs.push(l));
  await cam.start();
  children[1].stderr.write('MAPPING opened Global\\VoxoraMeetVCamFrames\r\n');
  await new Promise((r) => setImmediate(r));
  assert.ok(logs.some((l) => l.source === 'writer' && l.stderr && l.line.startsWith('MAPPING opened')));
  assert.ok(logs.some((l) => l.source === 'host' && l.line.startsWith('READY')));
  await cam.stop();
});
