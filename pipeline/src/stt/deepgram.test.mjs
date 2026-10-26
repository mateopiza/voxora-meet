import { test } from "node:test";
import assert from "node:assert/strict";
import { DeepgramStt, deepgramQuery } from "./deepgram.mjs";

test("deepgramQuery: nova-3-multi pide language=multi", () => {
  assert.equal(deepgramQuery("nova-3", "es").get("language"), "es");
  assert.equal(deepgramQuery("nova-3-multi", "es").get("model"), "nova-3");
  assert.equal(deepgramQuery("nova-3-multi", "es").get("language"), "multi");
});

test("DeepgramStt transcribe un turno y descarta el silencio", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization, type: init.headers["Content-Type"] });
    return new Response(JSON.stringify({
      results: { channels: [{ alternatives: [{ transcript: "hola equipo", confidence: 0.9 }] }] },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const stt = new DeepgramStt({ apiKey: "dg", model: "nova-3", fetch: fetchImpl, retries: 0 });
  const pcm = Buffer.alloc(3200);
  const result = await stt.transcribeTurn({ pcm, sampleRate: 16000, language: "es" });
  assert.equal(result.text, "hola equipo");
  assert.equal(result.discarded, false);
  assert.equal(result.model, "nova-3");
  assert.match(calls[0].url, /model=nova-3/);
  assert.match(calls[0].url, /language=es/);
  assert.equal(calls[0].auth, "Token dg");
  assert.equal(calls[0].type, "audio/wav");

  const empty = await stt.transcribeTurn({ pcm: Buffer.alloc(0) });
  assert.equal(empty.reason, "empty_audio");
});
