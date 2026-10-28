// TTS de catálogo de Deepgram (sin clon).
//
// Aura-1 y Aura-2: POST https://api.deepgram.com/v1/speak?model=aura-2-…
// Flux: POST https://api.deepgram.com/v2/speak?model=flux-…
// El id de la voz ES el modelo (`aura-2-thalia-en`). Aura admite WAV; Flux
// solo devuelve PCM crudo (`container=none`). Tope documentado: 2000 caracteres.

import { splitForSpeech } from "./speech.mjs";
import { wavToPcm } from "../util/wav.mjs";
import { fetchWithRetry, throwHttpError, isAbortError } from "../util/http.mjs";
import { TtsError } from "./elevenlabs.mjs";

export const DEEPGRAM_SPEAK_V1 = "https://api.deepgram.com/v1/speak";
export const DEEPGRAM_SPEAK_V2 = "https://api.deepgram.com/v2/speak";
export const DEFAULT_DEEPGRAM_TTS_MODEL = "aura-2";
export const DEFAULT_DEEPGRAM_VOICE = "aura-2-thalia-en";
const MAX_CHARS = 2000;

export class DeepgramTts {
  #apiKey;
  #fetch;

  constructor({
    apiKey,
    model = DEFAULT_DEEPGRAM_TTS_MODEL,
    voice = DEFAULT_DEEPGRAM_VOICE,
    timeoutMs = 60_000,
    retries = 1,
    sleep,
    fetch: fetchImpl,
    logger = null,
  } = {}) {
    if (!apiKey) throw new TypeError("DeepgramTts: falta la API key de Deepgram");
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.provider = "deepgram";
    this.modelId = String(model || DEFAULT_DEEPGRAM_TTS_MODEL);
    this.voice = String(voice || DEFAULT_DEEPGRAM_VOICE);
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

  setInstructions() {}

  setLanguage() {}

  setVoiceSettings() {}

  setTextNormalization() {}

  async synthesize({ text, signal } = {}) {
    const parts = splitForSpeech(text, MAX_CHARS);
    if (!parts.length) throw new TtsError("Deepgram TTS: texto vacío", { provider: this.provider, model: this.voice });
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
      voice: this.voice,
    };
  }

  async #one(text, signal) {
    const flux = this.voice.startsWith("flux-");
    const params = new URLSearchParams({
      model: this.voice,
      encoding: "linear16",
      sample_rate: "24000",
      container: flux ? "none" : "wav",
    });
    const url = `${flux ? DEEPGRAM_SPEAK_V2 : DEEPGRAM_SPEAK_V1}?${params}`;
    let res;
    try {
      res = await fetchWithRetry(
        url,
        { method: "POST", headers: { Authorization: `Token ${this.#apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ text }) },
        { retries: this.retries, timeoutMs: this.timeoutMs, signal, sleep: this.sleep, provider: "Deepgram TTS", fetch: this.#fetch },
      );
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      throw new TtsError(`Deepgram TTS: ${error.message}`, { cause: error, status: error.status, model: this.voice, provider: this.provider });
    }
    if (!res.ok) {
      await throwHttpError(res, "Deepgram TTS", url).catch((error) => {
        throw new TtsError(error.message, { cause: error, status: error.status, model: this.voice, provider: this.provider });
      });
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!flux && bytes.length > 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF") {
      const decoded = wavToPcm(bytes);
      return { audio: Buffer.from(decoded.pcm), sampleRate: decoded.sampleRate || 24000 };
    }
    return { audio: bytes, sampleRate: 24000 };
  }
}
