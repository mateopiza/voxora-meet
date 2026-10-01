import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyncBuffer, clampDelayMs, MIN_DELAY_MS, MAX_DELAY_MS } from '../src/sync-buffer.mjs';
import { resampleInt16, pcmToInt16 } from '../src/resampler.mjs';

const SR = 48000;

/** PCM s16le constante `value` de `ms` ms a `rate`. */
function tone(ms, value, rate = SR) {
  const samples = new Int16Array(Math.round((ms * rate) / 1000)).fill(value);
  return Buffer.from(samples.buffer);
}

function int16(buffer) {
  return pcmToInt16(buffer);
}

/** Cuenta cuántas muestras tienen exactamente `value`. */
function countValue(buffer, value) {
  const s = int16(buffer);
  let n = 0;
  for (const v of s) if (v === value) n++;
  return n;
}

function makeBuffer(overrides = {}) {
  const releases = [];
  const buffer = new SyncBuffer({ delayMs: 2000, fallbackMode: 'silence', maxTickMs: Infinity, fadeMs: 0, ...overrides, onRelease: (p) => releases.push(p) });
  return { buffer, releases };
}

test('clamp del delay a 2000–6000 en constructor y setDelay', () => {
  assert.equal(clampDelayMs(100), MIN_DELAY_MS);
  assert.equal(clampDelayMs(99999), MAX_DELAY_MS);
  assert.equal(clampDelayMs('abc'), 3000);
  const b = new SyncBuffer({ delayMs: 500 });
  assert.equal(b.delayMs, 2000);
  assert.equal(b.setDelay(7000), 6000);
  assert.equal(b.setDelay(3500.4), 3500);
  assert.equal(b.stats().delayMs, 3500);
});

test('primer tick inicializa sin emitir; ticks siguientes emiten audio continuo', () => {
  const { buffer, releases } = makeBuffer();
  assert.equal(buffer.tick(5000), null);
  const p = buffer.tick(5020);
  assert.ok(p);
  assert.equal(p.audio.samples, 960); // 20 ms a 48 kHz
  assert.equal(p.audio.rangeStart, 3000);
  assert.equal(p.audio.rangeEnd, 3020);
  assert.equal(releases.length, 1);
  // 1 s de ticks irregulares suma exactamente 48000 muestras.
  let total = 0;
  for (const t of [5033, 5061, 5100, 5140, 5177, 5220, 6020]) total += buffer.tick(t).audio.samples;
  assert.equal(total + 960, 48000 + 960);
});

test('sincronía exacta: el frame y el audio original del mismo timestamp salen en el mismo tick', () => {
  const { buffer } = makeBuffer({ fallbackMode: 'original' });
  buffer.tick(2000); // releasedUntil = 0
  buffer.pushFrame({ frame: 'A', timestamp: 100 });
  buffer.pushFrame({ frame: 'B', timestamp: 500 });
  buffer.pushAudio({ pcm: tone(100, 1000), sampleRate: SR, timestamp: 100 }); // [100, 200)
  buffer.pushAudio({ pcm: tone(100, 2000), sampleRate: SR, timestamp: 500 }); // [500, 600)

  // Ticks de 100 ms: rango [0,100) → nada; [100,200) → frame A + tono 1000.
  let p = buffer.tick(2100);
  assert.equal(p.frame, null);
  assert.equal(countValue(p.audio.pcm, 1000), 0);
  p = buffer.tick(2200);
  assert.equal(p.frame, 'A');
  assert.deepEqual(p.frames, ['A']);
  assert.equal(countValue(p.audio.pcm, 1000), 4800);
  p = buffer.tick(2300);
  assert.equal(p.frame, null);
  assert.equal(countValue(p.audio.pcm, 0), 4800);
  buffer.tick(2400); buffer.tick(2500);
  p = buffer.tick(2600);
  assert.equal(p.frame, 'B');
  assert.equal(countValue(p.audio.pcm, 2000), 4800);
  assert.equal(buffer.stats().queuedFrames, 0);
});

test('doblaje a tiempo reemplaza al original en su rango y se remuestrea a 48 kHz', () => {
  const { buffer } = makeBuffer({ fallbackMode: 'original' });
  buffer.tick(2000);
  // Original con voz [100, 400).
  buffer.pushAudio({ pcm: tone(300, 500), sampleRate: 16000, timestamp: 100 });
  // Doblaje de 200 ms a 24 kHz para el turno [100, 400) — llega antes de liberarse.
  buffer.pushDub({
    audioDub: tone(200, 7000, 24000), sampleRate: 24000,
    sourceTimestamp: 100, sourceEndedAt: 400, readyAt: 1500,
  });
  assert.equal(buffer.stats().dubsPending, 1);
  buffer.tick(2100);
  const p1 = buffer.tick(2200); // [100,200): dub
  assert.equal(countValue(p1.audio.pcm, 7000), 4800);
  assert.equal(p1.audio.sources.dub, 4800);
  const p2 = buffer.tick(2300); // [200,300): dub
  assert.equal(countValue(p2.audio.pcm, 7000), 4800);
  const p3 = buffer.tick(2400); // [300,400): turno doblado pero dub terminó → silencio, NO original
  assert.equal(countValue(p3.audio.pcm, 0), 4800);
  assert.equal(p3.audio.sources.original, 0);
  assert.equal(buffer.stats().dubsPending, 0);
  assert.equal(buffer.stats().driftMs, 0);
});

test('fallbacks: silence, original y duck (-18 dB)', () => {
  for (const [mode, expected] of [['silence', 0], ['original', 10000], ['duck', Math.round(10000 * 10 ** (-18 / 20))]]) {
    const { buffer } = makeBuffer({ fallbackMode: mode });
    buffer.tick(2000);
    buffer.pushAudio({ pcm: tone(100, 10000), sampleRate: SR, timestamp: 0 });
    const p = buffer.tick(2100);
    assert.equal(countValue(p.audio.pcm, expected), 4800, `modo ${mode}`);
  }
});

test('subir el delay en caliente congela (silencio, sin frames) hasta alcanzar el nuevo objetivo', () => {
  const { buffer } = makeBuffer({ fallbackMode: 'original' });
  buffer.tick(2000);
  for (let t = 0; t < 3000; t += 100) {
    buffer.pushAudio({ pcm: tone(100, 100 + t / 100), sampleRate: SR, timestamp: t });
    buffer.pushFrame({ frame: `f${t}`, timestamp: t });
  }
  buffer.tick(2100); // libera [0,100)
  buffer.setDelay(2500);
  // Ahora target = now - 2500: durante 500 ms sólo silencio y sin frames.
  const frozen = [];
  for (let t = 2200; t <= 2600; t += 100) frozen.push(buffer.tick(t));
  assert.ok(frozen.every((p) => p.frozen && p.frame === null && p.audio.samples === 4800));
  assert.ok(frozen.every((p) => countValue(p.audio.pcm, 0) === 4800));
  // t=2700 → target 200: se libera [100,200) sin saltos (sin descartes).
  const p = buffer.tick(2700);
  assert.equal(p.frozen, false);
  assert.equal(p.droppedMs, 0);
  assert.equal(p.audio.rangeStart, 100);
  assert.equal(p.audio.rangeEnd, 200);
  assert.equal(countValue(p.audio.pcm, 101), 4800);
  assert.equal(p.frame, 'f100');
});

test('bajar el delay en caliente descarta lo más viejo y retoma desde el nuevo objetivo', () => {
  const { buffer } = makeBuffer({ fallbackMode: 'original' });
  buffer.tick(3000);
  for (let t = 1000; t < 4000; t += 100) {
    buffer.pushAudio({ pcm: tone(100, 100 + t / 100), sampleRate: SR, timestamp: t });
    buffer.pushFrame({ frame: `f${t}`, timestamp: t });
  }
  buffer.tick(3100); // libera [1000,1100)
  buffer.setDelay(2000);
  const p = buffer.tick(3200); // target 1200: sin descarte, rango [1100,1200)
  assert.equal(p.droppedMs, 0);
  assert.equal(p.audio.rangeStart, 1100);
  const q = buffer.tick(3300); // ya en régimen: [1200,1300)
  assert.equal(q.audio.rangeStart, 1200);

  // Bajada grande: de 2000 a... ya en el mínimo; probamos desde 4000.
  const { buffer: b2 } = makeBuffer({ delayMs: 4000, fallbackMode: 'original' });
  b2.tick(5000); // cursor 1000
  for (let t = 1000; t < 4000; t += 100) {
    b2.pushAudio({ pcm: tone(100, 100 + t / 100), sampleRate: SR, timestamp: t });
    b2.pushFrame({ frame: `f${t}`, timestamp: t });
  }
  b2.tick(5100); // [1000,1100)
  b2.setDelay(2000);
  const r = b2.tick(5200); // target 3200 → emite [3100,3200), descarta [1100,3100)
  assert.equal(r.droppedMs, 2000);
  assert.equal(r.audio.rangeStart, 3100);
  assert.equal(countValue(r.audio.pcm, 131), 4800);
  // De los frames descartados sólo sobrevive el más nuevo si no hay otro en el rango.
  assert.deepEqual(r.frames, ['f3100']);
  assert.equal(b2.stats().queuedFrames, 8); // f3200..f3900
  assert.equal(b2.stats().queuedAudioMs, 800);
});

test('doblaje tardío: con lateDubPolicy=play se emite de inmediato; con drop se descarta; lateDubs cuenta', () => {
  for (const policy of ['play', 'drop']) {
    const { buffer } = makeBuffer({ lateDubPolicy: policy });
    const late = [];
    buffer.on('late-dub', (e) => late.push(e));
    buffer.tick(2000);
    buffer.tick(2500); // cursor 500: el turno [100,300) ya se liberó
    const result = buffer.pushDub({
      audioDub: tone(100, 9000), sampleRate: SR, sourceTimestamp: 100, sourceEndedAt: 300, readyAt: 2500,
    });
    assert.equal(late.length, 1);
    assert.equal(late[0].lateByMs, 400);
    assert.equal(buffer.stats().lateDubs, 1);
    const p = buffer.tick(2600);
    if (policy === 'play') {
      assert.equal(result.scheduled, true);
      assert.equal(result.placedStart, 500);
      assert.equal(countValue(p.audio.pcm, 9000), 4800);
    } else {
      assert.equal(result.scheduled, false);
      assert.equal(countValue(p.audio.pcm, 9000), 0);
    }
  }
});

test('deriva controlada: un doblaje más largo que su turno extiende, empuja al siguiente y avisa si supera maxDriftMs', () => {
  const { buffer } = makeBuffer({ maxDriftMs: 250 });
  const exceeded = [];
  buffer.on('drift-exceeded', (e) => exceeded.push(e));
  buffer.tick(2000);
  // Turno 1: [100,300) con doblaje de 500 ms → termina en 600 → drift 300.
  const r1 = buffer.pushDub({ audioDub: tone(500, 1111), sampleRate: SR, sourceTimestamp: 100, sourceEndedAt: 300 });
  assert.equal(r1.placedEnd, 600);
  assert.equal(buffer.stats().driftMs, 300);
  assert.equal(exceeded.length, 1);
  // Turno 2: [400,500) con doblaje de 100 ms → no puede empezar en 400, empieza en 600.
  const r2 = buffer.pushDub({ audioDub: tone(100, 2222), sampleRate: SR, sourceTimestamp: 400, sourceEndedAt: 500 });
  assert.equal(r2.placedStart, 600);
  assert.equal(buffer.stats().driftMs, 200);
  // Reproducción: [500,600) sigue siendo dub1, [600,700) es dub2.
  for (let t = 2100; t <= 2500; t += 100) buffer.tick(t);
  const p6 = buffer.tick(2600);
  assert.equal(countValue(p6.audio.pcm, 1111), 4800);
  const p7 = buffer.tick(2700);
  assert.equal(countValue(p7.audio.pcm, 2222), 4800);
  buffer.tick(2800);
  // Sin doblajes pendientes, la deriva vuelve a 0.
  assert.equal(buffer.stats().dubsPending, 0);
  assert.equal(buffer.stats().driftMs, 0);
});

test('pushDub(null) se ignora y start/stop usan el reloj inyectado', async () => {
  let now = 1000;
  const { buffer, releases } = makeBuffer({ now: () => now });
  assert.equal(buffer.pushDub(null), null);
  buffer.start(5);
  assert.equal(buffer.running, true);
  await new Promise((r) => setTimeout(r, 30));
  now = 1040;
  await new Promise((r) => setTimeout(r, 30));
  buffer.stop();
  assert.equal(buffer.running, false);
  assert.ok(releases.length >= 1);
  assert.equal(releases.reduce((a, p) => a + p.audio.samples, 0), 1920); // 40 ms exactos
});

test('resampler: longitud proporcional y señal constante preservada', () => {
  const input = new Int16Array(160).fill(1234); // 10 ms @16k
  const out = resampleInt16(input, 16000, 48000);
  assert.equal(out.length, 480);
  assert.ok(out.every((v) => v === 1234));
  const down = resampleInt16(out, 48000, 24000);
  assert.equal(down.length, 240);
});

test('original/duck already delivered cannot be followed by a late translation, even after changing fallback', () => {
  for (const mode of ['original', 'duck']) {
    const { buffer } = makeBuffer({ fallbackMode: mode });
    buffer.pushAudio({ pcm: tone(1000, 10000), sampleRate: SR, timestamp: 0 });
    buffer.tick(2000);
    assert.ok(buffer.tick(3000).audio.sources.original > 0);
    buffer.fallbackMode = 'silence';
    const r = buffer.pushDub({ audioDub: tone(1000, 20000), sampleRate: SR, sourceTimestamp: 0, sourceEndedAt: 1000 });
    assert.equal(r.reason, 'original-already-delivered');
    assert.equal(countValue(buffer.tick(4000).audio.pcm, 20000), 0);
  }
});

test('reservation from speech onset suppresses original until late dub is ready; result delivered once', () => {
  const { buffer } = makeBuffer({ fallbackMode: 'original' });
  buffer.reserveTurn({ turnId: 'a', sourceTimestamp: 0 });
  buffer.pushAudio({ pcm: tone(1000, 10000), sampleRate: SR, timestamp: 0 });
  buffer.tick(2000);
  assert.equal(countValue(buffer.tick(3000).audio.pcm, 10000), 0);
  buffer.reserveTurn({ turnId: 'a', sourceTimestamp: 0, sourceEndedAt: 1000 });
  const dub = { turnId: 'a', audioDub: tone(1000, 20000), sampleRate: SR, sourceTimestamp: 0, sourceEndedAt: 1000 };
  assert.equal(buffer.pushDub(dub).scheduled, true);
  assert.equal(countValue(buffer.tick(4000).audio.pcm, 20000), 48000);
  assert.equal(buffer.pushDub(dub).reason, 'already-decided');
  assert.equal(countValue(buffer.tick(5000).audio.pcm, 20000), 0);
});

test('reservations expire and reject results; oversized dub is rejected before queuing', () => {
  const { buffer } = makeBuffer({ maxPendingMs: 1000, maxDubQueueMs: 100 });
  const expired = [];
  buffer.on('turn-expired', (data) => expired.push(data));
  buffer.reserveTurn({ turnId: 'a', sourceTimestamp: 0 });
  buffer.tick(2000);
  assert.equal(expired.length, 1);
  assert.equal(buffer.canDub('a'), false);
  assert.equal(buffer.pushDub({ turnId: 'a', audioDub: tone(10, 2), sampleRate: SR, sourceTimestamp: 0 }).reason, 'already-decided');
  assert.equal(buffer.pushDub({ audioDub: tone(101, 2), sampleRate: SR, sourceTimestamp: 0 }).reason, 'dub-queue-full');
});

test('silence fallback does not retain or upsample original; provenance counts include actual silence', () => {
  const { buffer } = makeBuffer();
  assert.equal(buffer.pushAudio({ pcm: tone(1000, 1000, 16000), sampleRate: 16000, timestamp: 0 }), false);
  assert.equal(buffer.stats().queuedAudioMs, 0);
  buffer.tick(2000);
  assert.deepEqual(buffer.tick(2020).audio.sources, { silence: 960, original: 0, dub: 0 });
});

test('scheduler refuses a large stall before allocating or replaying old PCM', () => {
  const buffer = new SyncBuffer();
  buffer.tick(0);
  assert.throws(() => buffer.tick(30000), { code: 'audio_output_overload' });
});

test('utterance fades are continuous across ticks and presentation maps to source progress', () => {
  const { buffer } = makeBuffer({ fadeMs: 3 });
  buffer.tick(2000);
  buffer.pushDub({ turnId: 'fade', audioDub: tone(40, 10000), sampleRate: SR, sourceTimestamp: 0, sourceEndedAt: 20 });
  const chunks = [2010, 2020, 2030, 2040].map((t) => buffer.tick(t));
  const samples = int16(Buffer.concat(chunks.map((p) => p.audio.pcm)));
  assert.equal(samples[0], 0);
  assert.equal(samples.at(-1), 0);
  assert.equal(samples[144], 10000);
  assert.equal(samples[480], 10000); // no restart at tick boundary
  assert.equal(chunks[1].presentation.sourceTimestamp, 5);
  assert.equal(chunks[1].presentation.sourceRate, 0.5);
  assert.ok(chunks[3].presentation); // final block retains its presentation after purge
});

test('band-limited resampling suppresses aliasing and preserves voice-band amplitude', () => {
  const sine = (rate, hz) => Int16Array.from({ length: rate }, (_, i) => Math.round(10000 * Math.sin(2 * Math.PI * hz * i / rate)));
  const rms = (s) => Math.sqrt(s.subarray(100, s.length - 100).reduce((n, v) => n + v * v, 0) / (s.length - 200));
  const aliased = resampleInt16(sine(48000, 20000), 48000, 24000);
  assert.ok(rms(aliased) < 70, `alias RMS ${rms(aliased)}`);
  const voice = resampleInt16(sine(24000, 8000), 24000, 48000);
  assert.ok(rms(voice) > 6900 && rms(voice) < 7200, `voice RMS ${rms(voice)}`);
});
