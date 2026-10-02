import { test } from "node:test";
import assert from "node:assert/strict";
import { ElevenLabsScribeStt, buildKeyterms, scribeConfidence, scribeDiscardReason } from "./elevenlabs-scribe.mjs";
import { GroqWhisperStt, SttError } from "./groq-whisper.mjs";
import { VocabularyStore } from "../stores.mjs";
import { readWavInfo } from "../util/wav.mjs";
import { mockFetch, mockFetchSequence, jsonResponse, textResponse, instantSleep, makePcm, tmpDir } from "../_test-helpers.mjs";

const apiKey = "sk_test_key";

/** Respuesta de `POST /v1/speech-to-text` con palabras "seguras" por defecto. */
function scribeResponse(text, { logprob = -0.1, language = "spa" } = {}) {
  const words = [];
  for (const [i, word] of text.split(" ").entries()) {
    if (i) words.push({ text: " ", type: "spacing", start: i, end: i, logprob: 0 });
    words.push({ text: word, type: "word", start: i, end: i + 0.5, logprob });
  }
  return { language_code: language, language_probability: 0.99, text, words };
}

test("transcribeTurn envía multipart correcto a ElevenLabs Scribe (URL, auth, WAV, modelo, idioma)", async (t) => {
  const { calls } = mockFetch(t, () => jsonResponse(scribeResponse("Hola equipo, empecemos.")));
  const stt = new ElevenLabsScribeStt({ apiKey, sleep: instantSleep });
  const pcm = makePcm(1200);
  const result = await stt.transcribeTurn({ pcm, sampleRate: 16_000, language: "es-AR", keyterms: ["Kubernetes", "VOXORA"] });

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, "https://api.elevenlabs.io/v1/speech-to-text");
  assert.equal(call.method, "POST");
  assert.equal(call.headers["xi-api-key"], apiKey);
  assert.ok(call.body instanceof FormData);
  assert.equal(call.body.get("model_id"), "scribe_v2");
  assert.equal(call.body.get("language_code"), "es");
  assert.equal(call.body.get("tag_audio_events"), "false");
  assert.equal(call.body.get("diarize"), "false");
  assert.equal(call.body.has("temperature"), false, "temperatura 0 = la de por defecto: no se envía");
  assert.deepEqual(call.body.getAll("keyterms"), ["Kubernetes", "VOXORA"]);

  const file = call.body.get("file");
  assert.equal(file.type, "audio/wav");
  const info = readWavInfo(Buffer.from(await file.arrayBuffer()));
  assert.equal(info.sampleRate, 16_000);
  assert.equal(info.dataBytes, pcm.length);

  assert.equal(result.text, "Hola equipo, empecemos.");
  assert.equal(result.discarded, false);
  assert.equal(result.model, "scribe_v2");
  assert.equal(result.language, "spa");
  assert.ok(result.confidence > 0.85);
  assert.equal(result.durationMs, 1200);
  assert.deepEqual(result.segments, []);
});

test("keyterms: vocabulario del usuario solo en scribe_v2, dentro de los límites de Scribe", async (t) => {
  const dir = await tmpDir(t);
  const vocabulary = new VocabularyStore({ dir });
  await vocabulary.set("ana", ["Grafana", "Loki"]);
  const { calls } = mockFetch(t, () => jsonResponse(scribeResponse("ok grafana")));
  const stt = new ElevenLabsScribeStt({ apiKey, vocabulary, userId: "ana", temperature: 0.3, sleep: instantSleep });
  await stt.transcribeTurn({ pcm: makePcm(500), keyterms: ["Tempo"] });
  assert.deepEqual(calls[0].body.getAll("keyterms"), ["Grafana", "Loki", "Tempo"]);
  assert.equal(calls[0].body.get("temperature"), "0.3");

  stt.setModel("scribe_v1");
  await stt.transcribeTurn({ pcm: makePcm(500) });
  assert.equal(calls[1].body.get("model_id"), "scribe_v1");
  assert.equal(calls[1].body.has("keyterms"), false, "scribe_v1 rechaza keyterms");

  assert.deepEqual(buildKeyterms(["  VOXORA ", "voxora", "", "x".repeat(50), "uno dos tres cuatro cinco seis", "Buenos Aires"]), ["VOXORA", "Buenos Aires"]);
  assert.equal(buildKeyterms(Array.from({ length: 150 }, (_, i) => `t${i}`)).length, 100);
});

test("descarta vacío, alucinaciones, baja confianza y muletillas cortas dudosas", async (t) => {
  assert.equal(scribeConfidence([{ type: "word", logprob: -0.1 }, { type: "spacing", logprob: -9 }, { type: "audio_event", logprob: -9 }]) > 0.9, true);
  assert.equal(scribeConfidence([]), null);
  assert.equal(scribeDiscardReason("", null), "empty");
  assert.equal(scribeDiscardReason("Gracias por ver el video.", 0.9), "hallucination");
  assert.equal(scribeDiscardReason("Revisemos el presupuesto", 0.1, null, { minConfidence: 0.3 }), "low_confidence");
  assert.equal(scribeDiscardReason("Gracias", 0.5), "short_suspicious");
  assert.equal(scribeDiscardReason("Gracias", 0.9, { voicedMs: 150 }), "short_suspicious");
  assert.equal(scribeDiscardReason("Gracias", 0.9, { voicedMs: 600 }), null);

  mockFetch(t, () => jsonResponse(scribeResponse("Subtítulos realizados por la comunidad de Amara.org")));
  const stt = new ElevenLabsScribeStt({ apiKey, sleep: instantSleep });
  const result = await stt.transcribeTurn({ pcm: makePcm(800) });
  assert.deepEqual([result.text, result.discarded, result.reason], ["", true, "hallucination"]);
  assert.equal((await stt.transcribeTurn({ pcm: Buffer.alloc(0) })).reason, "empty_audio");
});

test("reintenta 429/5xx y falla con SttError (proveedor elevenlabs) en 401", async (t) => {
  const { calls } = mockFetchSequence(t, [
    () => textResponse("slow down", { status: 429 }),
    () => jsonResponse(scribeResponse("Listo.")),
  ]);
  const stt = new ElevenLabsScribeStt({ apiKey, sleep: instantSleep });
  assert.equal((await stt.transcribeTurn({ pcm: makePcm(600) })).text, "Listo.");
  assert.equal(calls.length, 2);

  mockFetch(t, () => textResponse('{"detail":{"status":"invalid_api_key"}}', { status: 401 }));
  await assert.rejects(stt.transcribeTurn({ pcm: makePcm(600) }), (error) => {
    assert.ok(error instanceof SttError);
    assert.deepEqual([error.status, error.stage, error.provider, error.model], [401, "stt", "elevenlabs", "scribe_v2"]);
    assert.match(error.message, /ElevenLabs Scribe 401/);
    return true;
  });
});

test("GroqWhisperStt con provider openai: URL de OpenAI, json + logprobs en gpt-4o-transcribe, verbose_json en whisper-1", async (t) => {
  const { calls } = mockFetch(t, () => jsonResponse({ text: "Hola equipo.", logprobs: [{ token: "Hola", logprob: -0.05 }, { token: " equipo", logprob: -0.15 }] }));
  const stt = new GroqWhisperStt({ provider: "openai", apiKey: "sk-openai", sleep: instantSleep });
  assert.deepEqual([stt.provider, stt.model], ["openai", "gpt-4o-transcribe"]);
  const result = await stt.transcribeTurn({ pcm: makePcm(900), keyterms: ["VOXORA"] });
  const [call] = calls;
  assert.equal(call.url, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(call.headers.Authorization, "Bearer sk-openai");
  assert.equal(call.body.get("response_format"), "json");
  assert.deepEqual(call.body.getAll("include[]"), ["logprobs"]);
  assert.equal(call.body.has("timestamp_granularities[]"), false);
  assert.equal(call.body.get("prompt"), "VOXORA.");
  assert.equal(result.text, "Hola equipo.");
  assert.ok(result.confidence > 0.85);

  stt.setModel("whisper-1");
  await stt.transcribeTurn({ pcm: makePcm(900) }).catch(() => {});
  assert.equal(calls[1].body.get("response_format"), "verbose_json");

  mockFetch(t, () => jsonResponse({ text: "mmm algo", logprobs: [{ token: "mmm", logprob: -3 }] }));
  stt.setModel("gpt-4o-mini-transcribe");
  assert.equal((await stt.transcribeTurn({ pcm: makePcm(900) })).reason, "low_confidence");

  mockFetch(t, () => textResponse('{"error":{"code":"invalid_api_key"}}', { status: 401 }));
  await assert.rejects(stt.transcribeTurn({ pcm: makePcm(900) }), (error) => error instanceof SttError && error.provider === "openai" && /OpenAI STT 401/.test(error.message));
});
