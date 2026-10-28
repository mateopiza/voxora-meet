import { test } from "node:test";
import assert from "node:assert/strict";
import { FallbackStt } from "./fallback.mjs";

const ok = (provider, text = "hola") => ({ provider, model: `${provider}-m`, transcribeTurn: async () => ({ text }) });
const fail = (provider, error = new Error(`${provider} caído`)) => ({ provider, transcribeTurn: async () => { throw error; } });

test("usa el principal si responde", async () => {
  const stt = new FallbackStt(ok("groq"), [ok("deepgram", "no")]);
  assert.deepEqual(await stt.transcribeTurn({}), { text: "hola" });
  assert.equal(stt.provider, "groq");
  assert.equal(stt.model, "groq-m");
});

test("cae al respaldo y lo informa", async () => {
  const events = [];
  const stt = new FallbackStt(fail("groq"), [fail("deepgram"), ok("elevenlabs", "ok")], { onFallback: (e) => events.push(e) });
  const res = await stt.transcribeTurn({});
  assert.equal(res.text, "ok");
  assert.equal(res.fallbackFrom, "groq");
  assert.equal(res.provider, "elevenlabs");
  assert.equal(events.length, 1);
  assert.equal(events[0].to, "elevenlabs");
  assert.match(events[0].error.message, /groq/);
});

test("si todos fallan, lanza el error del principal", async () => {
  const stt = new FallbackStt(fail("groq"), [fail("deepgram")]);
  await assert.rejects(stt.transcribeTurn({}), /groq caído/);
});

test("la cancelación no dispara el respaldo", async () => {
  let called = false;
  const abort = Object.assign(new Error("abort"), { name: "AbortError" });
  const stt = new FallbackStt(fail("groq", abort), [{ provider: "deepgram", transcribeTurn: async () => { called = true; return { text: "x" }; } }]);
  await assert.rejects(stt.transcribeTurn({}), { name: "AbortError" });
  assert.equal(called, false);
});
