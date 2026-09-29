// Resampler propio (interpolación lineal) para PCM s16le mono.
// Suficiente para llevar doblajes de 24/44.1 kHz y original de 16 kHz a la
// tasa del driver (48 kHz): sin dependencias nativas y determinista, que es lo
// que necesita el buffer de sincronía para contar muestras con exactitud.

/**
 * Convierte un Buffer/Uint8Array de PCM s16le a Int16Array.
 * Copia si el offset no está alineado a 2 bytes (los slices de Node pueden
 * no estarlo) o si sobra un byte impar al final.
 */
export function pcmToInt16(pcm) {
  if (pcm instanceof Int16Array) return pcm;
  if (!(pcm instanceof Uint8Array)) throw new TypeError('pcm debe ser Buffer/Uint8Array/Int16Array');
  const bytes = pcm.byteLength - (pcm.byteLength % 2);
  if (pcm.byteOffset % 2 === 0 && bytes === pcm.byteLength) {
    return new Int16Array(pcm.buffer, pcm.byteOffset, bytes / 2);
  }
  const copy = new Uint8Array(bytes);
  copy.set(pcm.subarray(0, bytes));
  return new Int16Array(copy.buffer);
}

/** Int16Array → Buffer s16le (sin copiar cuando ya está alineado). */
export function int16ToBuffer(samples) {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

/**
 * Remuestrea PCM mono con interpolación lineal.
 * @param {Int16Array} input
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Int16Array}
 */
export function resampleInt16(input, fromRate, toRate) {
  if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) {
    throw new RangeError(`tasas inválidas: ${fromRate} → ${toRate}`);
  }
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.round((input.length * toRate) / fromRate);
  const out = new Int16Array(outLength);
  const last = input.length - 1;
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    if (idx >= last) {
      out[i] = input[last];
      continue;
    }
    const frac = pos - idx;
    out[i] = Math.round(input[idx] + (input[idx + 1] - input[idx]) * frac);
  }
  return out;
}

/** Aplica ganancia lineal con saturación a 16 bits (devuelve copia). */
export function applyGain(samples, gain) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.round(samples[i] * gain);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

/** Decibelios → ganancia lineal. */
export function dbToGain(db) {
  return 10 ** (db / 20);
}
