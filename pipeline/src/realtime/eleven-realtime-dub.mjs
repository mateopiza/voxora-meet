// Camino Eleven Realtime: un agente speech-to-speech sustituye STT, traducción y TTS.
//
// El motor pide un client secret con la key de ElevenLabs y abre
// `wss://api.elevenlabs.io/v1/convai/realtime` (protocolo compatible con OpenAI).
// El PCM de entrada (16 kHz) se remuestrea a 24 kHz; la salida (24 kHz) sale a 48 kHz
// para el mic virtual. La sesión dura como máximo ~10 min y se renueva antes.

import { EventEmitter } from "node:events";
import { estimateTurnCost } from "../../../billing/src/index.mjs";
import { languageName, normalizeLanguage } from "../languages.mjs";
import { PcmRate } from "./pcm-rate.mjs";

export const REALTIME_SECRET_URL = "https://api.elevenlabs.io/v1/convai/realtime/client_secrets";
export const REALTIME_WS_URL = "wss://api.elevenlabs.io/v1/convai/realtime";
export const REALTIME_MAX_MS = 540_000;

export function interpreterInstructions({ sourceLanguage = "es", targetLanguage = "en", glossary = [], styleInstruction = "" } = {}) {
  const source = languageName(sourceLanguage);
  const target = languageName(targetLanguage);
  const terms = (Array.isArray(glossary) ? glossary : [])
    .map((entry) => {
      const term = String(entry?.term ?? "").trim();
      if (!term) return "";
      const translation = String(entry?.translation ?? "").trim();
      return translation ? `${term} = ${translation}` : term;
    })
    .filter(Boolean);
  return [
    `Eres un intérprete simultáneo. Escuchas ${source} y hablas únicamente la traducción en ${target}.`,
    "No saludes, no expliques y no añadas comentarios. Si no hay habla, no digas nada.",
    styleInstruction ? `Estilo: ${styleInstruction}` : "",
    terms.length ? `Respeta estos términos:\n${terms.join("\n")}` : "",
  ].filter(Boolean).join("\n");
}

function secretFrom(data) {
  if (typeof data?.value === "string") return data.value;
  if (typeof data?.client_secret?.value === "string") return data.client_secret.value;
  if (typeof data?.token === "string") return data.token;
  return "";
}

function audioB64(delta) {
  return delta?.delta || delta?.audio || "";
}

export class ElevenRealtimeDub extends EventEmitter {
  #apiKey;
  #fetch;
  #WebSocket;
  #ws = null;
  #up = new PcmRate(16_000, 24_000);
  #down = new PcmRate(24_000, 48_000);
  #openedAt = 0;
  #turn = 0;
  #pendingText = "";
  #spoken = "";
  #audioBytes = 0;
  #responseStarted = 0;
  #inputSamples = 0;
  #renewing = false;

  constructor({
    apiKey,
    model = "eleven_realtime_v1_max",
    voice = "",
    sourceLanguage = "es",
    targetLanguage = "en",
    glossary = [],
    styleInstruction = "",
    secretUrl = REALTIME_SECRET_URL,
    wsUrl = REALTIME_WS_URL,
    fetch: fetchImpl,
    WebSocket: WebSocketImpl = globalThis.WebSocket,
    now = () => performance.now(),
    maxSessionMs = REALTIME_MAX_MS,
  } = {}) {
    super();
    if (!apiKey) throw new TypeError("ElevenRealtimeDub: falta la API key de ElevenLabs");
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.#WebSocket = WebSocketImpl;
    this.model = model;
    this.voice = voice;
    this.sourceLanguage = normalizeLanguage(sourceLanguage);
    this.targetLanguage = normalizeLanguage(targetLanguage);
    this.glossary = glossary;
    this.styleInstruction = styleInstruction;
    this.secretUrl = secretUrl;
    this.wsUrl = wsUrl;
    this.now = now;
    this.maxSessionMs = maxSessionMs;
    this.provider = "elevenlabs";
  }

  async open() {
    if (this.#ws && this.#ws.readyState === 1) return;
    await this.close();
    const secret = await this.#mint();
    const ws = new this.#WebSocket(`${this.wsUrl}?model=${encodeURIComponent(this.model)}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    await new Promise((resolve, reject) => {
      const fail = (error) => reject(error instanceof Error ? error : new Error("No se pudo abrir Eleven Realtime"));
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", fail, { once: true });
    });
    ws.addEventListener("message", (event) => this.#onMessage(event));
    ws.addEventListener("close", () => {
      if (this.#ws === ws) this.#ws = null;
    });
    this.#ws = ws;
    this.#openedAt = this.now();
    this.#up = new PcmRate(16_000, 24_000);
    this.#down = new PcmRate(24_000, 48_000);
  }

  pushPcm(pcm, sampleRate = 16_000) {
    if (!pcm?.byteLength || !this.#ws || this.#ws.readyState !== 1) return;
    if (this.#openedAt && this.now() - this.#openedAt > this.maxSessionMs && !this.#renewing) {
      this.#renewing = true;
      this.open().catch((error) => this.emit("error", error)).finally(() => { this.#renewing = false; });
      return;
    }
    const input = sampleRate === 24_000 ? Buffer.from(pcm) : (sampleRate === 16_000 ? this.#up.process(pcm) : new PcmRate(sampleRate, 24_000).process(pcm));
    if (!input.length) return;
    this.#inputSamples += input.length / 2;
    this.#ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: input.toString("base64") }));
  }

  applySettings(patch = {}) {
    if (patch.realtimeModel) this.model = patch.realtimeModel;
    if (patch.voiceName || patch.voiceId) this.voice = patch.voiceName || patch.voiceId;
    if (patch.sourceLanguage) this.sourceLanguage = normalizeLanguage(patch.sourceLanguage);
    if (patch.targetLanguage) this.targetLanguage = normalizeLanguage(patch.targetLanguage);
    if (patch.styleInstruction !== undefined) this.styleInstruction = patch.styleInstruction;
    if (patch.realtimeModel && this.#ws) this.open().catch((error) => this.emit("error", error));
    return this.currentSettings();
  }

  currentSettings() {
    return {
      dubbingPath: "eleven_realtime",
      realtimeModel: this.model,
      voice: this.voice,
      sttProvider: "elevenlabs",
      sttClientKind: "eleven-realtime",
      translateProvider: null,
      ttsProvider: "elevenlabs",
    };
  }

  async close() {
    const ws = this.#ws;
    this.#ws = null;
    if (!ws) return;
    try { ws.close(); } catch { /* ya cerrada */ }
  }

  async #mint() {
    const doFetch = this.#fetch ?? globalThis.fetch;
    const instructions = interpreterInstructions(this);
    const res = await doFetch(this.secretUrl, {
      method: "POST",
      headers: { "xi-api-key": this.#apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model: this.model,
          instructions,
          output_modalities: ["audio"],
          max_duration_seconds: 600,
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              turn_detection: { type: "semantic_vad", eagerness: "medium" },
            },
            output: { format: { type: "audio/pcm", rate: 24000 }, voice: this.voice || "brian" },
          },
        },
      }),
    });
    const body = await res.text();
    if (!res.ok) {
      const unavailable = /not available|aren't available|realtime models/i.test(body);
      const message = unavailable
        ? "Eleven Realtime no está habilitado en esta cuenta de ElevenLabs. El camino por etapas sigue disponible: cámbialo en Modelos."
        : `ElevenLabs Realtime: ${body.slice(0, 300) || res.status}`;
      throw Object.assign(new Error(message), { status: res.status, provider: "elevenlabs", code: unavailable ? "model_unavailable" : "provider_auth" });
    }
    let data = {};
    try { data = JSON.parse(body); } catch { /* sin JSON */ }
    const secret = secretFrom(data);
    if (!secret) throw new Error("ElevenLabs Realtime no devolvió un client secret");
    return secret;
  }

  #onMessage(event) {
    let msg;
    try { msg = JSON.parse(String(event.data ?? "")); } catch { return; }
    const type = msg?.type || "";
    if (type === "error" || msg?.error) {
      const text = msg?.error?.message || msg?.message || type;
      this.emit("error", Object.assign(new Error(String(text)), { provider: "elevenlabs" }));
      return;
    }
    if (type === "response.created") {
      this.#turn += 1;
      this.#pendingText = "";
      this.#spoken = "";
      this.#audioBytes = 0;
      this.#responseStarted = this.now();
      return;
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const text = String(msg.transcript ?? "").trim();
      if (text) this.emit("transcript", { turnId: this.#turn || 1, text, endedAt: this.now() });
      return;
    }
    if (type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta") {
      this.#spoken += String(msg.delta ?? "");
      return;
    }
    if (type === "response.output_audio_transcript.done" || type === "response.audio_transcript.done") {
      this.#spoken = String(msg.transcript ?? this.#spoken).trim();
      if (this.#spoken) this.emit("translation", { turnId: this.#turn || 1, text: this.#spoken });
      return;
    }
    if (type === "response.output_audio.delta" || type === "response.audio.delta") {
      const b64 = audioB64(msg);
      if (!b64) return;
      const pcm24 = Buffer.from(b64, "base64");
      const pcm = this.#down.process(pcm24);
      this.#audioBytes += pcm.length;
      if (pcm.length) this.emit("audio", { pcm, sampleRate: 48000 });
      return;
    }
    if (type === "response.done") {
      const totalMs = this.#responseStarted ? this.now() - this.#responseStarted : 0;
      const audioMs = Math.round((this.#inputSamples / 24_000) * 1000);
      this.#inputSamples = 0;
      const cost = estimateTurnCost({ audioMs }, { dubbingPath: "eleven_realtime", realtimeModel: this.model });
      this.emit("segment", {
        turnId: this.#turn || 1,
        transcript: this.#pendingText,
        translation: this.#spoken,
        metrics: { totalMs },
        durationMs: Math.round((this.#audioBytes / 2 / 48_000) * 1000),
        cost,
        endedAt: this.now(),
      });
    }
  }
}
