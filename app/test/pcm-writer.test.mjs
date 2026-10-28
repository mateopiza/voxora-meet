import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PcmWriter } from '../engine/pcm-writer.mjs';
const tick = () => new Promise(setImmediate);
const pcm = () => Buffer.alloc(1920); // 20 ms

test('slow sink: exactly one write in flight, order preserved and bounded queue', async () => {
  const pending = [], written = [];
  const w = new PcmWriter({ write: (b) => { written.push(b[0]); return new Promise((r) => pending.push(r)); } });
  for (let i = 1; i <= 3; i++) { const b = pcm(); b[0] = i; w.enqueue(b); }
  await tick();
  assert.deepEqual(written, [1]);
  assert.equal(w.stats().queuedMs, 60);
  pending.shift()(); await tick();
  assert.deepEqual(written, [1, 2]);
  pending.shift()(); await tick(); pending.shift()(); await tick();
  assert.deepEqual(written, [1, 2, 3]);
  assert.equal(w.stats().queuedMs, 0);
  w.dispose();
});

test('a full queue drops the oldest unsent audio and keeps the destination open', async () => {
  let release;
  const errors = [], overruns = [], written = [];
  const w = new PcmWriter({ write: (b) => { written.push(b); return new Promise((r) => { release = r; }); } }, {
    maxQueuedMs: 40, onError: (e) => errors.push(e), onOverrun: (info) => overruns.push(info),
  });
  const first = pcm(); first[0] = 1;
  const stale = pcm(); stale[0] = 2;
  const kept = pcm(); kept[0] = 3;
  const live = pcm(); live[0] = 4;
  w.enqueue(first); await tick();
  w.enqueue(stale);
  w.enqueue(kept);
  assert.equal(w.enqueue(live), true);
  assert.equal(errors.length, 0);
  assert.equal(overruns.length, 1);
  assert.ok(overruns[0].droppedMs >= 20);
  assert.equal(w.stats().closed, false);
  release(); await tick();
  release(); await tick();
  release(); await tick();
  assert.deepEqual(written.map((chunk) => chunk[0]), [1, 3, 4]);
  assert.equal(w.stats().queuedMs, 0);
  w.dispose();
});

test('a one-second burst is sliced and written without stopping the dub', async () => {
  const written = [];
  const errors = [];
  const w = new PcmWriter({
    write(chunk) { written.push(chunk.length); return Promise.resolve(); },
  }, { maxWriteMs: 20, onError: (e) => errors.push(e) });
  const burst = Buffer.alloc(96 * 1000);
  assert.equal(w.enqueue(burst), true);
  await tick();
  assert.equal(errors.length, 0);
  assert.equal(w.stats().closed, false);
  assert.equal(written.reduce((sum, n) => sum + n, 0), burst.length);
  assert.ok(written.every((n) => n <= 1920));
  w.dispose();
});

test('async rejection and endpoint error are handled once', async () => {
  const errors = [];
  const sink = Object.assign(new EventEmitter(), { write: () => Promise.reject(new Error('broken')) });
  const w = new PcmWriter(sink, { onError: (e) => errors.push(e) });
  w.enqueue(pcm()); await tick();
  sink.emit('error', new Error('closed'));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'broken');
  w.dispose();
  assert.equal(sink.listenerCount('error'), 0);
});

test('blocked monitor does not delay the main output', async () => {
  let release;
  let mainWrites = 0;
  const monitor = new PcmWriter({ write: () => new Promise((r) => { release = r; }) });
  const main = new PcmWriter({ async write() { mainWrites++; } });
  for (let i = 0; i < 4; i++) { monitor.enqueue(pcm()); main.enqueue(pcm()); await tick(); }
  assert.equal(mainWrites, 4);
  assert.equal(monitor.stats().queuedMs, 80);
  monitor.stop(); release(); await tick(); monitor.dispose(); main.dispose();
});

test('stalled sink times out without an unhandled rejection', async () => {
  const errors = [];
  const w = new PcmWriter({ write: () => new Promise(() => {}) }, { writeTimeoutMs: 10, onError: (e) => errors.push(e) });
  w.enqueue(pcm());
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(errors[0].code, 'audio_output_timeout');
  w.dispose();
});
