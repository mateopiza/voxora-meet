// Prueba de humo del motor real por stdio: arranca `engine.mjs` como proceso
// hijo con un data-dir temporal y habla el protocolo JSON-lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'engine.mjs');

function startEngine(dataDir) {
  const child = spawn(process.execPath, [ENGINE, '--data-dir', dataDir], { stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [];
  const waiters = [];
  let pending = '';
  child.stdout.on('data', (chunk) => {
    pending += chunk.toString('utf8');
    let i;
    while ((i = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, i).trim();
      pending = pending.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      messages.push(msg);
      for (const w of [...waiters]) if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    }
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const waitFor = (match, timeoutMs = 8000) => new Promise((resolve, reject) => {
    const found = messages.find(match);
    if (found) return resolve(found);
    const timer = setTimeout(() => reject(new Error(`timeout esperando mensaje. stderr: ${stderr}`)), timeoutMs);
    waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
  });
  let nextId = 1;
  const call = async (cmd, params) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ id, cmd, params })}\n`);
    return waitFor((m) => m.id === id);
  };
  return { child, call, waitFor, messages, stderr: () => stderr };
}

test('engine: ready, ping, settings.get/set, delay.set, stats.get, devices.list y cierre limpio', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'voxora-meet-engine-'));
  const engine = startEngine(dataDir);
  try {
    const ready = await engine.waitFor((m) => m.event === 'ready');
    assert.equal(ready.data.protocol, 1);

    const ping = await engine.call('ping');
    assert.equal(ping.ok, true);
    assert.equal(ping.result.pong, true);

    const got = await engine.call('settings.get');
    assert.equal(got.ok, true);
    assert.equal(got.result.settings.delayMs, 3000);
    assert.equal(got.result.settings.targetLanguage, 'en');
    assert.deepEqual(got.result.providerKeys, { groq: false, elevenlabs: false, openai: false });

    const set = await engine.call('settings.set', { settings: { delayMs: 4000, tone: 'formal' } });
    assert.equal(set.ok, true);
    assert.equal(set.result.settings.delayMs, 4000);
    const onDisk = JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8'));
    assert.equal(onDisk.tone, 'formal');

    // cameraAlwaysOn: lo lee el shell de las respuestas de settings.get/set (cámara virtual permanente).
    assert.equal(got.result.settings.cameraAlwaysOn, true);
    const camOff = await engine.call('settings.set', { settings: { cameraAlwaysOn: false } });
    assert.equal(camOff.result.settings.cameraAlwaysOn, false);
    assert.equal(camOff.result.settings.tone, 'formal');
    assert.equal(JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8')).cameraAlwaysOn, false);

    const delay = await engine.call('delay.set', { delayMs: 9999 });
    assert.equal(delay.result.delayMs, 6000);

    const stats = await engine.call('stats.get');
    assert.equal(stats.result.state, 'idle');

    const devices = await engine.call('devices.list');
    assert.equal(devices.ok, true);
    assert.ok('virtualMic' in devices.result && 'virtualCamera' in devices.result);

    // Protocolo v3 por stdio (sin keys: catálogo de respaldo, sin red).
    const models = await engine.call('models.list', {});
    assert.equal(models.ok, true);
    assert.equal(models.result.offline, true);
    assert.equal(models.result.defaults.ttsModel, 'eleven_multilingual_v2');
    assert.ok(models.result.stt.length && models.result.translate.length && models.result.tts.length);
    const cost = await engine.call('cost.estimate', { minutes: 60 });
    assert.equal(cost.ok, true);
    assert.ok(cost.result.usdPerHour > 0 && cost.result.voxPerHour > 0);
    const setModel = await engine.call('settings.set', { settings: { ttsModel: 'eleven_v3', ttsStability: 2 } });
    assert.equal(setModel.result.settings.ttsModel, 'eleven_v3');
    assert.equal(setModel.result.settings.ttsStability, 1);
    const vocab = await engine.call('vocabulary.set', { terms: ['VOXORA'] });
    assert.deepEqual(vocab.result, { terms: ['VOXORA'] });
    const preview = await engine.call('tts.preview', {});
    assert.equal(preview.ok, false);
    assert.equal(preview.error.code, 'missing_key');

    const bad = await engine.call('voice.clone', {});
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'bad_request');

    const unknown = await engine.call('nope');
    assert.equal(unknown.error.code, 'unknown_command');

    engine.child.stdin.end();
    const code = await new Promise((r) => engine.child.on('exit', r));
    assert.equal(code, 0);
  } finally {
    engine.child.kill();
    await rm(dataDir, { recursive: true, force: true });
  }
});
