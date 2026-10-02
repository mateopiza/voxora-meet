// STT con ElevenLabs Scribe (`scribe_v2`) por turno completo.
//
// Misma unidad de trabajo e interfaz que GroqWhisperStt: el turno cerrado por
// VAD (PCM s16le mono) se envuelve en WAV y se manda a
// `POST /v1/speech-to-text` (multipart). Scribe devuelve el texto y las
// palabras con `logprob`, de donde sale la confianza del turno. La variante
// realtime (`scribe_v2_realtime`) es por WebSocket y no aplica a este pipeline.
//
// El vocabulario custom va como `keyterms` (solo `scribe_v2`; ElevenLabs lo
// cobra aparte): hasta 100 términos de menos de 50 caracteres y 5 palabras.

import { pcmToWav, pcmDurationMs } from "../util/wav.mjs";
import { fetchWithRetry, throwHttpError, isAbortError } from "../util/http.mjs";
import { normalizeLanguage } from "../languages.mjs";
import { SttError, clampSttTemperature, normalizeForHallucinationCheck, whisperDiscardReason, SHORT_SUSPICIOUS_TRANSCRIPTS } from "./groq-whisper.mjs";

export const ELEVEN_STT_BASE_URL = "https://api.elevenlabs.io/v1";
export const DEFAULT_SCRIBE_MODEL = "scribe_v2";

const PROVIDER_LABEL = "ElevenLabs Scribe";
const KEYTERMS_MAX = 100;
const KEYTERM_MAX_CHARS = 50;
const KEYTERM_MAX_WORDS = 5;

/** ¿El modelo admite `keyterms`? (Scribe v1 los rechaza.) */
export function scribeSupportsKeyterms(model) {
  return /^scribe_v2/i.test(String(model ?? ""));
}

/** Términos válidos como `keyterms` de Scribe: deduplicados y dentro de sus límites. */
export function buildKeyterms(terms = []) {
  const seen = new Set();
  const out = [];
  for (const raw of terms ?? []) {
    const term = String(raw ?? "").trim().replace(/\s+/g, " ");
    if (!term || term.length >= KEYTERM_MAX_CHARS || term.split(" ").length > KEYTERM_MAX_WORDS) continue;
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length === KEYTERMS_MAX) break;
  }
  return out;
}

/** Confianza 0..1: exp del logprob medio de las palabras (se ignoran espacios y eventos). */
export function scribeConfidence(words = []) {
  const values = [];
  for (const word of Array.isArray(words) ? words : []) {
    const logprob = Number(word?.logprob);
    if ((word?.type ?? "word") === "word" && Number.isFinite(logprob)) values.push(logprob);
  }
  if (!values.length) return null;
  return Math.min(1, Math.exp(values.reduce((a, b) => a + b, 0) / values.length));
}

/**
 * Decide si una transcripción de Scribe se descarta. Devuelve `null` si se
 * acepta, o la razón. Reusa la lista de alucinaciones de Whisper (Scribe
 * también las produce ante silencio, aunque menos).
 */
export function scribeDiscardReason(text, confidence = null, evidence = null, { minConfidence = 0 } = {}) {
  const reason = whisperDiscardReason(text);
  if (reason) return reason;
  if (confidence !== null && confidence < minConfidence) return "low_confidence";
  if (SHORT_SUSPICIOUS_TRANSCRIPTS.has(normalizeForHallucinationCheck(text))) {
    const voicedMs = Number(evidence?.voicedMs);
    if ((confidence !== null && confidence < 0.6) || (Number.isFinite(voicedMs) && voicedMs < 240)) return "short_suspicious";
  }
  return null;
}

/** Cliente de transcripción por turno (misma forma que GroqWhisperStt). */
export class ElevenLabsScribeStt {
  #apiKey;
  #fetch;

  constructor({
    apiKey = process.env.ELEVENLABS_API_KEY,
    model = DEFAULT_SCRIBE_MODEL,
    temperature = 0,
    language = "es",
    minConfidence = 0.3,
    vocabulary = null,
    userId = "default",
    baseUrl = ELEVEN_STT_BASE_URL,
    timeoutMs = 30_000,
    retries = 2,
    sleep,
    fetch: fetchImpl,
    logger = null,
  } = {}) {
    if (!apiKey) throw new TypeError("ElevenLabsScribeStt: falta `apiKey` (ELEVENLABS_API_KEY)");
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.provider = "elevenlabs";
    this.model = String(model || DEFAULT_SCRIBE_MODEL);
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
   * language, durationMs, discarded, reason, model }` (`segments` siempre
   * vacío: Scribe no segmenta).
   */
  async transcribeTurn({ pcm, sampleRate = 16_000, language, keyterms = [], signal, evidence = null, userId } = {}) {
    if (!pcm || !pcm.byteLength) {
      return this.#discarded("empty_audio", { durationMs: 0 });
    }
    const durationMs = pcmDurationMs(pcm.byteLength, { sampleRate });
    const lang = normalizeLanguage(language, this.language);
    const wav = pcmToWav(pcm, { sampleRate, channels: 1, bitsPerSample: 16 });

    // Se congela el modelo del turno: un cambio en caliente no afecta al turno en vuelo.
    const model = this.model;
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "turn.wav");
    form.append("model_id", model);
    form.append("language_code", lang);
    // Sin "(risas)" ni "(música)": la transcripción va directa al traductor.
    form.append("tag_audio_events", "false");
    form.append("diarize", "false");
    form.append("timestamps_granularity", "word");
    if (this.temperature > 0) form.append("temperature", String(this.temperature));
    if (scribeSupportsKeyterms(model)) {
      for (const term of buildKeyterms(await this.resolveKeyterms(keyterms, userId))) form.append("keyterms", term);
    }

    const url = `${this.baseUrl}/speech-to-text`;
    let res;
    try {
      res = await fetchWithRetry(
        url,
        { method: "POST", headers: { "xi-api-key": this.#apiKey }, body: form },
        { retries: this.retries, timeoutMs: this.timeoutMs, signal, sleep: this.sleep, provider: PROVIDER_LABEL, fetch: this.#fetch },
      );
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      throw new SttError(`${PROVIDER_LABEL}: ${error.message}`, { cause: error, status: error.status, model, provider: this.provider });
    }
    if (!res.ok) {
      await throwHttpError(res, PROVIDER_LABEL, url).catch((error) => {
        throw new SttError(error.message, { cause: error, status: error.status, model, provider: this.provider });
      });
    }

    let data;
    try {
      data = await res.json();
    } catch (error) {
      throw new SttError(`${PROVIDER_LABEL} devolvió una respuesta no JSON`, { cause: error, model, provider: this.provider });
    }
    const text = String(data?.text ?? "").trim();
    const words = Array.isArray(data?.words) ? data.words : [];
    const confidence = scribeConfidence(words);
    const reason = scribeDiscardReason(text, confidence, evidence, { minConfidence: this.minConfidence });
    const base = { confidence, words, segments: [], language: data?.language_code ?? lang, durationMs, model };
    if (reason) {
      this.logger?.debug?.("stt.discard", { reason, text, confidence });
      return { ...base, text: "", discarded: true, reason };
    }
    return { ...base, text, discarded: false, reason: null };
  }

  #discarded(reason, extra = {}) {
    return { text: "", confidence: null, words: [], segments: [], language: this.language, discarded: true, reason, model: this.model, ...extra };
  }
}
