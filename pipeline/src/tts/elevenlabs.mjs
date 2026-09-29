// TTS y clonación de voz con ElevenLabs.
//
// Síntesis: `eleven_multilingual_v2` con la voz clonada del usuario. Se pide
// PCM s16le en cascada 48000 → 44100 → 24000 (los rates altos dependen del
// tier de la cuenta; solo se baja de formato cuando ElevenLabs rechaza
// específicamente el formato, no ante 429/5xx/red) y como último recurso
// mp3_44100_128 para cuentas sin ningún PCM habilitado.
//
// Clonación: Instant Voice Cloning (`POST /v1/voices/add`, multipart) y
// Professional Voice Cloning (`POST /v1/voices/pvc` + samples + train).
//
// Modelo configurable (protocolo v3). Se usa siempre el endpoint no-stream
// `POST /v1/text-to-speech/{voice_id}`, que admite todos los modelos TTS
// (incluido `eleven_v3`, que no está pensado para `/stream` de baja latencia);
// el doblaje necesita el turno completo antes de encolarlo, así que el
// streaming no aporta nada aquí. Cada modelo admite un subconjunto distinto de
// parámetros (ver `ttsModelCapabilities`): solo se mandan los que admite.

import { fetchWithRetry, throwHttpError, isAbortError, safeText, truncate } from "../util/http.mjs";

export const ELEVEN_BASE_URL = "https://api.elevenlabs.io/v1";
export const DEFAULT_TTS_MODEL = "eleven_multilingual_v2";

/** `eleven_v3` solo acepta estos valores de estabilidad (Creativo, Natural, Robusto). */
export const V3_STABILITY_PRESETS = Object.freeze([0, 0.5, 1]);
/** Valores de `apply_text_normalization`. */
export const TEXT_NORMALIZATION_MODES = Object.freeze(["auto", "on", "off"]);
export const SPEED_RANGE = Object.freeze({ min: 0.7, max: 1.2 });

/**
 * Capacidades por modelo (qué parámetros admite). Son los valores curados por
 * defecto; el engine los pisa con los flags en vivo de `GET /v1/models`
 * (`can_use_style`, `can_use_speaker_boost`). Debe coincidir con el catálogo
 * de app/engine/models.mjs.
 *   - supportsLanguageCode: `language_code` fuerza el idioma (Flash/Turbo v2.5 y v3);
 *     el resto responde error si se manda.
 *   - supportsNormalizationOn: Flash/Turbo no permiten `apply_text_normalization: on`.
 *   - stabilityPresets: v3 solo acepta 0 / 0.5 / 1.
 */
export function ttsModelCapabilities(modelId) {
  const id = String(modelId ?? "").toLowerCase();
  const caps = {
    supportsStyle: false,
    supportsSpeakerBoost: false,
    supportsLanguageCode: false,
    supportsSpeed: true,
    supportsNormalizationOn: true,
    stabilityPresets: null,
  };
  if (/^eleven_(multilingual_v2|multilingual_v1|monolingual_v1)$/.test(id)) {
    caps.supportsStyle = true;
    caps.supportsSpeakerBoost = true;
  } else if (/^eleven_(flash|turbo)_v2_5$/.test(id)) {
    caps.supportsLanguageCode = true;
    caps.supportsNormalizationOn = false;
  } else if (/^eleven_(flash|turbo)_v2$/.test(id)) {
    caps.supportsNormalizationOn = false;
  } else if (/^eleven_v3/.test(id)) {
    caps.supportsLanguageCode = true;
    caps.supportsSpeed = false;
    caps.supportsSpeakerBoost = id === "eleven_v3_conversational";
    caps.stabilityPresets = [...V3_STABILITY_PRESETS];
  }
  return caps;
}

const CAPABILITY_KEYS = ["supportsStyle", "supportsSpeakerBoost", "supportsLanguageCode", "supportsSpeed", "supportsNormalizationOn", "stabilityPresets"];

/** Capacidades curadas del modelo + las que lleguen del catálogo en vivo (solo claves conocidas). */
export function resolveTtsCapabilities(modelId, overrides = null) {
  const caps = ttsModelCapabilities(modelId);
  if (overrides && typeof overrides === "object") {
    for (const key of CAPABILITY_KEYS) {
      if (overrides[key] === undefined) continue;
      if (key === "stabilityPresets") {
        caps.stabilityPresets = Array.isArray(overrides.stabilityPresets) && overrides.stabilityPresets.length
          ? overrides.stabilityPresets.map(Number).filter(Number.isFinite)
          : null;
      } else {
        caps[key] = Boolean(overrides[key]);
      }
    }
  }
  return caps;
}

/** Valor del preset más cercano (empate → el más estable). */
export function snapToPreset(value, presets) {
  if (!Array.isArray(presets) || !presets.length) return value;
  let best = presets[0];
  for (const p of presets) {
    if (Math.abs(p - value) < Math.abs(best - value) || (Math.abs(p - value) === Math.abs(best - value) && p > best)) best = p;
  }
  return best;
}

/**
 * Body JSON de `POST /v1/text-to-speech/{voice_id}` con solo los campos que
 * admite el modelo. `voiceSettings` ya normalizado (ver `normalizeVoiceSettings`).
 */
export function buildTtsBody({ text, modelId = DEFAULT_TTS_MODEL, voiceSettings = DEFAULT_VOICE_SETTINGS, capabilities, languageCode, textNormalization = "auto" }) {
  const caps = capabilities ?? ttsModelCapabilities(modelId);
  const vs = normalizeVoiceSettings(voiceSettings);
  const settings = {
    stability: caps.stabilityPresets ? snapToPreset(vs.stability, caps.stabilityPresets) : vs.stability,
    similarity_boost: vs.similarity_boost,
  };
  if (caps.supportsStyle) settings.style = vs.style;
  if (caps.supportsSpeakerBoost) settings.use_speaker_boost = vs.use_speaker_boost;
  if (caps.supportsSpeed) settings.speed = vs.speed;
  const body = { text, model_id: modelId, voice_settings: settings };
  if (languageCode && caps.supportsLanguageCode) body.language_code = String(languageCode).toLowerCase().split(/[-_]/)[0];
  let normalization = TEXT_NORMALIZATION_MODES.includes(textNormalization) ? textNormalization : "auto";
  if (normalization === "on" && caps.supportsNormalizationOn === false) normalization = "auto";
  // `auto` es el default de la API: no se manda para no chocar con modelos viejos.
  if (normalization !== "auto") body.apply_text_normalization = normalization;
  return body;
}

/** ¿El error se debe a `language_code` no admitido por el modelo? */
export function isLanguageCodeRejected(status, body) {
  return (status === 400 || status === 422) && /language_code|language code|unsupported_language|unsupported language/i.test(String(body ?? ""));
}

export const ELEVEN_PCM_FORMATS = Object.freeze([
  Object.freeze({ outputFormat: "pcm_48000", sampleRate: 48_000 }),
  Object.freeze({ outputFormat: "pcm_44100", sampleRate: 44_100 }),
  Object.freeze({ outputFormat: "pcm_24000", sampleRate: 24_000 }),
]);
export const ELEVEN_MP3_FALLBACK = "mp3_44100_128";

/**
 * Ajustes de voz por defecto para doblaje de reunión con voz clonada: alta
 * similitud y estabilidad media-alta (voz consistente entre turnos), sin
 * exageración de estilo, con speaker boost para fidelidad del timbre.
 */
export const DEFAULT_VOICE_SETTINGS = Object.freeze({
  stability: 0.6,
  similarity_boost: 0.85,
  style: 0.1,
  use_speaker_boost: true,
  speed: 1,
});

/** Requisitos documentados para Professional Voice Cloning. */
export const PVC_REQUIREMENTS = Object.freeze({
  minTotalMinutes: 30,
  recommendedTotalMinutes: 180,
  maxTotalMinutes: 180,
  maxFileBytes: 1024 * 1024 * 1024,
  guidance: [
    "Mínimo 30 minutos de audio limpio; se recomiendan entre 30 minutos y 3 horas.",
    "Un solo hablante, sin música, ruido de fondo ni reverberación; sin procesado agresivo.",
    "Mismo estilo de habla que se usará en las reuniones (ritmo, tono profesional).",
    "WAV/MP3 a 44.1 kHz o superior; evitar resampleos y compresión fuerte.",
    "Tras subir las muestras, ElevenLabs exige verificación de identidad y el entrenamiento tarda horas.",
  ],
});

/** Requisitos documentados para Instant Voice Cloning. */
export const IVC_REQUIREMENTS = Object.freeze({
  minTotalSeconds: 60,
  recommendedTotalSeconds: 180,
  maxFiles: 25,
  maxTotalBytes: 10 * 1024 * 1024,
  guidance: [
    "Al menos 1 minuto de audio en total; entre 1 y 3 minutos es el punto óptimo.",
    "Audio limpio, un solo hablante, sin música ni ruido.",
    "Hasta 25 archivos y 10 MB en total (WAV/MP3/M4A).",
  ],
});

export class TtsError extends Error {
  constructor(message, { cause, status, outputFormat, model, stage = "tts" } = {}) {
    super(message, { cause });
    this.name = "TtsError";
    this.status = status;
    this.outputFormat = outputFormat;
    this.stage = stage;
    if (model) this.model = model;
  }
}

/** ElevenLabs rechaza formatos PCM no incluidos en el plan con 400/403 y estos mensajes. */
export function isUnavailablePcmFormat(status, body) {
  if (status !== 400 && status !== 403) return false;
  return /output_format_not_allowed|subscription_required|output format|invalid_output_format/i.test(String(body ?? ""));
}

/** Normaliza y valida `voice_settings` (rangos 0..1; `speed` 0.7..1.2). */
export function normalizeVoiceSettings(settings = {}) {
  const merged = { ...DEFAULT_VOICE_SETTINGS, ...(settings ?? {}) };
  const clamp = (v, fallback, min = 0, max = 1) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    stability: clamp(merged.stability, DEFAULT_VOICE_SETTINGS.stability),
    similarity_boost: clamp(merged.similarity_boost, DEFAULT_VOICE_SETTINGS.similarity_boost),
    style: clamp(merged.style, DEFAULT_VOICE_SETTINGS.style),
    use_speaker_boost: Boolean(merged.use_speaker_boost),
    speed: clamp(merged.speed, DEFAULT_VOICE_SETTINGS.speed, SPEED_RANGE.min, SPEED_RANGE.max),
  };
}

/**
 * Ajustes planos del engine (`ttsStability`, `ttsSimilarityBoost`, `ttsStyle`,
 * `ttsSpeed`, `ttsSpeakerBoost`) → `voice_settings` de ElevenLabs. Solo incluye
 * las claves presentes (sirve para parches en caliente).
 */
export function voiceSettingsFromFlat(settings = {}) {
  const map = { ttsStability: "stability", ttsSimilarityBoost: "similarity_boost", ttsStyle: "style", ttsSpeed: "speed", ttsSpeakerBoost: "use_speaker_boost" };
  const out = {};
  for (const [flat, key] of Object.entries(map)) if (settings?.[flat] !== undefined) out[key] = settings[flat];
  return out;
}

function authHeaders(apiKey, extra = {}) {
  return { "xi-api-key": apiKey, ...extra };
}

export class ElevenLabsTts {
  #apiKey;
  #fetch;
  /** Modelos que rechazaron `language_code`: no se vuelve a mandar. */
  #noLanguageCode = new Set();

  constructor({
    apiKey = process.env.ELEVENLABS_API_KEY,
    modelId = DEFAULT_TTS_MODEL,
    voiceSettings = {},
    capabilities = null,
    textNormalization = "auto",
    baseUrl = ELEVEN_BASE_URL,
    timeoutMs = 60_000,
    retries = 2,
    sleep,
    fetch: fetchImpl,
    logger = null,
  } = {}) {
    if (!apiKey) throw new TypeError("ElevenLabsTts: falta `apiKey` (ELEVENLABS_API_KEY)");
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.modelId = String(modelId || DEFAULT_TTS_MODEL);
    this.capabilities = resolveTtsCapabilities(this.modelId, capabilities);
    this.voiceSettings = normalizeVoiceSettings(voiceSettings);
    this.textNormalization = TEXT_NORMALIZATION_MODES.includes(textNormalization) ? textNormalization : "auto";
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.sleep = sleep;
    this.logger = logger;
  }

  setVoiceSettings(settings) {
    this.voiceSettings = normalizeVoiceSettings({ ...this.voiceSettings, ...settings });
    return this.voiceSettings;
  }

  /** Cambia el modelo en caliente (desde la siguiente síntesis) con sus capacidades. */
  setModel(modelId, capabilities = null) {
    if (modelId) this.modelId = String(modelId);
    this.capabilities = resolveTtsCapabilities(this.modelId, capabilities);
    return this.modelId;
  }

  setTextNormalization(mode) {
    if (TEXT_NORMALIZATION_MODES.includes(mode)) this.textNormalization = mode;
    return this.textNormalization;
  }

  /** Body que se mandaría para `text` con el modelo y ajustes actuales (útil para diagnóstico). */
  buildBody({ text, modelId = this.modelId, voiceSettings, languageCode } = {}) {
    const settings = voiceSettings ? normalizeVoiceSettings({ ...this.voiceSettings, ...voiceSettings }) : this.voiceSettings;
    const capabilities = modelId === this.modelId ? this.capabilities : ttsModelCapabilities(modelId);
    return buildTtsBody({
      text,
      modelId,
      voiceSettings: settings,
      capabilities,
      languageCode: this.#noLanguageCode.has(modelId) ? null : languageCode,
      textNormalization: this.textNormalization,
    });
  }

  async #request({ voiceId, outputFormat, accept, body, signal }) {
    const url = `${this.baseUrl}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;
    return fetchWithRetry(
      url,
      {
        method: "POST",
        headers: authHeaders(this.#apiKey, { "Content-Type": "application/json", Accept: accept }),
        body: JSON.stringify(body),
      },
      { retries: this.retries, timeoutMs: this.timeoutMs, signal, sleep: this.sleep, provider: "ElevenLabs", fetch: this.#fetch },
    );
  }

  /**
   * Sintetiza `text` y devuelve `{ audio: Buffer, audioFormat: 'pcm_s16le'|'mp3',
   * sampleRate, outputFormat, modelId, voiceId, chars, requestId }`.
   * Si se pasa `outputFormat` explícito no hay cascada: se usa ese o falla.
   */
  async synthesize({ text, voiceId, modelId = this.modelId, outputFormat, voiceSettings, languageCode, signal, allowMp3Fallback = true } = {}) {
    const content = String(text ?? "").trim();
    if (!content) throw new TtsError("ElevenLabs: texto vacío");
    if (!voiceId) throw new TtsError("ElevenLabs: falta `voiceId`");
    // El body se arma una vez por turno: un cambio de modelo en caliente no afecta al turno en vuelo.
    const body = this.buildBody({ text: content, modelId, voiceSettings, languageCode });
    const candidates = outputFormat
      ? [{ outputFormat, sampleRate: pcmRateFromFormat(outputFormat) }]
      : ELEVEN_PCM_FORMATS;

    let lastFormatError = "";
    for (const candidate of candidates) {
      const isPcm = candidate.outputFormat.startsWith("pcm_");
      const accept = isPcm ? "audio/pcm" : "audio/mpeg";
      const send = () => this.#wrap(() => this.#request({ voiceId, outputFormat: candidate.outputFormat, accept, body, signal }), signal, candidate.outputFormat, modelId);
      let res = await send();
      if (res.ok) return this.#result(res, { candidate, isPcm, modelId, voiceId, chars: content.length });
      let errorBody = await safeText(res);
      if (body.language_code && isLanguageCodeRejected(res.status, errorBody)) {
        // El modelo no admite forzar idioma: se recuerda y se repite sin `language_code`.
        this.logger?.debug?.("tts.language_code_unsupported", { modelId });
        this.#noLanguageCode.add(modelId);
        delete body.language_code;
        res = await send();
        if (res.ok) return this.#result(res, { candidate, isPcm, modelId, voiceId, chars: content.length });
        errorBody = await safeText(res);
      }
      if (!outputFormat && isUnavailablePcmFormat(res.status, errorBody)) {
        this.logger?.debug?.("tts.format_unavailable", { outputFormat: candidate.outputFormat, status: res.status });
        lastFormatError = errorBody;
        continue;
      }
      throw new TtsError(`ElevenLabs ${res.status}: ${truncate(errorBody)}`, { status: res.status, outputFormat: candidate.outputFormat, model: modelId });
    }

    if (!allowMp3Fallback) {
      throw new TtsError(`ElevenLabs: ningún formato PCM disponible en la cuenta (${truncate(lastFormatError)})`, { status: 403, model: modelId });
    }
    // Compatibilidad fail-open para cuentas que no habiliten ningún PCM.
    const fallback = await this.#wrap(() =>
      this.#request({ voiceId, outputFormat: ELEVEN_MP3_FALLBACK, accept: "audio/mpeg", body, signal }), signal, ELEVEN_MP3_FALLBACK, modelId);
    if (!fallback.ok) {
      const errorBody = await safeText(fallback);
      throw new TtsError(`ElevenLabs ${fallback.status}: ${truncate(errorBody || lastFormatError)}`, { status: fallback.status, outputFormat: ELEVEN_MP3_FALLBACK, model: modelId });
    }
    return this.#result(fallback, { candidate: { outputFormat: ELEVEN_MP3_FALLBACK, sampleRate: null }, isPcm: false, modelId, voiceId, chars: content.length });
  }

  async #wrap(fn, signal, outputFormat, model) {
    try {
      return await fn();
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      throw new TtsError(`ElevenLabs: ${error.message}`, { cause: error, status: error.status, outputFormat, model });
    }
  }

  async #result(res, { candidate, isPcm, modelId, voiceId, chars }) {
    const audio = Buffer.from(await res.arrayBuffer());
    if (!audio.length) throw new TtsError("ElevenLabs devolvió audio vacío", { outputFormat: candidate.outputFormat, model: modelId });
    const contentType = res.headers?.get?.("content-type") || "";
    // Si pedimos PCM pero llega mpeg, se respeta lo que vino de verdad.
    const mp3 = !isPcm || /audio\/mpeg/i.test(contentType);
    return {
      audio,
      audioFormat: mp3 ? "mp3" : "pcm_s16le",
      sampleRate: mp3 ? null : candidate.sampleRate,
      outputFormat: candidate.outputFormat,
      modelId,
      voiceId,
      chars,
      requestId: res.headers?.get?.("request-id") || null,
      characterCost: Number(res.headers?.get?.("x-character-count")) || null,
    };
  }
}

function pcmRateFromFormat(outputFormat) {
  const m = /^pcm_(\d+)$/.exec(String(outputFormat));
  return m ? Number(m[1]) : null;
}

/** Gestión de voces clonadas (IVC/PVC) del usuario. */
export class VoiceCloning {
  #apiKey;
  #fetch;

  constructor({ apiKey = process.env.ELEVENLABS_API_KEY, baseUrl = ELEVEN_BASE_URL, timeoutMs = 120_000, retries = 1, sleep, fetch: fetchImpl } = {}) {
    if (!apiKey) throw new TypeError("VoiceCloning: falta `apiKey` (ELEVENLABS_API_KEY)");
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.sleep = sleep;
  }

  async #call(path, { method = "GET", body, headers = {}, signal, retries = this.retries } = {}) {
    const url = `${this.baseUrl}${path}`;
    let res;
    try {
      res = await fetchWithRetry(
        url,
        { method, headers: authHeaders(this.#apiKey, headers), body },
        { retries, timeoutMs: this.timeoutMs, signal, sleep: this.sleep, provider: "ElevenLabs Voices", fetch: this.#fetch },
      );
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      throw new TtsError(`ElevenLabs Voices: ${error.message}`, { cause: error, status: error.status });
    }
    if (!res.ok) {
      await throwHttpError(res, "ElevenLabs Voices", url).catch((error) => {
        throw new TtsError(error.message, { cause: error, status: error.status });
      });
    }
    if (res.status === 204) return {};
    const text = await safeText(res);
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  static #appendFiles(form, files) {
    if (!Array.isArray(files) || !files.length) throw new TtsError("VoiceCloning: se requiere al menos un archivo de muestra");
    for (const [i, file] of files.entries()) {
      const buffer = file?.buffer ?? file;
      if (!buffer?.byteLength) throw new TtsError(`VoiceCloning: muestra ${i} vacía`);
      form.append("files", new Blob([buffer], { type: file?.mimeType || "audio/wav" }), file?.name || `sample-${i + 1}.wav`);
    }
  }

  /**
   * Instant Voice Cloning. `files`: `[{ buffer, name, mimeType }]`.
   * Devuelve `{ voiceId, requiresVerification }`.
   */
  async createInstantVoice({ name, files, description = "", labels = null, removeBackgroundNoise = false, signal } = {}) {
    if (!name) throw new TtsError("VoiceCloning: `name` obligatorio");
    const form = new FormData();
    form.append("name", String(name));
    if (description) form.append("description", String(description));
    if (labels && typeof labels === "object") form.append("labels", JSON.stringify(labels));
    if (removeBackgroundNoise) form.append("remove_background_noise", "true");
    VoiceCloning.#appendFiles(form, files);
    // Multipart no se reintenta: subir muestras dos veces crearía dos voces.
    const data = await this.#call("/voices/add", { method: "POST", body: form, signal, retries: 0 });
    if (!data?.voice_id) throw new TtsError("ElevenLabs no devolvió voice_id");
    return { voiceId: data.voice_id, requiresVerification: Boolean(data.requires_verification) };
  }

  async listVoices({ signal } = {}) {
    const data = await this.#call("/voices", { signal });
    return (Array.isArray(data?.voices) ? data.voices : []).map(VoiceCloning.normalizeVoice);
  }

  async getVoice(voiceId, { signal } = {}) {
    if (!voiceId) throw new TtsError("VoiceCloning.getVoice: `voiceId` obligatorio");
    const data = await this.#call(`/voices/${encodeURIComponent(voiceId)}`, { signal });
    return VoiceCloning.normalizeVoice(data);
  }

  async deleteVoice(voiceId, { signal } = {}) {
    if (!voiceId) throw new TtsError("VoiceCloning.deleteVoice: `voiceId` obligatorio");
    const data = await this.#call(`/voices/${encodeURIComponent(voiceId)}`, { method: "DELETE", signal });
    return { ok: data?.status === "ok" || data?.status === undefined };
  }

  /**
   * Professional Voice Cloning: crea la voz (sin muestras). Después se llama
   * `addProfessionalSamples()` y `trainProfessionalClone()`; ElevenLabs pedirá
   * verificación de identidad antes de entrenar.
   */
  async startProfessionalClone({ name, language = "es", description = "", labels = null, signal } = {}) {
    if (!name) throw new TtsError("VoiceCloning: `name` obligatorio");
    const body = { name: String(name), language };
    if (description) body.description = String(description);
    if (labels && typeof labels === "object") body.labels = labels;
    const data = await this.#call("/voices/pvc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
      retries: 0,
    });
    if (!data?.voice_id) throw new TtsError("ElevenLabs no devolvió voice_id para PVC");
    return { voiceId: data.voice_id, requirements: PVC_REQUIREMENTS };
  }

  async addProfessionalSamples(voiceId, files, { removeBackgroundNoise = false, signal } = {}) {
    if (!voiceId) throw new TtsError("VoiceCloning.addProfessionalSamples: `voiceId` obligatorio");
    const form = new FormData();
    if (removeBackgroundNoise) form.append("remove_background_noise", "true");
    VoiceCloning.#appendFiles(form, files);
    const data = await this.#call(`/voices/pvc/${encodeURIComponent(voiceId)}/samples`, { method: "POST", body: form, signal, retries: 0 });
    const samples = Array.isArray(data) ? data : Array.isArray(data?.samples) ? data.samples : [];
    return { sampleIds: samples.map((s) => s?.sample_id).filter(Boolean), raw: data };
  }

  async trainProfessionalClone(voiceId, { modelId = DEFAULT_TTS_MODEL, signal } = {}) {
    if (!voiceId) throw new TtsError("VoiceCloning.trainProfessionalClone: `voiceId` obligatorio");
    const data = await this.#call(`/voices/pvc/${encodeURIComponent(voiceId)}/train`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_id: modelId }),
      signal,
      retries: 0,
    });
    return { status: data?.status ?? "ok" };
  }

  static normalizeVoice(v = {}) {
    return {
      voiceId: v.voice_id ?? null,
      name: v.name ?? null,
      category: v.category ?? null,
      description: v.description ?? null,
      labels: v.labels ?? {},
      previewUrl: v.preview_url ?? null,
      samples: Array.isArray(v.samples) ? v.samples.length : 0,
      fineTuning: v.fine_tuning ?? null,
      raw: v,
    };
  }
}
