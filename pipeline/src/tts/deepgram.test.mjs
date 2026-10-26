import { test } from "node:test";
import assert from "node:assert/strict";
import { DeepgramTts } from "./deepgram.mjs";
import { pcmToWav } from "../util/wav.mjs";

test("DeepgramTts pide Aura en /v1/speak como WAV y Flux en /v2 como PCM", async () => {
  const pcm = Buffer.alloc(8);
  pcm.writeInt16LE(1000, 0);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.Authorization, body: JSON.parse(init.body) });
    if (String(url).includes("/v2/")) return new Response(pcm, { status: 200 });
    return new Response(pcmToWav(pcm, { sampleRate: 24000 }), { status: 200 });
  };
  const aura = new DeepgramTts({ apiKey: "dg", model: "aura-2", voice: "aura-2-thalia-en", fetch: fetchImpl, retries: 0 });
  const spoken = await aura.synthesize({ text: "hola equipo" });
  assert.equal(spoken.audioFormat, "pcm_s16le");
  assert.equal(spoken.sampleRate, 24000);
  assert.equal(spoken.audio.readInt16LE(0), 1000);
  assert.match(calls[0].url, /\/v1\/speak\?/);
  assert.match(calls[0].url, /model=aura-2-thalia-en/);
  assert.match(calls[0].url, /container=wav/);
  assert.equal(calls[0].auth, "Token dg");
  assert.equal(calls[0].body.text, "hola equipo");

  const flux = new DeepgramTts({ apiKey: "dg", model: "flux", voice: "flux-alexis-en", fetch: fetchImpl, retries: 0 });
  const out = await flux.synthesize({ text: "hola" });
  assert.equal(out.audio.readInt16LE(0), 1000);
  assert.match(calls[1].url, /\/v2\/speak\?/);
  assert.match(calls[1].url, /container=none/);
  assert.match(calls[1].url, /model=flux-alexis-en/);
});
