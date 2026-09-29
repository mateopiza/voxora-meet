#!/usr/bin/env node
// E2E real de la cámara virtual "VOXORA Meet Camera" (Windows, DLL ya registrada).
//
// Reproduce el camino completo productor → memoria compartida → DLL (FrameServer) → consumidor MF:
//   - VoxoraMeetVCamHost.exe   crea la cámara (MFCreateVirtualCamera)
//   - VoxoraMeetFrameWriter.exe productor: este script le manda por stdin frames RGBA con un patrón
//                               conocido (8 barras de color + contador binario que avanza)
//   - VoxoraMeetCameraTest.exe  consumidor: abre la cámara con IMFSourceReader (NV12 / RGB32, formato
//                               nativo de la DLL) y clasifica cada frame: pattern | fallback | other
//
// Escenarios (ambos órdenes, como en la vida real: Meet abre la cámara antes o después que la app):
//   A. consumidor PRIMERO: ve la imagen de espera → arranca el productor → debe ver el patrón con el
//      contador avanzando → se para el productor → vuelve la imagen de espera (latido QPC, ≤ 2 s).
//   B. productor PRIMERO, antes incluso del host (el orden del bug: el shell publicaba antes de que la
//      DLL creara el mapping): el host se apaga por EOF en stdin, el productor arranca sin mapping y
//      debe abrirlo SOLO mientras le siguen llegando frames en cuanto la DLL lo crea → consumidor →
//      patrón (NV12); se cierra y se reabre el consumidor en RGB32 → patrón.
//   C. con el productor reteniendo el mapping se reinicia el host (la DLL se descarga y se vuelve a
//      cargar): la DLL reabre el mismo objeto y el consumidor ve el patrón sin que el productor reconecte.
//
// Uso: npm run test:camera-e2e   (no forma parte de `npm test`: necesita la cámara registrada)
//      node windows-camera/scripts/e2e-camera.mjs [--verbose]
// Salida 0 si todo pasa; 1 si falla alguna comprobación; 2 si faltan requisitos.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(here, '..', 'native', 'bin');
const HOST = path.join(BIN, 'VoxoraMeetVCamHost.exe');
const WRITER = path.join(BIN, 'VoxoraMeetFrameWriter.exe');
const TEST = path.join(BIN, 'VoxoraMeetCameraTest.exe');
const CAMERA_NAME = 'VOXORA Meet Camera';
const VERBOSE = process.argv.includes('--verbose');

// Patrón (mismo contrato que test-consumer/main.cpp): 640x360, 3/4 superiores con 8 barras, 1/4
// inferior con dos filas de 16 celdas (bits del contador MSB primero / complemento).
const W = 640;
const H = 360;
const FPS = 30;
const BARS = [[255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0], [255, 0, 255], [255, 0, 0], [0, 0, 255], [0, 0, 0]];

const results = [];
const children = new Set();

function log(...args) { console.log(...args); }
function debug(...args) { if (VERBOSE) console.log('   ·', ...args); }

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

// ── Frames de patrón ────────────────────────────────────────────────────────
const baseFrame = (() => {
  const buf = Buffer.alloc(W * H * 4);
  const barW = W / 8;
  for (let y = 0; y < 270; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = BARS[Math.min(7, Math.floor(x / barW))];
      const o = (y * W + x) * 4;
      buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 255;
    }
  }
  return buf;
})();

function patternFrame(counter, timestampMs) {
  const frame = Buffer.alloc(16 + W * H * 4);
  frame.writeUInt32LE(W, 0);
  frame.writeUInt32LE(H, 4);
  frame.writeBigUInt64LE(BigInt(Math.max(0, Math.round(timestampMs))), 8);
  baseFrame.copy(frame, 16);
  const cellW = W / 16;
  for (let j = 0; j < 16; j++) {
    const bit = (counter >> (15 - j)) & 1;
    for (const [y0, y1, value] of [[270, 315, bit], [315, 360, bit ^ 1]]) {
      const v = value ? 255 : 0;
      for (let y = y0; y < y1; y++) {
        for (let x = j * cellW; x < (j + 1) * cellW; x++) {
          const o = 16 + (y * W + x) * 4;
          frame[o] = v; frame[o + 1] = v; frame[o + 2] = v; frame[o + 3] = 255;
        }
      }
    }
  }
  return frame;
}

// ── Procesos ────────────────────────────────────────────────────────────────
function launch(exe, args, name) {
  const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.name = name;
  child.lines = [];
  child.exited = new Promise((resolve) => child.on('exit', (code) => { children.delete(child); resolve(code); }));
  child.on('error', (error) => log(`   [${name}] error: ${error.message}`));
  child.stdin.on('error', () => {});  // EPIPE si el proceso ya salió
  const onData = (stream, tag) => {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      pending += chunk;
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl).replace(/\r$/, '');
        pending = pending.slice(nl + 1);
        if (!line) continue;
        child.lines.push({ tag, line, at: Date.now() });
        child.emit('line', line, tag);
        if (tag === 'err' || !line.startsWith('{"type":"frame"')) debug(`[${name}${tag === 'err' ? ':err' : ''}] ${line}`);
      }
    });
  };
  onData(child.stdout, 'out');
  onData(child.stderr, 'err');
  children.add(child);
  return child;
}

async function stopChild(child, { command = null, timeoutMs = 5000 } = {}) {
  if (!child || child.exitCode !== null) return child?.exitCode;
  try {
    if (command) child.stdin.write(`${command}\n`);
    child.stdin.end();
  } catch { /* ya cerrado */ }
  const code = await Promise.race([child.exited, sleep(timeoutMs).then(() => 'timeout')]);
  if (code === 'timeout') {
    child.kill();
    return child.exited;
  }
  return code;
}

function waitForLine(child, predicate, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const existing = child.lines.find((l) => predicate(l.line, l.tag));
    if (existing) return resolve(existing.line);
    const timer = setTimeout(() => { cleanup(); reject(new Error(`${what}: sin respuesta en ${timeoutMs} ms`)); }, timeoutMs);
    const onLine = (line, tag) => { if (predicate(line, tag)) { cleanup(); resolve(line); } };
    const onExit = (code) => { cleanup(); reject(new Error(`${what}: ${child.name} terminó (código ${code})`)); };
    const cleanup = () => { clearTimeout(timer); child.off('line', onLine); child.off('exit', onExit); };
    child.on('line', onLine);
    child.on('exit', onExit);
  });
}

function runTool(args) {
  const r = spawnSync(TEST, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return (r.stdout || '').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
const probe = () => runTool(['--probe'])[0] || {};
const listCameras = () => runTool(['--list']).filter((d) => d.type === 'device').map((d) => d.name);
const cameraListed = () => listCameras().some((n) => n === CAMERA_NAME || n.startsWith(`${CAMERA_NAME} `));

async function waitUntil(fn, timeoutMs, intervalMs = 250) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) return null;
    await sleep(intervalMs);
  }
}

function processRunning(image) {
  const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return (r.stdout || '').toLowerCase().includes(image.toLowerCase());
}

// ── Consumidor ──────────────────────────────────────────────────────────────
class Consumer {
  constructor(format = 'nv12') {
    this.format = format;
    this.frames = [];
    this.child = launch(TEST, ['--format', format, '--seconds', '120'], `consumer-${format}`);
    this.child.on('line', (line) => {
      if (!line.startsWith('{')) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'frame') this.frames.push({ ...msg, at: Date.now() });
    });
  }

  opened(timeoutMs = 15000) {
    return waitForLine(this.child, (l) => l.startsWith('{"type":"open"') || l.startsWith('{"type":"error"'), timeoutMs, 'abrir la cámara')
      .then((line) => { if (line.includes('"error"')) throw new Error(`el consumidor no pudo abrir la cámara: ${line}`); return JSON.parse(line); });
  }

  since(t) { return this.frames.filter((f) => f.at >= t); }

  // Espera `count` frames de `kind` desde `t`; devuelve los frames o null.
  async waitKind(kind, count, t, timeoutMs) {
    return waitUntil(() => {
      const list = this.since(t).filter((f) => f.kind === kind);
      return list.length >= count ? list : null;
    }, timeoutMs, 100);
  }

  stop() { return stopChild(this.child, { command: 'stop' }); }
}

function counterStats(frames) {
  const counters = frames.map((f) => f.counter).filter((c) => c >= 0);
  const distinct = new Set(counters).size;
  let forward = 0;
  for (let i = 1; i < counters.length; i++) if (counters[i] > counters[i - 1]) forward++;
  return { valid: counters.length, distinct, forward, first: counters[0], last: counters.at(-1) };
}

// ── Productor ───────────────────────────────────────────────────────────────
class Producer {
  constructor() {
    this.child = launch(WRITER, [], 'writer');
    this.counter = 0;
    this.sent = 0;
    this.skipped = 0;
    this.busy = false;
    this.t0 = performance.now();
    this.timer = setInterval(() => this.tick(), Math.round(1000 / FPS));
  }

  tick() {
    if (this.child.exitCode !== null) return;
    if (this.busy) { this.skipped++; return; }
    this.counter = (this.counter + 1) & 0xffff;
    const ok = this.child.stdin.write(patternFrame(this.counter, performance.now() - this.t0));
    this.sent++;
    if (!ok) {
      this.busy = true;
      this.child.stdin.once('drain', () => { this.busy = false; });
    }
  }

  async stop() {
    clearInterval(this.timer);
    return stopChild(this.child);
  }

  stderr() { return this.child.lines.filter((l) => l.tag === 'err').map((l) => l.line); }
}

// ── Comprobaciones ─────────────────────────────────────────────────────────
async function expectPattern(consumer, since, label, timeoutMs = 10000) {
  const frames = await consumer.waitKind('pattern', 45, since, timeoutMs);
  if (!frames) {
    const seen = consumer.since(since);
    const kinds = seen.reduce((acc, f) => ({ ...acc, [f.kind]: (acc[f.kind] || 0) + 1 }), {});
    return check(label, false, `no llegó el patrón en ${timeoutMs / 1000} s (frames vistos: ${JSON.stringify(kinds)})`);
  }
  const s = counterStats(frames);
  const latency = frames[0].at - since;
  return check(label, s.distinct >= 15 && s.forward >= s.valid * 0.5,
    `${frames.length} frames de patrón en ${(latency / 1000).toFixed(1)} s, contador ${s.first}→${s.last} (${s.distinct} valores, ${s.forward} avances)`);
}

// ── Host ────────────────────────────────────────────────────────────────────
let host = null;

async function startHost() {
  host = launch(HOST, [], 'host');
  await waitForLine(host, (l) => l.startsWith('READY'), 15000, 'host READY');
  const listed = await waitUntil(() => (cameraListed() ? true : null), 10000, 500);
  if (!listed) throw new Error(`«${CAMERA_NAME}» no aparece en la enumeración de Media Foundation (cámaras: ${listCameras().join(', ') || 'ninguna'})`);
}

// `eof`: solo cerrar stdin (lo que pasa si el shell muere) en vez de mandar `stop`.
async function stopHost({ eof = false } = {}) {
  const code = await stopChild(host, { command: eof ? null : 'stop', timeoutMs: 8000 });
  host = null;
  return code;
}

// ── Escenarios ──────────────────────────────────────────────────────────────
async function scenarioConsumerFirst() {
  log('\nA. Consumidor PRIMERO (Meet abre la cámara antes de que la app publique)');
  const consumer = new Consumer('nv12');
  try {
    await consumer.opened();
    const t0 = Date.now();
    const fallback = await consumer.waitKind('fallback', 15, t0, 10000);
    check('sin productor, la cámara muestra la imagen de espera', Boolean(fallback),
      fallback ? `${fallback.length} frames de espera` : 'no llegaron frames de espera');
    const p = probe();
    check('la DLL tiene creada la memoria compartida', p.mapping === true && p.magicOk === true,
      `mapping=${p.mapping} magicOk=${p.magicOk}; relojes QPC vs MFGetSystemTime: ${p.clockDiff100ns ?? '?'} ×100 ns`);

    const producer = new Producer();
    const tProducer = Date.now();
    const okPattern = await expectPattern(consumer, tProducer, 'al arrancar el productor DESPUÉS, la cámara pasa al patrón');
    const writerLog = producer.stderr();
    debug('writer:', writerLog.join(' | '));
    check('el productor abrió el mapping creado por la DLL', writerLog.some((l) => l.startsWith('MAPPING opened')), writerLog.find((l) => l.startsWith('MAPPING')) || 'sin línea MAPPING');

    await producer.stop();
    const tStop = Date.now();
    if (okPattern) {
      const back = await consumer.waitKind('fallback', 10, tStop, 6000);
      check('al parar el productor vuelve la imagen de espera (latido QPC, ≤ 2 s)', Boolean(back),
        back ? `tras ${((back[0].at - tStop) / 1000).toFixed(1)} s` : 'siguió mostrando otra cosa');
    }
  } catch (error) {
    check('escenario A', false, error.message);
  } finally {
    const summary = consumer.frames.length;
    await consumer.stop();
    debug(`consumer A: ${summary} frames`);
  }
}

// B y C comparten el productor: se devuelve para el escenario C.
async function scenarioProducerFirst() {
  log('\nB. Productor PRIMERO (la app publica antes de que exista la cámara y de que Meet la abra — el orden del bug)');
  // Sin host no hay fuente en el FrameServer y la DLL no ha creado el mapping.
  const code = await stopHost({ eof: true });
  check('el host se apaga solo al recibir EOF en stdin (lo que pasa si el shell muere)', code === 0, `código ${code}`);
  const gone = await waitUntil(() => (probe().mapping === false ? true : null), 10000, 250);
  check('sin host, la DLL suelta la memoria compartida', Boolean(gone));

  const producer = new Producer();
  let consumer = null;
  try {
    await sleep(1500);
    const waiting = producer.stderr().some((l) => l.startsWith('WAITING'));
    check('el productor arranca sin mapping y sigue enviando frames (WAITING)', waiting, waiting ? 'WAITING' : 'el productor no informó espera');

    const tHost = Date.now();
    await startHost();
    const opened = await waitUntil(() => producer.stderr().find((l) => l.startsWith('MAPPING opened')) || null, 5000, 100);
    check('con frames llegando, el productor reintenta y abre el mapping en cuanto la DLL lo crea', Boolean(opened),
      opened ? `${((Date.now() - tHost) / 1000).toFixed(1)} s tras lanzar el host` : 'nunca abrió el mapping (el bug original)');

    consumer = new Consumer('nv12');
    await consumer.opened();
    await expectPattern(consumer, Date.now(), 'al abrir la cámara DESPUÉS del productor, llega el patrón (NV12)');
    await consumer.stop();
    consumer = null;

    await sleep(1000);
    consumer = new Consumer('rgb32');
    await consumer.opened();
    await expectPattern(consumer, Date.now(), 'cerrar y reabrir la cámara con el productor vivo: patrón otra vez (RGB32)');
    await consumer.stop();
    consumer = null;
    return producer;
  } catch (error) {
    check('escenario B', false, error.message);
    if (consumer) await consumer.stop();
    await producer.stop();
    return null;
  }
}

async function scenarioDllReload(producer) {
  log('\nC. Se reinicia el host (la DLL se descarga y se vuelve a cargar) con el productor reteniendo el mapping');
  let consumer = null;
  try {
    const code = await stopHost();
    check('el host se apaga limpio con `stop`', code === 0, `código ${code}`);
    await sleep(1000);
    const kept = probe();
    check('el mapping sobrevive mientras el productor lo tenga abierto', kept.mapping === true, `mapping=${kept.mapping}`);
    await startHost();
    consumer = new Consumer('nv12');
    await consumer.opened();
    await expectPattern(consumer, Date.now(), 'la DLL recargada reabre el MISMO mapping: patrón sin que el productor reconecte');
    const opens = producer.stderr().filter((l) => l.startsWith('MAPPING opened')).length;
    check('el productor no tuvo que reabrir el mapping', opens === 1, `${opens} aperturas`);
  } catch (error) {
    check('escenario C', false, error.message);
  } finally {
    if (consumer) await consumer.stop();
    await producer.stop();
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (process.platform !== 'win32') {
    log('La cámara virtual solo existe en Windows.');
    return 2;
  }
  for (const exe of [HOST, WRITER, TEST]) {
    if (!existsSync(exe)) {
      log(`Falta ${path.relative(process.cwd(), exe)}. Compila con: node scripts/build-native.mjs`);
      return 2;
    }
  }
  const reg = spawnSync(HOST, ['--check-registered'], { encoding: 'utf8', windowsHide: true });
  if (reg.status !== 0) {
    log(`La DLL de la cámara virtual no está registrada (${(reg.stdout || '').trim() || reg.status}).`);
    log('Regístrala una vez desde una consola elevada: VoxoraMeetVCamHost.exe --register-dll "C:\\ProgramData\\VOXORA Meet\\VoxoraMeetVCam.dll"');
    return 2;
  }
  if (processRunning('VoxoraMeetVCamHost.exe')) {
    log('Ya hay un VoxoraMeetVCamHost.exe en marcha (¿VOXORA Meet abierto con la cámara virtual activa?).');
    log('Su productor publicaría la webcam en la misma memoria compartida: ciérralo (o desactiva la cámara) y repite.');
    return 2;
  }
  if (processRunning('VoxoraMeet.exe')) log('Aviso: VoxoraMeet.exe está abierto; si activa su cámara virtual durante la prueba, interferirá.');
  const before = probe();
  if (before.mapping && before.heartbeatAgeMs !== null && before.heartbeatAgeMs < 2000) {
    log('Otro productor está publicando en la cámara virtual ahora mismo; ciérralo y repite.');
    return 2;
  }

  log(`E2E cámara virtual — binarios en ${BIN}`);
  try {
    await startHost();
    check(`el host crea «${CAMERA_NAME}» y aparece en Media Foundation`, true);
    const early = await waitUntil(() => (probe().mapping ? true : null), 3000, 100);
    debug(`antes de que ninguna app abra la cámara: mapping=${Boolean(early)} (la DLL lo crea al instanciarse la fuente)`);

    await scenarioConsumerFirst();
    const producer = await scenarioProducerFirst();
    if (producer) await scenarioDllReload(producer);
  } catch (error) {
    check('preparación', false, error.message);
  } finally {
    if (host) {
      const code = await stopHost();
      check('el host se apaga limpio con `stop`', code === 0, `código ${code}`);
    }
    const gone = await waitUntil(() => (!cameraListed() ? true : null), 10000, 500);
    check('al cerrar el host la cámara desaparece', Boolean(gone));
  }

  const failed = results.filter((r) => !r.ok);
  log(`\n${failed.length ? '✗' : '✓'} ${results.length - failed.length}/${results.length} comprobaciones OK`);
  return failed.length ? 1 : 0;
}

process.on('SIGINT', () => { for (const c of children) c.kill(); process.exit(130); });
main().then((code) => {
  for (const c of children) c.kill();
  process.exit(code);
}, (error) => {
  console.error(error);
  for (const c of children) c.kill();
  process.exit(1);
});
