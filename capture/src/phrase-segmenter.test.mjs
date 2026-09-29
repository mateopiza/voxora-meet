import test from "node:test";
import assert from "node:assert/strict";
import { PhraseSegmenter, rmsToDb } from "./phrase-segmenter.mjs";
import { tone, silence, noise, feed, durationMs } from "./test-signals.mjs";

function collect(segmenter) {
  const turns = [];
  const levels = [];
  segmenter.on("turn", (turn) => turns.push(turn));
  segmenter.on("level", (level) => levels.push(level));
  return { turns, levels };
}

function near(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected} ±${tolerance}`);
}

test("silencio + tono + silencio produce un turno con duración y tiempos correctos", () => {
  const segmenter = new PhraseSegmenter();
  const { turns, levels } = collect(segmenter);
  const signal = Buffer.concat([silence(1000), tone(2000), silence(2000)]);
  feed(segmenter, signal);

  assert.equal(turns.length, 1);
  const [turn] = turns;
  assert.equal(turn.sampleRate, 16000);
  assert.equal(turn.reason, "silence");
  assert.ok(Buffer.isBuffer(turn.pcm));
  // voz ≈ 2000 ms
  near(turn.voicedMs, 2000, 100, "voicedMs");
  // pre-roll 200 ms + attack 120 ms ⇒ arranca ≈ 800 ms
  near(turn.startedAt, 800, 60, "startedAt");
  // cola de silencio conservada 200 ms ⇒ termina ≈ 3200 ms
  near(turn.endedAt, 3200, 60, "endedAt");
  near(durationMs(turn.pcm), turn.endedAt - turn.startedAt, 1, "pcm coincide con [startedAt, endedAt]");
  // El PCM empieza con pre-roll de silencio y contiene el tono (RMS global alto).
  assert.ok(turn.rmsDb > -20, `rmsDb ${turn.rmsDb}`);
  assert.equal(turn.pcm.readInt16LE(0), 0);
  // level ~20 Hz: 5 s ⇒ ~100 eventos, con speaking true durante el tono.
  near(levels.length, 100, 5, "eventos level");
  assert.ok(levels.some((level) => level.speaking));
  assert.ok(levels.some((level) => !level.speaking));
});

test("dos frases separadas por 900 ms de silencio producen dos turnos", () => {
  const segmenter = new PhraseSegmenter();
  const { turns } = collect(segmenter);
  const signal = Buffer.concat([silence(1000), tone(1500), silence(900), tone(1500, 0.3, 300), silence(1000)]);
  feed(segmenter, signal);

  assert.equal(turns.length, 2);
  near(turns[0].voicedMs, 1500, 100, "voz turno 1");
  near(turns[1].voicedMs, 1500, 100, "voz turno 2");
  assert.ok(turns[0].endedAt <= turns[1].startedAt, "los turnos no se solapan");
  near(turns[1].startedAt, 1000 + 1500 + 900 - 200, 60, "inicio turno 2 con pre-roll de 200 ms");
});

test("una pausa de 400 ms no divide la frase", () => {
  const segmenter = new PhraseSegmenter();
  const { turns } = collect(segmenter);
  feed(segmenter, Buffer.concat([silence(1000), tone(1000), silence(400), tone(1000), silence(1000)]));
  assert.equal(turns.length, 1);
  near(turns[0].voicedMs, 2000, 100, "voz total");
});

test("ruido constante bajo no genera turnos y se aprende como piso", () => {
  const segmenter = new PhraseSegmenter();
  const { turns } = collect(segmenter);
  feed(segmenter, noise(8000, 0.02));
  segmenter.flush();
  assert.equal(turns.length, 0);
  const decision = segmenter.decision;
  assert.ok(decision.noiseFloorDb > -50 && decision.noiseFloorDb < -30, `piso ${decision.noiseFloorDb}`);
  assert.ok(decision.openThresholdDb > decision.signalDb);
});

test("un pico de 40 ms sobre el ruido se descarta (attack y minTurnMs)", () => {
  const segmenter = new PhraseSegmenter();
  const { turns } = collect(segmenter);
  feed(segmenter, Buffer.concat([noise(1500, 0.01), tone(40, 0.5), noise(1500, 0.01)]));
  segmenter.flush();
  assert.equal(turns.length, 0);
});

test("un tono de 150 ms abre la compuerta pero se descarta por minTurnMs", () => {
  const segmenter = new PhraseSegmenter();
  const { turns } = collect(segmenter);
  feed(segmenter, Buffer.concat([silence(1000), tone(150, 0.5), silence(1500)]));
  assert.equal(turns.length, 0);
});

test("voz sobre ruido de fondo se detecta gracias al piso adaptativo", () => {
  const segmenter = new PhraseSegmenter();
  const { turns } = collect(segmenter);
  const background = noise(6000, 0.01, 16000, 777);
  const speech = tone(1200, 0.3);
  // Mezcla: ruido continuo + tono entre 3.0 y 4.2 s.
  const mixed = Buffer.from(background);
  const startByte = 3000 * 32;
  for (let i = 0; i < speech.length; i += 2) {
    const mix = mixed.readInt16LE(startByte + i) + speech.readInt16LE(i);
    mixed.writeInt16LE(Math.max(-32768, Math.min(32767, mix)), startByte + i);
  }
  feed(segmenter, mixed);
  assert.equal(turns.length, 1);
  near(turns[0].voicedMs, 1200, 100, "voz");
});

test("maxTurnMs fuerza el corte de una frase continua (corte duro)", () => {
  const segmenter = new PhraseSegmenter({ maxTurnMs: 5000, softCutWindowMs: 0 });
  const { turns } = collect(segmenter);
  feed(segmenter, Buffer.concat([silence(500), tone(12000), silence(1000)]));

  assert.ok(turns.length >= 3, `turnos ${turns.length}`);
  for (const turn of turns) {
    assert.ok(turn.endedAt - turn.startedAt <= 5000 + 20, `turno de ${turn.endedAt - turn.startedAt} ms`);
  }
  const hard = turns.filter((turn) => turn.reason === "max-length");
  assert.ok(hard.length >= 2);
  // Continuidad: cada turno arranca donde terminó el anterior (sin huecos ni solapes).
  for (let i = 1; i < turns.length; i += 1) {
    near(turns[i].startedAt, turns[i - 1].endedAt, 20, `continuidad turno ${i}`);
  }
  const totalVoiced = turns.reduce((sum, turn) => sum + turn.voicedMs, 0);
  near(totalVoiced, 12000, 200, "voz total repartida");
});

test("cerca de maxTurnMs se corta en una pausa débil antes que en seco", () => {
  const segmenter = new PhraseSegmenter({ maxTurnMs: 6000, softCutWindowMs: 3000, softCutSilenceMs: 250 });
  const { turns } = collect(segmenter);
  // 4 s de voz, pausa de 400 ms (no llega a endSilenceMs), 2 s más de voz.
  feed(segmenter, Buffer.concat([silence(500), tone(4000), silence(400), tone(2000), silence(1000)]));

  assert.equal(turns.length, 2);
  assert.equal(turns[0].reason, "pause");
  near(turns[0].voicedMs, 4000, 100, "voz turno 1");
  assert.equal(turns[1].reason, "silence");
  near(turns[1].voicedMs, 2000, 100, "voz turno 2");
});

test("flush() cierra el turno en curso", () => {
  const segmenter = new PhraseSegmenter();
  const { turns } = collect(segmenter);
  feed(segmenter, Buffer.concat([silence(500), tone(1000)]));
  assert.equal(turns.length, 0);
  assert.equal(segmenter.active, true);
  segmenter.flush();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].reason, "flush");
  near(turns[0].voicedMs, 1000, 60, "voz");
  assert.equal(segmenter.active, false);
});

test("el reloj se ancla a nowMs y se re-ancla tras un hueco de la fuente", () => {
  const segmenter = new PhraseSegmenter();
  const { turns } = collect(segmenter);
  // Arranca en t=10000 ms.
  let now = feed(segmenter, Buffer.concat([silence(500), tone(1000), silence(1000)]), { startMs: 10000 });
  assert.equal(turns.length, 1);
  near(turns[0].startedAt, 10000 + 500 - 200, 40, "startedAt anclado");
  // La fuente se queda muda 2 s (hueco) y luego sigue: el reloj debe adelantarse.
  now += 2000;
  feed(segmenter, Buffer.concat([silence(500), tone(1000), silence(1000)]), { startMs: now });
  assert.equal(turns.length, 2);
  near(turns[1].startedAt, now + 500 - 200, 40, "startedAt tras re-anclaje");
});

test("acepta chunks de tamaño arbitrario (incluidos bytes impares)", () => {
  const segmenter = new PhraseSegmenter();
  const { turns } = collect(segmenter);
  const signal = Buffer.concat([silence(600), tone(800), silence(1000)]);
  const sizes = [1, 3, 7, 640, 1001, 5000];
  let offset = 0;
  let index = 0;
  while (offset < signal.length) {
    const size = sizes[index % sizes.length];
    index += 1;
    segmenter.push(signal.subarray(offset, Math.min(offset + size, signal.length)));
    offset += size;
  }
  assert.equal(turns.length, 1);
  near(turns[0].voicedMs, 800, 60, "voz");
});

test("acepta Int16Array como entrada", () => {
  const segmenter = new PhraseSegmenter();
  const { turns } = collect(segmenter);
  const signal = Buffer.concat([silence(600), tone(800), silence(1000)]);
  segmenter.push(new Int16Array(signal.buffer, signal.byteOffset, signal.length / 2));
  assert.equal(turns.length, 1);
});

test("valida las opciones", () => {
  assert.throws(() => new PhraseSegmenter({ endSilenceMs: 0 }), RangeError);
  assert.throws(() => new PhraseSegmenter({ maxTurnMs: 100, minTurnMs: 250 }), RangeError);
  assert.throws(() => new PhraseSegmenter({ noisePercentile: 2 }), RangeError);
  assert.throws(() => new PhraseSegmenter({ sampleRate: 22050, frameMs: 1 }), RangeError);
});

test("rmsToDb acota valores no válidos", () => {
  assert.equal(rmsToDb(0), -96);
  assert.equal(rmsToDb(NaN), -96);
  near(rmsToDb(1), 0, 1e-9, "0 dBFS");
  near(rmsToDb(0.1), -20, 1e-9, "-20 dB");
});

test('setLimits cambia maxTurnMs en caliente y valida', async () => {
  const { PhraseSegmenter } = await import('./phrase-segmenter.mjs');
  const seg = new PhraseSegmenter();
  assert.equal(seg.setLimits({ maxTurnMs: 2400, softCutWindowMs: 2400 }).maxTurnMs, 2400);
  assert.equal(seg.options.maxTurnMs, 2400);
  assert.throws(() => seg.setLimits({ maxTurnMs: 10 }), RangeError);
  assert.equal(seg.options.maxTurnMs, 2400);
});
