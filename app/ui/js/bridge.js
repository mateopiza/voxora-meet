// Puente UI ⇄ shell nativo (WebView2).
//
//   UI → shell  window.chrome.webview.postMessage({ type: 'engine', id, cmd, params })
//               window.chrome.webview.postMessage({ type: 'native', id, cmd, params })
//   shell → UI  { type: 'engine-reply' | 'native-reply', id, ok, result | error }
//               { type: 'engine-event', event, data, engineNowMs }
//               { type: 'native-event', event, data }
//               { type: 'devices', … }   { type: 'engine-state', state, message }
//
// Fuera de WebView2 (abrir index.html en un navegador para diseñar) se usa un
// backend simulado (mock.js) con la misma forma de mensajes.

const webview = window.chrome?.webview ?? null;
const pending = new Map();
const listeners = new Map();
let nextId = 1;
let transport = null;

function dispatch(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'engine-reply' || msg.type === 'native-reply') {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.result ?? {});
    else entry.reject(toError(msg.error));
    return;
  }
  for (const fn of listeners.get(msg.type) ?? []) {
    try { fn(msg); } catch (error) { console.error(error); }
  }
}

function toError(raw) {
  const error = new Error(raw?.message || 'Ocurrió un error inesperado.');
  error.code = raw?.code || 'internal';
  return error;
}

async function ensureTransport() {
  if (transport) return transport;
  if (webview) {
    webview.addEventListener('message', (event) => dispatch(event.data));
    transport = { send: (msg) => webview.postMessage(msg), mock: false };
  } else {
    const { createMock } = await import('./mock.js');
    transport = { send: createMock(dispatch), mock: true };
  }
  return transport;
}

function request(type, cmd, params = {}, timeoutMs = 30000) {
  return ensureTransport().then((t) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(toError({ code: 'timeout', message: 'La operación tardó demasiado. Inténtalo de nuevo.' }));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    t.send({ type, id, cmd, params });
  }));
}

/** Comando del motor (JSON-lines). Rechaza con Error { code, message } listo para mostrar. */
export const engine = (cmd, params, timeoutMs) => request('engine', cmd, params, timeoutMs);
/** Comando nativo del shell (native.*). */
export const native = (cmd, params, timeoutMs) => request('native', cmd, params, timeoutMs);

/** Suscribe a mensajes push: 'engine-event' | 'native-event' | 'devices' | 'engine-state'. */
export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type).delete(fn);
}

export const isMock = () => Boolean(transport?.mock);
export const ready = ensureTransport;
