import { test } from "node:test";
import assert from "node:assert/strict";
import { SpeechTts, splitForSpeech } from "./speech.mjs";
import { pcmToWav } from "../util/wav.mjs";

test("splitForSpeech corta Orpheus en 200 caracteres", () => {
  assert.deepEqual(splitForSpeech("hola", 200), ["hola"]);
  const long = `${"frase corta. ".repeat(30)}final`;
  const parts = splitForSpeech(long, 200);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 200));
  assert.equal(parts.join(" ").replace(/\s+/g, " ").includes("final"), true);
});

test("SpeechTts OpenAI concatena PCM y Groq lee WAV", async () => {
  const pcm = Buffer.alloc(8);
  pcm.writeInt16LE(1000, 0);
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.response_format === "wav") return new Response(pcmToWav(pcm, { sampleRate: 24000 }), { status: 200 });
    return new Response(pcm, { status: 200 });
  };
  const openai = new SpeechTts({ provider: "openai", apiKey: "sk", fetch: fetchImpl, retries: 0 });
  const spoken = await openai.synthesize({ text: "hola" });
  assert.equal(spoken.audioFormat, "pcm_s16le");
  assert.equal(spoken.sampleRate, 24000);
  assert.equal(spoken.audio.readInt16LE(0), 1000);

  const groq = new SpeechTts({ provider: "groq", apiKey: "gsk", model: "canopylabs/orpheus-v1-english", voice: "troy", fetch: fetchImpl, retries: 0 });
  const arabic = "palabra ".repeat(40);
  const out = await groq.synthesize({ text: arabic });
  assert.ok(out.audio.length >= 8);
  assert.equal(out.modelId, "canopylabs/orpheus-v1-english");
});
