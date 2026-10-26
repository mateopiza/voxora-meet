import test from 'node:test';
import assert from 'node:assert/strict';
import { PhraseSegmenter } from './phrase-segmenter.mjs';

function pcm(ms, amplitude = 0) {
  const result = Buffer.alloc(ms * 32);
  for (let i = 0; i < result.length; i += 2) result.writeInt16LE(amplitude, i);
  return result;
}

test('fixed windows continue through silence and continuous speech without duplicate PCM', () => {
  const segmenter = new PhraseSegmenter({ fixedWindowMs: 1000 });
  const windows = [], turns = [];
  segmenter.on('window', (event) => windows.push(event));
  segmenter.on('turn', (event) => turns.push(event));
  segmenter.push(Buffer.concat([pcm(1000), pcm(3000, 12000)]), 4000);
  assert.deepEqual(windows.map((w) => [w.startedAt, w.endedAt]), [[0, 1000], [1000, 2000], [2000, 3000], [3000, 4000]]);
  assert.deepEqual(turns.map((t) => [t.startedAt, t.endedAt]), [[1000, 2000], [2000, 3000], [3000, 4000]]);
  assert.equal(Buffer.concat(turns.map((t) => t.pcm)).length, pcm(3000).length);
});

test('speech onset inside a window preserves its timestamp and closes at the window deadline', () => {
  const segmenter = new PhraseSegmenter({ fixedWindowMs: 1000 });
  const starts = [], turns = [];
  segmenter.on('turn-start', (event) => starts.push(event));
  segmenter.on('turn', (event) => turns.push(event));
  segmenter.push(Buffer.concat([pcm(400), pcm(400, 12000), pcm(200)]), 11000);
  assert.equal(starts[0].startedAt, 10400);
  assert.equal(turns[0].startedAt, 10400);
  assert.equal(turns[0].endedAt, 10800);
  assert.equal(turns[0].capturedUntil, 11000);
});

test('window recalibration takes effect at the next boundary, not in the active window', () => {
  const segmenter = new PhraseSegmenter({ fixedWindowMs: 1000 });
  const windows = [];
  segmenter.on('window', (event) => windows.push(event));
  segmenter.push(pcm(500, 12000), 500);
  segmenter.setLimits({ fixedWindowMs: 600 });
  segmenter.push(pcm(1100, 12000), 1600);
  assert.deepEqual(windows.map((w) => [w.startedAt, w.endedAt]), [[0, 1000], [1000, 1600]]);
});

test('short noise is discarded; flush emits the remaining window only once', () => {
  const segmenter = new PhraseSegmenter({ fixedWindowMs: 1000 });
  const turns = [], discarded = [];
  segmenter.on('turn', (event) => turns.push(event));
  segmenter.on('turn-discarded', (event) => discarded.push(event));
  segmenter.push(Buffer.concat([pcm(100, 12000), pcm(900), pcm(400, 12000)]), 1400);
  segmenter.flush(); segmenter.flush();
  assert.equal(discarded.length, 1);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].startedAt, 1000);
  assert.equal(turns[0].reason, 'flush');
});

test('capture gap closes old PCM before reanchoring the next window', () => {
  const segmenter = new PhraseSegmenter({ fixedWindowMs: 1000 });
  const turns = [];
  segmenter.on('turn', (event) => turns.push(event));
  segmenter.push(pcm(400, 12000), 400);
  segmenter.push(pcm(1000, 12000), 3000);
  assert.deepEqual(turns.map((t) => [t.startedAt, t.capturedUntil, t.reason]), [[0, 400, 'gap'], [2000, 3000, 'window']]);
});
