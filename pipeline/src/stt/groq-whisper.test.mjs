import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GroqWhisperStt,
  SttError,
  buildVocabularyPrompt,
  whisperDiscardReason,
  shouldDiscardWhisperTranscript,
  summarizeSegments,
  normalizeForHallucinationCheck,
} from "./groq-whisper.mjs";
import { VocabularyStore } from "../stores.mjs";
import { readWavInfo } from "../util/wav.mjs";
import { mockFetch, mockFetchSequence, jsonResponse, textResponse, instantSleep, makePcm, whisperResponse, tmpDir } from "../_test-helpers.mjs";

const apiKey = "gsk_test_key";

test("transcribeTurn envía multipart correcto a Groq (URL, auth, WAV, verbose_json, prompt)", async (t) => {
  const { calls } = mockFetch(t, () => jsonResponse(whisperResponse("Hola equipo, empecemos.")));
  const stt = new GroqWhisperStt({ apiKey, sleep: instantSleep });
  const pcm = makePcm(1200);
  const result = await stt.transcribeTurn({ pcm, sampleRate: 16_000, language: "es-AR", keyterms: ["Kubernetes", "VOXORA"] });

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, "https://api.groq.com/openai/v1/audio/transcriptions");
  assert.equal(call.method, "POST");
  assert.equal(call.headers.Authorization, `Bearer ${apiKey}`);
  assert.ok(call.body instanceof FormData);
  assert.equal(call.body.get("model"), "whisper-large-v3");
  assert.equal(call.body.get("response_format"), "verbose_json");
  assert.deepEqual(call.body.getAll("timestamp_granularities[]"), ["segment"]);
  assert.equal(call.body.get("language"), "es");
  assert.equal(call.body.get("temperature"), "0");
  assert.equal(call.body.get("prompt"), "Kubernetes, VOXORA.");

  const file = call.body.get("file");
  assert.equal(file.name, "turn.wav");
  assert.equal(file.type, "audio/wav");
  const wav = Buffer.from(await file.arrayBuffer());
  const info = readWavInfo(wav);
  assert.equal(info.sampleRate, 16_000);
  assert.equal(info.channels, 1);
  assert.equal(info.dataBytes, pcm.length);

  assert.equal(result.text, "Hola equipo, empecemos.");
  assert.equal(result.discarded, false);
  assert.ok(result.confidence > 0.8);
  assert.equal(result.durationMs, 1200);
  assert.equal(result.segments.length, 1);
});

test("transcribeTurn fusiona el VocabularyStore del usuario con keyterms de la llamada", async (t) => {
  const dir = await tmpDir(t);
  const vocabulary = new VocabularyStore({ dir });
  await vocabulary.set("ana", ["Grafana", "Loki"]);
  const { calls } = mockFetch(t, () => jsonResponse(whisperResponse("ok grafana")));
  const stt = new GroqWhisperStt({ apiKey, vocabulary, userId: "ana", sleep: instantSleep });
  await stt.transcribeTurn({ pcm: makePcm(500), keyterms: ["Tempo"] });
  assert.equal(calls[0].body.get("prompt"), "Grafana, Loki, Tempo.");

  // Sin vocabulario ni keyterms no se manda prompt.
  const empty = new GroqWhisperStt({ apiKey, sleep: instantSleep });
  await empty.transcribeTurn({ pcm: makePcm(500) });
  assert.equal(calls[1].body.get("prompt"), null);
});

test("buildVocabularyPrompt deduplica y acota a ~224 tokens", () => {
  assert.equal(buildVocabularyPrompt([]), "");
  assert.equal(buildVocabularyPrompt(["a", "A", " b "]), "a, b.");
  assert.equal(buildVocabularyPrompt(["a"], { prefix: "Términos:" }), "Términos: a.");
  const many = Array.from({ length: 500 }, (_, i) => `termino${i}`);
  const prompt = buildVocabularyPrompt(many);
  assert.ok(prompt.length <= 224 * 4);
  assert.ok(prompt.startsWith("termino0, termino1"));
  assert.ok(prompt.endsWith("."));
});

test("filtro de alucinaciones: vacío, muletillas, no_speech y baja confianza", () => {
  assert.equal(whisperDiscardReason(""), "empty");
  assert.equal(whisperDiscardReason("¡Gracias por ver el vídeo!"), "hallucination");
  assert.equal(whisperDiscardReason("Subtítulos realizados por la comunidad de Amara.org"), "hallucination");
  assert.equal(normalizeForHallucinationCheck("¿Qué tal, José?"), "que tal jose");

  const good = [{ start: 0, end: 2, avg_logprob: -0.2, no_speech_prob: 0.05, compression_ratio: 1.2 }];
  assert.equal(whisperDiscardReason("Vamos a revisar el presupuesto.", good), null);

  const silence = [{ start: 0, end: 2, avg_logprob: -0.4, no_speech_prob: 0.8, compression_ratio: 1.2 }];
  assert.equal(whisperDiscardReason("Vamos a revisar el presupuesto.", silence), "no_confident_speech");

  const partialSilence = [
    { start: 0, end: 1, avg_logprob: -0.2, no_speech_prob: 0.1, compression_ratio: 1.2 },
    { start: 1, end: 5, avg_logprob: -0.2, no_speech_prob: 0.9, compression_ratio: 1.2 },
  ];
  assert.equal(whisperDiscardReason("texto", partialSilence), "no_speech");

  const lowLogProb = [{ start: 0, end: 2, avg_logprob: -1.5, no_speech_prob: 0.1, compression_ratio: 1.2 }];
  assert.equal(whisperDiscardReason("texto raro", lowLogProb), "no_confident_speech");

  const mediocre = [{ start: 0, end: 2, avg_logprob: -0.9, no_speech_prob: 0.1, compression_ratio: 1.2 }];
  assert.equal(whisperDiscardReason("texto", mediocre, null, { minConfidence: 0.5 }), "low_confidence");
  assert.equal(whisperDiscardReason("texto", mediocre, null, { minConfidence: 0.3 }), null);
  assert.equal(shouldDiscardWhisperTranscript("texto", mediocre, null, { minConfidence: 0.5 }), true);
});

test("filtro de textos cortos sospechosos usa señales débiles y evidencia del turno", () => {
  const strong = [{ start: 0, end: 1.5, avg_logprob: -0.1, no_speech_prob: 0.05, compression_ratio: 1.1 }];
  assert.equal(whisperDiscardReason("Gracias.", strong, { voicedMs: 900 }), null, "gracias real se conserva");
  const weak = [{ start: 0, end: 0.3, avg_logprob: -0.5, no_speech_prob: 0.3, compression_ratio: 1.1 }];
  assert.equal(whisperDiscardReason("Gracias.", weak, { voicedMs: 100 }), "short_suspicious");
  const summary = summarizeSegments(strong);
  assert.ok(summary.confidence > 0.9 && summary.confidentDuration === 1.5);
  assert.equal(summarizeSegments([]).confidence, null);
});

test("transcribeTurn descarta según segmentos y devuelve text vacío con razón", async (t) => {
  mockFetch(t, () => jsonResponse(whisperResponse("Gracias por ver", { segments: [{ start: 0, end: 1, avg_logprob: -0.1, no_speech_prob: 0.1 }] })));
  const stt = new GroqWhisperStt({ apiKey, sleep: instantSleep });
  const res = await stt.transcribeTurn({ pcm: makePcm(1000) });
  assert.equal(res.text, "");
  assert.equal(res.discarded, true);
  assert.equal(res.reason, "hallucination");

  const empty = await stt.transcribeTurn({ pcm: Buffer.alloc(0) });
  assert.equal(empty.discarded, true);
  assert.equal(empty.reason, "empty_audio");
});

test("transcribeTurn reintenta 429/5xx y falla con SttError en 401", async (t) => {
  const { calls } = mockFetchSequence(t, [
    () => textResponse("rate limit", { status: 429 }),
    () => textResponse("upstream", { status: 502 }),
    () => jsonResponse(whisperResponse("listo")),
  ]);
  const stt = new GroqWhisperStt({ apiKey, retries: 2, sleep: instantSleep });
  const res = await stt.transcribeTurn({ pcm: makePcm(500) });
  assert.equal(res.text, "listo");
  assert.equal(calls.length, 3);

  mockFetch(t, () => textResponse('{"error":"invalid api key"}', { status: 401 }));
  await assert.rejects(stt.transcribeTurn({ pcm: makePcm(500) }), (e) => {
    assert.ok(e instanceof SttError);
    assert.equal(e.status, 401);
    assert.match(e.message, /Groq Whisper 401/);
    return true;
  });
});

test("transcribeTurn propaga AbortError sin envolverlo", async (t) => {
  const controller = new AbortController();
  mockFetch(t, (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))));
  const stt = new GroqWhisperStt({ apiKey, sleep: instantSleep });
  const p = stt.transcribeTurn({ pcm: makePcm(500), signal: controller.signal });
  controller.abort();
  await assert.rejects(p, (e) => e.name === "AbortError");
  assert.throws(() => new GroqWhisperStt({ apiKey: "" }), /GROQ_API_KEY/);
});
