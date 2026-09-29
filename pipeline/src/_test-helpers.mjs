// Utilidades compartidas por los tests del pipeline. NO es un archivo de test
// (no termina en .test.mjs). Nunca se hacen llamadas de red reales: cada test
// sustituye `globalThis.fetch` / `globalThis.WebSocket` con mocks.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Respuesta JSON simulada. */
export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Respuesta binaria simulada. */
export function binaryResponse(bytes, { status = 200, contentType = "audio/pcm", headers = {} } = {}) {
  return new Response(bytes, { status, headers: { "content-type": contentType, ...headers } });
}

/** Respuesta de texto/error simulada. */
export function textResponse(text, { status = 500, headers = {} } = {}) {
  return new Response(text, { status, headers: { "content-type": "text/plain", ...headers } });
}

/**
 * Reemplaza `globalThis.fetch` durante el test con `handler(url, init, call)`.
 * Devuelve `{ calls }` con `{ url, init, method, headers, body }` por llamada.
 * Se restaura automáticamente al terminar el test (t.mock).
 */
export function mockFetch(t, handler) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const call = { url, init, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body, signal: init.signal };
    calls.push(call);
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("Aborted", "AbortError");
    return handler(url, init, call, calls.length);
  });
  return { calls };
}

/** Secuencia de respuestas: la N-ésima llamada recibe la N-ésima respuesta (o la última). */
export function mockFetchSequence(t, responses) {
  return mockFetch(t, (_url, _init, _call, n) => {
    const item = responses[Math.min(n - 1, responses.length - 1)];
    return typeof item === "function" ? item() : item;
  });
}

/** `sleep` instantáneo para no esperar backoffs reales en tests. */
export const instantSleep = async () => {};

/** PCM s16le mono de `ms` milisegundos (tono simple, no silencio). */
export function makePcm(ms, sampleRate = 16_000, amplitude = 8000) {
  const samples = Math.round((ms / 1000) * sampleRate);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    buf.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 440 * 2 * Math.PI) * amplitude), i * 2);
  }
  return buf;
}

/** Turno de captura según contrato capture → pipeline. */
export function makeTurn({ ms = 2000, startedAt = 1000, voicedMs, rmsDb = -20 } = {}) {
  return { pcm: makePcm(ms), sampleRate: 16_000, startedAt, endedAt: startedAt + ms, voicedMs: voicedMs ?? ms * 0.8, rmsDb };
}

/** Respuesta verbose_json de Whisper con segmentos "seguros" por defecto. */
export function whisperResponse(text, { segments, language = "es", duration = 2 } = {}) {
  return {
    task: "transcribe",
    language,
    duration,
    text,
    segments: segments ?? [{ id: 0, start: 0, end: duration, text, avg_logprob: -0.2, no_speech_prob: 0.02, compression_ratio: 1.3 }],
  };
}

/** Respuesta de chat completions con la traducción. */
export function chatResponse(content, { promptTokens = 120, completionTokens = 20, model = "openai/gpt-oss-120b" } = {}) {
  return {
    id: "chatcmpl-test",
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  };
}

/** Directorio temporal aislado por test, borrado al terminar. */
export async function tmpDir(t, prefix = "voxora-meet-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Promesa controlable desde fuera. */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const tick = () => new Promise((r) => setImmediate(r));
