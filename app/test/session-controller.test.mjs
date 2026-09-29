import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { SessionController, SampleClock } from '../engine/session-controller.mjs';
import { SyncBuffer } from '../../sync-buffer/src/sync-buffer.mjs';

const tick = () => new Promise((r) => setImmediate(r));

function makeDeps(overrides = {}) {
  let now = 10_000;
  const clock = { now: () => now, advance: (ms) => { now += ms; } };
  const settings = { delayMs: 2000, fallbackMode: 'original', lateDubPolicy: 'play', maxDriftMs: 1500, micDeviceId: 'mic-1', maxVoxPerSession: 100, warnAtVox: 50, sourceLanguage: 'es', targetLanguage: 'en', tone: 'professional', memoryTurns: 8, voiceId: 'v1' };
  const mic = Object.assign(new EventEmitter(), { started: 0, stopped: 0, start() { this.started++; }, stop() { this.stopped++; } });
  const virtualMic = { opened: 0, closed: 0, written: [], async open() { this.opened++; }, write(pcm) { this.written.push(pcm); }, async close() { this.closed++; } };
  const pipeline = { calls: [], async processTurn(turn) { this.calls.push(turn); return pipeline.next?.(turn) ?? null; } };
  const meter = Object.assign(new EventEmitter(), {
    totalVox: 0, limitReached: false, remainingVox: 100,
    add(cost) { this.totalVox += cost.totalVox; this.remainingVox = 100 - this.totalVox; if (this.totalVox >= 100) { this.limitReached = true; this.emit('limit', { totalVox: this.totalVox, maxVoxPerSession: 100 }); } return { totalVox: this.totalVox }; },
  });
  const created = { micOpts: null, pipelineOpts: null, syncOpts: null, meterOpts: null };
  const deps = {
    settingsStore: { async load() { return { ...settings }; }, async getProviderKeys() { return { groq: 'k' }; } },
    createMicCapture: (opts) => { created.micOpts = opts; return mic; },
    createPipeline: (opts) => { created.pipelineOpts = opts; return pipeline; },
    createSyncBuffer: (opts) => { created.syncOpts = opts; return new SyncBuffer(opts); },
    createVirtualMic: () => virtualMic,
    createMeter: (opts) => { created.meterOpts = opts; return meter; },
    now: clock.now,
    tickIntervalMs: 5,
    statsIntervalMs: 1000,
    ...overrides,
  };
  return { deps, clock, mic, virtualMic, pipeline, meter, created, settings };
}

function collect(controller) {
  const events = [];
  for (const e of ['status', 'level', 'transcript', 'translation', 'dub', 'stats', 'cost', 'warn', 'limit', 'error']) {
    controller.on(e, (data) => events.push({ event: e, data }));
  }
  return events;
}

test('start: abre mic virtual, crea pipeline con ajustes+keys, arranca captura; stop cierra todo', async () => {
  const { deps, mic, virtualMic, created, meter } = makeDeps();
  const c = new SessionController(deps);
  const events = collect(c);
  assert.equal(c.state, 'idle');
  const stats = await c.start();
  assert.equal(c.state, 'running');
  assert.equal(stats.state, 'running');
  assert.equal(stats.delayMs, 2000);
  assert.equal(virtualMic.opened, 1);
  assert.equal(mic.started, 1);
  assert.equal(created.micOpts.deviceId, 'mic-1');
  assert.equal(created.pipelineOpts.keys.groq, 'k');
  assert.equal(created.pipelineOpts.settings.targetLanguage, 'en');
  assert.equal(created.syncOpts.fallbackMode, 'original');
  assert.deepEqual(created.meterOpts, { maxVoxPerSession: 100, warnAtVox: 50 });
  assert.equal(meter.listenerCount('limit'), 1);
  await assert.rejects(() => c.start(), /no se puede iniciar/);

  await c.stop();
  assert.equal(c.state, 'idle');
  assert.equal(mic.stopped, 1);
  assert.equal(virtualMic.closed, 1);
  assert.deepEqual(events.filter((e) => e.event === 'status').map((e) => e.data.state), ['starting', 'running', 'stopping', 'idle']);
});

test('fallo al abrir el mic virtual: vuelve a idle y propaga el error', async () => {
  const { deps, mic } = makeDeps({ createVirtualMic: () => ({ async open() { throw new Error('driver ausente'); }, write() {}, async close() {} }) });
  const c = new SessionController(deps);
  await assert.rejects(() => c.start(), /driver ausente/);
  assert.equal(c.state, 'idle');
  assert.equal(mic.started, 0);
});

test('turno → pipeline → SyncBuffer → VirtualMic: el doblaje sale tras delayMs y se emiten transcript/translation/dub/cost', async () => {
  const { deps, clock, mic, virtualMic, pipeline } = makeDeps();
  const c = new SessionController(deps);
  const events = collect(c);
  await c.start();
  const dubPcm = Buffer.alloc(2 * 4800).fill(0x11); // 100 ms @48k
  pipeline.next = (turn) => ({
    audioDub: dubPcm, sampleRate: 48000,
    sourceTimestamp: turn.startedAt, sourceEndedAt: turn.endedAt, readyAt: clock.now(),
    transcript: 'hola', translation: 'hello', cost: { stt: 1, translate: 1, tts: 2, totalVox: 4 },
  });
  // Primer tick inicializa el cursor en now - delay.
  await new Promise((r) => setTimeout(r, 15));
  const t0 = clock.now();
  mic.emit('level', { rmsDb: -30, speaking: true, noiseFloorDb: -60 });
  mic.emit('turn', { pcm: Buffer.alloc(3200), sampleRate: 16000, startedAt: t0 + 100, endedAt: t0 + 200, voicedMs: 100, rmsDb: -30 });
  await tick(); await tick();
  assert.equal(pipeline.calls.length, 1);
  assert.ok(events.some((e) => e.event === 'transcript' && e.data.text === 'hola'));
  assert.ok(events.some((e) => e.event === 'translation' && e.data.text === 'hello'));
  const dub = events.find((e) => e.event === 'dub');
  assert.equal(dub.data.late, false);
  assert.equal(dub.data.durationMs, 100);
  assert.deepEqual(events.find((e) => e.event === 'level').data, { rmsDb: -30, speaking: true });
  assert.equal(events.find((e) => e.event === 'cost').data.totalVox, 4);
  assert.equal(c.stats().totalVox, 4);
  assert.equal(c.stats().dubsPending, 1);

  // Avanzar 2.3 s de reloj: el rango [t0+100, t0+200) ya se liberó con el doblaje.
  clock.advance(2300);
  await new Promise((r) => setTimeout(r, 20));
  const all = Buffer.concat(virtualMic.written);
  let dubbed = 0;
  for (let i = 0; i < all.length; i += 2) if (all.readInt16LE(i) === 0x1111) dubbed++;
  assert.equal(dubbed, 4800);
  assert.equal(c.stats().dubsPending, 0);
  await c.stop();
});

test('límite de VOX: tras alcanzarlo no se envían más turnos al pipeline y se emite limit', async () => {
  const { deps, mic, pipeline, clock } = makeDeps();
  const c = new SessionController(deps);
  const events = collect(c);
  await c.start();
  pipeline.next = (turn) => ({ audioDub: Buffer.alloc(0), sampleRate: 48000, sourceTimestamp: turn.startedAt, sourceEndedAt: turn.endedAt, cost: { totalVox: 100 } });
  mic.emit('turn', { pcm: Buffer.alloc(320), sampleRate: 16000, startedAt: clock.now(), endedAt: clock.now() + 10 });
  await tick(); await tick();
  assert.ok(events.some((e) => e.event === 'limit'));
  mic.emit('turn', { pcm: Buffer.alloc(320), sampleRate: 16000, startedAt: clock.now(), endedAt: clock.now() + 10 });
  await tick();
  assert.equal(pipeline.calls.length, 1);
  assert.ok(events.some((e) => e.event === 'warn' && e.data.reason === 'limit-reached'));
  assert.equal(c.stats().limitReached, true);
  await c.stop();
});

test('errores del pipeline se reportan como evento error sin tumbar la sesión; turnos null se descartan', async () => {
  const { deps, mic, pipeline, clock } = makeDeps();
  const c = new SessionController(deps);
  const events = collect(c);
  await c.start();
  pipeline.next = () => { throw new Error('STT caído'); };
  mic.emit('turn', { pcm: Buffer.alloc(320), sampleRate: 16000, startedAt: clock.now(), endedAt: clock.now() + 10 });
  await tick(); await tick();
  assert.ok(events.some((e) => e.event === 'error' && e.data.scope === 'pipeline' && /STT/.test(e.data.message)));
  pipeline.next = () => null;
  mic.emit('turn', { pcm: Buffer.alloc(320), sampleRate: 16000, startedAt: clock.now(), endedAt: clock.now() + 10 });
  await tick(); await tick();
  assert.equal(c.state, 'running');
  assert.equal(c.stats().pendingTurns, 0);
  assert.equal(events.filter((e) => e.event === 'dub').length, 0);
  await c.stop();
});

test('setDelay en caliente y applyLiveSettings actualizan el SyncBuffer; sin sesión solo clampa', async () => {
  const { deps } = makeDeps();
  const c = new SessionController(deps);
  assert.equal(c.setDelay(100), 2000);
  assert.equal(c.applyLiveSettings({ fallbackMode: 'duck' }), false);
  await c.start();
  assert.equal(c.setDelay(4321), 4321);
  assert.equal(c.stats().delayMs, 4321);
  assert.equal(c.setDelay(9000), 6000);
  assert.equal(c.applyLiveSettings({ fallbackMode: 'duck', delayMs: 2500 }), true);
  assert.equal(c.session.syncBuffer.fallbackMode, 'duck');
  assert.equal(c.stats().delayMs, 2500);
  await c.stop();
});

test('fuente PCM inyectada: el original se copia al SyncBuffer con timestamps del reloj de muestras', async () => {
  const source = new PassThrough();
  const { deps, clock, created } = makeDeps({ createAudioSource: async () => source });
  const c = new SessionController(deps);
  await c.start();
  assert.equal(created.micOpts.source, source);
  await new Promise((r) => setTimeout(r, 15)); // primer tick
  source.write(Buffer.alloc(3200, 1)); // 100 ms @16k
  await tick();
  // El chunk termina en now: queda todo el delay (2000 ms) por delante del cursor.
  assert.equal(c.stats().queuedAudioMs, 2000);
  await c.stop();
  assert.equal(source.destroyed, true);
  // SampleClock: chunks consecutivos son contiguos; un hueco grande re-ancla.
  const sc = new SampleClock({ sampleRate: 16000, resyncToleranceMs: 250 });
  assert.equal(sc.stamp(3200, 1000), 900);
  assert.equal(sc.stamp(3200, 1100), 1000);
  assert.equal(sc.stamp(3200, 2000), 1900);
  clock.advance(0);
});

test('start sin voz seleccionada falla con voice_missing y no abre dispositivos', async () => {
  const { deps, virtualMic, settings } = makeDeps();
  settings.voiceId = '';
  const c = new SessionController(deps);
  await assert.rejects(c.start(), (e) => e.code === 'voice_missing');
  assert.equal(virtualMic.opened, 0);
  assert.equal(c.state, 'idle');
});

test('start usa la salida resuelta, avisa del fallback y duplica el audio al monitor', async () => {
  const opened = [];
  const makeMic = (opts) => ({ opts, written: 0, async open() { opened.push(opts); }, write() { this.written++; }, async close() {} });
  const mics = [];
  const { deps, settings } = makeDeps({
    resolveOutputDevice: async () => ({ deviceId: 'cable', deviceName: 'CABLE Input', captureName: 'CABLE Output', warning: 'cae a VB-Cable' }),
    createVirtualMic: (opts) => { const m = makeMic(opts); mics.push(m); return m; },
  });
  settings.monitorDevice = 'Altavoces';
  const c = new SessionController(deps);
  const events = collect(c);
  await c.start();
  assert.equal(opened[0].deviceId, 'cable');
  assert.equal(opened[1].deviceName, 'Altavoces');
  assert.ok(events.some((e) => e.event === 'warn' && e.data.kind === 'output' && /VB-Cable/.test(e.data.message)));
  await c.stop();
});

test('presupuesto de frase: limita maxTurnMs al delay y se recalibra con la latencia medida', async () => {
  const { deps, mic, settings, pipeline, clock } = makeDeps();
  settings.delayMs = 6000;
  const limits = [];
  mic.setSegmenterLimits = (patch) => { limits.push(patch); return patch; };
  const c = new SessionController(deps);
  await c.start();
  // 6000 - 3200 (latencia inicial) - 400 (margen) = 2400 ms
  assert.equal(limits.at(-1).maxTurnMs, 2400);
  assert.equal(c.stats().turnBudgetMs, 2400);

  // Un doblaje que tardó 1,5 s desde el fin de la voz amplía el presupuesto.
  pipeline.next = (turn) => ({ audioDub: Buffer.alloc(960), sampleRate: 48000, sourceTimestamp: turn.startedAt, sourceEndedAt: turn.endedAt, readyAt: turn.endedAt + 1500, transcript: 'hola', translation: 'hello' });
  const now = clock.now();
  mic.emit('turn', { pcm: Buffer.alloc(3200), sampleRate: 16000, startedAt: now - 1000, endedAt: now - 500, voicedMs: 500 });
  await tick(); await tick();
  assert.ok(limits.at(-1).maxTurnMs > 2400, `esperaba > 2400, llegó ${limits.at(-1).maxTurnMs}`);

  // Con delay mínimo nunca baja de 1,5 s.
  c.setDelay(2000);
  assert.equal(limits.at(-1).maxTurnMs, 1500);
  await c.stop();
});
