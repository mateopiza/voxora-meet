// Deterministic scheduler benchmark; no microphone, provider or meeting audio.
// node --expose-gc scripts/bench-audio.mjs [--compare-head]
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { SyncBuffer } from '../sync-buffer/src/sync-buffer.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const simulatedMs = 45 * 60 * 1000;
const original = Buffer.from(new Int16Array(320).fill(1000).buffer);
const dub = Buffer.from(new Int16Array(48000).fill(5000).buffer);
async function measure(Type, label) {
  global.gc?.();
  const before = process.memoryUsage();
  const cpu = process.cpuUsage();
  const started = performance.now();
  const buffer = new Type({ delayMs: 3000, fallbackMode: 'silence' });
  let emitted = 0, maxOriginalMs = 0, maxDubs = 0;
  buffer.on('release', ({ audio }) => { emitted += audio.samples; });
  buffer.tick(0);
  for (let t = 20; t <= simulatedMs; t += 20) {
    buffer.pushAudio({ pcm: original, sampleRate: 16000, timestamp: t - 20 });
    if (t % 2000 === 0) buffer.pushDub({ turnId: `t${t}`, audioDub: dub, sampleRate: 48000, sourceTimestamp: t - 1400, sourceEndedAt: t - 200 });
    buffer.tick(t);
    if (t % 1000 === 0) {
      const stats = buffer.stats();
      maxOriginalMs = Math.max(maxOriginalMs, stats.queuedAudioMs);
      maxDubs = Math.max(maxDubs, stats.dubsPending);
    }
    if (t % 10000 === 0) await new Promise(setImmediate);
  }
  const used = process.cpuUsage(cpu);
  const wallMs = performance.now() - started;
  global.gc?.();
  const after = process.memoryUsage();
  return {
    label, simulatedMinutes: simulatedMs / 60000, wallMs: Math.round(wallMs), cpuMs: (used.user + used.system) / 1000,
    retainedHeapDeltaBytes: after.heapUsed - before.heapUsed,
    retainedArrayBufferDeltaBytes: after.arrayBuffers - before.arrayBuffers,
    maxOriginalQueuedMs: maxOriginalMs, maxDubsPending: maxDubs,
    emittedSamples: emitted, expectedSamples: simulatedMs * 48,
  };
}

const results = [];
if (process.argv.includes('--compare-head')) {
  const folder = await mkdtemp(path.join(tmpdir(), 'voxora-audio-baseline-'));
  try {
    for (const name of ['sync-buffer.mjs', 'resampler.mjs']) {
      const source = execFileSync('git', ['show', `HEAD:sync-buffer/src/${name}`], { cwd: root, encoding: 'utf8' });
      await writeFile(path.join(folder, name), source);
    }
    const { SyncBuffer: Baseline } = await import(pathToFileURL(path.join(folder, 'sync-buffer.mjs')));
    results.push(await measure(Baseline, 'HEAD baseline'));
  } finally { await rm(folder, { recursive: true, force: true }); }
}
results.push(await measure(SyncBuffer, 'working tree'));
console.log(JSON.stringify({ synthetic: true, node: process.version, results }, null, 2));
if (results.some((r) => r.emittedSamples !== r.expectedSamples)) process.exitCode = 1;
