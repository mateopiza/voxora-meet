// Protocolo v3: modelo y parámetros configurables en STT, traducción y TTS,
// aplicables en caliente desde el siguiente turno. Fetch siempre mockeado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GroqWhisperStt } from "./stt/groq-whisper.mjs";
import { ContextTranslator, chatReasoningProfile, reasoningParamsFor, cleanTranslation, maxCompletionTokens, TranslationError } from "./translate/groq-translate.mjs";
import {
  ElevenLabsTts,
  TtsError,
  buildTtsBody,
  ttsModelCapabilities,
  resolveTtsCapabilities,
  snapToPreset,
  voiceSettingsFromFlat,
  isLanguageCodeRejected,
} from "./tts/elevenlabs.mjs";
import { DubbingPipeline } from "./dubbing-pipeline.mjs";
import { estimateTurnCost } from "../../billing/src/index.mjs";
import { mockFetch, mockFetchSequence, jsonResponse, binaryResponse, textResponse, instantSleep, makePcm, makeTurn, whisperResponse, chatResponse } from "./_test-helpers.mjs";

const pcm = makePcm(200, 48_000);

// ── STT ─────────────────────────────────────────────────────────────────────

test("STT: modelo y temperatura configurables y cambiables en caliente", async (t) => {
  const { calls } = mockFetch(t, () => jsonResponse(whisperResponse("hola a todos")));
  const stt = new GroqWhisperStt({ apiKey: "gsk", model: "whisper-large-v3-turbo", temperature: 0.4, sleep: instantSleep });
  const first = await stt.transcribeTurn({ pcm: makePcm(1000) });
  assert.equal(calls[0].body.get("model"), "whisper-large-v3-turbo");
  assert.equal(calls[0].body.get("temperature"), "0.4");
  assert.equal(first.model, "whisper-large-v3-turbo");

  stt.setModel("whisper-large-v3");
  assert.equal(stt.setTemperature(7), 1, "se recorta a 0..1");
  assert.equal(stt.setTemperature("x"), 1, "valor inválido conserva el anterior");
  await stt.transcribeTurn({ pcm: makePcm(1000) });
  assert.equal(calls[1].body.get("model"), "whisper-large-v3");
  assert.equal(calls[1].body.get("temperature"), "1");
  assert.equal(new GroqWhisperStt({ apiKey: "gsk", temperature: -3 }).temperature, 0);
});

test("STT: el error lleva el modelo para poder explicarlo (model_unavailable)", async (t) => {
  mockFetch(t, () => textResponse('{"error":{"message":"The model `whisper-x` does not exist or you do not have access to it.","code":"model_not_found"}}', { status: 404 }));
  const stt = new GroqWhisperStt({ apiKey: "gsk", model: "whisper-x", sleep: instantSleep, retries: 0 });
  await assert.rejects(stt.transcribeTurn({ pcm: makePcm(1000) }), (e) => e.model === "whisper-x" && e.status === 404 && e.stage === "stt");
});

// ── Traducción ──────────────────────────────────────────────────────────────

test("razonamiento por familia: gpt-oss low/medium/high, Qwen3 none/default, resto nada", () => {
  assert.deepEqual(chatReasoningProfile("openai/gpt-oss-120b").efforts, ["low", "medium", "high"]);
  assert.deepEqual(chatReasoningProfile("qwen/qwen3-32b").efforts, ["none", "default"]);
  assert.deepEqual(chatReasoningProfile("llama-3.3-70b-versatile").efforts, []);

  assert.deepEqual(reasoningParamsFor("openai/gpt-oss-20b", "high"), { reasoning_effort: "high" });
  assert.deepEqual(reasoningParamsFor("openai/gpt-oss-20b", "none"), { reasoning_effort: "low" });
  assert.deepEqual(reasoningParamsFor("openai/gpt-oss-20b", "default"), { reasoning_effort: "medium" });
  assert.deepEqual(reasoningParamsFor("openai/gpt-oss-20b", "raro"), { reasoning_effort: "low" });
  assert.deepEqual(reasoningParamsFor("qwen/qwen3.6-27b", "low"), { reasoning_effort: "none", reasoning_format: "hidden" });
  assert.deepEqual(reasoningParamsFor("qwen/qwen3-32b", "high"), { reasoning_effort: "default", reasoning_format: "hidden" });
  assert.deepEqual(reasoningParamsFor("llama-3.1-8b-instant", "high"), {});
});

test("traductor: modelo, temperatura, esfuerzo y memoria se cambian en caliente", async (t) => {
  let n = 0;
  const { calls } = mockFetch(t, () => jsonResponse(chatResponse(`t${++n}`)));
  const tr = new ContextTranslator({ apiKey: "gsk", model: "openai/gpt-oss-120b", temperature: 0.3, reasoningEffort: "medium", memoryTurns: 4, sleep: instantSleep });
  for (const text of ["uno", "dos", "tres"]) await tr.translate({ text });
  let body = JSON.parse(calls[2].body);
  assert.equal(body.model, "openai/gpt-oss-120b");
  assert.equal(body.temperature, 0.3);
  assert.equal(body.reasoning_effort, "medium");
  assert.equal(body.messages.length, 1 + 2 * 2 + 1);

  tr.setModel("qwen/qwen3-32b");
  tr.setTemperature(5);
  tr.setReasoningEffort("low");
  assert.equal(tr.setReasoningEffort("extremo"), "low", "valor desconocido no cambia el esfuerzo");
  tr.setMemoryTurns(1);
  assert.equal(tr.memory.length, 1, "bajar la memoria descarta los turnos más antiguos");
  await tr.translate({ text: "cuatro" });
  body = JSON.parse(calls[3].body);
  assert.equal(body.model, "qwen/qwen3-32b");
  assert.equal(body.temperature, 1);
  assert.equal(body.reasoning_effort, "none");
  assert.equal(body.reasoning_format, "hidden");
  assert.equal(body.messages.length, 1 + 2 + 1);

  tr.setModel("llama-3.3-70b-versatile");
  await tr.translate({ text: "cinco" });
  body = JSON.parse(calls[4].body);
  assert.equal("reasoning_effort" in body, false);
  assert.equal("reasoning_format" in body, false);
});

test("traductor: si el modelo rechaza reasoning_effort se reintenta sin él y se recuerda", async (t) => {
  const { calls } = mockFetchSequence(t, [
    () => textResponse('{"error":{"message":"`reasoning_effort` is not supported with this model","type":"invalid_request_error"}}', { status: 400 }),
    () => jsonResponse(chatResponse("hello")),
    () => jsonResponse(chatResponse("bye")),
  ]);
  const tr = new ContextTranslator({ apiKey: "gsk", model: "qwen/qwen3.8-27b", sleep: instantSleep, retries: 0 });
  const res = await tr.translate({ text: "hola" });
  assert.equal(res.translation, "hello");
  assert.equal(JSON.parse(calls[0].body).reasoning_effort, "none");
  assert.equal("reasoning_effort" in JSON.parse(calls[1].body), false);
  await tr.translate({ text: "chau" });
  assert.equal(calls.length, 3, "el siguiente turno ya no manda los parámetros");
  assert.equal("reasoning_effort" in JSON.parse(calls[2].body), false);
});

test("traductor: 404 de modelo inexistente lanza TranslationError con el modelo", async (t) => {
  mockFetch(t, () => textResponse('{"error":{"message":"The model `acme/x` does not exist or you do not have access to it.","code":"model_not_found"}}', { status: 404 }));
  const tr = new ContextTranslator({ apiKey: "gsk", model: "acme/x", sleep: instantSleep, retries: 0 });
  await assert.rejects(tr.translate({ text: "hola" }), (e) => e instanceof TranslationError && e.status === 404 && e.model === "acme/x" && /model_not_found/.test(e.cause.body));
});

test("max_completion_tokens reserva margen para el razonamiento (sin él gpt-oss high devuelve vacío)", async (t) => {
  assert.equal(maxCompletionTokens("hola", undefined), 256);
  assert.equal(maxCompletionTokens("hola", "none"), 256);
  assert.equal(maxCompletionTokens("hola", "low"), 256 + 1024);
  assert.equal(maxCompletionTokens("hola", "high"), 256 + 4096);
  assert.equal(maxCompletionTokens("x".repeat(10_000), "high"), 8192);

  const { calls } = mockFetch(t, () => jsonResponse(chatResponse("ok")));
  const tr = new ContextTranslator({ apiKey: "gsk", model: "openai/gpt-oss-20b", reasoningEffort: "high", sleep: instantSleep });
  await tr.translate({ text: "hola" });
  assert.equal(JSON.parse(calls[0].body).max_completion_tokens, 256 + 4096);
  tr.setModel("llama-3.3-70b-versatile");
  await tr.translate({ text: "hola" });
  assert.equal(JSON.parse(calls[1].body).max_completion_tokens, 256);
});

test("cleanTranslation quita bloques <think> que cuelan algunos modelos", () => {
  assert.equal(cleanTranslation("<think>el usuario quiere…</think>\nHello everyone."), "Hello everyone.");
  assert.equal(cleanTranslation("<think>sin cerrar"), "");
});

// ── TTS ─────────────────────────────────────────────────────────────────────

test("capacidades TTS curadas por modelo", () => {
  const v2 = ttsModelCapabilities("eleven_multilingual_v2");
  assert.equal(v2.supportsStyle, true);
  assert.equal(v2.supportsSpeakerBoost, true);
  assert.equal(v2.supportsLanguageCode, false);
  const flash = ttsModelCapabilities("eleven_flash_v2_5");
  assert.deepEqual([flash.supportsStyle, flash.supportsSpeakerBoost, flash.supportsLanguageCode, flash.supportsNormalizationOn], [false, false, true, false]);
  assert.equal(ttsModelCapabilities("eleven_turbo_v2_5").supportsLanguageCode, true);
  const v3 = ttsModelCapabilities("eleven_v3");
  assert.deepEqual(v3.stabilityPresets, [0, 0.5, 1]);
  assert.equal(v3.supportsLanguageCode, true);
  assert.equal(v3.supportsSpeakerBoost, false);
  assert.equal(ttsModelCapabilities("eleven_v3_conversational").supportsSpeakerBoost, true);
  assert.equal(ttsModelCapabilities("eleven_desconocido").supportsLanguageCode, false);

  // El catálogo en vivo pisa solo las claves conocidas.
  const merged = resolveTtsCapabilities("eleven_v4", { supportsStyle: true, stabilityPresets: [], label: "x" });
  assert.equal(merged.supportsStyle, true);
  assert.equal(merged.stabilityPresets, null);
  assert.equal("label" in merged, false);
});

test("buildTtsBody manda solo los campos que el modelo admite", () => {
  const vs = { stability: 0.3, similarity_boost: 0.8, style: 0.4, use_speaker_boost: false, speed: 1.1 };
  const v2 = buildTtsBody({ text: "Hi", modelId: "eleven_multilingual_v2", voiceSettings: vs, languageCode: "en", textNormalization: "on" });
  assert.deepEqual(v2, {
    text: "Hi",
    model_id: "eleven_multilingual_v2",
    voice_settings: { stability: 0.3, similarity_boost: 0.8, style: 0.4, use_speaker_boost: false, speed: 1.1 },
    apply_text_normalization: "on",
  });

  const flash = buildTtsBody({ text: "Hi", modelId: "eleven_flash_v2_5", voiceSettings: vs, languageCode: "en-US", textNormalization: "on" });
  assert.deepEqual(flash.voice_settings, { stability: 0.3, similarity_boost: 0.8, speed: 1.1 });
  assert.equal(flash.language_code, "en");
  assert.equal("apply_text_normalization" in flash, false, "Flash no admite normalización 'on': queda en auto");

  const v3 = buildTtsBody({ text: "Hi", modelId: "eleven_v3", voiceSettings: vs, languageCode: "pt", textNormalization: "off" });
  assert.deepEqual(v3.voice_settings, { stability: 0.5, similarity_boost: 0.8 }, "v3: estabilidad al preset más cercano, sin speed/style/boost");
  assert.equal(v3.language_code, "pt");
  assert.equal(v3.apply_text_normalization, "off");

  assert.equal(snapToPreset(0.2, [0, 0.5, 1]), 0);
  assert.equal(snapToPreset(0.25, [0, 0.5, 1]), 0.5, "empate → el más estable");
  assert.equal(snapToPreset(0.9, [0, 0.5, 1]), 1);
  assert.equal(snapToPreset(0.9, null), 0.9);
});

test("voiceSettingsFromFlat traduce claves planas del engine y omite las ausentes", () => {
  assert.deepEqual(voiceSettingsFromFlat({ ttsStability: 0.5, ttsSimilarityBoost: 0.75, ttsStyle: 0, ttsSpeed: 1, ttsSpeakerBoost: true, delayMs: 3000 }), {
    stability: 0.5, similarity_boost: 0.75, style: 0, speed: 1, use_speaker_boost: true,
  });
  assert.deepEqual(voiceSettingsFromFlat({ ttsSpeed: 0.9 }), { speed: 0.9 });
  assert.deepEqual(voiceSettingsFromFlat({}), {});
});

test("ElevenLabsTts: setModel/setVoiceSettings/setTextNormalization en caliente", async (t) => {
  const { calls } = mockFetch(t, () => binaryResponse(pcm));
  const tts = new ElevenLabsTts({ apiKey: "xi", modelId: "eleven_multilingual_v2", voiceSettings: { stability: 0.5, similarity_boost: 0.75, style: 0, speed: 1 }, sleep: instantSleep });
  await tts.synthesize({ text: "Hello", voiceId: "v", languageCode: "en" });
  let body = JSON.parse(calls[0].body);
  assert.equal(body.model_id, "eleven_multilingual_v2");
  assert.equal(body.voice_settings.style, 0);

  tts.setModel("eleven_v3");
  tts.setVoiceSettings({ stability: 0.9 });
  tts.setTextNormalization("off");
  assert.equal(tts.setTextNormalization("raro"), "off");
  const res = await tts.synthesize({ text: "Hello", voiceId: "v", languageCode: "en" });
  body = JSON.parse(calls[1].body);
  assert.equal(body.model_id, "eleven_v3");
  assert.deepEqual(body.voice_settings, { stability: 1, similarity_boost: 0.75 });
  assert.equal(body.language_code, "en");
  assert.equal(body.apply_text_normalization, "off");
  assert.equal(res.modelId, "eleven_v3");
  assert.match(calls[1].url, /\/v1\/text-to-speech\/v\?output_format=pcm_48000$/, "endpoint no-stream, válido para v3");

  tts.setModel("eleven_v4", { supportsStyle: true });
  assert.equal(tts.capabilities.supportsStyle, true);
});

test("ElevenLabsTts: si el modelo rechaza language_code se repite sin él y se recuerda", async (t) => {
  const { calls } = mockFetchSequence(t, [
    () => textResponse('{"detail":{"status":"invalid_request","message":"Model does not support language_code"}}', { status: 400 }),
    () => binaryResponse(pcm),
    () => binaryResponse(pcm),
  ]);
  const tts = new ElevenLabsTts({ apiKey: "xi", modelId: "eleven_turbo_v2_5", sleep: instantSleep, retries: 0 });
  const res = await tts.synthesize({ text: "Hola", voiceId: "v", languageCode: "es" });
  assert.equal(res.sampleRate, 48_000);
  assert.equal(JSON.parse(calls[0].body).language_code, "es");
  assert.equal("language_code" in JSON.parse(calls[1].body), false);
  await tts.synthesize({ text: "Otra", voiceId: "v", languageCode: "es" });
  assert.equal(calls.length, 3);
  assert.equal("language_code" in JSON.parse(calls[2].body), false);
  assert.equal(isLanguageCodeRejected(400, "output_format_not_allowed"), false);
});

test("ElevenLabsTts: error de modelo inválido lleva el modelo", async (t) => {
  mockFetch(t, () => textResponse('{"detail":{"status":"model_not_found","message":"Model eleven_zzz not found"}}', { status: 400 }));
  const tts = new ElevenLabsTts({ apiKey: "xi", modelId: "eleven_zzz", sleep: instantSleep, retries: 0 });
  await assert.rejects(tts.synthesize({ text: "hola", voiceId: "v" }), (e) => e instanceof TtsError && e.model === "eleven_zzz" && e.stage === "tts");
});

// ── DubbingPipeline ─────────────────────────────────────────────────────────

function router({ chatModel = "openai/gpt-oss-120b" } = {}) {
  return (url, init) => {
    if (url.endsWith("/audio/transcriptions")) return jsonResponse(whisperResponse("Hola a todos."));
    if (url.endsWith("/chat/completions")) {
      const body = JSON.parse(init.body);
      return jsonResponse(chatResponse("Hello everyone.", { model: body.model ?? chatModel, promptTokens: 300, completionTokens: 40 }));
    }
    if (url.includes("/text-to-speech/")) return binaryResponse(pcm);
    throw new Error(`URL inesperada ${url}`);
  };
}

test("DubbingPipeline.applySettings delega en cada etapa y rige desde el siguiente turno", async (t) => {
  const { calls } = mockFetch(t, router());
  const stt = new GroqWhisperStt({ apiKey: "gsk", sleep: instantSleep, retries: 0 });
  const translator = new ContextTranslator({ apiKey: "gsk", sleep: instantSleep, retries: 0 });
  const tts = new ElevenLabsTts({ apiKey: "xi", sleep: instantSleep, retries: 0 });
  const pipeline = new DubbingPipeline({ stt, translator, tts, voiceId: "voz-1", targetLanguage: "en" });

  const first = await pipeline.processTurn(makeTurn({ ms: 3000 }));
  assert.deepEqual(first.cost, estimateTurnCost(first.usage, { sttModel: "whisper-large-v3", translateModel: "openai/gpt-oss-120b", ttsModel: "eleven_multilingual_v2" }));

  const snapshot = pipeline.applySettings({
    sttModel: "whisper-large-v3-turbo",
    sttTemperature: 0.2,
    translateModel: "openai/gpt-oss-20b",
    translateTemperature: 0.5,
    translateReasoningEffort: "high",
    memoryTurns: 2,
    ttsModel: "eleven_flash_v2_5",
    ttsCapabilities: { supportsSpeakerBoost: false },
    ttsStability: 0.4,
    ttsSimilarityBoost: 0.9,
    ttsStyle: 0.3,
    ttsSpeed: 1.1,
    ttsSpeakerBoost: false,
    ttsTextNormalization: "off",
    ttsCostMultiplier: 0.5,
    voiceId: "voz-2",
  });
  assert.equal(snapshot.sttModel, "whisper-large-v3-turbo");
  assert.equal(snapshot.translateReasoningEffort, "high");
  assert.equal(snapshot.memoryTurns, 2);
  assert.equal(snapshot.ttsModel, "eleven_flash_v2_5");
  assert.equal(snapshot.voiceSettings.speed, 1.1);
  assert.equal(snapshot.voiceId, "voz-2");

  const second = await pipeline.processTurn(makeTurn({ ms: 3000, startedAt: 9000 }));
  const [sttCall, chatCall, ttsCall] = calls.slice(3);
  assert.equal(sttCall.body.get("model"), "whisper-large-v3-turbo");
  assert.equal(sttCall.body.get("temperature"), "0.2");
  const chat = JSON.parse(chatCall.body);
  assert.equal(chat.model, "openai/gpt-oss-20b");
  assert.equal(chat.temperature, 0.5);
  assert.equal(chat.reasoning_effort, "high");
  assert.match(ttsCall.url, /text-to-speech\/voz-2\?/);
  const ttsBody = JSON.parse(ttsCall.body);
  assert.equal(ttsBody.model_id, "eleven_flash_v2_5");
  assert.deepEqual(ttsBody.voice_settings, { stability: 0.4, similarity_boost: 0.9, speed: 1.1 });
  assert.equal(ttsBody.language_code, "en");
  assert.equal(ttsBody.apply_text_normalization, "off");

  // El costo usa los modelos nuevos: STT turbo y TTS a mitad de precio.
  assert.deepEqual(second.cost, estimateTurnCost(second.usage, { sttModel: "whisper-large-v3-turbo", translateModel: "openai/gpt-oss-20b", ttsModel: "eleven_flash_v2_5", ttsCostMultiplier: 0.5 }));
  assert.ok(second.cost.tts <= first.cost.tts);
});

test("DubbingPipeline.applySettings tolera dobles sin setters y parches vacíos", () => {
  const pipeline = new DubbingPipeline({
    stt: { transcribeTurn() {} },
    translator: { translate() {} },
    tts: { synthesize() {} },
    voiceId: "v",
  });
  const snap = pipeline.applySettings({ sttModel: "whisper-large-v3", ttsSpeed: 1 });
  assert.equal(snap.voiceId, "v");
  assert.equal(pipeline.applySettings(null).voiceId, "v");
});
