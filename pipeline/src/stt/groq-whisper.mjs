// STT con Groq Whisper (`whisper-large-v3`) por turno completo.
//
// La unidad de trabajo es el turno cerrado por VAD (PCM s16le mono 16 kHz):
// se envuelve en WAV y se manda a `POST /openai/v1/audio/transcriptions` con
// `verbose_json` para obtener `no_speech_prob`/`avg_logprob` por segmento, que
// son la señal real de Whisper de "esto no era voz". Groq no ofrece streaming,
// así que no hay modo WebSocket.
//
// El vocabulario custom (nombres propios, jerga) va en el campo `prompt`, que
// Whisper usa como contexto previo: sesga la ortografía de los términos sin
// forzarlos. Whisper solo mira los últimos ~224 tokens del prompt, por eso se
// acota el largo.

import { pcmToWav, pcmDurationMs } from "../util/wav.mjs";
import { fetchWithRetry, throwHttpError, isAbortError } from "../util/http.mjs";
import { normalizeLanguage } from "../languages.mjs";

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
export const DEFAULT_WHISPER_MODEL = "whisper-large-v3";

/**
 * Whisper alucina estas muletillas de cierre de video a partir de silencio o
 * ruido de fondo (viene de sus datos de entrenamiento con subtítulos). El match
 * es exacto sobre texto normalizado (sin puntuación ni acentos).
 */
export const WHISPER_HALLUCINATIONS = Object.freeze([
  "subtitulos realizados por la comunidad de amara.org",
  "subtitulos por la comunidad de amara.org",
  "subtitulado por la comunidad de amara.org",
  "gracias por ver el video",
  "gracias por ver",
  "gracias por verme",
  "muchas gracias por ver",
  "suscribete al canal",
  "no olvides suscribirte",
  "nos vemos en el proximo video",
  "thank you for watching",
  "thanks for watching",
  "subtitles by the amara.org community",
  "please subscribe",
]);

/** Textos cortos que Whisper produce ante silencio; solo se descartan con señales débiles. */
export const SHORT_SUSPICIOUS_TRANSCRIPTS = new Set(["gracias", "muchas gracias", "thanks", "thank you", "ok", "okay", "si", "no"]);

/** Aproximación conservadora: ~4 caracteres por token en texto latino. */
const PROMPT_MAX_TOKENS = 224;
const CHARS_PER_TOKEN = 4;

export class SttError extends Error {
  constructor(message, { cause, status, model } = {}) {
    super(message, { cause });
    this.name = "SttError";
    this.status = status;
    this.stage = "stt";
    if (model) this.model = model;
  }
}

/** Temperatura de muestreo de Whisper acotada a 0..1 (0 = determinista, lo recomendado). */
export function clampSttTemperature(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/** Quita puntuación, acentos y espacios repetidos para comparar contra la lista de alucinaciones. */
export function normalizeForHallucinationCheck(text) {
  return String(text ?? "")
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[¡!¿?.,;:"'…«»()-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function finiteMetric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function segmentDuration(segment) {
  const start = finiteMetric(segment?.start);
  const end = finiteMetric(segment?.end);
  return start !== null && end !== null && end > start ? end - start : 0;
}

function weightedMetric(segments, key) {
  let weighted = 0;
  let duration = 0;
  for (const segment of segments) {
    const value = finiteMetric(segment?.[key]);
    const weight = segmentDuration(segment);
    if (value === null || weight <= 0) continue;
    weighted += value * weight;
    duration += weight;
  }
  return duration > 0 ? weighted / duration : null;
}

/**
 * Métricas agregadas de los segmentos de Whisper. `confidence` es
 * exp(avg_logprob ponderado) en 0..1 (1 = el modelo estaba seguro).
 */
export function summarizeSegments(segments = []) {
  const list = Array.isArray(segments) ? segments : [];
  const weightedNoSpeech = weightedMetric(list, "no_speech_prob");
  const weightedLogProb = weightedMetric(list, "avg_logprob");
  let confidentDuration = 0;
  for (const segment of list) {
    const noSpeech = finiteMetric(segment?.no_speech_prob);
    const logProb = finiteMetric(segment?.avg_logprob);
    const compression = finiteMetric(segment?.compression_ratio);
    if (noSpeech !== null && noSpeech < 0.45 && (logProb === null || logProb >= -1) && (compression === null || compression <= 2.4)) {
      confidentDuration += segmentDuration(segment);
    }
  }
  return {
    weightedNoSpeech,
    weightedLogProb,
    confidentDuration,
    confidence: weightedLogProb === null ? null : Math.min(1, Math.exp(weightedLogProb)),
  };
}

// La lista se compara ya normalizada (sin puntos ni acentos), así "amara.org"
// y "Amara.org" coinciden aunque la normalización elimine la puntuación.
const HALLUCINATIONS_NORMALIZED = new Set(WHISPER_HALLUCINATIONS.map(normalizeForHallucinationCheck));

/**
 * Decide si una transcripción es alucinación o ruido. `evidence` es opcional
 * (`{ voicedMs, rmsDb }` del turno de captura) y solo pesa en textos cortos.
 * Devuelve `null` si se acepta, o una razón string si se descarta.
 */
export function whisperDiscardReason(text, segments = [], evidence = null, { minConfidence = 0 } = {}) {
  const normalized = normalizeForHallucinationCheck(text);
  if (!normalized) return "empty";
  if (HALLUCINATIONS_NORMALIZED.has(normalized)) return "hallucination";
  if (!Array.isArray(segments) || !segments.length) return null;

  const { weightedNoSpeech, weightedLogProb, confidentDuration, confidence } = summarizeSegments(segments);
  if (confidentDuration < 0.16) return "no_confident_speech";
  if (weightedNoSpeech !== null && weightedNoSpeech >= 0.5) return "no_speech";
  if (weightedLogProb !== null && weightedLogProb < -1) return "low_logprob";
  if (confidence !== null && confidence < minConfidence) return "low_confidence";

  if (SHORT_SUSPICIOUS_TRANSCRIPTS.has(normalized)) {
    const weakSignals = [
      weightedNoSpeech === null || weightedNoSpeech >= 0.25,
      weightedLogProb === null || weightedLogProb < -0.35,
      confidentDuration < 0.4,
      evidence && finiteMetric(evidence.voicedMs) !== null && Number(evidence.voicedMs) < 240,
      evidence && finiteMetric(evidence.maxSnrDb) !== null && Number(evidence.maxSnrDb) < 10,
    ].filter(Boolean).length;
    if (weakSignals >= 2) return "short_suspicious";
  }
  return null;
}

/** Compatibilidad con la firma booleana de la referencia. */
export function shouldDiscardWhisperTranscript(text, segments = [], evidence = null, options) {
  return whisperDiscardReason(text, segments, evidence, options) !== null;
}

/**
 * Arma el `prompt` de vocabulario: lista de términos separados por coma,
 * deduplicada y acotada a ~224 tokens (los últimos tokens son los que Whisper
 * realmente usa, por eso se recorta por el principio de la lista si sobra).
 */
export function buildVocabularyPrompt(terms = [], { maxTokens = PROMPT_MAX_TOKENS, prefix = "" } = {}) {
  const seen = new Set();
  const clean = [];
  for (const raw of terms ?? []) {
    const term = String(raw ?? "").trim().replace(/\s+/g, " ");
    if (!term) continue;
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(term);
  }
  if (!clean.length) return prefix.trim();
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  let list = clean;
  let text = `${prefix ? `${prefix.trim()} ` : ""}${list.join(", ")}.`;
  while (text.length > maxChars && list.length > 1) {
    list = list.slice(0, -1);
    text = `${prefix ? `${prefix.trim()} ` : ""}${list.join(", ")}.`;
  }
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/**
 * Cliente de transcripción por turno.
 *
 * `vocabulary` (VocabularyStore) y `userId` son opcionales: si están, los
 * términos del usuario se fusionan con `keyterms` de cada llamada.
 */
export class GroqWhisperStt {
  #apiKey;
  #fetch;

  constructor({
    apiKey = process.env.GROQ_API_KEY,
    model = DEFAULT_WHISPER_MODEL,
    temperature = 0,
    language = "es",
    minConfidence = 0.3,
    vocabulary = null,
    userId = "default",
    baseUrl = GROQ_BASE_URL,
    timeoutMs = 30_000,
    retries = 2,
    sleep,
    fetch: fetchImpl,
    logger = null,
  } = {}) {
    if (!apiKey) throw new TypeError("GroqWhisperStt: falta `apiKey` (GROQ_API_KEY)");
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.model = String(model || DEFAULT_WHISPER_MODEL);
    this.temperature = clampSttTemperature(temperature);
    this.language = normalizeLanguage(language);
    this.minConfidence = minConfidence;
    this.vocabulary = vocabulary;
    this.userId = userId;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.sleep = sleep;
    this.logger = logger;
  }

  /** Cambia el modelo en caliente (aplica desde el siguiente turno). */
  setModel(model) {
    if (model) this.model = String(model);
    return this.model;
  }

  setTemperature(value) {
    this.temperature = clampSttTemperature(value, this.temperature);
    return this.temperature;
  }

  /** Términos del usuario + los pasados por llamada. */
  async resolveKeyterms(extra = [], userId = this.userId) {
    const stored = this.vocabulary ? await this.vocabulary.get(userId) : [];
    return [...stored, ...(extra ?? [])];
  }

  /**
   * Transcribe un turno. Devuelve `{ text, confidence, words, segments,
   * language, durationMs, discarded, reason }`. Si el turno se descarta
   * (vacío/alucinación/baja confianza) `text` es "" y `discarded` true.
   */
  async transcribeTurn({ pcm, sampleRate = 16_000, language, keyterms = [], prompt, signal, evidence = null, userId } = {}) {
    if (!pcm || !pcm.byteLength) {
      return this.#discarded("empty_audio", { durationMs: 0 });
    }
    const durationMs = pcmDurationMs(pcm.byteLength, { sampleRate });
    const lang = normalizeLanguage(language, this.language);
    const wav = pcmToWav(pcm, { sampleRate, channels: 1, bitsPerSample: 16 });
    const terms = await this.resolveKeyterms(keyterms, userId);
    const vocabularyPrompt = prompt ?? buildVocabularyPrompt(terms);

    // Se congela el modelo del turno: un cambio en caliente no afecta al turno en vuelo.
    const model = this.model;
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "turn.wav");
    form.append("model", model);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    form.append("language", lang);
    form.append("temperature", String(this.temperature));
    if (vocabularyPrompt) form.append("prompt", vocabularyPrompt);

    const url = `${this.baseUrl}/audio/transcriptions`;
    let res;
    try {
      res = await fetchWithRetry(
        url,
        { method: "POST", headers: { Authorization: `Bearer ${this.#apiKey}` }, body: form },
        { retries: this.retries, timeoutMs: this.timeoutMs, signal, sleep: this.sleep, provider: "Groq Whisper", fetch: this.#fetch },
      );
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      throw new SttError(`Groq Whisper: ${error.message}`, { cause: error, status: error.status, model });
    }
    if (!res.ok) {
      await throwHttpError(res, "Groq Whisper", url).catch((error) => {
        throw new SttError(error.message, { cause: error, status: error.status, model });
      });
    }

    let data;
    try {
      data = await res.json();
    } catch (error) {
      throw new SttError("Groq Whisper devolvió una respuesta no JSON", { cause: error });
    }
    const text = String(data?.text ?? "").trim();
    const segments = Array.isArray(data?.segments) ? data.segments : [];
    const words = Array.isArray(data?.words) ? data.words : [];
    const summary = summarizeSegments(segments);
    const reason = whisperDiscardReason(text, segments, evidence, { minConfidence: this.minConfidence });
    const base = {
      confidence: summary.confidence,
      words,
      segments,
      language: data?.language ?? lang,
      durationMs,
      model,
    };
    if (reason) {
      this.logger?.debug?.("stt.discard", { reason, text, confidence: summary.confidence });
      return { ...base, text: "", discarded: true, reason };
    }
    return { ...base, text, discarded: false, reason: null };
  }

  #discarded(reason, extra = {}) {
    return { text: "", confidence: null, words: [], segments: [], language: this.language, discarded: true, reason, model: this.model, ...extra };
  }
}
