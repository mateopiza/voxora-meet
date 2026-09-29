import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextTranslator, TranslationError, TONES, buildSystemPrompt, cleanTranslation } from "./groq-translate.mjs";
import { GlossaryStore } from "../stores.mjs";
import { mockFetch, mockFetchSequence, jsonResponse, textResponse, instantSleep, chatResponse, tmpDir } from "../_test-helpers.mjs";

const apiKey = "gsk_test_key";

test("translate envía el request correcto a Groq Chat Completions", async (t) => {
  const { calls } = mockFetch(t, () => jsonResponse(chatResponse("Let's start with the budget.")));
  const translator = new ContextTranslator({ apiKey, sourceLanguage: "es", targetLanguage: "en", sleep: instantSleep });
  const res = await translator.translate({ text: "Empecemos por el presupuesto." });

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(call.method, "POST");
  assert.equal(call.headers.Authorization, `Bearer ${apiKey}`);
  assert.equal(call.headers["Content-Type"], "application/json");
  const body = JSON.parse(call.body);
  assert.equal(body.model, "openai/gpt-oss-120b");
  assert.equal(body.temperature, 0.2);
  assert.equal(body.reasoning_effort, "low");
  assert.equal(body.stream, false);
  assert.ok(body.max_completion_tokens >= 256);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages[0].content, /de español a inglés/);
  assert.match(body.messages[0].content, /primera persona/);
  assert.match(body.messages[0].content, /números, cifras, fechas/);
  assert.match(body.messages[0].content, /ÚNICAMENTE con la traducción/);
  assert.match(body.messages[0].content, new RegExp(TONES.professional.slice(0, 30)));
  assert.deepEqual(body.messages[1], { role: "user", content: "Empecemos por el presupuesto." });

  assert.equal(res.translation, "Let's start with the budget.");
  assert.deepEqual(res.usage, { inputTokens: 120, outputTokens: 20 });
  assert.equal(res.discarded, false);
});

test("VOXORA_MEET_GROQ_MODEL y opciones de constructor cambian el modelo; sin gpt-oss no manda reasoning_effort", async (t) => {
  const { calls } = mockFetch(t, () => jsonResponse(chatResponse("hi")));
  const translator = new ContextTranslator({ apiKey, model: "llama-3.3-70b-versatile", temperature: 0, sleep: instantSleep });
  await translator.translate({ text: "hola" });
  const body = JSON.parse(calls[0].body);
  assert.equal(body.model, "llama-3.3-70b-versatile");
  assert.equal(body.temperature, 0);
  assert.equal("reasoning_effort" in body, false);

  const prevEnv = process.env.VOXORA_MEET_GROQ_MODEL;
  process.env.VOXORA_MEET_GROQ_MODEL = "openai/gpt-oss-20b";
  t.after(() => { if (prevEnv === undefined) delete process.env.VOXORA_MEET_GROQ_MODEL; else process.env.VOXORA_MEET_GROQ_MODEL = prevEnv; });
  assert.equal(new ContextTranslator({ apiKey }).model, "openai/gpt-oss-20b");
});

test("memoria: conserva los últimos N turnos como mensajes previos", async (t) => {
  let n = 0;
  const { calls } = mockFetch(t, () => jsonResponse(chatResponse(`t${++n}`)));
  const translator = new ContextTranslator({ apiKey, memoryTurns: 2, sleep: instantSleep });
  await translator.translate({ text: "uno" });
  await translator.translate({ text: "dos" });
  await translator.translate({ text: "tres" });
  const body = JSON.parse(calls[2].body);
  // sistema + 2 turnos (4 mensajes) + actual
  assert.equal(body.messages.length, 6);
  assert.deepEqual(body.messages.slice(1), [
    { role: "user", content: "uno" },
    { role: "assistant", content: "t1" },
    { role: "user", content: "dos" },
    { role: "assistant", content: "t2" },
    { role: "user", content: "tres" },
  ]);
  await translator.translate({ text: "cuatro" });
  const body4 = JSON.parse(calls[3].body);
  assert.equal(body4.messages[1].content, "dos", "el turno más antiguo cae");
  assert.deepEqual(translator.memory.map((m) => m.source), ["tres", "cuatro"]);
  translator.clearMemory();
  assert.deepEqual(translator.memory, []);
});

test("memoria: una traducción vacía no se recuerda y se marca descartada", async (t) => {
  mockFetch(t, () => jsonResponse(chatResponse("   ")));
  const translator = new ContextTranslator({ apiKey, sleep: instantSleep });
  const res = await translator.translate({ text: "eh..." });
  assert.equal(res.translation, "");
  assert.equal(res.discarded, true);
  assert.deepEqual(translator.memory, []);
  const empty = await translator.translate({ text: "   " });
  assert.equal(empty.discarded, true);
});

test("glosario persistente se inyecta en el prompt de sistema", async (t) => {
  const dir = await tmpDir(t);
  const glossary = new GlossaryStore({ dir });
  await glossary.set("ana", [
    { term: "VOXORA", translation: null },
    { term: "sprint", translation: "iteración" },
  ]);
  const { calls } = mockFetch(t, () => jsonResponse(chatResponse("ok")));
  const translator = new ContextTranslator({ apiKey, glossary, userId: "ana", sleep: instantSleep });
  await translator.translate({ text: "hola" });
  const system = JSON.parse(calls[0].body).messages[0].content;
  assert.match(system, /Glosario del usuario/);
  assert.match(system, /"VOXORA" → se mantiene sin traducir/);
  assert.match(system, /"sprint" → "iteración"/);

  // Otro usuario sin glosario → sin sección.
  await translator.translate({ text: "hola", userId: "beto" });
  assert.doesNotMatch(JSON.parse(calls[1].body).messages[0].content, /Glosario/);
});

test("tono e instrucción de estilo se reflejan en el prompt (constructor y por llamada)", async (t) => {
  const { calls } = mockFetch(t, () => jsonResponse(chatResponse("ok")));
  const translator = new ContextTranslator({ apiKey, tone: "formal", styleInstruction: "Frases cortas.", sleep: instantSleep });
  await translator.translate({ text: "hola" });
  let system = JSON.parse(calls[0].body).messages[0].content;
  assert.match(system, new RegExp(TONES.formal.slice(0, 20)));
  assert.match(system, /Instrucción de estilo del usuario.*Frases cortas\./);

  translator.setTone("neutral");
  translator.setStyleInstruction("");
  await translator.translate({ text: "hola", targetLanguage: "pt" });
  system = JSON.parse(calls[1].body).messages[0].content;
  assert.match(system, new RegExp(TONES.neutral.slice(0, 20)));
  assert.doesNotMatch(system, /Instrucción de estilo/);
  assert.match(system, /a portugués/);
  assert.throws(() => translator.setTone("gritando"), /Tono desconocido/);
  assert.equal(new ContextTranslator({ apiKey, tone: "loco" }).tone, "professional");
});

test("buildSystemPrompt y cleanTranslation", () => {
  const prompt = buildSystemPrompt({ sourceLanguage: "es", targetLanguage: "de", glossaryLines: ['- "x" → "y"'] });
  assert.match(prompt, /español a alemán/);
  assert.match(prompt, /- "x" → "y"/);
  assert.equal(cleanTranslation('"Hello there."'), "Hello there.");
  assert.equal(cleanTranslation("Traducción: Hello"), "Hello");
  assert.equal(cleanTranslation("«Hola»"), "Hola");
  assert.equal(cleanTranslation('He said "hi" and "bye"'), 'He said "hi" and "bye"');
  assert.equal(cleanTranslation(null), "");
});

test("reintentos con backoff en 429/5xx y TranslationError en 4xx", async (t) => {
  const { calls } = mockFetchSequence(t, [
    () => textResponse("slow down", { status: 429, headers: { "retry-after": "0" } }),
    () => textResponse("bad gateway", { status: 502 }),
    () => jsonResponse(chatResponse("done")),
  ]);
  const translator = new ContextTranslator({ apiKey, retries: 2, sleep: instantSleep });
  const res = await translator.translate({ text: "hola" });
  assert.equal(res.translation, "done");
  assert.equal(calls.length, 3);

  mockFetch(t, () => textResponse("bad request", { status: 400 }));
  await assert.rejects(translator.translate({ text: "hola" }), (e) => {
    assert.ok(e instanceof TranslationError);
    assert.equal(e.status, 400);
    return true;
  });

  mockFetch(t, () => textResponse("down", { status: 500 }));
  await assert.rejects(translator.translate({ text: "hola" }), (e) => e instanceof TranslationError && e.status === 500);
});

test("timeout y abort", async (t) => {
  mockFetch(t, (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))));
  const translator = new ContextTranslator({ apiKey, retries: 0, timeoutMs: 15, sleep: instantSleep });
  await assert.rejects(translator.translate({ text: "hola" }), (e) => e.name === "TimeoutError" || e.name === "AbortError");

  const controller = new AbortController();
  const p = translator.translate({ text: "hola", signal: controller.signal });
  controller.abort();
  await assert.rejects(p, (e) => e.name === "AbortError");
});
