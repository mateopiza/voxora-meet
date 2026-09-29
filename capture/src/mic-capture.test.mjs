import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { MicCapture, DEFAULT_HELPER_PATH } from "./mic-capture.mjs";
import { tone, silence } from "./test-signals.mjs";

/** Proceso hijo falso: stdout/stderr son PassThrough y `kill()` emite `exit`. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.stdout.end();
    queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
    return true;
  };
  return child;
}

test("con source sintético emite turn y level según el contrato", async () => {
  const source = new PassThrough();
  const capture = new MicCapture({ source });
  const turns = [];
  const levels = [];
  capture.on("turn", (turn) => turns.push(turn));
  capture.on("level", (level) => levels.push(level));
  capture.start();

  const signal = Buffer.concat([silence(1000), tone(1500), silence(1500)]);
  for (let offset = 0; offset < signal.length; offset += 3200) {
    source.write(signal.subarray(offset, offset + 3200));
  }
  source.end();
  await once(capture, "sourceEnd");

  assert.equal(turns.length, 1);
  const [turn] = turns;
  assert.equal(turn.sampleRate, 16000);
  assert.ok(Buffer.isBuffer(turn.pcm));
  assert.ok(Math.abs(turn.voicedMs - 1500) <= 100, `voicedMs ${turn.voicedMs}`);
  assert.ok(turn.endedAt > turn.startedAt);
  assert.equal(typeof turn.rmsDb, "number");
  assert.ok(levels.length > 0);
  assert.ok(levels.every((level) => typeof level.rmsDb === "number" && typeof level.speaking === "boolean"));

  const stopped = once(capture, "stopped");
  capture.stop();
  await stopped;
});

test("stop() cierra el turno en curso con flush", async () => {
  const source = new PassThrough();
  const capture = new MicCapture({ source });
  const turns = [];
  capture.on("turn", (turn) => turns.push(turn));
  capture.start();
  source.write(Buffer.concat([silence(500), tone(800)]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(turns.length, 0);
  capture.stop();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].reason, "flush");
});

test("lanza el helper con --device/--rate y lee PCM de su stdout", async () => {
  const calls = [];
  const children = [];
  const spawn = (file, args, options) => {
    calls.push({ file, args, options });
    const child = fakeChild();
    children.push(child);
    return child;
  };
  const capture = new MicCapture({ deviceId: "{abc-123}", helperPath: "C:\\fake\\wasapi-capture.exe", spawn });
  const turns = [];
  const logs = [];
  capture.on("turn", (turn) => turns.push(turn));
  capture.on("helperLog", (line) => logs.push(line));
  capture.start();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "C:\\fake\\wasapi-capture.exe");
  assert.deepEqual(calls[0].args, ["--rate", "16000", "--device", "{abc-123}"]);
  assert.equal(calls[0].options.stdio[1], "pipe");

  children[0].stderr.write('{"event":"ready"}\npartial');
  children[0].stdout.write(Buffer.concat([silence(1000), tone(1000), silence(1500)]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(turns.length, 1);
  assert.deepEqual(logs, ['{"event":"ready"}']);

  capture.stop();
  assert.equal(children[0].killed, true);
});

test("reinicia el helper con backoff exponencial si muere", async () => {
  const children = [];
  const spawn = () => {
    const child = fakeChild();
    children.push(child);
    return child;
  };
  let now = 0;
  const capture = new MicCapture({
    helperPath: "C:\\fake\\wasapi-capture.exe",
    spawn,
    clock: () => now,
    restart: { baseMs: 5, maxMs: 20, factor: 2, stableAfterMs: 10000 },
  });
  const exits = [];
  capture.on("helperExit", (info) => exits.push(info));
  capture.on("error", () => {});
  capture.start();
  assert.equal(children.length, 1);

  // Muere tres veces seguidas: 5, 10, 20 ms de espera.
  for (let i = 0; i < 3; i += 1) {
    now += 100; // vivió poco: el backoff crece
    const restarted = new Promise((resolve) => {
      const check = () => (children.length === i + 2 ? resolve() : setTimeout(check, 1));
      check();
    });
    children[i].emit("exit", 1, null);
    await restarted;
  }
  assert.deepEqual(exits.map((info) => info.restartInMs), [5, 10, 20]);
  assert.equal(exits[0].code, 1);

  // Si vivió "mucho" (≥ stableAfterMs), el backoff vuelve al valor base.
  now += 20000;
  const restarted = new Promise((resolve) => {
    const check = () => (children.length === 5 ? resolve() : setTimeout(check, 1));
    check();
  });
  children[3].emit("exit", 1, null);
  await restarted;
  assert.equal(exits[3].restartInMs, 5);

  capture.stop();
  assert.equal(children[4].killed, true);
});

test("si el helper no existe emite error HELPER_NOT_FOUND y se detiene", async () => {
  const spawn = () => {
    const child = fakeChild();
    queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })));
    return child;
  };
  const capture = new MicCapture({ helperPath: "C:\\no\\existe.exe", spawn });
  const errorPromise = once(capture, "error");
  capture.start();
  const [error] = await errorPromise;
  assert.equal(error.code, "HELPER_NOT_FOUND");
  assert.equal(capture.running, false);
});

test("listDevices ejecuta --list y normaliza el JSON", async () => {
  const calls = [];
  const execFile = (file, args, options, callback) => {
    calls.push({ file, args });
    callback(null, '[{"id":"{a}","name":"Mic USB","default":true},{"id":"{b}","name":"Webcam"}]');
  };
  const devices = await MicCapture.listDevices({ helperPath: "C:\\fake\\wasapi-capture.exe", execFile });
  assert.deepEqual(calls, [{ file: "C:\\fake\\wasapi-capture.exe", args: ["--list"] }]);
  assert.deepEqual(devices, [
    { id: "{a}", name: "Mic USB", default: true },
    { id: "{b}", name: "Webcam", default: false },
  ]);
});

test("listDevices rechaza salida inválida", async () => {
  const execFile = (file, args, options, callback) => callback(null, "no es json");
  await assert.rejects(
    MicCapture.listDevices({ helperPath: "x", execFile }),
    (error) => error.code === "HELPER_BAD_OUTPUT",
  );
});

test("la ruta por defecto del helper apunta a native/bin", () => {
  assert.match(DEFAULT_HELPER_PATH.replaceAll("\\", "/"), /\/native\/bin\/wasapi-capture\.exe$/);
});
