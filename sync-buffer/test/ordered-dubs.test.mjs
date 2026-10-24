import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncBuffer } from '../src/sync-buffer.mjs';

const dub = (id, start, ms, value) => {
  const pcm = Buffer.alloc(ms * 2);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(value, i);
  return { turnId: id, sourceTimestamp: start, sourceEndedAt: start + ms, sampleRate: 1000, audioDub: pcm };
};
test('concurrent TTS results arriving in reverse order play by source timestamp', () => {
  const buffer = new SyncBuffer({ delayMs: 2000, outputSampleRate: 1000, maxDeferralMs: 500, fadeMs: 0 });
  buffer.pushDub(dub('second', 400, 200, 2000));
  buffer.pushDub(dub('first', 100, 400, 1000));
  buffer.tick(2000);
  let first = 0, second = 0;
  for (let now = 2020; now <= 2700; now += 20) {
    const data = buffer.tick(now).audio.pcm;
    for (let i = 0; i < data.length; i += 2) {
      const sample = data.readInt16LE(i);
      if (sample === 1000) { assert.equal(second, 0, 'first voice cannot play after second voice'); first++; }
      if (sample === 2000) { assert.equal(first, 400); second++; }
    }
  }
  assert.equal(first, 400); assert.equal(second, 200);
});
test('a result that would defer a neighbor beyond the limit is rejected atomically', () => {
  const buffer = new SyncBuffer({ delayMs: 2000, outputSampleRate: 1000, maxDeferralMs: 100 });
  buffer.pushDub(dub('second', 400, 200, 2000));
  assert.equal(buffer.pushDub(dub('first', 100, 600, 1000)).reason, 'deferral-limit');
  assert.equal(buffer.presentationAt(400).turnId, 'second');
  assert.equal(buffer.presentationAt(400).sourceTimestamp, 400);
});
test('an already started clip remains intact and an older result cannot invert speech order', () => {
  const buffer = new SyncBuffer({ delayMs: 2000, outputSampleRate: 1000, maxDeferralMs: 1000, fadeMs: 0 });
  buffer.pushDub(dub('second', 400, 200, 2000));
  buffer.tick(2000); buffer.tick(2450);
  const placed = buffer.pushDub(dub('first', 100, 100, 1000));
  assert.equal(placed.reason, 'out-of-order');
  assert.equal(buffer.presentationAt(450).turnId, 'second');
});
