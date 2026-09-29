import { test } from "node:test";
import assert from "node:assert/strict";
import { pcmToWav, readWavInfo, wavToPcm, pcmDurationMs } from "./wav.mjs";
import { makePcm } from "../_test-helpers.mjs";

test("pcmDurationMs calcula la duración según rate, canales y bits", () => {
  assert.equal(pcmDurationMs(32_000, { sampleRate: 16_000 }), 1000);
  assert.equal(pcmDurationMs(32_000, { sampleRate: 16_000, channels: 2 }), 500);
  assert.equal(pcmDurationMs(48_000 * 2, { sampleRate: 48_000 }), 1000);
  assert.equal(pcmDurationMs(100, { sampleRate: 0 }), 0);
  assert.equal(pcmDurationMs(100, {}), 0);
});

test("pcmToWav escribe una cabecera RIFF/WAVE válida de 44 bytes", () => {
  const pcm = makePcm(500);
  const wav = pcmToWav(pcm, { sampleRate: 16_000 });
  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length);
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.toString("ascii", 12, 16), "fmt ");
  assert.equal(wav.readUInt16LE(20), 1, "PCM lineal");
  assert.equal(wav.readUInt16LE(22), 1, "mono");
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt32LE(28), 32_000, "byte rate");
  assert.equal(wav.readUInt16LE(32), 2, "block align");
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.ok(wav.subarray(44).equals(pcm));
});

test("pcmToWav acepta Uint8Array y valida parámetros", () => {
  const u8 = new Uint8Array([1, 2, 3, 4]);
  const wav = pcmToWav(u8, { sampleRate: 8000 });
  assert.equal(wav.length, 48);
  assert.throws(() => pcmToWav(u8, { sampleRate: 0 }), /sampleRate/);
  assert.throws(() => pcmToWav(u8, { sampleRate: 8000, bitsPerSample: 12 }), /bitsPerSample/);
  assert.throws(() => pcmToWav(u8, { sampleRate: 8000, channels: 0 }), /channels/);
});

test("readWavInfo hace ida y vuelta con pcmToWav y reporta duración", () => {
  const pcm = makePcm(1500, 44_100);
  const wav = pcmToWav(pcm, { sampleRate: 44_100 });
  const info = readWavInfo(wav);
  assert.equal(info.format, 1);
  assert.equal(info.channels, 1);
  assert.equal(info.sampleRate, 44_100);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.dataOffset, 44);
  assert.equal(info.dataBytes, pcm.length);
  assert.ok(Math.abs(info.durationMs - 1500) < 1);
  const back = wavToPcm(wav);
  assert.ok(back.pcm.equals(pcm));
});

test("readWavInfo salta chunks intermedios (LIST/JUNK) antes de data", () => {
  const pcm = makePcm(100);
  const wav = pcmToWav(pcm, { sampleRate: 16_000 });
  // Inserta un chunk LIST de 7 bytes (impar → padding a 8) entre fmt y data.
  const list = Buffer.alloc(8 + 8);
  list.write("LIST", 0, "ascii");
  list.writeUInt32LE(7, 4);
  const patched = Buffer.concat([wav.subarray(0, 36), list, wav.subarray(36)]);
  const info = readWavInfo(patched);
  assert.equal(info.dataBytes, pcm.length);
  assert.equal(info.dataOffset, 36 + 16 + 8);
});

test("readWavInfo rechaza buffers que no son WAV", () => {
  assert.throws(() => readWavInfo(Buffer.from("no es wav")), /RIFF/);
  const noData = pcmToWav(Buffer.alloc(0), { sampleRate: 16_000 }).subarray(0, 36);
  assert.throws(() => readWavInfo(noData), /falta chunk data/);
});
