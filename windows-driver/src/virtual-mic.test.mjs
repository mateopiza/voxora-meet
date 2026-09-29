// virtual-mic.test.mjs — Tests de VirtualMic con spawn inyectado (sin driver,
// sin helper real). node --test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { VirtualMic, listRenderEndpoints, RENDER_ENDPOINT_NAME } from './virtual-mic.mjs';

// Usamos este mismo archivo como "helperPath": existe en disco, que es lo
// único que comprueba VirtualMic antes de hacer spawn.
const FAKE_HELPER = fileURLToPath(import.meta.url);

const ENDPOINTS = [
  { id: '{0.0.0.00000000}.{aaaa}', name: 'Altavoces (Realtek Audio)', isDefault: true },
  { id: '{0.0.0.00000000}.{bbbb}', name: 'VOXORA Meet Speaker (VOXORA Meet Virtual Audio)', isDefault: false },
];

/** Proceso hijo falso con stdin/stdout/stderr y control manual de la salida. */
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 4242;
    this.killed = false;
    this.written = [];
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new Writable({
      write: (chunk, _enc, cb) => { this.written.push(Buffer.from(chunk)); cb(); },
      // Como el helper real: tras EOF de stdin vacía la cola, emite "eof" y sale.
      final: (cb) => { this.stdinEnded = true; cb(); setTimeout(() => { if (!this.exited) { this.say({ event: 'eof' }); this.exit(0); } }, 2); },
    });
    this.stdinEnded = false;
    this.exited = false;
  }
  kill() { this.killed = true; queueMicrotask(() => { if (!this.exited) { this.exited = true; this.emit('exit', null, 'SIGTERM'); } }); return true; }
  say(obj) { this.stdout.write(`${JSON.stringify(obj)}\n`); }
  exit(code = 0) { if (this.exited) return; this.exited = true; this.emit('exit', code, null); }
}

/** Crea un spawn falso; `onSpawn(child, cmd, args)` decide el comportamiento. */
function fakeSpawn(onSpawn) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = new FakeChild();
    calls.push({ cmd, args, opts, child });
    queueMicrotask(() => onSpawn(child, cmd, args));
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

const listBehaviour = (child, _cmd, args) => {
  if (args.includes('--list')) {
    child.stdout.write(`${JSON.stringify(ENDPOINTS)}\n`);
    child.exit(0);
  }
};

test('listRenderEndpoints parsea el JSON de --list', async () => {
  const spawn = fakeSpawn(listBehaviour);
  const eps = await listRenderEndpoints({ helperPath: FAKE_HELPER, spawn });
  assert.deepEqual(eps, ENDPOINTS);
  assert.deepEqual(spawn.calls[0].args, ['--list']);
});

test('listRenderEndpoints falla si el helper no existe', async () => {
  await assert.rejects(
    listRenderEndpoints({ helperPath: 'Z:\\no\\existe\\wasapi-render.exe', spawn: fakeSpawn(() => {}) }),
    /Helper WASAPI no encontrado/,
  );
});

test('listRenderEndpoints falla con código de salida != 0', async () => {
  const spawn = fakeSpawn((child) => { child.stderr.write('boom\n'); child.exit(4); });
  await assert.rejects(listRenderEndpoints({ helperPath: FAKE_HELPER, spawn }), /código 4/);
});

test('isInstalled detecta el endpoint por nombre (case-insensitive)', async () => {
  assert.equal(await VirtualMic.isInstalled({ helperPath: FAKE_HELPER, spawn: fakeSpawn(listBehaviour) }), true);
  const sinDriver = fakeSpawn((child) => { child.stdout.write(`${JSON.stringify([ENDPOINTS[0]])}\n`); child.exit(0); });
  assert.equal(await VirtualMic.isInstalled({ helperPath: FAKE_HELPER, spawn: sinDriver }), false);
  const ep = await VirtualMic.findEndpoint({ helperPath: FAKE_HELPER, spawn: fakeSpawn(listBehaviour) });
  assert.equal(ep.id, ENDPOINTS[1].id);
  assert.ok(ep.name.includes(RENDER_ENDPOINT_NAME));
});

test('open() pasa los argumentos y resuelve con "ready"', async () => {
  const spawn = fakeSpawn((child) => {
    child.say({ event: 'ready', device: { id: ENDPOINTS[1].id, name: ENDPOINTS[1].name }, format: { rate: 48000, channels: 1, bits: 16 }, bufferFrames: 4800 });
  });
  const mic = new VirtualMic({ helperPath: FAKE_HELPER, spawn, sampleRate: 48000, channels: 1, bufferMs: 80 });
  const device = await mic.open();
  assert.equal(mic.isOpen, true);
  assert.equal(device.name, ENDPOINTS[1].name);
  const { args } = spawn.calls[0];
  assert.deepEqual(args, ['--rate', '48000', '--channels', '1', '--buffer-ms', '80', '--name', RENDER_ENDPOINT_NAME]);
  await mic.close();
  assert.equal(mic.isOpen, false);
});

test('open() usa --device cuando se da un id', async () => {
  const spawn = fakeSpawn((child) => child.say({ event: 'ready', device: { id: 'X', name: 'Y' } }));
  const mic = new VirtualMic({ helperPath: FAKE_HELPER, spawn, deviceId: '{dev-id}' });
  await mic.open();
  assert.ok(spawn.calls[0].args.includes('--device'));
  assert.ok(spawn.calls[0].args.includes('{dev-id}'));
  assert.ok(!spawn.calls[0].args.includes('--name'));
  await mic.close();
});

test('open() rechaza si el helper reporta error o sale antes de ready', async () => {
  const errSpawn = fakeSpawn((child) => { child.say({ event: 'error', code: 'device-not-found', hresult: '0x80070490', detail: 'x' }); child.exit(3); });
  await assert.rejects(new VirtualMic({ helperPath: FAKE_HELPER, spawn: errSpawn }).open(), /device-not-found/);

  const exitSpawn = fakeSpawn((child) => child.exit(2));
  await assert.rejects(new VirtualMic({ helperPath: FAKE_HELPER, spawn: exitSpawn }).open(), /antes de estar listo/);

  const silentSpawn = fakeSpawn(() => {});
  await assert.rejects(new VirtualMic({ helperPath: FAKE_HELPER, spawn: silentSpawn, readyTimeoutMs: 30 }).open(), /no emitió "ready"/);
  assert.equal(silentSpawn.calls[0].child.killed, true);
});

test('write() envía el PCM por stdin y close() cierra stdin y espera la salida', async () => {
  let child;
  const spawn = fakeSpawn((c) => { child = c; c.say({ event: 'ready', device: { id: 'X', name: 'Y' } }); });
  const mic = new VirtualMic({ helperPath: FAKE_HELPER, spawn, channels: 1 });
  await mic.open();

  const pcm = Buffer.alloc(960, 0x12); // 480 frames mono s16le (10 ms)
  await mic.write(pcm);
  await mic.write(pcm);
  assert.equal(mic.bytesWritten, 1920);
  assert.equal(Buffer.concat(child.written).length, 1920);

  // Frames incompletos y datos no binarios se rechazan.
  await assert.rejects(mic.write(Buffer.alloc(3)), RangeError);
  await assert.rejects(mic.write('texto'), TypeError);

  const closed = new Promise((resolve) => mic.once('close', resolve));
  // El helper (falso) termina al vaciar su cola tras EOF de stdin.
  await mic.close();
  assert.equal(child.stdinEnded, true);
  assert.deepEqual(await closed, { code: 0, signal: null });
  assert.equal(mic.isOpen, false);
  await assert.rejects(mic.write(pcm), /no está abierto/);
});

test('close() mata al helper si no termina a tiempo', async () => {
  let child;
  const spawn = fakeSpawn((c) => { child = c; c.say({ event: 'ready' }); });
  const mic = new VirtualMic({ helperPath: FAKE_HELPER, spawn });
  await mic.open();
  child.stdin._final = (cb) => cb(); // helper colgado: no sale tras EOF
  await mic.close({ timeoutMs: 20 });
  assert.equal(child.killed, true);
});

test('la muerte inesperada del helper emite error y close', async () => {
  let child;
  const spawn = fakeSpawn((c) => { child = c; c.say({ event: 'ready' }); });
  const mic = new VirtualMic({ helperPath: FAKE_HELPER, spawn });
  await mic.open();
  const err = new Promise((resolve) => mic.once('error', resolve));
  child.exit(4);
  assert.match((await err).message, /inesperadamente/);
  assert.equal(mic.isOpen, false);
});

test('valida parámetros del constructor', () => {
  assert.throws(() => new VirtualMic({ channels: 3 }), RangeError);
  assert.throws(() => new VirtualMic({ sampleRate: 100 }), RangeError);
});
