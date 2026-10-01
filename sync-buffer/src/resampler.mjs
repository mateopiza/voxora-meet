// Band-limited, windowed-sinc conversion for complete TTS utterances.
// Live original audio arrives at 48 kHz and bypasses this conversion.
const kernels = new Map();
const TAPS = 32;
const PHASES = 256;
function kernel(fromRate, toRate) {
  const key = `${fromRate}:${toRate}`;
  if (kernels.has(key)) return kernels.get(key);
  const cutoff = Math.min(1, toRate / fromRate) * 0.94;
  const table = Array.from({ length: PHASES }, (_, phase) => {
    const weights = new Float64Array(TAPS);
    for (let j = 0; j < TAPS; j++) {
      const x = j - (TAPS / 2 - 1) - phase / PHASES;
      const sinc = Math.abs(x) < 1e-12 ? cutoff : Math.sin(Math.PI * cutoff * x) / (Math.PI * x);
      const window = 0.5 + 0.5 * Math.cos(Math.PI * x / (TAPS / 2));
      weights[j] = sinc * window;
    }
    return weights;
  });
  if (kernels.size >= 8) kernels.delete(kernels.keys().next().value);
  kernels.set(key, table);
  return table;
}

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
 * Remuestrea un turno PCM completo con filtro paso-bajo e interpolación sinc.
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
  const table = kernel(fromRate, toRate);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const weights = table[Math.min(PHASES - 1, Math.floor(frac * PHASES))];
    let value = 0, sum = 0;
    for (let j = 0; j < TAPS; j++) {
      const at = Math.max(0, Math.min(last, idx + j - (TAPS / 2 - 1)));
      value += input[at] * weights[j];
      sum += weights[j];
    }
    out[i] = Math.max(-32768, Math.min(32767, Math.round(value / sum)));
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
