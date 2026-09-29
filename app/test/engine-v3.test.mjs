// Protocolo v3: models.list, cost.estimate, tts.preview, glossary/vocabulary,
// aplicación en caliente y errores model_unavailable. Sin red real: fetch
// mockeado y DPAPI falso (las keys no salen del proceso de test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createEngine, previewTextFor } from '../engine/engine.mjs';
import { friendlyError } from '../engine/errors.mjs';
import { serializeError } from '../engine/protocol.mjs';
import { SessionController } from '../engine/session-controller.mjs';
import { SyncBuffer } from '../../sync-buffer/src/sync-buffer.mjs';
import { readWavInfo } from '../../pipeline/src/util/wav.mjs';
import { SttError } from '../../pipeline/src/stt/groq-whisper.mjs';
import { TranslationError } from '../../pipeline/src/translate/groq-translate.mjs';
import { TtsError } from '../../pipeline/src/tts/elevenlabs.mjs';
import { HttpError } from '../../pipeline/src/util/http.mjs';

function fakeCrypto() {
  return {
    available: () => true,
    async protect(plain) { return Buffer.concat([Buffer.from('DPAPI'), Buffer.from(plain, 'utf8').reverse()]); },
    async unprotect(blob) { return Buffer.from(blob.subarray(5)).reverse().toString('utf8'); },
  };
}

/** Motor con data-dir temporal, DPAPI falso y fetch enrutable. */
async function withEngine(t, fn, { keys = { groq: 'gsk_test', elevenlabs: 'xi_test' } } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'voxora-meet-v3-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  let handler = async (url) => { throw new Error(`fetch inesperado: ${url}`); };
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  const engine = await createEngine({ input: new PassThrough(), output: new PassThrough(), dataDir: dir, crypto: fakeCrypto(), fetch });
  if (keys) await engine.store.setProviderKeys(keys);
  await fn({ ...engine, dir, calls, route: (h) => { handler = h; } });
}

const GROQ_MODELS = { data: [
  { id: 'whisper-large-v3', active: true }, { id: 'whisper-large-v3-turbo', active: true },
  { id: 'openai/gpt-oss-120b', active: true, context_window: 131072, pricing: { prompt: '0.00000015', completion: '0.0000006' } },
  { id: 'openai/gpt-oss-20b', active: true, context_window: 131072 },
] };
const ELEVEN_MODELS = [
  { model_id: 'eleven_multilingual_v2', can_do_text_to_speech: true, can_use_style: true, can_use_speaker_boost: true, languages: [{}, {}], model_rates: { character_cost_multiplier: 1 } },
  { model_id: 'eleven_flash_v2_5', can_do_text_to_speech: true, can_use_style: false, can_use_speaker_boost: false, languages: [{}], model_rates: { character_cost_multiplier: 0.5 } },
  { model_id: 'eleven_v3', can_do_text_to_speech: true, can_use_style: false, can_use_speaker_boost: false, languages: [{}], model_rates: { character_cost_multiplier: 1 } },
];
const modelsRoute = (url) => {
  if (url.endsWith('/openai/v1/models')) return Response.json(GROQ_MODELS);
  if (url.endsWith('/v1/models')) return Response.json(ELEVEN_MODELS);
  throw new Error(`URL inesperada ${url}`);
};

test('models.list por el protocolo: usa las keys guardadas y marca el modelo elegido', async (t) => {
  await withEngine(t, async ({ handlers, store, calls, route }) => {
    route(modelsRoute);
    await store.save({ ttsModel: 'eleven_flash_v2_5' });
    const res = await handlers['models.list']({});
    assert.equal(res.offline, false);
    assert.deepEqual(res.stt.map((m) => m.id), ['whisper-large-v3', 'whisper-large-v3-turbo']);
    assert.equal(res.translate[0].id, 'openai/gpt-oss-120b');
    assert.equal(res.tts.find((m) => m.id === 'eleven_flash_v2_5').costMultiplier, 0.5);
    assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer gsk_test');
    await handlers['models.list']({});
    assert.equal(calls.length, 2, 'segunda llamada sale de la caché');
    await handlers['models.list']({ refresh: true });
    assert.equal(calls.length, 4);
  });
});

test('models.list sin keys ni red devuelve el catálogo de respaldo (offline)', async (t) => {
  await withEngine(t, async ({ handlers, calls }) => {
    const res = await handlers['models.list']();
    assert.equal(res.offline, true);
    assert.equal(calls.length, 0, 'sin keys no se llama a la red');
    assert.equal(res.errors.groq.code, 'missing_key');
    assert.ok(res.stt.length && res.translate.length && res.tts.length);
  }, { keys: null });
});

test('cost.estimate: tarifas por hora con los ajustes guardados y overrides sin persistir', async (t) => {
  await withEngine(t, async ({ handlers, store }) => {
    const base = await handlers['cost.estimate']({});
    assert.equal(base.minutes, 60);
    assert.equal(base.speakingRatio, 0.5);
    for (const key of ['voxPerMinute', 'voxPerHour', 'usdPerHour']) assert.equal(typeof base[key], 'number');
    assert.deepEqual(Object.keys(base.breakdown), ['stt', 'translate', 'tts']);
    assert.deepEqual(base.models, { stt: 'whisper-large-v3', translate: 'openai/gpt-oss-120b', tts: 'eleven_multilingual_v2' });
    assert.ok(base.usdPerHour > 0.5 && base.usdPerHour < 10, `usdPerHour=${base.usdPerHour}`);

    const cheap = await handlers['cost.estimate']({
      minutes: 30,
      speakingRatio: 0.5,
      overrides: { sttModel: 'whisper-large-v3-turbo', ttsModel: 'eleven_flash_v2_5', delayMs: 9999, bogus: 1 },
    });
    assert.equal(cheap.minutes, 30);
    assert.equal(cheap.models.tts, 'eleven_flash_v2_5');
    assert.ok(cheap.breakdown.stt < base.breakdown.stt);
    assert.ok(Math.abs(cheap.breakdown.tts - base.breakdown.tts / 2) / base.breakdown.tts < 0.05);
    assert.ok(cheap.usdPerHour < base.usdPerHour);
    assert.equal((await store.load()).ttsModel, 'eleven_multilingual_v2', 'los overrides no se guardan');

    const clamped = await handlers['cost.estimate']({ minutes: -5, speakingRatio: 7, overrides: { translateReasoningEffort: 'high' } });
    assert.equal(clamped.minutes, 1);
    assert.equal(clamped.speakingRatio, 1);
    assert.ok(clamped.breakdown.translate > 0);
  }, { keys: null });
});

test('tts.preview: frase fija del idioma destino, ajustes TTS actuales y WAV en data URL', async (t) => {
  await withEngine(t, async ({ handlers, store, calls, route }) => {
    await store.save({
      voiceId: 'VozClonada01', targetLanguage: 'en', ttsModel: 'eleven_flash_v2_5',
      ttsStability: 0.4, ttsSimilarityBoost: 0.9, ttsStyle: 0.7, ttsSpeed: 1.1, ttsSpeakerBoost: true, ttsTextNormalization: 'off',
    });
    const pcm = Buffer.alloc(24_000 * 2); // 0.5 s @48k
    route(() => new Response(pcm, { headers: { 'content-type': 'audio/pcm' } }));
    const res = await handlers['tts.preview']({});
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1\/text-to-speech\/VozClonada01\?output_format=pcm_48000$/);
    assert.equal(new Headers(calls[0].init.headers).get('xi-api-key'), 'xi_test');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.text, 'Hello everyone, this is how my voice will sound in the meeting.');
    assert.equal(body.model_id, 'eleven_flash_v2_5');
    assert.deepEqual(body.voice_settings, { stability: 0.4, similarity_boost: 0.9, speed: 1.1 }, 'Flash no admite style ni speaker boost');
    assert.equal(body.language_code, 'en');
    assert.equal(body.apply_text_normalization, 'off');

    assert.match(res.audioDataUrl, /^data:audio\/wav;base64,/);
    const wav = Buffer.from(res.audioDataUrl.split(',')[1], 'base64');
    const info = readWavInfo(wav);
    assert.equal(info.sampleRate, 48_000);
    assert.equal(Math.round(info.durationMs), 500);
    assert.equal(res.chars, body.text.length);
    assert.equal(res.sampleRate, 48_000);
    assert.equal(res.model, 'eleven_flash_v2_5');

    // Texto propio y voz explícita; multilingual_v2 no manda language_code.
    await store.save({ ttsModel: 'eleven_multilingual_v2', targetLanguage: 'pt' });
    await handlers['tts.preview']({ text: '  Olá,   mundo ', voiceId: 'OtraVoz12345' });
    const second = JSON.parse(calls[1].init.body);
    assert.equal(second.text, 'Olá, mundo');
    assert.match(calls[1].url, /OtraVoz12345/);
    assert.equal('language_code' in second, false);
    assert.equal(second.voice_settings.style, 0.7);
    assert.equal(second.voice_settings.use_speaker_boost, true);

    await assert.rejects(handlers['tts.preview']({ text: 'x'.repeat(301) }), (e) => e.code === 'bad_request');
    await assert.rejects(handlers['tts.preview']({ voiceId: 'no válido' }), (e) => e.code === 'bad_request');
  });
});

test('tts.preview: sin voz → voice_missing; sin key → missing_key; pago pendiente → provider_payment', async (t) => {
  await withEngine(t, async ({ handlers, store, route }) => {
    await assert.rejects(handlers['tts.preview']({}), (e) => e.code === 'voice_missing');
    await store.save({ voiceId: 'VozClonada01' });
    route(() => new Response('{"detail":{"status":"payment_issue","message":"failed or incomplete payment"}}', { status: 401 }));
    await assert.rejects(handlers['tts.preview']({}), (e) => {
      const s = serializeError(e);
      assert.equal(s.code, 'provider_payment');
      assert.match(s.message, /ElevenLabs.*pago pendiente/);
      return true;
    });
    route(() => new Response('{"detail":{"status":"model_not_found","message":"Model eleven_zzz not found"}}', { status: 400 }));
    await store.save({ ttsModel: 'eleven_zzz' });
    await assert.rejects(handlers['tts.preview']({}), (e) => {
      const s = serializeError(e);
      assert.equal(s.code, 'model_unavailable');
      assert.match(s.message, /«eleven_zzz».*ElevenLabs/);
      return true;
    });
    await store.setProviderKeys({ elevenlabs: '' });
    await assert.rejects(handlers['tts.preview']({}), (e) => e.code === 'missing_key');
  });
});

test('previewTextFor: tabla por idioma con inglés de respaldo', () => {
  assert.match(previewTextFor('es'), /así sonará mi voz/);
  assert.match(previewTextFor('fr-CA'), /^Bonjour/);
  assert.equal(previewTextFor('xx'), previewTextFor('en'));
  assert.equal(previewTextFor(undefined), previewTextFor('en'));
});

test('glossary.get/set y vocabulary.get/set persisten en el dir de datos y los ve el pipeline', async (t) => {
  await withEngine(t, async ({ handlers, controller, store, dir }) => {
    assert.deepEqual(await handlers['glossary.get'](), { entries: [] });
    assert.deepEqual(await handlers['vocabulary.get'](), { terms: [] });

    // El pipeline se crea antes: debe ver los cambios posteriores (misma instancia de store).
    const pipeline = await controller.deps.createPipeline({ settings: { ...(await store.load()), voiceId: 'VozClonada01' }, keys: { groq: 'g', elevenlabs: 'x' } });

    const g = await handlers['glossary.set']({ entries: [
      { term: ' VOXORA ', translation: '' },
      { term: 'sprint', translation: 'iteración', note: 'jerga ágil' },
      { term: '' },
      'Kubernetes',
      { term: 'SPRINT', translation: 'ciclo' },
    ] });
    // Filas vacías fuera, término duplicado (sin distinguir mayúsculas) → gana el último.
    assert.deepEqual(g.entries, [
      { term: 'VOXORA' },
      { term: 'SPRINT', translation: 'ciclo' },
      { term: 'Kubernetes' },
    ]);
    assert.deepEqual(await handlers['glossary.get'](), g);
    const onDisk = JSON.parse(await readFile(path.join(dir, 'glossary.json'), 'utf8'));
    assert.equal(onDisk.default.length, 3);

    const v = await handlers['vocabulary.set']({ terms: ['Mateo', ' mateo ', 'Kubernetes', '', 42, null] });
    assert.deepEqual(v, { terms: ['Mateo', 'Kubernetes', '42'] });
    assert.deepEqual(await handlers['vocabulary.get'](), v);

    // El traductor y el STT del pipeline ya creado leen los valores nuevos.
    const route = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      route.push({ url: String(url), init });
      if (String(url).endsWith('/audio/transcriptions')) return Response.json({ text: 'Hola Mateo', segments: [{ start: 0, end: 2, avg_logprob: -0.1, no_speech_prob: 0.01, compression_ratio: 1.2 }] });
      if (String(url).endsWith('/chat/completions')) return Response.json({ model: 'openai/gpt-oss-120b', choices: [{ message: { content: 'Hi Mateo' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
      return new Response(Buffer.alloc(4800), { headers: { 'content-type': 'audio/pcm' } });
    });
    const pcm = Buffer.alloc(16_000 * 2 * 2, 1);
    await pipeline.processTurn({ pcm, sampleRate: 16_000, startedAt: 0, endedAt: 2000, voicedMs: 1500, rmsDb: -20 });
    assert.match(route[0].init.body.get('prompt'), /Mateo, Kubernetes, 42/);
    assert.match(JSON.parse(route[1].init.body).messages[0].content, /"SPRINT" → "ciclo"/);

    await assert.rejects(handlers['glossary.set']({}), (e) => e.code === 'bad_request');
    await assert.rejects(handlers['glossary.set']({ entries: Array.from({ length: 501 }, (_, i) => ({ term: `t${i}` })) }), (e) => e.code === 'bad_request');
    await assert.rejects(handlers['vocabulary.set']({ terms: 'Mateo' }), (e) => e.code === 'bad_request');
  }, { keys: null });
});

test('createPipeline aplica los ajustes de modelo y settings.set los cambia en caliente', async (t) => {
  await withEngine(t, async ({ controller, store, handlers, models, route }) => {
    route(modelsRoute);
    await handlers['models.list']({}); // llena la ficha en vivo (multiplicador de flash = 0.5)
    await store.save({
      sttModel: 'whisper-large-v3-turbo', sttTemperature: 0.1,
      translateModel: 'openai/gpt-oss-20b', translateTemperature: 0.4, translateReasoningEffort: 'medium', memoryTurns: 3,
      ttsModel: 'eleven_v3', ttsStability: 0.8, ttsSimilarityBoost: 0.6, ttsTextNormalization: 'on',
    });
    const pipeline = await controller.deps.createPipeline({ settings: { ...(await store.load()), voiceId: 'VozClonada01' }, keys: { groq: 'g', elevenlabs: 'x' } });
    let s = pipeline.currentSettings();
    assert.equal(s.sttModel, 'whisper-large-v3-turbo');
    assert.equal(s.sttTemperature, 0.1);
    assert.equal(s.translateModel, 'openai/gpt-oss-20b');
    assert.equal(s.translateTemperature, 0.4);
    assert.equal(s.translateReasoningEffort, 'medium');
    assert.equal(s.memoryTurns, 3);
    assert.equal(s.ttsModel, 'eleven_v3');
    assert.deepEqual(s.ttsCapabilities.stabilityPresets, [0, 0.5, 1]);
    assert.equal(s.voiceSettings.stability, 0.8);
    assert.equal(s.ttsTextNormalization, 'on');
    assert.equal(s.ttsCostMultiplier, 1);

    // Sesión "en curso" con este pipeline: settings.set lo actualiza sin reiniciar.
    controller.session = { syncBuffer: new SyncBuffer({ delayMs: 3000 }), pipeline };
    const res = await handlers['settings.set']({ settings: { ttsModel: 'eleven_flash_v2_5', ttsSpeed: 0.9, translateModel: 'openai/gpt-oss-120b', memoryTurns: 1 } });
    assert.equal(res.settings.ttsModel, 'eleven_flash_v2_5');
    s = pipeline.currentSettings();
    assert.equal(s.ttsModel, 'eleven_flash_v2_5');
    assert.equal(s.ttsCapabilities.supportsLanguageCode, true);
    assert.equal(s.ttsCapabilities.stabilityPresets, null);
    assert.equal(s.ttsCostMultiplier, 0.5, 'multiplicador en vivo del catálogo');
    assert.equal(s.voiceSettings.speed, 0.9);
    assert.equal(s.translateModel, 'openai/gpt-oss-120b');
    assert.equal(s.memoryTurns, 1);
    assert.equal(models.ttsInfo('eleven_flash_v2_5').source, 'live');
    controller.session = null;
  });
});

test('createPipeline normaliza overrides de session.start (ids inválidos → default)', async (t) => {
  await withEngine(t, async ({ controller, store }) => {
    const pipeline = await controller.deps.createPipeline({
      settings: { ...(await store.load()), voiceId: 'VozClonada01', ttsModel: 'mal id', sttTemperature: 9 },
      keys: { groq: 'g', elevenlabs: 'x' },
    });
    const s = pipeline.currentSettings();
    assert.equal(s.ttsModel, 'eleven_multilingual_v2');
    assert.equal(s.sttTemperature, 1);
  }, { keys: null });
});

test('SessionController.applyLiveSettings delega los ajustes de modelo en pipeline.applySettings', async () => {
  const applied = [];
  const pipeline = { applySettings(p) { applied.push(p); }, async processTurn() { return null; } };
  const mic = Object.assign(new EventEmitter(), { start() {}, stop() {} });
  const c = new SessionController({
    settingsStore: { async load() { return { delayMs: 2000, voiceId: 'v1', fallbackMode: 'silence' }; }, async getProviderKeys() { return {}; } },
    createMicCapture: () => mic,
    createPipeline: () => pipeline,
    createSyncBuffer: (opts) => new SyncBuffer(opts),
    createVirtualMic: () => ({ async open() {}, write() {}, async close() {} }),
    createMeter: () => Object.assign(new EventEmitter(), { add() { return {}; }, totalVox: 0, limitReached: false, remainingVox: Infinity }),
    tickIntervalMs: 5,
    statsIntervalMs: 10_000,
  });
  assert.equal(c.applyLiveSettings({ ttsModel: 'eleven_v3' }), false, 'sin sesión no aplica');
  await c.start();
  assert.equal(c.applyLiveSettings({ ttsModel: 'eleven_v3', ttsStability: 0.2, voiceId: 'v2' }), true);
  assert.deepEqual(applied, [{ ttsModel: 'eleven_v3', ttsStability: 0.2, voiceId: 'v2' }]);
  assert.equal(c.settings.ttsModel, 'eleven_v3');

  // Un fallo del pipeline al aplicar se reporta como evento, no rompe la sesión.
  const errors = [];
  c.on('error', (e) => errors.push(e));
  pipeline.applySettings = () => { throw new Error('boom'); };
  assert.equal(c.applyLiveSettings({ ttsModel: 'x' }), true);
  assert.equal(errors[0].scope, 'pipeline');
  await c.stop();
});

test('errores: modelo inexistente o sin acceso → model_unavailable con mensaje en español', () => {
  const groq404 = new TranslationError('Groq Chat 404: {"error":{"message":"The model `acme/x` does not exist or you do not have access to it.","type":"invalid_request_error","code":"model_not_found"}}', {
    status: 404,
    model: 'acme/x',
    cause: new HttpError('Groq Chat 404', { status: 404, body: '{"error":{"code":"model_not_found"}}' }),
  });
  const a = friendlyError(groq404);
  assert.equal(a.code, 'model_unavailable');
  assert.match(a.message, /modelo de traducción «acme\/x» no está disponible en tu cuenta de Groq/);
  assert.match(a.message, /Ajustes/);

  const decommissioned = friendlyError(new SttError('Groq Whisper 400: {"error":{"message":"The model `distil-whisper-large-v3-en` has been decommissioned","code":"model_decommissioned"}}', { status: 400 }));
  assert.equal(decommissioned.code, 'model_unavailable');
  assert.match(decommissioned.message, /transcripción «distil-whisper-large-v3-en».*Groq/);

  const blocked = friendlyError(new TranslationError('Groq Chat 403: {"error":{"code":"model_permission_blocked_project"}}', { status: 403, model: 'openai/gpt-oss-120b' }));
  assert.equal(blocked.code, 'model_unavailable', 'sin acceso al modelo no es una key inválida');

  const eleven = friendlyError(new TtsError('ElevenLabs 400: {"detail":{"status":"model_not_found"}}', { status: 400, model: 'eleven_zzz' }));
  assert.equal(eleven.code, 'model_unavailable');
  assert.match(eleven.message, /de voz «eleven_zzz».*ElevenLabs/);

  // Passthrough: un ProtocolError/objeto con el código ya amigable se respeta.
  assert.deepEqual(
    { ...friendlyError(Object.assign(new Error('Elige otro modelo.'), { code: 'model_unavailable' })) },
    { code: 'model_unavailable', message: 'Elige otro modelo.' },
  );
  // No confunde: voz inexistente, rate limit con nombre de modelo, key inválida.
  assert.equal(friendlyError(new TtsError('ElevenLabs 404: {"detail":{"status":"voice_not_found"}}', { status: 404 })).code, 'voice_missing');
  assert.equal(friendlyError(new TranslationError('Groq Chat 429: Rate limit reached for model `openai/gpt-oss-120b`', { status: 429 })).code, 'provider_quota');
  assert.equal(friendlyError(new SttError('Groq Whisper 401: invalid_api_key', { status: 401 })).code, 'provider_auth');
  const timeout = friendlyError(Object.assign(new DOMException('The operation was aborted due to timeout', 'TimeoutError'), { provider: 'groq' }));
  assert.equal(timeout.code, 'network');
  assert.match(timeout.message, /Groq no respondió a tiempo/);
});
