import test from "node:test";
import assert from "node:assert/strict";
import { Resampler, resamplePcm16 } from "./resample.mjs";
import { tone } from "./test-signals.mjs";

/** Estima la frecuencia dominante contando cruces por cero ascendentes. */
function estimateFrequency(buffer, rate) {
  const n = buffer.length / 2;
  let crossings = 0;
  let prev = buffer.readInt16LE(0);
  for (let i = 1; i < n; i += 1) {
    const cur = buffer.readInt16LE(i * 2);
    if (prev < 0 && cur >= 0) crossings += 1;
    prev = cur;
  }
  return crossings / (n / rate);
}

function rms(buffer) {
  const n = buffer.length / 2;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const s = buffer.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

test("16 kHz → 48 kHz triplica las muestras y conserva frecuencia y amplitud", () => {
  const input = tone(1000, 0.5, 440, 16000);
  const output = resamplePcm16(input, 16000, 48000);
  assert.equal(output.length, input.length * 3);
  const freq = estimateFrequency(output, 48000);
  assert.ok(Math.abs(freq - 440) < 3, `frecuencia ${freq}`);
  assert.ok(Math.abs(rms(output) - rms(input)) < 0.01, `rms ${rms(output)} vs ${rms(input)}`);
});

test("16 kHz → 24 kHz (ratio no entero) produce la longitud esperada", () => {
  const input = tone(1000, 0.5, 440, 16000);
  const output = resamplePcm16(input, 16000, 24000);
  assert.equal(output.length / 2, 24000);
  const freq = estimateFrequency(output, 24000);
  assert.ok(Math.abs(freq - 440) < 3, `frecuencia ${freq}`);
});

test("48 kHz → 16 kHz reduce a un tercio y conserva un tono en banda", () => {
  const input = tone(1000, 0.5, 1000, 48000);
  const output = resamplePcm16(input, 48000, 16000);
  assert.equal(output.length / 2, 16000);
  const freq = estimateFrequency(output, 16000);
  assert.ok(Math.abs(freq - 1000) < 5, `frecuencia ${freq}`);
  assert.ok(Math.abs(rms(output) - rms(input)) < 0.02, `rms ${rms(output)} vs ${rms(input)}`);
});

test("48 kHz → 16 kHz atenúa fuertemente un tono por encima de Nyquist (antialias)", () => {
  const input = tone(1000, 0.5, 12000, 48000);
  const output = resamplePcm16(input, 48000, 16000);
  const ratio = rms(output) / rms(input);
  assert.ok(ratio < 0.05, `atenuación insuficiente: ${ratio}`);
});

test("el procesamiento por chunks es idéntico al de una sola pasada", () => {
  const input = tone(700, 0.4, 700, 48000);
  const whole = resamplePcm16(input, 48000, 16000);
  const streaming = new Resampler(48000, 16000);
  const parts = [];
  const sizes = [2, 10, 94, 1000, 3, 4096, 777];
  let offset = 0;
  let index = 0;
  while (offset < input.length) {
    const size = sizes[index % sizes.length] * 2;
    index += 1;
    parts.push(streaming.process(input.subarray(offset, Math.min(offset + size, input.length))));
    offset += size;
  }
  parts.push(streaming.flush());
  assert.deepEqual(Buffer.concat(parts), whole);
});

test("misma tasa devuelve una copia idéntica", () => {
  const input = tone(100, 0.3, 440, 16000);
  const output = resamplePcm16(input, 16000, 16000);
  assert.deepEqual(output, input);
  assert.notEqual(output.buffer, input.buffer);
});

test("acepta Int16Array y entradas vacías", () => {
  const input = tone(100, 0.3, 440, 16000);
  const asInt16 = new Int16Array(input.buffer, input.byteOffset, input.length / 2);
  assert.deepEqual(resamplePcm16(asInt16, 16000, 48000), resamplePcm16(input, 16000, 48000));
  assert.equal(resamplePcm16(Buffer.alloc(0), 16000, 48000).length, 0);
});

test("valida las tasas", () => {
  assert.throws(() => new Resampler(0, 16000), RangeError);
  assert.throws(() => new Resampler(16000, -1), RangeError);
  assert.throws(() => new Resampler(48000, 16000, { taps: 10 }), RangeError);
});
