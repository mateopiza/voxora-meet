import { test } from "node:test";
import assert from "node:assert/strict";
import { DubbingPipeline, DubbingError, StageQueue } from "./dubbing-pipeline.mjs";
import { GroqWhisperStt } from "./stt/groq-whisper.mjs";
import { ContextTranslator } from "./translate/groq-translate.mjs";
import { ElevenLabsTts } from "./tts/elevenlabs.mjs";
import { ProfileStore, GlossaryStore } from "./stores.mjs";
import { estimateTurnCost, SessionMeter } from "../../billing/src/index.mjs";
import { mockFetch, jsonResponse, binaryResponse, textResponse, instantSleep, makePcm, makeTurn, whisperResponse, chatResponse, deferred, tick, tmpDir } from "./_test-helpers.mjs";

const GROQ_STT = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_CHAT = "https://api.groq.com/openai/v1/chat/completions";
const ELEVEN_TTS = /^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/([^/?]+)\?output_format=(.+)$/;
const dubAudio = makePcm(300, 48_000);

test('bounded admission rejects overload and avoids TTS after delivery expires', async () => {
  const gate = deferred();
  let ttsCalls = 0;
  const pipeline = new DubbingPipeline({
    voiceId: 'voice',
    stt: { async transcribeTurn() { await gate.promise; return { text: 'hola' }; } },
    translator: { async translate() { return { translation: 'hello' }; } },
    tts: { async synthesize() { ttsCalls++; throw new Error('must not synthesize'); } },
  });
  const pending = Array.from({ length: 4 }, () => pipeline.processTurn(makeTurn({ ms: 1000 }), { shouldSynthesize: () => false }));
  await assert.rejects(pipeline.processTurn(makeTurn({ ms: 1000 })), { code: 'pipeline_overload' });
  gate.resolve();
  assert.deepEqual(await Promise.all(pending), [null, null, null, null]);
  assert.equal(ttsCalls, 0);
  assert.deepEqual(pipeline.metrics.queued, { stt: 0, translate: 0, tts: 0 });
});

/** Pipeline real (STT + traductor + TTS reales) con fetch global mockeado por URL. */
function buildPipeline(overrides = {}) {
  const stt = new GroqWhisperStt({ apiKey: "gsk", sleep: instantSleep, retries: 0 });
  const translator = new ContextTranslator({ apiKey: "gsk", sleep: instantSleep, retries: 0 });
  const tts = new ElevenLabsTts({ apiKey: "xi", sleep: instantSleep, retries: 0 });
  return new DubbingPipeline({ stt, translator, tts, voiceId: "voice-ana", sourceLanguage: "es", targetLanguage: "en", ...overrides });
}

/** Router de proveedores: cada handler puede devolver Response o Promise<Response>. */
function providerRouter({ onStt, onChat, onTts } = {}) {
  let sttN = 0;
  let chatN = 0;
  let ttsN = 0;
  return (url, init, call) => {
    if (url === GROQ_STT) return (onStt ?? (() => jsonResponse(whisperResponse(`frase ${sttN}`))))(++sttN, call);
    if (url === GROQ_CHAT) {
      const body = JSON.parse(init.body);
      const last = body.messages.at(-1).content;
      return (onChat ?? (() => jsonResponse(chatResponse(`translated: ${last}`))))(++chatN, call, body);
    }
    const m = ELEVEN_TTS.exec(url);
    if (m) return (onTts ?? (() => binaryResponse(dubAudio)))(++ttsN, call, { voiceId: m[1], outputFormat: m[2], body: JSON.parse(init.body) });
    throw new Error(`URL inesperada en test: ${url}`);
  };
}

test("E2E: un turno atraviesa STT → traducción → TTS y devuelve DubResult con costo", async (t) => {
  const { calls } = mockFetch(t, providerRouter({
    onStt: () => jsonResponse(whisperResponse("Hola a todos, empecemos por el presupuesto.")),
    onChat: (_n, _c, body) => {
      assert.equal(body.messages.at(-1).content, "Hola a todos, empecemos por el presupuesto.");
      return jsonResponse(chatResponse("Hello everyone, let's start with the budget.", { promptTokens: 200, completionTokens: 12 }));
    },
  }));
  let clock = 0;
  const pipeline = buildPipeline({ now: () => (clock += 10) });
  const events = [];
  pipeline.on("turn", (r) => events.push(r));
  const turn = makeTurn({ ms: 3000, startedAt: 5000 });
  const result = await pipeline.processTurn(turn);

  assert.ok(result.audioDub.equals(dubAudio));
  assert.equal(result.sampleRate, 48_000);
  assert.equal(result.audioFormat, "pcm_s16le");
  assert.equal(result.sourceTimestamp, 5000);
  assert.equal(result.sourceEndedAt, 8000);
  assert.ok(result.readyAt > 0);
  assert.equal(result.transcript, "Hola a todos, empecemos por el presupuesto.");
  assert.equal(result.translation, "Hello everyone, let's start with the budget.");
  assert.ok(result.confidence > 0.5);

  const expectedCost = estimateTurnCost({ audioMs: 3000, inputTokens: 200, outputTokens: 12, ttsChars: "Hello everyone, let's start with the budget.".length });
  assert.deepEqual(result.cost, expectedCost);
  assert.ok(result.cost.totalVox >= 3);
  assert.deepEqual(result.usage, { audioMs: 3000, inputTokens: 200, outputTokens: 12, ttsChars: 44 });
  assert.ok(result.metrics.sttMs > 0 && result.metrics.translateMs > 0 && result.metrics.ttsMs > 0 && result.metrics.totalMs > 0);

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, GROQ_STT);
  assert.equal(calls[1].url, GROQ_CHAT);
  assert.match(calls[2].url, /text-to-speech\/voice-ana\?output_format=pcm_48000/);
  assert.equal(JSON.parse(calls[2].body).text, "Hello everyone, let's start with the budget.");
  // eleven_multilingual_v2 no admite `language_code` (lo rechaza): no se manda.
  assert.equal("language_code" in JSON.parse(calls[2].body), false);
  assert.equal(events.length, 1);
  assert.equal(pipeline.metrics.dubbed, 1);
  assert.equal(pipeline.metrics.processed, 1);
});

test("E2E: descartes resuelven null (turno corto, alucinación, traducción vacía) sin llamar etapas siguientes", async (t) => {
  let mode = "hallucination";
  const { calls } = mockFetch(t, providerRouter({
    onStt: () => jsonResponse(mode === "hallucination" ? whisperResponse("Gracias por ver el video") : whisperResponse("eh, mmm")),
    onChat: () => jsonResponse(chatResponse("")),
  }));
  const pipeline = buildPipeline();
  const discards = [];
  pipeline.on("discard", (d) => discards.push(d));

  assert.equal(await pipeline.processTurn(makeTurn({ voicedMs: 100 })), null);
  assert.equal(calls.length, 0, "turno demasiado corto: ni STT");
  assert.equal(discards[0].reason, "too_short");

  assert.equal(await pipeline.processTurn(makeTurn()), null);
  assert.equal(calls.length, 1, "alucinación: STT sí, traducción no");
  assert.equal(discards[1].reason, "hallucination");

  mode = "empty";
  assert.equal(await pipeline.processTurn(makeTurn()), null);
  assert.equal(calls.length, 3, "traducción vacía: STT + chat, sin TTS");
  assert.equal(discards[2].reason, "empty_translation");
  assert.equal(pipeline.metrics.discarded, 3);
  assert.equal(pipeline.metrics.dubbed, 0);
});

test("pipeline por etapas: el STT del turno N+1 arranca mientras el TTS del N sigue, y el orden se conserva", async (t) => {
  const ttsGate = deferred();
  const sttStarted = [];
  mockFetch(t, providerRouter({
    onStt: (n) => { sttStarted.push(n); return jsonResponse(whisperResponse(`frase ${n}`)); },
    onTts: async (n) => {
      if (n === 1) await ttsGate.promise;
      return binaryResponse(dubAudio);
    },
  }));
  const pipeline = buildPipeline();
  const order = [];
  const p1 = pipeline.processTurn(makeTurn({ startedAt: 1 })).then((r) => { order.push(1); return r; });
  const p2 = pipeline.processTurn(makeTurn({ startedAt: 2 })).then((r) => { order.push(2); return r; });
  const p3 = pipeline.processTurn(makeTurn({ startedAt: 3 })).then((r) => { order.push(3); return r; });

  // Dejar correr el event loop: STT 1,2,3 y traducciones deben avanzar aunque TTS 1 esté bloqueado.
  for (let i = 0; i < 20; i += 1) await tick();
  assert.deepEqual(sttStarted, [1, 2, 3], "los STT de los turnos siguientes no esperan al TTS del primero");
  assert.deepEqual(order, [], "nadie termina antes que el turno 1");
  assert.equal(pipeline.metrics.queued.tts >= 1, true);

  ttsGate.resolve();
  const results = await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(results.map((r) => r.transcript), ["frase 1", "frase 2", "frase 3"]);
  assert.deepEqual(results.map((r) => r.translation), ["translated: frase 1", "translated: frase 2", "translated: frase 3"]);
  await pipeline.drain();
  assert.deepEqual(pipeline.metrics.queued, { stt: 0, translate: 0, tts: 0 });
});

test("memoria del traductor se alimenta turno a turno dentro del pipeline", async (t) => {
  const bodies = [];
  mockFetch(t, providerRouter({ onChat: (_n, _c, body) => { bodies.push(body); return jsonResponse(chatResponse("ok")); } }));
  const pipeline = buildPipeline();
  await pipeline.processTurn(makeTurn());
  await pipeline.processTurn(makeTurn());
  assert.equal(bodies[0].messages.length, 2);
  assert.equal(bodies[1].messages.length, 4, "segundo turno lleva el primero como contexto");
});

test("cancelación: AbortSignal por turno y abort() global rechazan con AbortError", async (t) => {
  const gate = deferred();
  mockFetch(t, providerRouter({
    onStt: async (_n, call) => {
      await Promise.race([gate.promise, new Promise((_, reject) => call.signal.addEventListener("abort", () => reject(call.signal.reason)))]);
      return jsonResponse(whisperResponse("x"));
    },
  }));
  const pipeline = buildPipeline();
  const cancels = [];
  pipeline.on("cancel", (c) => cancels.push(c));

  const controller = new AbortController();
  const p1 = pipeline.processTurn(makeTurn({ startedAt: 1 }), { signal: controller.signal });
  await tick();
  controller.abort();
  await assert.rejects(p1, (e) => e.name === "AbortError");
  assert.equal(cancels.length, 1);

  const p2 = pipeline.processTurn(makeTurn({ startedAt: 2 }));
  const p3 = pipeline.processTurn(makeTurn({ startedAt: 3 }));
  await tick();
  pipeline.abort();
  await assert.rejects(p2, (e) => e.name === "AbortError");
  await assert.rejects(p3, (e) => e.name === "AbortError");
  assert.equal(pipeline.metrics.cancelled, 3);

  // Tras abort(), todo nuevo turno se rechaza hasta reset().
  await assert.rejects(pipeline.processTurn(makeTurn()), (e) => e.name === "AbortError");
  pipeline.reset();
  gate.resolve();
  const ok = await pipeline.processTurn(makeTurn());
  assert.equal(ok.transcript, "x");
});

test("errores de proveedor rechazan el turno, se contabilizan y no bloquean los siguientes", async (t) => {
  let fail = true;
  mockFetch(t, providerRouter({
    onTts: () => (fail ? textResponse('{"detail":"voice_not_found"}', { status: 400 }) : binaryResponse(dubAudio)),
  }));
  const pipeline = buildPipeline();
  const errors = [];
  pipeline.on("error", (e) => errors.push(e));
  await assert.rejects(pipeline.processTurn(makeTurn()), (e) => e.name === "TtsError" && e.status === 400);
  assert.equal(errors.length, 1);
  fail = false;
  const ok = await pipeline.processTurn(makeTurn());
  assert.ok(ok.audioDub.length > 0);
  assert.equal(pipeline.metrics.failed, 1);
  assert.equal(pipeline.metrics.dubbed, 1);

  await assert.rejects(pipeline.processTurn({}), DubbingError);
});

test("mp3 de fallback se rechaza por defecto (el sync-buffer exige PCM) y se acepta con allowMp3", async (t) => {
  const formatError = () => textResponse("output_format_not_allowed", { status: 403 });
  mockFetch(t, providerRouter({
    onTts: (_n, _c, { outputFormat }) => (outputFormat.startsWith("pcm_") ? formatError() : binaryResponse(Buffer.from("mp3"), { contentType: "audio/mpeg" })),
  }));
  const strict = buildPipeline();
  await assert.rejects(strict.processTurn(makeTurn()), (e) => e.name === "TtsError" && /ningún formato PCM/.test(e.message));

  const lenient = buildPipeline({ allowMp3: true });
  const res = await lenient.processTurn(makeTurn());
  assert.equal(res.audioFormat, "mp3");
  assert.equal(res.sampleRate, null);
});

test("voiceId desde ProfileStore, glosario en el prompt y SessionMeter acumulando costo", async (t) => {
  const dir = await tmpDir(t);
  const profiles = new ProfileStore({ dir });
  await profiles.setVoice("ana", { voiceId: "voice-from-profile" });
  const glossary = new GlossaryStore({ dir });
  await glossary.set("ana", [{ term: "VOXORA", translation: null }]);

  const ttsVoices = [];
  const systems = [];
  mockFetch(t, providerRouter({
    onChat: (_n, _c, body) => { systems.push(body.messages[0].content); return jsonResponse(chatResponse("ok", { promptTokens: 300, completionTokens: 5 })); },
    onTts: (_n, _c, { voiceId }) => { ttsVoices.push(voiceId); return binaryResponse(dubAudio); },
  }));
  const meter = new SessionMeter({ maxVoxPerSession: 5, warnAtVox: 3 });
  const meterEvents = [];
  meter.on("warn", () => meterEvents.push("warn"));
  meter.on("limit", () => meterEvents.push("limit"));

  const stt = new GroqWhisperStt({ apiKey: "gsk", sleep: instantSleep });
  const translator = new ContextTranslator({ apiKey: "gsk", glossary, userId: "ana", sleep: instantSleep });
  const tts = new ElevenLabsTts({ apiKey: "xi", sleep: instantSleep });
  const pipeline = new DubbingPipeline({ stt, translator, tts, profiles, userId: "ana", meter });

  const r1 = await pipeline.processTurn(makeTurn());
  assert.deepEqual(ttsVoices, ["voice-from-profile"]);
  assert.match(systems[0], /"VOXORA" → se mantiene sin traducir/);
  assert.equal(meter.totalVox, r1.cost.totalVox);
  await pipeline.processTurn(makeTurn());
  assert.equal(meter.turns, 2);
  assert.ok(meterEvents.includes("warn") || meterEvents.includes("limit"), "el medidor reacciona al consumo acumulado");

  await profiles.clearVoice("ana");
  pipeline.setVoiceId(null);
  await assert.rejects(pipeline.processTurn(makeTurn()), (e) => e instanceof DubbingError && /voz clonada/.test(e.message));
});

test("StageQueue conserva el orden, no se bloquea por errores y reporta pendientes", async () => {
  const q = new StageQueue();
  const log = [];
  const a = q.run(async () => { await tick(); log.push("a"); return "a"; });
  const b = q.run(async () => { log.push("b"); throw new Error("b falla"); });
  const c = q.run(async () => { log.push("c"); return "c"; });
  assert.equal(q.pending, 3);
  assert.equal(await a, "a");
  await assert.rejects(b, /b falla/);
  assert.equal(await c, "c");
  assert.deepEqual(log, ["a", "b", "c"]);
  await q.idle();
  assert.equal(q.pending, 0);
});

test("constructor valida dependencias", () => {
  const stub = { transcribeTurn() {}, translate() {}, synthesize() {} };
  assert.throws(() => new DubbingPipeline({ translator: stub, tts: stub, voiceId: "v" }), /stt/);
  assert.throws(() => new DubbingPipeline({ stt: stub, tts: stub, voiceId: "v" }), /translator/);
  assert.throws(() => new DubbingPipeline({ stt: stub, translator: stub, voiceId: "v" }), /tts/);
  assert.throws(() => new DubbingPipeline({ stt: stub, translator: stub, tts: stub }), /voiceId.*profiles/);
});
