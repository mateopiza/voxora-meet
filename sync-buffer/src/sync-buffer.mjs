// SyncBuffer (M5): cola de delay que retiene el audio original (y, opcionalmente,
// frames de cámara) `delayMs` y libera una línea de tiempo continua hacia la
// capa de entrega. Donde existe un doblaje que cubre el rango liberado se emite
// el doblaje; si no, el fallback configurado (silencio / original / original a
// -18 dB). Todo el tiempo es ms monotónicos (reloj inyectable) y el scheduler
// es un `tick(nowMs)` puro para poder testearlo sin timers.
//
// Modelo de tiempo:
//  - "línea de tiempo fuente": timestamps con los que llegan frames/audio/dubs.
//  - "reloj de pared": `now()`. La salida de audio debe ser CONTINUA (el driver
//    consume 48 kHz sin pausas), así que cada tick emite exactamente las
//    muestras que corresponden al tiempo de pared transcurrido; lo que cambia
//    con el delay es qué rango de la línea fuente se usa para llenarlas.
//  - `releasedUntil` es el cursor de la línea fuente ya liberada. En régimen
//    estacionario `releasedUntil === now - delayMs`.
//  - Si el delay SUBE, el objetivo `now - delayMs` queda por detrás del cursor:
//    se congela (silencio, sin frames) hasta que lo alcance — sin saltos.
//  - Si el delay BAJA, el objetivo se adelanta al cursor: se descarta lo más
//    viejo de la cola (frames y audio) y se retoma desde el nuevo objetivo.

import { EventEmitter } from 'node:events';
import { dbToGain, int16ToBuffer, pcmToInt16, resampleInt16 } from './resampler.mjs';

export const MIN_DELAY_MS = 2000;
export const MAX_DELAY_MS = 6000;
export const DEFAULT_DELAY_MS = 3000;
export const DEFAULT_OUTPUT_SAMPLE_RATE = 48000;
export const DUCK_DB = -18;

const FALLBACK_MODES = new Set(['silence', 'original', 'duck']);
const LATE_DUB_POLICIES = new Set(['play', 'drop']);
const HISTORY_MS = 60000;

export function clampDelayMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_DELAY_MS;
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Math.round(n)));
}

/**
 * @typedef {object} ReleasePayload
 * @property {object|null} frame   Último frame liberado en este tick (null si ninguno / congelado).
 * @property {object[]} frames     Todos los frames liberados en orden (la entrega escribe todos).
 * @property {object} audio        `{ pcm: Buffer s16le mono, sampleRate, samples, durationMs, rangeStart, rangeEnd, sources }`
 * @property {boolean} frozen      true si el tick emitió solo silencio por subida de delay.
 * @property {number} droppedMs    ms de línea fuente descartados en este tick (bajada de delay).
 */

export class SyncBuffer extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.delayMs=3000]           Delay inicial (se clampa a 2000–6000).
   * @param {number} [options.outputSampleRate=48000] Tasa de la salida (driver WaveRT).
   * @param {'silence'|'original'|'duck'} [options.fallbackMode='silence']
   * @param {'play'|'drop'} [options.lateDubPolicy='play']
   * @param {number} [options.maxDriftMs=1500]        Umbral de aviso de deriva.
   * @param {() => number} [options.now]              Reloj inyectable (ms monotónicos).
   * @param {(payload: ReleasePayload) => void} [options.onRelease]
   * @param {number} [options.maxQueuedFrames=600]    Techo de frames retenidos (protección de memoria).
   */
  constructor(options = {}) {
    super();
    this.#delayMs = clampDelayMs(options.delayMs ?? DEFAULT_DELAY_MS);
    this.#sampleRate = Number(options.outputSampleRate) || DEFAULT_OUTPUT_SAMPLE_RATE;
    this.fallbackMode = options.fallbackMode ?? 'silence';
    this.lateDubPolicy = options.lateDubPolicy ?? 'play';
    this.maxDriftMs = Number.isFinite(options.maxDriftMs) ? options.maxDriftMs : 1500;
    this.maxQueuedFrames = Number.isFinite(options.maxQueuedFrames) ? options.maxQueuedFrames : 600;
    this.maxDubQueueMs = options.maxDubQueueMs ?? 15000;
    this.maxPendingMs = options.maxPendingMs ?? 30000;
    this.maxTickMs = options.maxTickMs ?? 500;
    this.fadeMs = options.fadeMs ?? 3;
    this.#now = typeof options.now === 'function' ? options.now : () => performance.now();
    if (typeof options.onRelease === 'function') this.on('release', options.onRelease);
    this.#duckGain = dbToGain(DUCK_DB);
    this.reset();
  }

  // ── estado interno ──────────────────────────────────────────────────────
  #delayMs;
  #sampleRate;
  #now;
  #duckGain;
  #timer = null;

  /** @type {{ frame: any, timestamp: number }[]} */
  #frames = [];
  /** @type {{ start: number, end: number, samples: Int16Array }[]} original remuestreado */
  #original = [];
  /** @type {{ sourceStart, sourceEnd, placedStart, placedEnd, coverEnd, samples, dub }[]} */
  #dubs = [];
  #turns = new Map();
  #fallbackRanges = [];
  #rejectedDubs = 0;

  #releasedUntil = null;   // cursor de línea fuente (null hasta el primer tick)
  #originWall = 0;         // reloj de pared del primer tick
  #emittedSamples = 0;     // muestras emitidas desde el primer tick (contabilidad exacta)
  #driftMs = 0;
  #lateDubs = 0;
  #driftWarned = false;

  // ── configuración ───────────────────────────────────────────────────────
  get delayMs() { return this.#delayMs; }
  get outputSampleRate() { return this.#sampleRate; }
  get releasedUntil() { return this.#releasedUntil; }

  get fallbackMode() { return this._fallbackMode; }
  set fallbackMode(mode) {
    if (!FALLBACK_MODES.has(mode)) throw new RangeError(`fallbackMode inválido: ${mode}`);
    this._fallbackMode = mode;
  }

  get lateDubPolicy() { return this._lateDubPolicy; }
  set lateDubPolicy(policy) {
    if (!LATE_DUB_POLICIES.has(policy)) throw new RangeError(`lateDubPolicy inválido: ${policy}`);
    this._lateDubPolicy = policy;
  }

  /**
   * Cambia el delay en caliente. La transición la resuelve el siguiente tick:
   * subir → congela; bajar → descarta lo más viejo. Devuelve el valor aplicado.
   */
  setDelay(ms) {
    const next = clampDelayMs(ms);
    if (next !== this.#delayMs) {
      const previous = this.#delayMs;
      this.#delayMs = next;
      this.emit('delay', { delayMs: next, previousDelayMs: previous });
    }
    return this.#delayMs;
  }

  /** Vacía colas y cursores (mantiene configuración). */
  reset() {
    this.#frames = [];
    this.#original = [];
    this.#dubs = [];
    this.#turns.clear();
    this.#fallbackRanges = [];
    this.#rejectedDubs = 0;
    this.#releasedUntil = null;
    this.#originWall = 0;
    this.#emittedSamples = 0;
    this.#driftMs = 0;
    this.#lateDubs = 0;
    this.#driftWarned = false;
  }

  // ── entradas ────────────────────────────────────────────────────────────

  /** Reserve on speech onset, before original fallback can escape. */
  reserveTurn({ turnId, sourceTimestamp, sourceEndedAt }) {
    if (turnId == null || !Number.isFinite(sourceTimestamp)) throw new TypeError('reserveTurn: turno y timestamp requeridos');
    const key = String(turnId);
    const previous = this.#turns.get(key);
    if (previous && previous.state !== 'pending') return false;
    if (this.#turns.size >= 1024 && !previous) return false;
    this.#turns.set(key, {
      start: sourceTimestamp,
      end: Number.isFinite(sourceEndedAt) ? sourceEndedAt : sourceTimestamp + this.maxPendingMs,
      expires: previous?.expires ?? sourceTimestamp + this.maxPendingMs,
      state: 'pending',
    });
    return true;
  }

  finishTurn(turnId, reason = 'fallback') {
    const turn = this.#turns.get(String(turnId));
    if (turn?.state === 'pending') { turn.state = reason; return true; }
    return false;
  }

  canDub(turnId) {
    const turn = this.#turns.get(String(turnId));
    return !turn || (turn.state === 'pending' && !this.#fallbackRanges.some((r) => r.end > turn.start && r.start < turn.end));
  }

  /** Frame de cámara con timestamp (opcional: el shell nativo puede llevar su propio ring). */
  pushFrame({ frame, timestamp }) {
    if (!Number.isFinite(timestamp)) throw new TypeError('pushFrame: timestamp numérico requerido');
    if (this.#releasedUntil !== null && timestamp < this.#releasedUntil) {
      // Llega ya vencido (p. ej. tras bajar el delay): no se encola.
      return false;
    }
    this.#frames.push({ frame, timestamp });
    // Los frames deben quedar ordenados aunque lleguen ligeramente desordenados.
    const n = this.#frames.length;
    if (n > 1 && this.#frames[n - 2].timestamp > timestamp) {
      this.#frames.sort((a, b) => a.timestamp - b.timestamp);
    }
    if (n > this.maxQueuedFrames) this.#frames.splice(0, n - this.maxQueuedFrames);
    return true;
  }

  /** Audio original (PCM s16le mono) con el timestamp de su primera muestra. */
  pushAudio({ pcm, sampleRate, timestamp }) {
    if (!Number.isFinite(timestamp)) throw new TypeError('pushAudio: timestamp numérico requerido');
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new TypeError('pushAudio: sampleRate inválido');
    // Nothing will consume the original in translation-only mode.
    if (this.fallbackMode === 'silence') return false;
    const samples = resampleInt16(pcmToInt16(pcm), sampleRate, this.#sampleRate);
    if (samples.length === 0) return false;
    const end = timestamp + (samples.length * 1000) / this.#sampleRate;
    if (this.#releasedUntil !== null && end <= this.#releasedUntil) return false;
    this.#original.push({ start: timestamp, end, samples });
    const n = this.#original.length;
    if (n > 1 && this.#original[n - 2].start > timestamp) {
      this.#original.sort((a, b) => a.start - b.start);
    }
    return true;
  }

  /**
   * Doblaje del pipeline (`DubResult`). `null` = turno descartado (se ignora).
   * Se coloca en la línea de tiempo en `sourceTimestamp`, o después del doblaje
   * anterior si aquel aún no terminó (deriva controlada, sin time-stretch).
   */
  pushDub(dub) {
    if (dub == null) return null;
    const { audioDub, sampleRate, sourceTimestamp, sourceEndedAt } = dub;
    if (!Number.isFinite(sourceTimestamp)) throw new TypeError('pushDub: sourceTimestamp requerido');
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new TypeError('pushDub: sampleRate inválido');
    const sourceEnd = Number.isFinite(sourceEndedAt) ? Math.max(sourceEndedAt, sourceTimestamp) : sourceTimestamp;
    const key = String(dub.turnId ?? `source:${sourceTimestamp}:${sourceEnd}`);
    const turn = this.#turns.get(key);
    const reject = (reason) => {
      this.#rejectedDubs++;
      if (turn?.state === 'pending') turn.state = reason;
      this.emit('dub-rejected', { turnId: dub.turnId, sourceTimestamp, reason });
      return { scheduled: false, reason, late: this.#releasedUntil !== null && sourceTimestamp < this.#releasedUntil };
    };
    if (turn && turn.state !== 'pending') return reject('already-decided');
    if (this.#releasedUntil !== null && sourceTimestamp < this.#releasedUntil - HISTORY_MS) return reject('expired');
    if (this.#fallbackRanges.some((r) => r.end > sourceTimestamp && r.start < Math.max(sourceEnd, sourceTimestamp + 1000 / sampleRate))) return reject('original-already-delivered');
    if (this.#turns.size >= 1024 && !turn) return reject('turn-capacity');
    const durationEstimate = (audioDub?.byteLength ?? 0) / 2 / sampleRate * 1000;
    const queuedEnd = this.#dubs.at(-1)?.placedEnd ?? sourceTimestamp;
    if (durationEstimate > this.maxDubQueueMs || Math.max(queuedEnd, sourceTimestamp, this.#releasedUntil ?? sourceTimestamp) + durationEstimate - (this.#releasedUntil ?? sourceTimestamp) > this.maxDubQueueMs) return reject('dub-queue-full');
    const samples = resampleInt16(pcmToInt16(audioDub ?? Buffer.alloc(0)), sampleRate, this.#sampleRate);
    const durationMs = (samples.length * 1000) / this.#sampleRate;

    const late = this.#releasedUntil !== null && sourceTimestamp < this.#releasedUntil;
    if (late) {
      this.#lateDubs += 1;
      const lateByMs = this.#releasedUntil - sourceTimestamp;
      this.emit('late-dub', { sourceTimestamp, lateByMs, policy: this.lateDubPolicy, lateDubs: this.#lateDubs });
      if (this.lateDubPolicy === 'drop') return reject('late');
    }

    const lastEnd = this.#dubs.length ? this.#dubs[this.#dubs.length - 1].placedEnd : -Infinity;
    let placedStart = Math.max(sourceTimestamp, lastEnd);
    if (this.#releasedUntil !== null) placedStart = Math.max(placedStart, this.#releasedUntil);
    const placedEnd = placedStart + durationMs;
    this.#turns.set(key, { start: sourceTimestamp, end: sourceEnd, expires: placedEnd, state: 'scheduled' });
    const entry = {
      sourceStart: sourceTimestamp,
      sourceEnd,
      placedStart,
      placedEnd,
      // El original queda silenciado durante todo el turno y durante la
      // extensión del doblaje: el rango dubbeado nunca deja pasar la voz original.
      coverEnd: Math.max(sourceEnd, placedEnd),
      samples,
      dub,
    };
    this.#dubs.push(entry);
    if (this.#dubs.length > 1 && this.#dubs[this.#dubs.length - 2].placedStart > placedStart) {
      this.#dubs.sort((a, b) => a.placedStart - b.placedStart);
    }
    this.#updateDrift(Math.max(0, placedEnd - sourceEnd));
    return { scheduled: true, late, placedStart, placedEnd, driftMs: this.#driftMs };
  }

  // ── scheduler ───────────────────────────────────────────────────────────

  /** Arranca el scheduler con setInterval (usa el reloj inyectado). */
  start(intervalMs = 20) {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      try {
        this.tick(this.#now());
      } catch (error) {
        this.emit('error', error);
      }
    }, Math.max(1, intervalMs));
    if (typeof this.#timer.unref === 'function') this.#timer.unref();
  }

  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  get running() { return this.#timer !== null; }

  /**
   * Un paso del scheduler. Puro respecto al reloj: `nowMs` decide qué se libera.
   * El primer tick solo inicializa cursores (no emite). Devuelve el payload
   * emitido (o null) y lo publica en `release`.
   * @returns {ReleasePayload|null}
   */
  tick(nowMs) {
    if (!Number.isFinite(nowMs)) nowMs = this.#now();
    const sr = this.#sampleRate;
    const target = nowMs - this.#delayMs;
    for (const [turnId, turn] of this.#turns) {
      if (turn.state === 'pending' && nowMs >= turn.expires) {
        turn.state = 'expired';
        this.emit('turn-expired', { turnId });
      }
    }

    if (this.#releasedUntil === null) {
      this.#releasedUntil = target;
      this.#originWall = nowMs;
      this.#emittedSamples = 0;
      return null;
    }
    if (nowMs < this.#originWall) return null; // reloj hacia atrás: ignorar

    // Contabilidad exacta de muestras: la salida es continua a `sr`.
    const totalSamples = Math.round(((nowMs - this.#originWall) * sr) / 1000);
    const samplesToEmit = totalSamples - this.#emittedSamples;
    if (samplesToEmit <= 0) return null;
    const wallMs = (samplesToEmit * 1000) / sr;
    if (wallMs > this.maxTickMs) throw Object.assign(new Error('El audio se interrumpió demasiado tiempo. Reinicia el doblaje para evitar reproducir voz atrasada.'), { code: 'audio_output_overload' });
    const tolMs = 1000 / sr; // una muestra

    const available = target - this.#releasedUntil;
    let droppedMs = 0;
    let silenceSamples = 0;
    let rangeStart = this.#releasedUntil;
    let rangeEnd = target;
    let frozen = false;

    if (available < -tolMs) {
      // El delay subió: aún no toca liberar nada → congelar.
      frozen = true;
      silenceSamples = samplesToEmit;
      rangeStart = rangeEnd = this.#releasedUntil;
    } else if (available < wallMs - tolMs) {
      // Fin de la congelación: parte silencio, parte contenido.
      silenceSamples = Math.max(0, Math.min(samplesToEmit, Math.round(((wallMs - available) * sr) / 1000)));
      rangeStart = this.#releasedUntil;
    } else if (available > wallMs + tolMs) {
      // El delay bajó: descartar lo más viejo y retomar desde el nuevo objetivo.
      rangeStart = target - wallMs;
      droppedMs = rangeStart - this.#releasedUntil;
    }

    const contentSamples = samplesToEmit - silenceSamples;
    // Si todo el tick es relleno por la transición, sigue contando como congelado.
    if (contentSamples === 0 && silenceSamples > 0) frozen = true;
    const out = new Int16Array(samplesToEmit);
    const sources = { silence: silenceSamples, dub: 0, original: 0 };
    if (contentSamples > 0) {
      this.#fillRange(out.subarray(silenceSamples), rangeStart, sources);
    }

    // Frames: cada frame se libera en el tick cuyo rango de audio contiene su
    // timestamp (rangeStart <= ts < rangeEnd), así frame y audio del mismo
    // instante salen juntos. Los del rango saltado se descartan, conservando
    // el más nuevo si no hay otro que liberar en este tick.
    const frames = [];
    if (!frozen) {
      let dropped = null;
      while (this.#frames.length && this.#frames[0].timestamp < rangeEnd) {
        const item = this.#frames.shift();
        if (droppedMs > 0 && item.timestamp < rangeStart) dropped = item;
        else frames.push(item);
      }
      if (frames.length === 0 && dropped) frames.push(dropped);
    }

    // Avanzar cursores y purgar lo ya consumido.
    const presentation = this.presentationAt(rangeStart);
    this.#emittedSamples = totalSamples;
    if (!frozen) this.#releasedUntil = rangeEnd;
    this.#purge();

    const payload = {
      frame: frames.length ? frames[frames.length - 1].frame : null,
      frames: frames.map((f) => f.frame),
      audio: {
        pcm: int16ToBuffer(out),
        sampleRate: sr,
        samples: samplesToEmit,
        durationMs: wallMs,
        rangeStart,
        rangeEnd,
        sources,
      },
      frozen,
      droppedMs,
      now: nowMs,
      presentation,
    };
    this.emit('release', payload);
    return payload;
  }

  /** Métricas para la UI. */
  stats() {
    const cursor = this.#releasedUntil;
    let queuedAudioMs = 0;
    if (this.#original.length) {
      const last = this.#original[this.#original.length - 1];
      queuedAudioMs = Math.max(0, last.end - (cursor ?? this.#original[0].start));
    }
    const dubsPending = cursor === null
      ? this.#dubs.length
      : this.#dubs.filter((d) => d.placedEnd > cursor).length;
    return {
      delayMs: this.#delayMs,
      queuedFrames: this.#frames.length,
      queuedAudioMs: Math.round(queuedAudioMs),
      dubsPending,
      driftMs: Math.round(this.#driftMs),
      lateDubs: this.#lateDubs,
      rejectedDubs: this.#rejectedDubs,
      pendingReservations: [...this.#turns.values()].filter((t) => t.state === 'pending').length,
      dubQueueMs: Math.max(0, (this.#dubs.at(-1)?.placedEnd ?? cursor ?? 0) - (cursor ?? this.#dubs[0]?.placedStart ?? 0)),
    };
  }

  // ── internos ────────────────────────────────────────────────────────────

  presentationAt(timestamp) {
    const dub = this.#dubs.find((d) => timestamp >= d.placedStart && timestamp < d.placedEnd);
    if (!dub) return null;
    const sourceRate = (dub.sourceEnd - dub.sourceStart) / (dub.placedEnd - dub.placedStart);
    return {
      turnId: dub.dub.turnId,
      sourceTimestamp: dub.sourceStart + (timestamp - dub.placedStart) * sourceRate,
      sourceRate,
      remainingMs: dub.placedEnd - timestamp,
    };
  }

  /**
   * Llena `out` (muestras consecutivas desde `rangeStart`) con la mezcla:
   * fallback donde no hay doblaje; silencio + doblaje donde lo hay.
   */
  #fillRange(out, rangeStart, sources) {
    const sr = this.#sampleRate;
    const n = out.length;
    const rangeEnd = rangeStart + (n * 1000) / sr;
    const kinds = new Uint8Array(n); // 0 silence, 1 original, 2 dub; zero samples still have provenance.

    // 1) Fallback.
    if (this.fallbackMode !== 'silence') {
      const gain = this.fallbackMode === 'duck' ? this.#duckGain : 1;
      for (const seg of this.#original) {
        if (seg.end <= rangeStart || seg.start >= rangeEnd) continue;
        const offset = Math.round(((rangeStart - seg.start) * sr) / 1000);
        const from = Math.max(0, -offset);
        const to = Math.min(n, seg.samples.length - offset);
        if (to <= from) continue;
        if (gain === 1) out.set(seg.samples.subarray(from + offset, to + offset), from);
        else for (let i = from; i < to; i++) out[i] = Math.round(seg.samples[i + offset] * gain);
        kinds.fill(1, from, to);
      }
    }

    for (const turn of this.#turns.values()) {
      if (turn.state !== 'pending' || turn.end <= rangeStart || turn.start >= rangeEnd) continue;
      const from = Math.max(0, Math.round((turn.start - rangeStart) * sr / 1000));
      const to = Math.min(n, Math.round((turn.end - rangeStart) * sr / 1000));
      out.fill(0, from, to);
      kinds.fill(0, from, to);
    }

    // 2) Silenciar los rangos cubiertos por un turno doblado.
    for (const d of this.#dubs) {
      const coverStart = Math.min(d.sourceStart, d.placedStart);
      if (d.coverEnd <= rangeStart || coverStart >= rangeEnd) continue;
      const from = Math.max(0, Math.round(((coverStart - rangeStart) * sr) / 1000));
      const to = Math.min(n, Math.round(((d.coverEnd - rangeStart) * sr) / 1000));
      if (to > from) {
        out.fill(0, from, to);
        kinds.fill(0, from, to);
      }
    }

    // 3) Superponer el audio doblado.
    for (const d of this.#dubs) {
      if (d.placedEnd <= rangeStart || d.placedStart >= rangeEnd) continue;
      const offset = Math.round(((rangeStart - d.placedStart) * sr) / 1000);
      const from = Math.max(0, -offset);
      const to = Math.min(n, d.samples.length - offset);
      if (to <= from) continue;
      out.set(d.samples.subarray(from + offset, to + offset), from);
      const fadeSamples = Math.round(this.fadeMs * sr / 1000);
      // Fade only utterance boundaries; never restart the envelope on each tick.
      for (let i = from; i < to && fadeSamples > 0; i++) {
        const at = i + offset;
        const gain = Math.min(1, at / fadeSamples, (d.samples.length - 1 - at) / fadeSamples);
        if (gain < 1) out[i] = Math.round(out[i] * Math.max(0, gain));
      }
      kinds.fill(2, from, to);
    }
    for (let i = 0; i < n;) {
      const kind = kinds[i];
      let end = i + 1;
      while (end < n && kinds[end] === kind) end++;
      sources[kind === 1 ? 'original' : kind === 2 ? 'dub' : 'silence'] += end - i;
      if (kind === 1) {
        const startMs = rangeStart + i * 1000 / sr;
        const endMs = rangeStart + end * 1000 / sr;
        const last = this.#fallbackRanges.at(-1);
        if (last && startMs <= last.end + 1000 / sr) last.end = endMs;
        else this.#fallbackRanges.push({ start: startMs, end: endMs });
      }
      i = end;
    }
  }

  #purge() {
    const cursor = this.#releasedUntil;
    const cutoff = cursor - HISTORY_MS;
    while (this.#fallbackRanges.length && this.#fallbackRanges[0].end <= cutoff) this.#fallbackRanges.shift();
    for (const [key, turn] of this.#turns) {
      if (turn.state !== 'pending' && Math.max(turn.end, turn.expires) < cutoff) this.#turns.delete(key);
    }
    while (this.#original.length && this.#original[0].end <= cursor) this.#original.shift();
    while (this.#dubs.length && this.#dubs[0].coverEnd <= cursor) this.#dubs.shift();
    // Deriva: si ya no hay doblajes retrasando la línea, vuelve a 0.
    if (this.#dubs.length === 0 && this.#driftMs !== 0) this.#updateDrift(0);
  }

  #updateDrift(driftMs) {
    this.#driftMs = driftMs;
    if (driftMs > this.maxDriftMs) {
      if (!this.#driftWarned) {
        this.#driftWarned = true;
        this.emit('drift-exceeded', { driftMs, maxDriftMs: this.maxDriftMs });
      }
    } else {
      this.#driftWarned = false;
    }
    this.emit('drift', { driftMs });
  }
}

export default SyncBuffer;
