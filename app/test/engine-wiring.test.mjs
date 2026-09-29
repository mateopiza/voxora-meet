// Verifica que el motor construya el pipeline real (Groq STT + Groq traducción +
// ElevenLabs TTS + stores) con los módulos hermanos, sin tocar la red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createEngine } from '../engine/engine.mjs';

async function withEngine(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'voxora-meet-wiring-'));
  const engine = await createEngine({ input: new PassThrough(), output: new PassThrough(), dataDir: dir });
  try {
    await fn(engine);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('createPipeline arma DubbingPipeline con las APIs reales del módulo pipeline', async () => {
  await withEngine(async ({ controller, store }) => {
    const settings = await store.load();
    const pipeline = await controller.deps.createPipeline({
      settings: { ...settings, voiceId: 'voice-123', tone: 'formal' },
      keys: { groq: 'gsk_test', elevenlabs: 'xi_test' },
    });
    assert.equal(typeof pipeline.processTurn, 'function');
    assert.equal(pipeline.targetLanguage, settings.targetLanguage);
    assert.equal(await pipeline.resolveVoiceId(), 'voice-123');
  });
});

test('createPipeline exige las keys de Groq y ElevenLabs', async () => {
  await withEngine(async ({ controller, store }) => {
    const settings = await store.load();
    await assert.rejects(
      controller.deps.createPipeline({ settings, keys: { elevenlabs: 'x' } }),
      (error) => error.code === 'missing_key' && /Groq/.test(error.message),
    );
    await assert.rejects(
      controller.deps.createPipeline({ settings, keys: { groq: 'x' } }),
      (error) => error.code === 'missing_key' && /ElevenLabs/.test(error.message),
    );
  });
});
