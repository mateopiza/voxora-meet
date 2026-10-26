// Scribe v2 Realtime sobre el turno ya cerrado.
//
// Una conexión WebSocket por sesión. Cada turno manda el PCM en trozos
// (`input_audio_chunk`) y el último lleva `commit: true`. El texto final es el
// `committed_transcript`. Después el pipeline sigue con traducción y TTS.

import { pcmDurationMs } from "../util/wav.mjs";
import { isAbortError } from "../util/http.mjs";
import { normalizeLanguage } from "../languages.mjs";
import { SttError } from "./groq-whisper.mjs";
import { scribeDiscardReason } from "./elevenlabs-scribe.mjs";

export const SCRIBE_REALTIME_MODEL = "scribe_v2_realtime";
export const SCRIBE_REALTIME_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";

const CHUNK_BYTES = 32_000;

function socketOpen(ws) {
  return new Promise((resolve, reject) => {
    const fail = (error) => reject(error instanceof Error ? error : new Error(String(error?.message || error || "WebSocket")));
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", fail, { once: true });
  });
}

export class ElevenLabsScribeRealtimeStt {
  #apiKey;
  #WebSocket;
  #ws = null;
  #wsLanguage = null;
  #chain = Promise.resolve();
  #opening = null;

  constructor({
    apiKey = process.env.ELEVENLABS_API_KEY,
    model = SCRIBE_REALTIME_MODEL,
    language = "es",
    minConfidence = 0.3,
    url = SCRIBE_REALTIME_URL,
    timeoutMs = 30_000,
    WebSocket: WebSocketImpl = globalThis.WebSocket,
    logger = null,
  } = {}) {
    if (!apiKey) throw new TypeError("ElevenLabsScribeRealtimeStt: falta `apiKey` (ELEVENLABS_API_KEY)");
    if (typeof WebSocketImpl !== "function") throw new TypeError("ElevenLabsScribeRealtimeStt: WebSocket no está disponible");
    this.#apiKey = apiKey;
    this.#WebSocket = WebSocketImpl;
    this.provider = "elevenlabs";
    this.clientKind = "scribe-realtime";
    this.model = SCRIBE_REALTIME_MODEL;
    this.language = normalizeLanguage(language);
    this.minConfidence = minConfidence;
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    if (model && model !== SCRIBE_REALTIME_MODEL) this.logger?.debug?.("scribe.realtime.model", { ignored: model });
  }

  setModel() {
    this.model = SCRIBE_REALTIME_MODEL;
    return this.model;
  }

  setTemperature() {
    return 0;
  }

  async transcribeTurn(turn = {}) {
    const run = this.#chain.then(() => this.#transcribe(turn));
    this.#chain = run.then(() => {}, () => {});
    return run;
  }

  async #transcribe({ pcm, sampleRate = 16_000, language, signal, evidence = null } = {}) {
    if (signal?.aborted) throw signal.reason;
    if (!pcm || !pcm.byteLength) return this.#discarded("empty_audio", 0);
    const durationMs = pcmDurationMs(pcm.byteLength, { sampleRate });
    const lang = normalizeLanguage(language, this.language);
    const ws = await this.#ensure(lang);
    const text = await this.#sendTurn(ws, pcm, sampleRate, signal);
    const reason = scribeDiscardReason(text, null, evidence, { minConfidence: this.minConfidence });
    if (!text || reason) return this.#discarded(reason || "empty_transcript", durationMs, text);
    return {
      text, confidence: null, words: [], segments: [], language: lang, durationMs, discarded: false, reason: null, model: this.model,
    };
  }

  async #ensure(language) {
    if (this.#ws && this.#ws.readyState === 1 && this.#wsLanguage === language) return this.#ws;
    await this.close();
    const params = new URLSearchParams({
      model_id: SCRIBE_REALTIME_MODEL,
      commit_strategy: "manual",
      audio_format: "pcm_16000",
      language_code: language,
    });
    const ws = new this.#WebSocket(`${this.url}?${params}`, { headers: { "xi-api-key": this.#apiKey } });
    this.#opening = socketOpen(ws);
    try {
      await this.#opening;
    } catch (error) {
      try { ws.close(); } catch { /* ya cerrada */ }
      throw new SttError(`ElevenLabs Scribe Realtime: ${error.message}`, { cause: error, model: this.model, provider: this.provider });
    }
    this.#ws = ws;
    this.#wsLanguage = language;
    ws.addEventListener("close", () => {
      if (this.#ws === ws) this.#ws = null;
    });
    return ws;
  }

  #sendTurn(ws, pcm, sampleRate, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new SttError("ElevenLabs Scribe Realtime no respondió a tiempo", { model: this.model, provider: this.provider })), this.timeoutMs);
      const onAbort = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
      signal?.addEventListener("abort", onAbort, { once: true });
      let settled = false;
      const finish = (error, text) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        ws.removeEventListener("message", onMessage);
        if (error) {
          if (isAbortError(error)) reject(error);
          else if (error instanceof SttError) reject(error);
          else reject(new SttError(`ElevenLabs Scribe Realtime: ${error.message || error}`, { cause: error, model: this.model, provider: this.provider }));
          return;
        }
        resolve(text);
      };
      const onMessage = (event) => {
        let msg;
        try { msg = JSON.parse(String(event.data ?? "")); } catch { return; }
        const type = msg?.message_type;
        if (type === "committed_transcript" || type === "committed_transcript_with_timestamps") finish(null, String(msg.text ?? "").trim());
        else if (type && type !== "session_started" && type !== "partial_transcript" && type !== "committed_transcript_entities") {
          if (/error|quota|throttl|unaccepted|rate_limited|invalid|exhausted/i.test(type)) finish(new Error(msg.error || type));
        }
      };
      ws.addEventListener("message", onMessage);
      try {
        const bytes = pcm.byteLength - (pcm.byteLength % 2);
        for (let offset = 0; offset < bytes; offset += CHUNK_BYTES) {
          const end = Math.min(bytes, offset + CHUNK_BYTES);
          const slice = pcm.subarray(offset, end);
          const last = end === bytes;
          ws.send(JSON.stringify({
            message_type: "input_audio_chunk",
            audio_base_64: Buffer.from(slice).toString("base64"),
            commit: last,
            sample_rate: sampleRate,
          }));
        }
      } catch (error) {
        finish(error);
      }
    });
  }

  #discarded(reason, durationMs, text = "") {
    return { text, confidence: null, words: [], segments: [], language: this.language, durationMs, discarded: true, reason, model: this.model };
  }

  async close() {
    const ws = this.#ws;
    this.#ws = null;
    if (!ws) return;
    try { ws.close(); } catch { /* ya cerrada */ }
  }
}
