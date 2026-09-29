// Resampler s16le mono simple para VOXORA Meet.
//
// - Interpolación lineal entre muestras (suficiente para voz 16 kHz → 24/48 kHz hacia TTS).
// - Al bajar la tasa (p. ej. 48 kHz → 16 kHz del helper WASAPI) se aplica antes un filtro FIR
//   paso-bajo (sinc enventanado con Hamming) para evitar aliasing.
// - `Resampler` mantiene estado entre chunks (historial del FIR, última muestra y fase fraccional),
//   por lo que procesar un stream por trozos da exactamente el mismo resultado que de una vez.

const DEFAULT_TAPS = 47;

/**
 * Convierte cualquier entrada aceptada (Buffer, Uint8Array, Int16Array) a Int16Array
 * sin copiar cuando la alineación lo permite.
 */
function toInt16(input) {
  if (input instanceof Int16Array) return input;
  if (!(input instanceof Uint8Array)) {
    throw new TypeError("resample: la entrada debe ser Buffer, Uint8Array o Int16Array");
  }
  const usable = input.byteLength - (input.byteLength % 2);
  if (input.byteOffset % 2 === 0) {
    return new Int16Array(input.buffer, input.byteOffset, usable / 2);
  }
  // Desalineado: copia a un ArrayBuffer propio.
  const copy = new Uint8Array(usable);
  copy.set(input.subarray(0, usable));
  return new Int16Array(copy.buffer);
}

/** Diseña un FIR paso-bajo sinc enventanado (Hamming). `cutoff` en fracción de la tasa de entrada (0..0.5). */
function designLowpass(taps, cutoff) {
  const coeffs = new Float64Array(taps);
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i += 1) {
    const n = i - mid;
    const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    coeffs[i] = sinc * window;
    sum += coeffs[i];
  }
  // Ganancia unitaria en DC.
  for (let i = 0; i < taps; i += 1) coeffs[i] /= sum;
  return coeffs;
}

function validateRate(rate, name) {
  if (!Number.isInteger(rate) || rate <= 0) {
    throw new RangeError(`resample: ${name} debe ser un entero positivo (recibido ${rate})`);
  }
}

export class Resampler {
  /**
   * @param {number} fromRate tasa de entrada en Hz
   * @param {number} toRate tasa de salida en Hz
   * @param {{ lowpass?: boolean, taps?: number }} [options]
   *   - lowpass: aplicar FIR antialias al bajar la tasa (default true; ignorado al subirla)
   *   - taps: longitud del FIR (impar; default 47)
   */
  constructor(fromRate, toRate, options = {}) {
    validateRate(fromRate, "fromRate");
    validateRate(toRate, "toRate");
    this.fromRate = fromRate;
    this.toRate = toRate;
    this.step = fromRate / toRate;
    const wantsLowpass = options.lowpass ?? true;
    this.useLowpass = wantsLowpass && toRate < fromRate;
    if (this.useLowpass) {
      const taps = options.taps ?? DEFAULT_TAPS;
      if (!Number.isInteger(taps) || taps < 3 || taps % 2 === 0) {
        throw new RangeError("resample: taps debe ser un entero impar >= 3");
      }
      // Corte al 45 % de la tasa de salida, expresado en fracción de la tasa de entrada.
      this.coeffs = designLowpass(taps, 0.45 * (toRate / fromRate));
      this.history = new Float64Array(taps - 1);
    } else {
      this.coeffs = null;
      this.history = null;
    }
    this.reset();
  }

  /** Vuelve al estado inicial (descarta historial y fase). */
  reset() {
    this.prev = 0;
    // Posición fraccional relativa al vector extendido [prev, x0, x1, ...]; 1 = primera muestra real.
    this.pos = 1;
    this.inputSamples = 0;
    this.outputSamples = 0;
    if (this.history) this.history.fill(0);
  }

  /** Aplica el FIR de forma continua entre chunks. Devuelve Float64Array del mismo largo. */
  #filter(samples) {
    const { coeffs, history } = this;
    const taps = coeffs.length;
    const histLen = taps - 1;
    const n = samples.length;
    // Vector extendido: historial + chunk actual.
    const ext = new Float64Array(histLen + n);
    ext.set(history, 0);
    for (let i = 0; i < n; i += 1) ext[histLen + i] = samples[i];
    const out = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      let acc = 0;
      const base = i + histLen;
      for (let k = 0; k < taps; k += 1) acc += coeffs[k] * ext[base - k];
      out[i] = acc;
    }
    // Guarda las últimas histLen muestras para el siguiente chunk.
    if (n >= histLen) {
      history.set(ext.subarray(ext.length - histLen));
    } else {
      history.copyWithin(0, n);
      history.set(ext.subarray(histLen), histLen - n);
    }
    return out;
  }

  /**
   * Procesa un chunk s16le y devuelve el PCM remuestreado (Buffer s16le). Puede devolver un
   * Buffer vacío si el chunk no alcanza para producir una muestra de salida.
   */
  process(chunk) {
    const raw = toInt16(chunk);
    if (raw.length === 0) return Buffer.alloc(0);
    if (this.fromRate === this.toRate) {
      return Buffer.from(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    }
    const samples = this.useLowpass ? this.#filter(raw) : raw;
    const n = samples.length;
    const { step } = this;
    // Salidas disponibles: mientras pos <= n (el índice n es la última muestra real del vector extendido).
    const maxOut = this.pos <= n ? Math.floor((n - this.pos) / step) + 1 : 0;
    const out = new Int16Array(maxOut);
    let pos = this.pos;
    for (let count = 0; count < maxOut; count += 1) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const a = i0 === 0 ? this.prev : samples[i0 - 1];
      // i0 puede ser n exactamente (frac 0) → usa la última muestra.
      const b = i0 >= n ? samples[n - 1] : samples[i0];
      let v = a + (b - a) * frac;
      if (v > 32767) v = 32767;
      else if (v < -32768) v = -32768;
      out[count] = Math.round(v);
      pos += step;
    }
    // Avanza el marco de referencia: la última muestra pasa a ser `prev` (índice 0).
    this.prev = samples[n - 1];
    this.pos = pos - n;
    this.inputSamples += n;
    this.outputSamples += maxOut;
    return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  }

  /**
   * Vacía el estado al terminar un stream: emite la cola pendiente extrapolando con la última
   * muestra (evita perder hasta `step` muestras al final) y reinicia el estado.
   */
  flush() {
    // Salidas que corresponden a la entrada total (round(N·to/from)) y aún no se emitieron:
    // se rellenan repitiendo la última muestra. Usar el conteo (y no la fase flotante) evita
    // producir una muestra de más o de menos por errores de redondeo.
    const expected = Math.round((this.inputSamples * this.toRate) / this.fromRate);
    const missing = Math.max(0, expected - this.outputSamples);
    const tail = new Int16Array(missing).fill(Math.round(this.prev));
    this.reset();
    return Buffer.from(tail.buffer);
  }
}

/**
 * Remuestreo de una sola pasada. Devuelve un Buffer s16le.
 * @param {Buffer|Uint8Array|Int16Array} input
 * @param {number} fromRate
 * @param {number} toRate
 * @param {{ lowpass?: boolean, taps?: number }} [options]
 */
export function resamplePcm16(input, fromRate, toRate, options = {}) {
  const resampler = new Resampler(fromRate, toRate, options);
  const body = resampler.process(input);
  const tail = resampler.flush();
  return tail.length ? Buffer.concat([body, tail]) : body;
}
