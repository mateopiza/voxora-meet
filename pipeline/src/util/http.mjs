// Cliente HTTP mínimo sobre `fetch` global con timeout, cancelación y
// reintentos con backoff exponencial para 429/5xx/errores de red.
// `fetch` se resuelve en cada llamada desde `globalThis` (o el inyectado) para
// que los tests puedan sustituirlo sin reimportar módulos.

export class HttpError extends Error {
  constructor(message, { status, body, url, provider, retryAfterMs = null } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
    this.url = url;
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
  }

  get retryable() {
    return isRetryableStatus(this.status);
  }
}

export function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function isAbortError(error) {
  return error?.name === "AbortError" || error?.name === "TimeoutError";
}

/** Lee `Retry-After` (segundos o fecha HTTP) y lo devuelve en ms, o null. */
export function parseRetryAfter(headers) {
  const raw = headers?.get?.("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/** Combina señales externas con un timeout; `null` si no hay ninguna. */
export function combineSignals({ signal, timeoutMs } = {}) {
  const signals = [];
  if (signal) signals.push(signal);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (!signals.length) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

export const defaultSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Backoff exponencial con jitter completo, acotado a `maxDelayMs`. */
export function backoffDelay(attempt, { baseDelayMs = 500, maxDelayMs = 8000, random = Math.random } = {}) {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.round(cap * (0.5 + random() * 0.5));
}

/**
 * `fetch` con timeout y reintentos. Reintenta ante 429/5xx/408 y errores de
 * red (TypeError de undici), nunca ante abort del llamador ni 4xx de negocio.
 * Devuelve la `Response` (el llamador decide cómo leer el cuerpo).
 *
 * Nota: `init.body` se reutiliza entre intentos, así que debe ser
 * re-enviable (string, Buffer, FormData, Blob), no un stream.
 */
export async function fetchWithRetry(url, init = {}, options = {}) {
  const {
    retries = 2,
    baseDelayMs = 500,
    maxDelayMs = 8000,
    timeoutMs = 30_000,
    signal,
    sleep = defaultSleep,
    random,
    provider = "http",
    fetch: fetchImpl,
    shouldRetryResponse = (res) => isRetryableStatus(res.status),
    onRetry,
  } = options;
  const doFetch = fetchImpl ?? globalThis.fetch;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    signal?.throwIfAborted?.();
    const attemptSignal = combineSignals({ signal, timeoutMs });
    let res;
    try {
      res = await doFetch(url, { ...init, signal: attemptSignal });
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      if (attempt === retries) break;
      const delay = backoffDelay(attempt, { baseDelayMs, maxDelayMs, random });
      onRetry?.({ attempt: attempt + 1, delay, error });
      await sleep(delay, signal);
      continue;
    }

    if (!shouldRetryResponse(res)) return res;

    const body = await safeText(res);
    const retryAfterMs = parseRetryAfter(res.headers);
    lastError = new HttpError(`${provider} ${res.status}: ${truncate(body)}`, {
      status: res.status,
      body,
      url: String(url),
      provider,
      retryAfterMs,
    });
    if (attempt === retries) break;
    const delay = Math.max(retryAfterMs ?? 0, backoffDelay(attempt, { baseDelayMs, maxDelayMs, random }));
    onRetry?.({ attempt: attempt + 1, delay, error: lastError, status: res.status });
    await sleep(Math.min(delay, maxDelayMs * 4), signal);
  }
  throw lastError;
}

/** Convierte una respuesta no-OK en `HttpError` con el cuerpo leído. */
export async function throwHttpError(res, provider, url) {
  const body = await safeText(res);
  throw new HttpError(`${provider} ${res.status}: ${truncate(body)}`, {
    status: res.status,
    body,
    url: String(url ?? res.url),
    provider,
    retryAfterMs: parseRetryAfter(res.headers),
  });
}

export async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export function truncate(text, max = 300) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
