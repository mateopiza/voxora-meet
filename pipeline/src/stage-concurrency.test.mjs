import test from 'node:test';
import assert from 'node:assert/strict';
import { StageQueue } from './dubbing-pipeline.mjs';

test('two TTS lanes execute concurrently, bound concurrency and drain after a failure', async () => {
  const queue = new StageQueue(2);
  const releases = [];
  let active = 0, maximum = 0;
  const jobs = Array.from({ length: 4 }, (_, index) => queue.run(async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise((resolve) => releases[index] = resolve);
    active--;
    if (index === 0) throw new Error('failed synthesis');
    return index;
  }));
  const results = Promise.allSettled(jobs);
  await new Promise(setImmediate);
  assert.equal(active, 2); assert.equal(releases[2], undefined);
  releases[0](); releases[1]();
  await new Promise(setImmediate);
  assert.equal(active, 2); releases[2](); releases[3]();
  assert.deepEqual((await results).map((item) => item.status), ['rejected', 'fulfilled', 'fulfilled', 'fulfilled']);
  await queue.idle(); assert.equal(queue.pending, 0); assert.equal(maximum, 2);
});
