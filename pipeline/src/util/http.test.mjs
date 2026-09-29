import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry, HttpError, backoffDelay, parseRetryAfter, combineSignals } from "./http.mjs";
import { mockFetch, mockFetchSequence, jsonResponse, textResponse, instantSleep } from "../_test-helpers.mjs";

test("fetchWithRetry devuelve la respuesta OK sin reintentar", async (t) => {
  const { calls } = mockFetch(t, () => jsonResponse({ ok: true }));
  const res = await fetchWithRetry("https://example.test/x", { method: "POST" }, { sleep: instantSleep });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.ok(calls[0].signal instanceof AbortSignal, "siempre se pasa una señal con timeout");
});

test("fetchWithRetry reintenta en 429 y 5xx y devuelve el primer éxito", async (t) => {
  const { calls } = mockFetchSequence(t, [
    () => textResponse("rate limited", { status: 429, headers: { "retry-after": "0" } }),
    () => textResponse("boom", { status: 503 }),
    () => jsonResponse({ done: true }),
  ]);
  const delays = [];
  const res = await fetchWithRetry("https://example.test/x", {}, { retries: 3, sleep: async (ms) => { delays.push(ms); }, random: () => 0 });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 3);
  assert.equal(delays.length, 2);
  assert.ok(delays[1] >= delays[0], "backoff exponencial");
});

test("fetchWithRetry agota reintentos y lanza HttpError con status y body", async (t) => {
  const { calls } = mockFetch(t, () => textResponse("overloaded", { status: 500 }));
  await assert.rejects(
    fetchWithRetry("https://example.test/x", {}, { retries: 2, sleep: instantSleep, provider: "Prov" }),
    (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 500);
      assert.equal(error.body, "overloaded");
      assert.equal(error.provider, "Prov");
      assert.match(error.message, /Prov 500: overloaded/);
      assert.ok(error.retryable);
      return true;
    },
  );
  assert.equal(calls.length, 3);
});

test("fetchWithRetry NO reintenta 4xx de negocio", async (t) => {
  const { calls } = mockFetch(t, () => textResponse("bad", { status: 400 }));
  const res = await fetchWithRetry("https://example.test/x", {}, { retries: 3, sleep: instantSleep });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 1);
});

test("fetchWithRetry reintenta errores de red y propaga el último", async (t) => {
  let n = 0;
  mockFetch(t, () => {
    n += 1;
    throw new TypeError("fetch failed");
  });
  await assert.rejects(fetchWithRetry("https://example.test/x", {}, { retries: 1, sleep: instantSleep }), /fetch failed/);
  assert.equal(n, 2);
});

test("fetchWithRetry respeta el abort del llamador sin reintentar", async (t) => {
  const controller = new AbortController();
  let n = 0;
  mockFetch(t, (_url, init) => {
    n += 1;
    controller.abort();
    // Como un fetch real: si la señal ya está abortada, rechaza de inmediato.
    if (init.signal.aborted) return Promise.reject(init.signal.reason);
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  });
  await assert.rejects(fetchWithRetry("https://example.test/x", {}, { retries: 3, signal: controller.signal, sleep: instantSleep }), (e) => e.name === "AbortError");
  assert.equal(n, 1);
});

test("fetchWithRetry aplica timeout por intento", async (t) => {
  mockFetch(t, (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))));
  await assert.rejects(
    fetchWithRetry("https://example.test/x", {}, { retries: 0, timeoutMs: 20, sleep: instantSleep }),
    (e) => e.name === "TimeoutError" || e.name === "AbortError",
  );
});

test("helpers: backoffDelay acotado, parseRetryAfter y combineSignals", () => {
  assert.equal(backoffDelay(0, { baseDelayMs: 100, random: () => 0 }), 50);
  assert.equal(backoffDelay(0, { baseDelayMs: 100, random: () => 1 }), 100);
  assert.equal(backoffDelay(10, { baseDelayMs: 100, maxDelayMs: 400, random: () => 1 }), 400);
  assert.equal(parseRetryAfter(new Headers({ "retry-after": "2" })), 2000);
  assert.equal(parseRetryAfter(new Headers()), null);
  assert.equal(combineSignals({}), undefined);
  const c = new AbortController();
  assert.equal(combineSignals({ signal: c.signal }), c.signal);
  assert.ok(combineSignals({ signal: c.signal, timeoutMs: 1000 }) instanceof AbortSignal);
});
