// Generadores de señal sintética s16le para los tests del módulo de captura.

export const RATE = 16000;

/** Tono senoidal. `amp` en escala [0, 1]. */
export function tone(ms, amp = 0.3, freq = 440, rate = RATE, phase0 = 0) {
  const n = Math.round((ms / 1000) * rate);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = Math.round(Math.sin(phase0 + (2 * Math.PI * freq * i) / rate) * amp * 32767);
  }
  return Buffer.from(out.buffer);
}

/** Silencio digital. */
export function silence(ms, rate = RATE) {
  return Buffer.alloc(Math.round((ms / 1000) * rate) * 2);
}

/** Ruido blanco uniforme determinista (LCG). `amp` en escala [0, 1]. */
export function noise(ms, amp = 0.02, rate = RATE, seed = 12345) {
  const n = Math.round((ms / 1000) * rate);
  const out = new Int16Array(n);
  let state = seed >>> 0;
  for (let i = 0; i < n; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const uniform = state / 0x100000000; // [0, 1)
    out[i] = Math.round((uniform * 2 - 1) * amp * 32767);
  }
  return Buffer.from(out.buffer);
}

/** Duración en ms de un buffer s16le mono. */
export function durationMs(buffer, rate = RATE) {
  return ((buffer.length / 2) / rate) * 1000;
}

/**
 * Alimenta el segmentador en chunks de `chunkMs`, con `nowMs` coherente con el reloj de muestras
 * (como si llegara en tiempo real). Devuelve el instante final.
 */
export function feed(segmenter, buffer, { chunkMs = 100, startMs = 0, rate = RATE } = {}) {
  const chunkBytes = Math.round((chunkMs / 1000) * rate) * 2;
  let now = startMs;
  for (let offset = 0; offset < buffer.length; offset += chunkBytes) {
    const chunk = buffer.subarray(offset, Math.min(offset + chunkBytes, buffer.length));
    now += durationMs(chunk, rate);
    segmenter.push(chunk, now);
  }
  return now;
}
