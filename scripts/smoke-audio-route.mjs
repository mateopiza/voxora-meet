// Native cable loopback using synthetic tones only. Never opens a physical mic.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { VirtualMic, listRenderEndpoints } from '../windows-driver/src/virtual-mic.mjs';
import { MicCapture, DEFAULT_HELPER_PATH } from '../capture/src/mic-capture.mjs';
import { PcmWriter } from '../app/engine/pcm-writer.mjs';

const [inputs, outputs] = await Promise.all([MicCapture.listDevices(), listRenderEndpoints()]);
const pairs = [['VOXORA Meet Speaker', 'VOXORA Meet Microphone'], ['CABLE Input', 'CABLE Output']];
const pair = pairs.map(([render, capture]) => ({
  output: outputs.find((e) => e.name.includes(render)), input: inputs.find((e) => e.name.includes(capture)),
})).find((p) => p.input && p.output);
if (!pair) throw new Error('No hay cable virtual instalado para la prueba; no se usará un micrófono físico.');
const captured = [];
let capturedBytes = 0;
const capture = spawn(DEFAULT_HELPER_PATH, ['--device', pair.input.id, '--rate', '48000'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let captureError;
let captureLog = '';
let captureExit = null;
capture.on('error', (e) => { captureError = e; });
capture.stderr.on('data', (chunk) => { captureLog = (captureLog + String(chunk)).slice(-2000); });
capture.on('exit', (code) => { captureExit = code; });
capture.stdout.on('data', (chunk) => {
  capturedBytes += chunk.length;
  if (capturedBytes <= 48000 * 2 * 10) captured.push(chunk);
});
const sink = new VirtualMic({ deviceId: pair.output.id });
let outputError;
const writer = new PcmWriter(sink, { onError: (e) => { outputError = e; } });
try {
  await sink.open();
  const deadline = performance.now() + 5000;
  while (!capturedBytes && !captureError && captureExit === null && performance.now() < deadline) await sleep(20);
  if (!capturedBytes) throw new Error(`La captura virtual no entregó PCM: ${captureError?.message ?? captureLog}`);
  const started = performance.now();
  // 600 ms silence, three distinct 200 ms tones separated by 300 ms, trailing silence.
  const timeline = [{ start: 600, hz: 440 }, { start: 1100, hz: 660 }, { start: 1600, hz: 880 }];
  for (let ms = 0; ms < 2400; ms += 20) {
    const b = Buffer.alloc(1920);
    const tone = timeline.find((t) => ms >= t.start && ms < t.start + 200);
    if (tone) for (let i = 0; i < 960; i++) b.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * tone.hz * ((ms - tone.start) * 48 + i) / 48000)), i * 2);
    writer.enqueue(b);
    await sleep(Math.max(0, started + ms + 20 - performance.now()));
    if (outputError || captureError) throw outputError || captureError;
  }
  await sleep(400);
} finally {
  writer.stop();
  await sink.close({ discard: true });
  writer.dispose();
  capture.kill();
}
const audio = Buffer.concat(captured);
const segments = [];
let segment = null;
for (let offset = 0; offset + 1920 <= audio.length; offset += 1920) {
  let sum = 0, crossings = 0;
  for (let i = 0; i < 960; i++) {
    const v = audio.readInt16LE(offset + i * 2);
    sum += v * v;
    if (i && v >= 0 && audio.readInt16LE(offset + (i - 1) * 2) < 0) crossings++;
  }
  if (Math.sqrt(sum / 960) > 1000) {
    segment ??= { startMs: offset / 96, durationMs: 0, crossings: 0 };
    segment.durationMs += 20;
    segment.crossings += crossings;
  } else if (segment) { segments.push(segment); segment = null; }
}
if (segment) segments.push(segment);
for (const s of segments) {
  // Estimate the dominant tone inside the burst; zero crossings are sensitive to
  // WASAPI dithering and low-level noise around zero.
  const start = Math.round((s.startMs + 40) * 48);
  const count = Math.min(4800, Math.floor(audio.length / 2) - start);
  let bestPower = -1, bestHz = 0;
  for (let hz = 300; hz <= 1400; hz += 10) {
    let re = 0, im = 0;
    for (let i = 0; i < count; i++) {
      const value = audio.readInt16LE((start + i) * 2);
      const phase = 2 * Math.PI * hz * i / 48000;
      re += value * Math.cos(phase);
      im += value * Math.sin(phase);
    }
    const power = re * re + im * im;
    if (power > bestPower) { bestPower = power; bestHz = hz; }
  }
  s.frequencyHz = bestHz;
  delete s.crossings;
}
const expectedHz = [440, 660, 880];
const ok = segments.length === 3 && segments.every((s, i) => s.durationMs >= 160 && s.durationMs <= 240 && Math.abs(s.frequencyHz - expectedHz[i]) < 100);
console.log(JSON.stringify({ synthetic: true, output: pair.output.name, input: pair.input.name, ok, capturedBytes, segments, deviceAudio: sink.telemetry }, null, 2));
if (!ok) process.exitCode = 1;
