// STT con Deepgram Nova por turno completo.
//
// Misma interfaz que GroqWhisperStt: el PCM del turno se envuelve en WAV y se
// manda a `POST /v1/listen`. `nova-3` usa el idioma de origen; `nova-3-multi`
// no es otro modelo del API: pide `model=nova-3` y `language=multi`.
//
// `endpointing` solo existe en el streaming. Aquí el turno ya viene cortado
// por el segmentador, así que no se envía. El sample rate va en la cabecera
// WAV (no se duplica en la query). El vocabulario de Nova-3 va como `keyterm`
// repetido (Nova-2 usaba `keywords`, que este cliente no manda).

import { pcmToWav, pcmDurationMs } from "../util/wav.mjs";
import { fetchWithRetry, throwHttpError, isAbortError } from "../util/http.mjs";
import { normalizeLanguage } from "../languages.mjs";
import { SttError } from "./groq-whisper.mjs";
import { scribeDiscardReason } from "./elevenlabs-scribe.mjs";

export const DEEPGRAM_BASE_URL = "https://api.deepgram.com/v1";
export const DEFAULT_DEEPGRAM_MODEL = "nova-3";

const PROVIDER_LABEL = "Deepgram";
const KEYTERMS_MAX = 100;
const KEYTERM_MAX_CHARS = 100;

/** Términos válidos como `keyterm` de Nova-3: deduplicados y dentro del tope del API. */
export function buildDeepgramKeyterms(terms = []) {
  const seen = new Set();
  const out = [];
  for (const raw of terms ?? []) {
    const term = String(raw ?? "").trim().replace(/\s+/g, " ");
    if (!term || term.length > KEYTERM_MAX_CHARS) continue;
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length === KEYTERMS_MAX) break;
  }
  return out;
}

export function deepgramQuery(model, language, { keyterms = [] } = {}) {
  const multi = model === "nova-3-multi";
  const params = new URLSearchParams({
    model: multi ? "nova-3" : (model || DEFAULT_DEEPGRAM_MODEL),
    smart_format: "true",
    punctuate: "true",
    numerals: "true",
    language: multi ? "multi" : normalizeLanguage(language),
  });
  for (const term of buildDeepgramKeyterms(keyterms)) params.append("keyterm", term);
  return params;
}

export class DeepgramStt {
  #apiKey;
  #fetch;

  constructor({
    apiKey = process.env.DEEPGRAM_API_KEY,
    model = DEFAULT_DEEPGRAM_MODEL,
    language = "es",
    minConfidence = 0.3,
    vocabulary = null,
    userId = "default",
    baseUrl = DEEPGRAM_BASE_URL,
    timeoutMs = 30_000,
    retries = 2,
    sleep,
    fetch: fetchImpl,
    logger = null,
  } = {}) {
    if (!apiKey) throw new TypeError("DeepgramStt: falta `apiKey` (DEEPGRAM_API_KEY)");
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.provider = "deepgram";
    this.clientKind = "deepgram";
    this.model = String(model || DEFAULT_DEEPGRAM_MODEL);
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

  setModel(model) {
    if (model) this.model = String(model);
    return this.model;
  }

  setTemperature() {
    return 0;
  }

  async resolveKeyterms(extra = [], userId = this.userId) {
    const stored = this.vocabulary ? await this.vocabulary.get(userId) : [];
    return [...stored, ...(extra ?? [])];
  }

  async transcribeTurn({ pcm, sampleRate = 16_000, language, keyterms = [], signal, evidence = null, userId } = {}) {
    if (!pcm || !pcm.byteLength) return this.#discarded("empty_audio", { durationMs: 0 });
    const durationMs = pcmDurationMs(pcm.byteLength, { sampleRate });
    const model = this.model;
    const wav = pcmToWav(pcm, { sampleRate, channels: 1, bitsPerSample: 16 });
    const terms = await this.resolveKeyterms(keyterms, userId);
    const url = `${this.baseUrl}/listen?${deepgramQuery(model, language || this.language, { keyterms: terms })}`;
    let res;
    try {
      res = await fetchWithRetry(
        url,
        { method: "POST", headers: { Authorization: `Token ${this.#apiKey}`, "Content-Type": "audio/wav" }, body: wav },
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
    const alt = data?.results?.channels?.[0]?.alternatives?.[0] ?? {};
    const text = String(alt.transcript ?? "").trim();
    const confidence = Number.isFinite(Number(alt.confidence)) ? Number(alt.confidence) : null;
    const reason = scribeDiscardReason(text, confidence, evidence, { minConfidence: this.minConfidence });
    if (!text || reason) return this.#discarded(reason || "empty_transcript", { durationMs, model, confidence, text });
    return {
      text,
      confidence,
      words: Array.isArray(alt.words) ? alt.words : [],
      segments: [],
      language: normalizeLanguage(language, this.language),
      durationMs,
      discarded: false,
      reason: null,
      model,
    };
  }

  #discarded(reason, extra = {}) {
    return { text: extra.text ?? "", confidence: extra.confidence ?? null, words: [], segments: [], language: this.language, durationMs: extra.durationMs ?? 0, discarded: true, reason, model: extra.model ?? this.model };
  }
}
