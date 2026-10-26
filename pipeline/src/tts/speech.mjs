// TTS de catálogo (sin clon): OpenAI `POST /v1/audio/speech` y Groq Orpheus
// en el mismo endpoint bajo `api.groq.com`. Orpheus admite como máximo 200
// caracteres: el texto se parte por frases y el PCM se concatena.

import { wavToPcm, readWavInfo } from "../util/wav.mjs";
import { fetchWithRetry, throwHttpError, isAbortError } from "../util/http.mjs";
import { TtsError } from "./elevenlabs.mjs";

export const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
export const GROQ_SPEECH_URL = "https://api.groq.com/openai/v1/audio/speech";
export const DEFAULT_OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
export const DEFAULT_GROQ_TTS_MODEL = "canopylabs/orpheus-v1-english";
export const DEFAULT_OPENAI_VOICE = "alloy";
export const DEFAULT_GROQ_VOICE = "troy";

const PROVIDERS = Object.freeze({
  openai: { label: "OpenAI TTS", url: OPENAI_SPEECH_URL, model: DEFAULT_OPENAI_TTS_MODEL, voice: DEFAULT_OPENAI_VOICE, maxChars: 4000, format: "pcm" },
  groq: { label: "Groq Orpheus", url: GROQ_SPEECH_URL, model: DEFAULT_GROQ_TTS_MODEL, voice: DEFAULT_GROQ_VOICE, maxChars: 200, format: "wav" },
});

/** Parte el texto sin pasar de `maxChars`, cortando en puntuación o espacio. */
export function splitForSpeech(text, maxChars) {
  const clean = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];
  const parts = [];
  let rest = clean;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const cuts = [". ", "? ", "! ", ", ", " "].map((mark) => window.lastIndexOf(mark)).filter((n) => n > 20);
    const at = cuts.length ? Math.max(...cuts) + 1 : maxChars;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

function pcmFromBody(bytes, format) {
  if (format === "wav" || (bytes.length > 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF")) {
    const decoded = wavToPcm(bytes);
    return { audio: Buffer.from(decoded.pcm), sampleRate: decoded.sampleRate || 24000 };
  }
  return { audio: bytes, sampleRate: 24000 };
}

export class SpeechTts {
  #apiKey;
  #fetch;
  #info;

  constructor({
    provider = "openai",
    apiKey,
    model,
    voice,
    instructions = "",
    timeoutMs = 60_000,
    retries = 1,
    sleep,
    fetch: fetchImpl,
    logger = null,
  } = {}) {
    this.#info = PROVIDERS[provider];
    if (!this.#info) throw new TypeError(`SpeechTts: proveedor desconocido ${provider}`);
    if (!apiKey) throw new TypeError(`SpeechTts: falta la API key de ${this.#info.label}`);
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.provider = provider;
    this.modelId = String(model || this.#info.model);
    this.voice = String(voice || this.#info.voice);
    this.instructions = String(instructions || "");
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.sleep = sleep;
    this.logger = logger;
    this.capabilities = null;
    this.voiceSettings = null;
    this.textNormalization = "auto";
  }

  setModel(modelId) {
    if (modelId) this.modelId = String(modelId);
    return this.modelId;
  }

  setVoice(voice) {
    if (voice) this.voice = String(voice);
    return this.voice;
  }

  setInstructions(text) {
    this.instructions = String(text || "");
  }

  setLanguage() {}

  setVoiceSettings() {}

  setTextNormalization() {}

  async synthesize({ text, signal } = {}) {
    const parts = splitForSpeech(text, this.#info.maxChars);
    if (!parts.length) throw new TtsError(`${this.#info.label}: texto vacío`, { provider: this.provider, model: this.modelId });
    const chunks = [];
    let sampleRate = 24000;
    for (const part of parts) {
      const piece = await this.#one(part, signal);
      sampleRate = piece.sampleRate;
      chunks.push(piece.audio);
    }
    return {
      audio: Buffer.concat(chunks),
      sampleRate,
      audioFormat: "pcm_s16le",
      chars: parts.join("").length,
      modelId: this.modelId,
    };
  }

  async #one(text, signal) {
    const body = {
      model: this.modelId,
      input: text,
      voice: this.voice,
      response_format: this.#info.format,
    };
    if (this.provider === "openai" && this.modelId === "gpt-4o-mini-tts" && this.instructions.trim()) body.instructions = this.instructions.trim();
    let res;
    try {
      res = await fetchWithRetry(
        this.#info.url,
        { method: "POST", headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
        { retries: this.retries, timeoutMs: this.timeoutMs, signal, sleep: this.sleep, provider: this.#info.label, fetch: this.#fetch },
      );
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      throw new TtsError(`${this.#info.label}: ${error.message}`, { cause: error, status: error.status, model: this.modelId, provider: this.provider });
    }
    if (!res.ok) {
      await throwHttpError(res, this.#info.label, this.#info.url).catch((error) => {
        throw new TtsError(error.message, { cause: error, status: error.status, model: this.modelId, provider: this.provider });
      });
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    return pcmFromBody(bytes, this.#info.format);
  }
}
