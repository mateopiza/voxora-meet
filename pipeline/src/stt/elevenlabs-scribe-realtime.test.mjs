import { test } from "node:test";
import assert from "node:assert/strict";
import { ElevenLabsScribeRealtimeStt } from "./elevenlabs-scribe-realtime.mjs";

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

  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }

  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((item) => item !== fn);
  }

  dispatch(type, event) {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }

  send(data) {
    const msg = JSON.parse(data);
    this.sent.push(msg);
    if (msg.commit) this.dispatch("message", { data: JSON.stringify({ message_type: "committed_transcript", text: "buenos días" }) });
  }

  close() {
    this.readyState = 3;
  }
}

test("Scribe realtime manda el turno y espera el commit", async () => {
  const sockets = [];
  const WS = class extends FakeSocket {
    constructor(url, options) {
      super(url, options);
      sockets.push(this);
    }
  };
  const stt = new ElevenLabsScribeRealtimeStt({ apiKey: "xi", language: "es", WebSocket: WS, timeoutMs: 2000 });
  const pcm = Buffer.alloc(4000);
  const result = await stt.transcribeTurn({ pcm, sampleRate: 16000 });
  assert.equal(result.text, "buenos días");
  assert.equal(result.discarded, false);
  assert.match(sockets[0].url, /model_id=scribe_v2_realtime/);
  assert.equal(sockets[0].options.headers["xi-api-key"], "xi");
  assert.equal(sockets[0].sent.at(-1).commit, true);
  await stt.close();
  assert.equal(sockets[0].readyState, 3);
});
