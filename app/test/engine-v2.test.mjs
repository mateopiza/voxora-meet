// Protocolo v2: salida del doblaje con fallback, errores amigables, voces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describeOutput, resolveOutputDevice, captureNameFor } from '../engine/output-device.mjs';
import { friendlyError } from '../engine/errors.mjs';
import { createEngine } from '../engine/engine.mjs';
import { pcmToWav } from '../../pipeline/src/util/wav.mjs';

const ENDPOINTS = [
  { id: 'spk', name: 'Altavoces (Realtek High Definition Audio)', isDefault: true },
  { id: 'cable', name: 'CABLE Input (VB-Audio Virtual Cable)', isDefault: false },
];

test('output: usa el dispositivo configurado si existe', async () => {
  const out = await resolveOutputDevice(async () => ENDPOINTS, 'altavoces');
  assert.equal(out.deviceId, 'spk');
  assert.equal(out.warning, undefined);
});

test('output: sin driver propio cae a VB-Cable y avisa qué micrófono elegir en Meet', async () => {
  const out = await resolveOutputDevice(async () => ENDPOINTS, 'VOXORA Meet Speaker');
  assert.equal(out.deviceId, 'cable');
  assert.equal(out.captureName, 'CABLE Output');
  assert.match(out.warning, /CABLE Output/);
});

test('output: sin ningún cable virtual lanza virtual_mic_missing', async () => {
  await assert.rejects(
    resolveOutputDevice(async () => [ENDPOINTS[0]], 'VOXORA Meet Speaker'),
    (error) => error.code === 'virtual_mic_missing' && /VB-Cable/.test(error.message),
  );
  const described = describeOutput([ENDPOINTS[0]], 'VOXORA Meet Speaker');
  assert.equal(described.endpoint, null);
  assert.deepEqual(described.candidates, []);
  assert.equal(captureNameFor('VOXORA Meet Speaker (VOXORA)'), 'VOXORA Meet Microphone');
});

test('errores: pago pendiente, key inválida, cuota y mic ausente se traducen', () => {
  const payment = friendlyError(Object.assign(new Error('ElevenLabs 401: {"detail":{"status":"payment_issue"}}'), { status: 401 }));
  assert.equal(payment.code, 'provider_payment');
  assert.match(payment.message, /ElevenLabs.*pago pendiente/);

  const auth = friendlyError(Object.assign(new Error('Groq Whisper: HTTP 401 invalid_api_key'), { status: 401 }));
  assert.equal(auth.code, 'provider_auth');
  assert.match(auth.message, /Groq/);

  assert.equal(friendlyError(Object.assign(new Error('x'), { status: 429, stage: 'translate' })).code, 'provider_quota');
  assert.equal(friendlyError(new Error('wasapi-render: device-not-found 0x80070490 VOXORA Meet Speaker')).code, 'virtual_mic_missing');
  assert.deepEqual(
    { ...friendlyError(Object.assign(new Error('Falta la API key'), { code: 'missing_key' })) },
    { code: 'missing_key', message: 'Falta la API key' },
  );
});

async function withEngine(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'voxora-meet-v2-'));
  const engine = await createEngine({ input: new PassThrough(), output: new PassThrough(), dataDir: dir });
  const realFetch = globalThis.fetch;
  try {
    await fn({ ...engine, dir });
  } finally {
    globalThis.fetch = realFetch;
    await rm(dir, { recursive: true, force: true });
  }
}

const onWindows = { skip: process.platform !== 'win32' }; // las keys se cifran con DPAPI real

test('voices.list ordena clonadas primero y marca la actual', onWindows, async () => {
  await withEngine(async ({ handlers, store }) => {
    await store.setProviderKeys({ elevenlabs: 'xi_test' });
    await store.save({ voiceId: 'Clon1234' });
    globalThis.fetch = async (url, init) => {
      assert.match(String(url), /\/v1\/voices$/);
      assert.equal(new Headers(init.headers).get('xi-api-key'), 'xi_test');
      return Response.json({
        voices: [
          { voice_id: 'Rachel123', name: 'Rachel', category: 'premade', preview_url: 'https://x/r.mp3' },
          { voice_id: 'Clon1234', name: 'Mateo', category: 'cloned', preview_url: null },
        ],
      });
    };
    const { voices, currentVoiceId } = await handlers['voices.list']();
    assert.equal(currentVoiceId, 'Clon1234');
    assert.deepEqual(voices.map((v) => [v.voiceId, v.category, v.isCurrent]), [
      ['Clon1234', 'cloned', true],
      ['Rachel123', 'premade', false],
    ]);
  });
});

test('voice.set valida formato y existencia, y persiste la voz', onWindows, async () => {
  await withEngine(async ({ handlers, store }) => {
    await store.setProviderKeys({ elevenlabs: 'xi_test' });
    await assert.rejects(handlers['voice.set']({ voiceId: 'no válido!' }), (e) => e.code === 'bad_request');

    globalThis.fetch = async () => new Response('{"detail":{"status":"voice_not_found"}}', { status: 404 });
    await assert.rejects(handlers['voice.set']({ voiceId: 'Nope12345' }), (e) => e.code === 'voice_missing');

    globalThis.fetch = async () => Response.json({ voice_id: 'Q1qrcPEKgAS0RfsAMRXV', name: 'Mateo - Sagitario', category: 'cloned' });
    const result = await handlers['voice.set']({ voiceId: 'Q1qrcPEKgAS0RfsAMRXV' });
    assert.deepEqual(result, { voiceId: 'Q1qrcPEKgAS0RfsAMRXV', name: 'Mateo - Sagitario' });
    assert.equal((await store.load()).voiceId, 'Q1qrcPEKgAS0RfsAMRXV');
  });
});

test('voice.clone rechaza WAV de menos de 60 s con un mensaje accionable', onWindows, async () => {
  await withEngine(async ({ handlers, store, dir }) => {
    await store.setProviderKeys({ elevenlabs: 'xi_test' });
    const wavPath = path.join(dir, 'toma.wav');
    await writeFile(wavPath, pcmToWav(Buffer.alloc(48_000 * 2 * 17), { sampleRate: 48_000, channels: 1, bitsPerSample: 16 }));
    globalThis.fetch = async () => { throw new Error('no debe llamar a la red'); };
    await assert.rejects(
      handlers['voice.clone']({ name: 'Yo', wavPaths: [wavPath] }),
      (e) => e.code === 'samples_too_short' && /17 s/.test(e.message),
    );
  });
});

test('voice.clone con 60 s crea la voz, la guarda y la deja como actual', onWindows, async () => {
  await withEngine(async ({ handlers, store, dir }) => {
    await store.setProviderKeys({ elevenlabs: 'xi_test' });
    const paths = [];
    for (const i of [1, 2]) {
      const p = path.join(dir, `toma${i}.wav`);
      await writeFile(p, pcmToWav(Buffer.alloc(16_000 * 2 * 31), { sampleRate: 16_000, channels: 1, bitsPerSample: 16 }));
      paths.push(p);
    }
    let form = null;
    globalThis.fetch = async (url, init) => {
      assert.match(String(url), /\/v1\/voices\/add$/);
      form = init.body;
      return Response.json({ voice_id: 'NewVoice01', requires_verification: false });
    };
    const result = await handlers['voice.clone']({ name: 'Mi voz', wavPaths: paths });
    assert.equal(result.voiceId, 'NewVoice01');
    assert.equal(form.getAll('files').length, 2);
    assert.equal((await store.load()).voiceId, 'NewVoice01');
  });
});
