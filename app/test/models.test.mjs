// Catálogo de modelos (protocolo v3): filtrado, metadatos curados, caché por
// key, respaldo offline y coherencia con lo que aplica el pipeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ModelCatalog,
  buildCatalog,
  describeTtsModel,
  reasoningProfileFor,
  ttsCapabilitiesFor,
  MODEL_DEFAULTS,
  GROQ_MODELS_URL,
  ELEVEN_MODELS_URL,
} from '../engine/models.mjs';
import { DEFAULTS } from '../engine/settings-store.mjs';
import { reasoningParamsFor, chatReasoningProfile } from '../../pipeline/src/translate/groq-translate.mjs';
import { ttsModelCapabilities } from '../../pipeline/src/tts/elevenlabs.mjs';

// Respuestas reales recortadas (GET /models de cada proveedor, 2026-09-28).
const GROQ = {
  object: 'list',
  data: [
    { id: 'qwen/qwen3.6-27b', active: true, context_window: 131072, input_modalities: ['text', 'image'], output_modalities: ['text'], pricing: { prompt: '0.0000006', completion: '0.000003' } },
    { id: 'openai/gpt-oss-20b', active: true, context_window: 131072, output_modalities: ['text'], pricing: { prompt: '0.000000075', completion: '0.0000003' } },
    { id: 'canopylabs/orpheus-v1-english', active: true, output_modalities: ['speech'] },
    { id: 'openai/gpt-oss-120b', active: true, context_window: 131072, output_modalities: ['text'], pricing: { prompt: '0.00000015', completion: '0.0000006' } },
    { id: 'openai/gpt-oss-safeguard-20b', active: true, output_modalities: ['text'] },
    { id: 'whisper-large-v3', active: true, context_window: 448, input_modalities: ['audio'], output_modalities: ['transcription'] },
    { id: 'meta-llama/llama-prompt-guard-2-86m', active: true, output_modalities: ['text'] },
    { id: 'whisper-large-v3-turbo', active: true, input_modalities: ['audio'], output_modalities: ['transcription'] },
    { id: 'groq/compound', active: true },
    { id: 'playai-tts', active: true },
    { id: 'llama-3.3-70b-versatile', active: false, context_window: 131072 },
    { id: 'allam-2-7b', active: true, context_window: 4096 },
  ],
};

const langs = (n) => Array.from({ length: n }, (_, i) => ({ language_id: `l${i}`, name: `L${i}` }));
const ELEVEN = [
  { model_id: 'eleven_v3', name: 'Eleven v3', can_do_text_to_speech: true, can_use_style: false, can_use_speaker_boost: false, requires_alpha_access: false, maximum_text_length_per_request: 5000, languages: langs(74), model_rates: { character_cost_multiplier: 1 } },
  { model_id: 'eleven_multilingual_v2', name: 'Eleven Multilingual v2', can_do_text_to_speech: true, can_use_style: true, can_use_speaker_boost: true, requires_alpha_access: false, maximum_text_length_per_request: 10000, languages: langs(29), model_rates: { character_cost_multiplier: 1 } },
  { model_id: 'eleven_flash_v2_5', name: 'Eleven Flash v2.5', can_do_text_to_speech: true, can_use_style: false, can_use_speaker_boost: false, maximum_text_length_per_request: 40000, languages: langs(32), model_rates: { character_cost_multiplier: 0.5 } },
  { model_id: 'eleven_multilingual_sts_v2', can_do_text_to_speech: false, can_use_style: true, languages: langs(29) },
  { model_id: 'eleven_secret_alpha', can_do_text_to_speech: true, requires_alpha_access: true, languages: langs(3) },
  { model_id: 'eleven_nuevo_x', name: 'Eleven Nuevo', can_do_text_to_speech: true, can_use_style: true, can_use_speaker_boost: false, languages: langs(12), model_rates: { character_cost_multiplier: 0.8 } },
];

function mockProviders({ groq = () => Response.json(GROQ), eleven = () => Response.json(ELEVEN) } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    if (String(url) === GROQ_MODELS_URL) return groq(init);
    if (String(url) === ELEVEN_MODELS_URL) return eleven(init);
    throw new Error(`URL inesperada ${url}`);
  };
  return { fetch, calls };
}

function catalogWith({ keys = { groq: 'gsk_1', elevenlabs: 'xi_1' }, now, ...rest } = {}) {
  const providers = mockProviders(rest);
  let clock = 1_000_000;
  const catalog = new ModelCatalog({ getKeys: async () => keys, fetch: providers.fetch, now: now ?? (() => clock) });
  return { catalog, calls: providers.calls, advance: (ms) => { clock += ms; }, keys };
}

test('models.list en vivo: STT = whisper, traducción = chat activos sin guard/tts/orpheus/compound', async () => {
  const { catalog, calls } = catalogWith();
  const res = await catalog.list();
  assert.equal(res.offline, false);
  assert.deepEqual(res.sources, { groq: 'live', elevenlabs: 'live' });
  assert.deepEqual(res.errors, {});
  assert.equal(typeof res.fetchedAt, 'string');
  assert.equal(calls[0].headers.Authorization, 'Bearer gsk_1');
  assert.equal(calls[1].headers['xi-api-key'], 'xi_1');

  assert.deepEqual(res.stt.map((m) => m.id), ['whisper-large-v3', 'whisper-large-v3-turbo']);
  assert.equal(res.stt[0].recommended, true);
  assert.equal(res.stt[0].price.unit, 'hora de audio');
  assert.equal(res.stt[0].price.usd, 0.111);
  assert.equal(res.stt[1].price.usd, 0.04);
  assert.match(res.stt[1].description, /barato/);

  const ids = res.translate.map((m) => m.id);
  assert.deepEqual(ids.slice(0, 2), ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'], 'recomendado primero, luego orden curado');
  for (const excluded of ['canopylabs/orpheus-v1-english', 'openai/gpt-oss-safeguard-20b', 'meta-llama/llama-prompt-guard-2-86m', 'groq/compound', 'playai-tts', 'whisper-large-v3', 'llama-3.3-70b-versatile']) {
    assert.equal(ids.includes(excluded), false, `${excluded} no debe listarse`);
  }
  assert.ok(ids.includes('qwen/qwen3.6-27b') && ids.includes('allam-2-7b'));

  const oss = res.translate[0];
  assert.equal(oss.label, 'GPT-OSS 120B');
  assert.equal(oss.recommended, true);
  assert.equal(oss.contextWindow, 131072);
  assert.equal(oss.supportsReasoningEffort, true);
  assert.deepEqual(oss.reasoningEfforts, ['low', 'medium', 'high']);
  assert.deepEqual(oss.price, { unit: '1M tokens de entrada', usd: 0.15, usdOutput: 0.6, outputUnit: '1M tokens de salida', source: 'live' });
  const qwen = res.translate.find((m) => m.id === 'qwen/qwen3.6-27b');
  assert.deepEqual(qwen.reasoningEfforts, ['none', 'default']);
  assert.equal(qwen.price.usdOutput, 3);
  const allam = res.translate.find((m) => m.id === 'allam-2-7b');
  assert.equal(allam.supportsReasoningEffort, false);
  assert.deepEqual(allam.reasoningEfforts, []);
  assert.equal(allam.price.source, 'estimate', 'sin precio en vivo ni en tabla → default conservador');
  for (const m of [...res.stt, ...res.translate]) {
    assert.equal(typeof m.label, 'string');
    assert.equal(typeof m.description, 'string');
    assert.equal('order' in m, false);
  }
  assert.deepEqual(res.defaults, MODEL_DEFAULTS);
  assert.equal(res.defaults.ttsModel, DEFAULTS.ttsModel);
});

test('models.list TTS: solo can_do_text_to_speech, sin alfa, con multiplicador y capacidades', async () => {
  const { catalog } = catalogWith();
  const { tts } = await catalog.list();
  assert.deepEqual(tts.map((m) => m.id), ['eleven_multilingual_v2', 'eleven_v3', 'eleven_flash_v2_5', 'eleven_nuevo_x']);

  const v2 = tts[0];
  assert.equal(v2.recommended, true);
  assert.equal(v2.label, 'Multilingual v2');
  assert.equal(v2.languages, 29);
  assert.equal(v2.costMultiplier, 1);
  assert.deepEqual(v2.price, { unit: '1k caracteres', usd: 0.18 });
  assert.equal(v2.supportsStyle, true);
  assert.equal(v2.supportsSpeakerBoost, true);
  assert.equal(v2.supportsLanguageCode, false);
  assert.equal(v2.stabilityPresets, null);
  assert.equal(v2.maxChars, 10000);

  const v3 = tts[1];
  assert.deepEqual(v3.stabilityPresets, [0, 0.5, 1]);
  assert.equal(v3.supportsLanguageCode, true);
  assert.equal(v3.supportsStyle, false);
  assert.equal(v3.maxChars, 5000);

  const flash = tts[2];
  assert.equal(flash.costMultiplier, 0.5);
  assert.equal(flash.price.usd, 0.09);
  assert.equal(flash.supportsLanguageCode, true);
  assert.equal(flash.supportsNormalizationOn, false);

  const nuevo = tts[3];
  assert.equal(nuevo.label, 'Eleven Nuevo');
  assert.equal(nuevo.supportsStyle, true, 'el flag en vivo manda');
  assert.equal(nuevo.costMultiplier, 0.8);
  assert.match(nuevo.description, /12 idiomas/);
});

test('caché de 10 min por key; refresh y cambio de key vuelven a consultar', async () => {
  const { catalog, calls, advance, keys } = catalogWith();
  await catalog.list();
  assert.equal(calls.length, 2);
  await catalog.list();
  assert.equal(calls.length, 2, 'dentro del TTL no hay red');
  advance(9 * 60_000);
  await catalog.list();
  assert.equal(calls.length, 2);
  advance(2 * 60_000);
  await catalog.list();
  assert.equal(calls.length, 4, 'pasado el TTL se refresca');
  await catalog.list({ refresh: true });
  assert.equal(calls.length, 6);
  keys.groq = 'gsk_2';
  await catalog.list();
  assert.equal(calls.length, 7, 'key nueva de Groq → solo Groq se consulta');
  assert.equal(calls[6].headers.Authorization, 'Bearer gsk_2');
});

test('sin red: catálogo estático con offline:true y error de red amigable; los fallos no se cachean', async () => {
  let fail = true;
  const { catalog, calls } = catalogWith({
    groq: () => { if (fail) throw new TypeError('fetch failed'); return Response.json(GROQ); },
    eleven: () => { if (fail) throw new TypeError('fetch failed'); return Response.json(ELEVEN); },
  });
  const res = await catalog.list();
  assert.equal(res.offline, true);
  assert.deepEqual(res.sources, { groq: 'static', elevenlabs: 'static' });
  assert.equal(res.errors.groq.code, 'network');
  assert.match(res.errors.groq.message, /Groq/);
  assert.equal(res.errors.elevenlabs.code, 'network');
  assert.ok(res.stt.some((m) => m.id === 'whisper-large-v3'));
  assert.ok(res.translate.some((m) => m.id === 'openai/gpt-oss-120b' && m.recommended));
  assert.ok(res.tts.some((m) => m.id === 'eleven_multilingual_v2' && m.recommended));
  assert.ok(res.tts.every((m) => m.source === 'static'));
  assert.equal(res.tts.find((m) => m.id === 'eleven_flash_v2_5').costMultiplier, 0.5);

  fail = false;
  const again = await catalog.list();
  assert.equal(again.offline, false);
  assert.equal(calls.length, 4);
});

test('sin key o key inválida: esa sección usa el respaldo y explica el motivo', async () => {
  const { catalog } = catalogWith({
    keys: { elevenlabs: 'xi_bad' },
    eleven: () => new Response('{"detail":{"status":"invalid_api_key"}}', { status: 401 }),
  });
  const res = await catalog.list();
  assert.equal(res.offline, true);
  assert.equal(res.errors.groq.code, 'missing_key');
  assert.match(res.errors.groq.message, /API key de Groq/);
  assert.equal(res.errors.elevenlabs.code, 'provider_auth');
  assert.match(res.errors.elevenlabs.message, /ElevenLabs/);
});

test('el modelo elegido que ya no existe aparece con available:false', async () => {
  const { catalog } = catalogWith();
  const res = await catalog.list({ settings: { ...DEFAULTS, translateModel: 'moonshotai/kimi-k2-instruct', ttsModel: 'eleven_multilingual_v2' } });
  const kimi = res.translate.find((m) => m.id === 'moonshotai/kimi-k2-instruct');
  assert.equal(kimi.available, false);
  assert.equal(kimi.label, 'Kimi K2');
  assert.match(kimi.description, /retirado|sin acceso/);
  assert.equal('order' in kimi, false);
  assert.equal(res.tts.filter((m) => m.id === 'eleven_multilingual_v2').length, 1, 'no duplica los que sí existen');
});

test('ttsInfo/capabilitiesFor usan la última lista en vivo o el respaldo curado', async () => {
  const { catalog } = catalogWith();
  assert.equal(catalog.ttsInfo('eleven_flash_v2_5').source, 'static');
  assert.deepEqual(catalog.capabilitiesFor({ ttsModel: 'eleven_v3' }).ttsCapabilities.stabilityPresets, [0, 0.5, 1]);
  await catalog.list();
  const info = catalog.ttsInfo('eleven_nuevo_x');
  assert.equal(info.source, 'live');
  const caps = catalog.capabilitiesFor({ ttsModel: 'eleven_nuevo_x' });
  assert.equal(caps.ttsCostMultiplier, 0.8);
  assert.equal(caps.ttsCapabilities.supportsStyle, true);
  assert.deepEqual(Object.keys(caps.ttsCapabilities).sort(), ['stabilityPresets', 'supportsLanguageCode', 'supportsNormalizationOn', 'supportsSpeakerBoost', 'supportsSpeed', 'supportsStyle']);
  assert.equal(catalog.ttsInfo('eleven_inventado').costMultiplier, 1);
});

test('coherencia: el catálogo anuncia exactamente lo que el pipeline aplica', () => {
  const chatIds = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3-32b', 'qwen/qwen3.6-27b', 'qwen/qwen3.8-27b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'moonshotai/kimi-k2-instruct', 'allam-2-7b'];
  for (const id of chatIds) {
    const ui = reasoningProfileFor(id);
    assert.deepEqual(ui.reasoningEfforts, chatReasoningProfile(id).efforts, id);
    assert.equal(ui.supportsReasoningEffort, Object.keys(reasoningParamsFor(id, 'medium')).length > 0, id);
  }
  const ttsIds = ['eleven_multilingual_v2', 'eleven_v3', 'eleven_v3_conversational', 'eleven_v4', 'eleven_v4_turbo', 'eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_flash_v2', 'eleven_turbo_v2', 'eleven_x'];
  for (const id of ttsIds) assert.deepEqual(ttsCapabilitiesFor(id), ttsModelCapabilities(id), id);
});

test('buildCatalog y describeTtsModel toleran respuestas incompletas', () => {
  const empty = buildCatalog({ groq: [null, {}, { id: 'whisper-x', active: false }], elevenlabs: [{}, { model_id: 'x' }] });
  assert.deepEqual(empty, { stt: [], translate: [], tts: [] });
  const bare = describeTtsModel({ model_id: 'eleven_v3' }, 'static');
  assert.equal(bare.languages, 74);
  assert.equal(bare.maxChars, 5000);
  assert.equal(bare.costMultiplier, 1);
});
