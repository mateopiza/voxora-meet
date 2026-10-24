import { test } from "node:test";
import assert from "node:assert/strict";
import { ElevenRealtimeDub, interpreterInstructions } from "./eleven-realtime-dub.mjs";

class FakeSocket {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.sent = [];
    this.listeners = {};
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatch("open");
    });
  }

  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener() {}
  dispatch(type, event) { for (const fn of this.listeners[type] ?? []) fn(event); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
}

test("las instrucciones solo piden la traducción", () => {
  const text = interpreterInstructions({ sourceLanguage: "es", targetLanguage: "en", glossary: [{ term: "VOXORA", translation: "VOXORA" }] });
  assert.match(text, /español/);
  assert.match(text, /inglés/);
  assert.match(text, /VOXORA = VOXORA/);
  assert.match(text, /No saludes/);
});

test("Eleven Realtime abre con client secret y emite audio de 48 kHz", async () => {
  let secretBody;
  const fetchImpl = async (_url, init) => {
    secretBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ value: "secret-1" }), { status: 200 });
  };
  const sockets = [];
  const WS = class extends FakeSocket {
    constructor(url, options) { super(url, options); sockets.push(this); }
  };
  const dub = new ElevenRealtimeDub({
    apiKey: "xi", model: "eleven_realtime_v1_max", voice: "Ana", fetch: fetchImpl, WebSocket: WS, now: () => 0,
  });
  const audio = [];
  const segments = [];
  dub.on("audio", (chunk) => audio.push(chunk));
  dub.on("segment", (segment) => segments.push(segment));
  await dub.open();
  assert.equal(secretBody.session.model, "eleven_realtime_v1_max");
  assert.equal(secretBody.session.audio.output.voice, "Ana");
  assert.equal(sockets[0].options.headers.Authorization, "Bearer secret-1");

  const pcm = Buffer.alloc(3200);
  dub.pushPcm(pcm, 16000);
  assert.equal(sockets[0].sent[0].type, "input_audio_buffer.append");
  sockets[0].dispatch("message", { data: JSON.stringify({ type: "response.created" }) });
  sockets[0].dispatch("message", { data: JSON.stringify({ type: "response.output_audio.delta", delta: Buffer.alloc(480).toString("base64") }) });
  sockets[0].dispatch("message", { data: JSON.stringify({ type: "response.done" }) });
  assert.ok(audio[0].pcm.length > 0);
  assert.equal(audio[0].sampleRate, 48000);
  assert.equal(segments[0].cost.totalVox >= 0, true);
  assert.equal(segments[0].metrics.totalMs, 0);

  const unavailable = async () => new Response("Realtime models are not available", { status: 403 });
  const blocked = new ElevenRealtimeDub({ apiKey: "xi", fetch: unavailable, WebSocket: WS });
  await assert.rejects(blocked.open(), /no está habilitado/);
});
