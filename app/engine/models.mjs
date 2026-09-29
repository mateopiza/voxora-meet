// Catálogo de modelos para el comando `models.list` (protocolo v3).
//
// Se consulta en vivo a los proveedores con las keys guardadas del usuario:
//   - Groq        GET https://api.groq.com/openai/v1/models
//       STT       = ids con "whisper".
//       Traducción = modelos de chat activos (sin whisper/guard/tts/playai/orpheus/compound).
//   - ElevenLabs  GET https://api.elevenlabs.io/v1/models
//       TTS       = `can_do_text_to_speech`; se omiten los que piden acceso alfa.
// y se enriquece con metadatos curados en español (etiqueta, descripción,
// recomendado, capacidades). Caché de 10 min por key. Sin red o sin key se
// devuelve un catálogo estático de respaldo con `offline: true`.
//
// Las capacidades de razonamiento y TTS deben coincidir con las que aplica el
// pipeline (`reasoningParamsFor` y `ttsModelCapabilities` en pipeline/src): hay
// un test que lo verifica.

import { createHash } from 'node:crypto';
import { DEFAULTS, MODEL_SETTING_KEYS } from './settings-store.mjs';
import { friendlyError } from './errors.mjs';
import { sttPriceFor, chatPriceFor, ttsCostMultiplierFor, TTS_BASE_USD_PER_1K_CHARS } from '../../billing/src/index.mjs';

export const MODELS_TTL_MS = 10 * 60_000;
export const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';
export const ELEVEN_MODELS_URL = 'https://api.elevenlabs.io/v1/models';
const FETCH_TIMEOUT_MS = 8_000;

/** Defaults de los ajustes de modelo (los mismos de settings-store). */
export const MODEL_DEFAULTS = Object.freeze(Object.fromEntries(MODEL_SETTING_KEYS.map((k) => [k, DEFAULTS[k]])));

/** Ids de Groq que no son modelos de chat aptos para traducir. */
const EXCLUDED_CHAT = /whisper|guard|tts|playai|orpheus|compound|prompt-guard/i;

// ── Metadatos curados ───────────────────────────────────────────────────────

const STT_META = {
  'whisper-large-v3': {
    label: 'Whisper Large v3',
    description: 'La transcripción más precisa: acierta más con nombres propios, cifras y acentos. Recomendado para reuniones.',
    recommended: true,
    order: 0,
  },
  'whisper-large-v3-turbo': {
    label: 'Whisper Large v3 Turbo',
    description: 'Más rápido y ~64 % más barato; algo menos preciso con términos poco comunes.',
    order: 1,
  },
};

// Familias de chat: el primer match gana.
const CHAT_META = [
  { match: /^openai\/gpt-oss-120b$/i, label: 'GPT-OSS 120B', description: 'La mejor calidad de traducción y la terminología más consistente. Recomendado.', recommended: true, order: 0 },
  { match: /^openai\/gpt-oss-20b$/i, label: 'GPT-OSS 20B', description: 'Más rápido y barato; buena calidad en frases directas, flojea con matices.', order: 1 },
  { match: /qwen-?3-32b/i, label: 'Qwen3 32B', description: 'Multilingüe sólido y económico. Su razonamiento se desactiva para traducir en tiempo real.', order: 2 },
  { match: /qwen-?3\.8/i, label: 'Qwen3.8 27B', description: 'Qwen de última generación, multilingüe; más caro. El razonamiento se oculta para que no llegue a la voz.', order: 3 },
  { match: /qwen-?3\.6/i, label: 'Qwen3.6 27B', description: 'Qwen multilingüe de buena calidad; más caro que GPT-OSS. El razonamiento se oculta para que no llegue a la voz.', order: 4 },
  { match: /qwen-?3/i, label: null, description: 'Modelo Qwen3 multilingüe. El razonamiento se oculta para que no llegue a la voz.', order: 5 },
  { match: /llama-3\.3-70b/i, label: 'Llama 3.3 70B', description: 'Traducción fluida sin razonamiento y latencia estable.', order: 6 },
  { match: /llama-3\.1-8b/i, label: 'Llama 3.1 8B Instant', description: 'Muy rápido y barato; menos fiable con matices y jerga.', order: 7 },
  { match: /kimi-k2/i, label: 'Kimi K2', description: 'Modelo grande con buen manejo de contexto largo; más caro.', order: 8 },
  { match: /allam/i, label: 'ALLaM 2 7B', description: 'Especializado en árabe; no recomendado para otros idiomas.', order: 20 },
];

const TTS_META = {
  eleven_multilingual_v2: {
    label: 'Multilingual v2',
    description: 'La voz clonada más fiel y natural, en 29 idiomas. Recomendado para reuniones.',
    recommended: true, order: 0, languages: 29, maxChars: 10_000,
  },
  eleven_v3: {
    label: 'Eleven v3',
    description: 'El más expresivo (70+ idiomas). Estabilidad por presets (Creativo, Natural, Robusto) y más latencia.',
    order: 1, languages: 74, maxChars: 5_000,
  },
  eleven_v3_conversational: {
    label: 'Eleven v3 Conversational',
    description: 'v3 afinado para diálogo natural; mitad de costo por carácter.',
    order: 2, languages: 74, maxChars: 5_000,
  },
  eleven_v4: {
    label: 'Eleven v4',
    description: 'Nueva generación: muy expresivo y rápido, 90+ idiomas.',
    order: 3, languages: 85, maxChars: 10_000,
  },
  eleven_v4_turbo: {
    label: 'Eleven v4 Turbo',
    description: 'v4 optimizado para baja latencia; mitad de costo por carácter.',
    order: 4, languages: 85, maxChars: 10_000,
  },
  eleven_turbo_v2_5: {
    label: 'Turbo v2.5',
    description: 'Buen equilibrio entre calidad y latencia en 32 idiomas; mitad de costo, algo menos fiel al timbre clonado.',
    order: 5, languages: 32, maxChars: 40_000,
  },
  eleven_flash_v2_5: {
    label: 'Flash v2.5',
    description: 'Latencia mínima y mitad de costo en 32 idiomas; la menos fiel al timbre clonado.',
    order: 6, languages: 32, maxChars: 40_000,
  },
  eleven_turbo_v2: {
    label: 'Turbo v2 (solo inglés)',
    description: 'Solo inglés, baja latencia; mitad de costo.',
    order: 7, languages: 1, maxChars: 30_000,
  },
  eleven_flash_v2: {
    label: 'Flash v2 (solo inglés)',
    description: 'Solo inglés, latencia mínima; mitad de costo.',
    order: 8, languages: 1, maxChars: 30_000,
  },
};

// Respaldo sin red: lo que devolvían los proveedores al 2026-09-28.
const STATIC_GROQ = [
  { id: 'whisper-large-v3', active: true },
  { id: 'whisper-large-v3-turbo', active: true },
  { id: 'openai/gpt-oss-120b', active: true, context_window: 131_072 },
  { id: 'openai/gpt-oss-20b', active: true, context_window: 131_072 },
  { id: 'qwen/qwen3.8-27b', active: true, context_window: 131_072 },
  { id: 'qwen/qwen3.6-27b', active: true, context_window: 131_072 },
];
const STATIC_ELEVEN = [
  'eleven_multilingual_v2', 'eleven_v3', 'eleven_v3_conversational', 'eleven_v4', 'eleven_v4_turbo', 'eleven_turbo_v2_5', 'eleven_flash_v2_5',
].map((id) => ({ model_id: id, can_do_text_to_speech: true }));

// ── Capacidades ─────────────────────────────────────────────────────────────

/** Razonamiento configurable por familia (igual que `chatReasoningProfile` del pipeline). */
export function reasoningProfileFor(id) {
  const s = String(id ?? '').toLowerCase();
  if (/gpt-oss/.test(s)) return { supportsReasoningEffort: true, reasoningEfforts: ['low', 'medium', 'high'] };
  if (/qwen-?3/.test(s)) return { supportsReasoningEffort: true, reasoningEfforts: ['none', 'default'] };
  return { supportsReasoningEffort: false, reasoningEfforts: [] };
}

/** Capacidades TTS curadas (igual que `ttsModelCapabilities` del pipeline). */
export function ttsCapabilitiesFor(id) {
  const s = String(id ?? '').toLowerCase();
  const caps = {
    supportsStyle: false,
    supportsSpeakerBoost: false,
    supportsLanguageCode: false,
    supportsSpeed: true,
    supportsNormalizationOn: true,
    stabilityPresets: null,
  };
  if (/^eleven_(multilingual_v2|multilingual_v1|monolingual_v1)$/.test(s)) {
    caps.supportsStyle = true;
    caps.supportsSpeakerBoost = true;
  } else if (/^eleven_(flash|turbo)_v2_5$/.test(s)) {
    caps.supportsLanguageCode = true;
    caps.supportsNormalizationOn = false;
  } else if (/^eleven_(flash|turbo)_v2$/.test(s)) {
    caps.supportsNormalizationOn = false;
  } else if (/^eleven_v3/.test(s)) {
    caps.supportsLanguageCode = true;
    caps.supportsSpeed = false;
    caps.supportsSpeakerBoost = s === 'eleven_v3_conversational';
    caps.stabilityPresets = [0, 0.5, 1];
  }
  return caps;
}

const TTS_CAP_KEYS = ['supportsStyle', 'supportsSpeakerBoost', 'supportsLanguageCode', 'supportsSpeed', 'supportsNormalizationOn', 'stabilityPresets'];

// ── Descripción de cada modelo ──────────────────────────────────────────────

const round = (n, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;

function prettify(id) {
  const tail = String(id).split('/').at(-1);
  return tail.replace(/[-_]+/g, ' ').replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

function perMillion(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? round(n * 1_000_000, 4) : null;
}

export function describeSttModel(raw, source = 'live') {
  const id = String(raw.id);
  const meta = STT_META[id] ?? {};
  return {
    id,
    label: meta.label ?? prettify(id),
    description: meta.description ?? 'Modelo Whisper de Groq sin ficha propia.',
    recommended: Boolean(meta.recommended),
    supportsReasoningEffort: false,
    reasoningEfforts: [],
    price: { unit: 'hora de audio', usd: sttPriceFor(id).usdPerHour },
    available: true,
    source,
    order: meta.order ?? 50,
  };
}

export function describeTranslateModel(raw, source = 'live') {
  const id = String(raw.id);
  const meta = CHAT_META.find((m) => m.match.test(id)) ?? {};
  const table = chatPriceFor(id);
  const liveIn = perMillion(raw.pricing?.prompt);
  const liveOut = perMillion(raw.pricing?.completion);
  const live = liveIn !== null && liveOut !== null;
  const model = {
    id,
    label: meta.label ?? prettify(id),
    description: meta.description ?? 'Modelo de chat de Groq sin ficha propia.',
    recommended: Boolean(meta.recommended),
    ...reasoningProfileFor(id),
    price: {
      unit: '1M tokens de entrada',
      usd: live ? liveIn : table.input,
      usdOutput: live ? liveOut : table.output,
      outputUnit: '1M tokens de salida',
      source: live ? 'live' : table.known ? 'table' : 'estimate',
    },
    available: true,
    source,
    order: meta.order ?? 50,
  };
  const ctx = Number(raw.context_window);
  if (Number.isFinite(ctx) && ctx > 0) model.contextWindow = ctx;
  return model;
}

export function describeTtsModel(raw, source = 'live') {
  const id = String(raw.model_id ?? raw.id);
  const meta = TTS_META[id] ?? {};
  const caps = ttsCapabilitiesFor(id);
  // Los flags en vivo de ElevenLabs mandan sobre los curados.
  if (typeof raw.can_use_style === 'boolean') caps.supportsStyle = raw.can_use_style;
  if (typeof raw.can_use_speaker_boost === 'boolean') caps.supportsSpeakerBoost = raw.can_use_speaker_boost;
  const liveMultiplier = Number(raw.model_rates?.character_cost_multiplier);
  const costMultiplier = ttsCostMultiplierFor(id, Number.isFinite(liveMultiplier) && liveMultiplier > 0 ? liveMultiplier : undefined);
  const languages = Array.isArray(raw.languages) ? raw.languages.length : meta.languages ?? null;
  const maxChars = Number(raw.maximum_text_length_per_request) || meta.maxChars || null;
  return {
    id,
    label: meta.label ?? (typeof raw.name === 'string' && raw.name ? raw.name : prettify(id)),
    description: meta.description ?? `Modelo de ElevenLabs sin ficha propia${languages ? ` (${languages} idiomas)` : ''}.`,
    recommended: Boolean(meta.recommended),
    supportsReasoningEffort: false,
    reasoningEfforts: [],
    price: { unit: '1k caracteres', usd: round(TTS_BASE_USD_PER_1K_CHARS * costMultiplier) },
    languages,
    costMultiplier,
    ...caps,
    maxChars,
    available: true,
    source,
    order: meta.order ?? 50,
  };
}

function isActive(raw) {
  return raw && raw.active !== false;
}

export function isSttCandidate(raw) {
  return isActive(raw) && /whisper/i.test(String(raw.id ?? ''));
}

export function isTranslateCandidate(raw) {
  if (!isActive(raw)) return false;
  const id = String(raw.id ?? '');
  if (!id || EXCLUDED_CHAT.test(id)) return false;
  const out = raw.output_modalities;
  const input = raw.input_modalities;
  if (Array.isArray(out) && !out.includes('text')) return false;
  if (Array.isArray(input) && !input.includes('text')) return false;
  return true;
}

export function isTtsCandidate(raw) {
  return raw && raw.can_do_text_to_speech === true && raw.requires_alpha_access !== true && Boolean(raw.model_id);
}

function sortModels(list) {
  return list
    .sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.order - b.order || a.label.localeCompare(b.label, 'es'))
    .map(({ order, ...rest }) => rest);
}

/** Construye las tres listas a partir de las respuestas crudas de Groq y ElevenLabs. */
export function buildCatalog({ groq = [], elevenlabs = [], groqSource = 'live', elevenSource = 'live' } = {}) {
  return {
    stt: sortModels(groq.filter(isSttCandidate).map((m) => describeSttModel(m, groqSource))),
    translate: sortModels(groq.filter(isTranslateCandidate).map((m) => describeTranslateModel(m, groqSource))),
    tts: sortModels(elevenlabs.filter(isTtsCandidate).map((m) => describeTtsModel(m, elevenSource))),
  };
}

// ── Catálogo con caché ──────────────────────────────────────────────────────

class ProviderHttpError extends Error {
  constructor(provider, status, body) {
    super(`${provider === 'groq' ? 'Groq' : 'ElevenLabs'} models ${status}: ${String(body ?? '').slice(0, 300)}`);
    this.status = status;
    this.body = body;
    this.provider = provider;
  }
}

function keyHash(key) {
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
}

export class ModelCatalog {
  #cache = new Map();
  #lastLive = { groq: null, elevenlabs: null };

  /**
   * @param {object} options
   * @param {() => Promise<{ groq?: string, elevenlabs?: string }>} options.getKeys  Keys guardadas (store).
   * @param {typeof fetch} [options.fetch]
   * @param {() => number} [options.now]  Reloj de pared en ms (tests).
   */
  constructor({ getKeys, fetch: fetchImpl, now = () => Date.now(), ttlMs = MODELS_TTL_MS, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
    if (typeof getKeys !== 'function') throw new TypeError('ModelCatalog: falta getKeys');
    this.getKeys = getKeys;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
  }

  async #fetchJson(provider, url, headers) {
    const doFetch = this.fetchImpl ?? globalThis.fetch;
    const res = await doFetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch { /* sin cuerpo */ }
      throw new ProviderHttpError(provider, res.status, body);
    }
    return res.json();
  }

  async #section(provider, apiKey, refresh) {
    const label = provider === 'groq' ? 'Groq' : 'ElevenLabs';
    if (!apiKey) {
      return {
        source: 'static',
        raw: provider === 'groq' ? STATIC_GROQ : STATIC_ELEVEN,
        error: { code: 'missing_key', message: `Falta la API key de ${label}: se muestra el catálogo de referencia.` },
      };
    }
    const cacheKey = `${provider}:${keyHash(apiKey)}`;
    const cached = this.#cache.get(cacheKey);
    if (!refresh && cached && this.now() - cached.fetchedAt < this.ttlMs) return { source: 'live', raw: cached.raw, fetchedAt: cached.fetchedAt, cached: true };
    try {
      let raw;
      if (provider === 'groq') {
        const data = await this.#fetchJson('groq', GROQ_MODELS_URL, { Authorization: `Bearer ${apiKey}` });
        raw = Array.isArray(data?.data) ? data.data : [];
      } else {
        const data = await this.#fetchJson('elevenlabs', ELEVEN_MODELS_URL, { 'xi-api-key': apiKey });
        raw = Array.isArray(data) ? data : Array.isArray(data?.models) ? data.models : [];
      }
      const fetchedAt = this.now();
      this.#cache.set(cacheKey, { raw, fetchedAt });
      this.#lastLive[provider] = raw;
      return { source: 'live', raw, fetchedAt };
    } catch (error) {
      const { code, message } = friendlyError(Object.assign(error, { provider }));
      return { source: 'static', raw: provider === 'groq' ? STATIC_GROQ : STATIC_ELEVEN, error: { code, message } };
    }
  }

  /**
   * Respuesta de `models.list`. `settings` (opcional) asegura que los modelos
   * elegidos aparezcan aunque ya no estén en el catálogo (con `available: false`).
   */
  async list({ refresh = false, settings = null } = {}) {
    const keys = (await this.getKeys()) ?? {};
    const [groq, elevenlabs] = await Promise.all([
      this.#section('groq', keys.groq, refresh),
      this.#section('elevenlabs', keys.elevenlabs, refresh),
    ]);
    const catalog = buildCatalog({ groq: groq.raw, elevenlabs: elevenlabs.raw, groqSource: groq.source, elevenSource: elevenlabs.source });

    if (settings) {
      ensureSelected(catalog.stt, settings.sttModel, groq.source, (id) => describeSttModel({ id }, groq.source));
      ensureSelected(catalog.translate, settings.translateModel, groq.source, (id) => describeTranslateModel({ id }, groq.source));
      ensureSelected(catalog.tts, settings.ttsModel, elevenlabs.source, (id) => describeTtsModel({ model_id: id }, elevenlabs.source));
    }

    const liveTimes = [groq.fetchedAt, elevenlabs.fetchedAt].filter(Number.isFinite);
    const errors = {};
    if (groq.error) errors.groq = groq.error;
    if (elevenlabs.error) errors.elevenlabs = elevenlabs.error;
    return {
      ...catalog,
      defaults: { ...MODEL_DEFAULTS },
      offline: groq.source !== 'live' || elevenlabs.source !== 'live',
      fetchedAt: new Date(liveTimes.length ? Math.min(...liveTimes) : this.now()).toISOString(),
      sources: { groq: groq.source, elevenlabs: elevenlabs.source },
      errors,
    };
  }

  /** Ficha del modelo TTS: última lista en vivo si la hay, si no el respaldo curado. */
  ttsInfo(modelId = DEFAULTS.ttsModel) {
    const id = String(modelId || DEFAULTS.ttsModel);
    const live = this.#lastLive.elevenlabs?.find((m) => m?.model_id === id);
    if (live) return describeTtsModel(live, 'live');
    return describeTtsModel(STATIC_ELEVEN.find((m) => m.model_id === id) ?? { model_id: id }, 'static');
  }

  /**
   * Lo que el pipeline necesita saber del modelo TTS elegido:
   * `{ ttsCapabilities, ttsCostMultiplier }` (se pasa a createPipeline y a applyLiveSettings).
   */
  capabilitiesFor(settings = {}) {
    const info = this.ttsInfo(settings.ttsModel);
    const ttsCapabilities = {};
    for (const key of TTS_CAP_KEYS) ttsCapabilities[key] = info[key];
    return { ttsCapabilities, ttsCostMultiplier: info.costMultiplier };
  }

  clear() {
    this.#cache.clear();
    this.#lastLive = { groq: null, elevenlabs: null };
  }
}

function ensureSelected(list, id, source, describe) {
  if (!id || list.some((m) => m.id === id)) return;
  const { order, ...model } = describe(id);
  if (source === 'live') {
    model.available = false;
    model.description = 'No aparece en el catálogo de tu cuenta: puede estar retirado o sin acceso. Elige otro.';
  }
  list.push(model);
}

export default ModelCatalog;
