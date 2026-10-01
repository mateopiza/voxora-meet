// PhraseSegmenter — VAD adaptativo + endpointing por silencio para VOXORA Meet.
//
// Clase pura (sin I/O): recibe PCM s16le mono a 16 kHz vía `push(buffer, nowMs)`, trocea en
// frames de 20 ms, calcula el nivel RMS en dB de cada frame y decide con una compuerta
// adaptativa (piso de ruido por percentil, margen de apertura, histéresis, attack y hangover)
// cuándo hay voz. Un turno se abre al detectar voz sostenida (incluyendo un pre-roll de audio
// previo) y se cierra tras `endSilenceMs` de silencio, o por longitud máxima (`maxTurnMs`):
// primero intenta cortar en una pausa débil y, si no aparece, corta en seco.
//
// Eventos:
//   - `turn`  → { pcm, sampleRate, startedAt, endedAt, voicedMs, rmsDb, reason }
//   - `level` → { rmsDb, speaking, noiseFloorDb, openThresholdDb, at } (~20 Hz)
//
// Tiempos: milisegundos derivados del reloj de muestras, anclado al `nowMs` del primer push.
// Si la fuente se queda muda un rato (hueco > resyncToleranceMs), el reloj se adelanta para no
// acumular desfase con el reloj monotónico de la app.

import { EventEmitter } from "node:events";

const DEFAULTS = Object.freeze({
  sampleRate: 16000,
  frameMs: 20,
  // Endpointing
  endSilenceMs: 700, // silencio continuo que cierra el turno
  minTurnMs: 250, // voz mínima para no descartar el turno como ruido
  maxTurnMs: 15000, // longitud máxima del turno
  maxTurnGraceMs: 0, // margen opcional para terminar una palabra antes del corte duro
  preRollMs: 200, // audio previo al inicio de voz que se conserva
  tailSilenceMs: 200, // silencio final que se conserva al cerrar por endpointing
  softCutWindowMs: 3000, // ventana antes de maxTurnMs donde se acepta cortar en pausa débil
  softCutSilenceMs: 250, // pausa débil mínima para el corte anticipado
  // Compuerta adaptativa
  attackMs: 120, // voz sostenida necesaria para abrir
  hangoverMs: 300, // silencio necesario para cerrar la compuerta
  openMarginDb: 12, // margen sobre el piso de ruido para abrir
  hysteresisDb: 4, // la compuerta cierra `hysteresisDb` por debajo del umbral de apertura
  minOpenDb: -45, // límites del umbral de apertura adaptativo
  maxOpenDb: -24,
  noiseHistoryMs: 5000, // ventana del piso de ruido
  noisePercentile: 0.3,
  noiseRiseDbPerSec: 1, // el piso sube lento (una voz larga no se aprende como ruido)
  noiseFallDbPerSec: 6, // y baja rápido
  // Varios
  levelIntervalMs: 50, // cadencia de eventos `level`
  resyncToleranceMs: 250, // hueco a partir del cual se re-ancla el reloj
});

const MIN_DB = -96;

export function rmsToDb(rms) {
  if (!Number.isFinite(rms) || rms <= 0) return MIN_DB;
  return Math.max(MIN_DB, 20 * Math.log10(rms));
}

export function dbToRms(db) {
  return 10 ** (db / 20);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function percentile(values, ratio) {
  if (!values.length) return -60;
  const ordered = values.slice().sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * ratio))];
}

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Int16Array || chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new TypeError("PhraseSegmenter.push: se esperaba Buffer, Uint8Array o Int16Array");
}

function validateOptions(options) {
  const positive = [
    "sampleRate", "frameMs", "endSilenceMs", "minTurnMs", "maxTurnMs", "attackMs", "hangoverMs",
    "noiseHistoryMs", "levelIntervalMs",
  ];
  for (const key of positive) {
    if (!(options[key] > 0)) throw new RangeError(`PhraseSegmenter: ${key} debe ser > 0`);
  }
  for (const key of ["preRollMs", "tailSilenceMs", "softCutWindowMs", "softCutSilenceMs", "resyncToleranceMs", "maxTurnGraceMs"]) {
    if (!(options[key] >= 0)) throw new RangeError(`PhraseSegmenter: ${key} debe ser >= 0`);
  }
  if (options.maxTurnMs < options.minTurnMs) {
    throw new RangeError("PhraseSegmenter: maxTurnMs debe ser >= minTurnMs");
  }
  if (!(options.noisePercentile >= 0 && options.noisePercentile <= 1)) {
    throw new RangeError("PhraseSegmenter: noisePercentile debe estar en [0, 1]");
  }
  if ((options.sampleRate * options.frameMs) % 1000 !== 0) {
    throw new RangeError("PhraseSegmenter: sampleRate * frameMs debe ser múltiplo de 1000");
  }
}

export class PhraseSegmenter extends EventEmitter {
  /** @param {Partial<typeof DEFAULTS>} [options] */
  constructor(options = {}) {
    super();
    this.options = Object.freeze({ ...DEFAULTS, ...options });
    validateOptions(this.options);
    this.samplesPerFrame = (this.options.sampleRate * this.options.frameMs) / 1000;
    this.frameBytes = this.samplesPerFrame * 2;
    this.reset();
  }

  /**
   * Cambia los límites de turno en caliente (p. ej. `maxTurnMs` según el delay de sincronía).
   * Solo se aceptan claves de tiempo; el turno en curso usa los nuevos límites desde el siguiente frame.
   */
  setLimits(patch = {}) {
    const allowed = ["endSilenceMs", "minTurnMs", "maxTurnMs", "softCutWindowMs", "softCutSilenceMs", "maxTurnGraceMs"];
    const next = { ...this.options };
    for (const key of allowed) if (patch[key] !== undefined) next[key] = patch[key];
    validateOptions(next);
    this.options = Object.freeze(next);
    return this.options;
  }

  /** Descarta todo el estado (incluido cualquier turno en curso, sin emitirlo). */
  reset() {
    this.pending = Buffer.alloc(0);
    this.consumedSamples = 0;
    this.originMs = null;
    this.gateOpen = false;
    this.attackAccumMs = 0;
    this.quietMs = 0;
    this.noiseFloorDb = -60;
    this.noiseHistory = [];
    this.preRoll = []; // frames recientes fuera de turno (para el pre-roll)
    this.preRollTotalMs = 0;
    this.turn = null;
    this.nextLevelAt = null;
    this.lastDecision = null;
  }

  /** `true` mientras la compuerta considera que hay voz. */
  get speaking() {
    return this.gateOpen;
  }

  /** `true` mientras hay un turno abierto (todavía no cerrado por silencio). */
  get active() {
    return this.turn !== null;
  }

  /** Última decisión de la compuerta (útil para UI/diagnóstico). */
  get decision() {
    return this.lastDecision;
  }

  /**
   * Alimenta PCM s16le mono. `nowMs` es el instante (reloj monotónico) en que termina el audio del
   * chunk; si se omite, el reloj de muestras arranca en 0.
   */
  push(chunk, nowMs) {
    const buffer = toBuffer(chunk);
    if (buffer.length === 0) return;
    const { sampleRate, resyncToleranceMs } = this.options;
    const pendingMs = ((this.pending.length / 2) / sampleRate) * 1000;
    const chunkMs = ((buffer.length / 2) / sampleRate) * 1000;

    if (this.originMs === null) {
      this.originMs = (typeof nowMs === "number" ? nowMs : chunkMs) - chunkMs - pendingMs;
    } else if (typeof nowMs === "number") {
      const expectedEndMs = this.originMs + (this.consumedSamples / sampleRate) * 1000 + pendingMs + chunkMs;
      const gap = nowMs - expectedEndMs;
      // Solo re-anclamos hacia adelante: si el audio llega "más rápido que el tiempo real" es porque
      // venía bufferizado y el reloj de muestras sigue siendo la referencia correcta.
      if (gap > resyncToleranceMs) this.originMs += gap;
    }

    const data = this.pending.length ? Buffer.concat([this.pending, buffer]) : buffer;
    let offset = 0;
    while (offset + this.frameBytes <= data.length) {
      this.#processFrame(data.subarray(offset, offset + this.frameBytes));
      offset += this.frameBytes;
    }
    // Copia el resto para no retener el buffer original de la fuente.
    this.pending = Buffer.from(data.subarray(offset));
  }

  /**
   * Cierra el turno en curso (si lo hay) y emite el resto. Los bytes sueltos que no llegan a un
   * frame completo se descartan. Se llama al parar la captura.
   */
  flush() {
    if (this.turn) this.#closeTurn("flush");
    this.pending = Buffer.alloc(0);
  }

  // --- Núcleo por frame -----------------------------------------------------------------------

  #processFrame(pcm) {
    const { options } = this;
    const { frameMs, sampleRate } = options;
    const startMs = this.originMs + (this.consumedSamples / sampleRate) * 1000;
    this.consumedSamples += this.samplesPerFrame;
    const endMs = startMs + frameMs;

    // RMS normalizado a [-1, 1].
    let sumSquares = 0;
    for (let i = 0; i < pcm.length; i += 2) {
      const s = pcm.readInt16LE(i) / 32768;
      sumSquares += s * s;
    }
    const signalDb = rmsToDb(Math.sqrt(sumSquares / this.samplesPerFrame));

    this.#learnNoiseFloor(signalDb);
    const openThresholdDb = clamp(this.noiseFloorDb + options.openMarginDb, options.minOpenDb, options.maxOpenDb);
    const closeThresholdDb = openThresholdDb - options.hysteresisDb;

    // Compuerta con attack (para abrir) e hangover (para cerrar).
    const wasOpen = this.gateOpen;
    if (!this.gateOpen) {
      if (signalDb >= openThresholdDb) {
        this.attackAccumMs += frameMs;
      } else {
        this.attackAccumMs = Math.max(0, this.attackAccumMs - frameMs * 2);
      }
      if (this.attackAccumMs >= options.attackMs) {
        this.gateOpen = true;
        this.attackAccumMs = 0;
        this.quietMs = 0;
      }
    } else if (signalDb < closeThresholdDb) {
      this.quietMs += frameMs;
      if (this.quietMs >= options.hangoverMs) {
        this.gateOpen = false;
        this.quietMs = 0;
      }
    } else {
      this.quietMs = 0;
    }
    const voiceLike = signalDb >= (this.gateOpen ? closeThresholdDb : openThresholdDb);

    const frame = { pcm: Buffer.from(pcm), startMs, db: signalDb, sumSquares, voiced: voiceLike };

    if (!this.turn) {
      this.#pushPreRoll(frame);
      // Abre turno al transicionar a compuerta abierta, o si la compuerta sigue abierta tras un
      // corte por longitud y vuelve a haber voz.
      if (this.gateOpen && (!wasOpen || voiceLike)) this.#openTurn();
    } else {
      this.#appendFrame(frame);
      this.#checkEndpoint(endMs);
    }

    this.lastDecision = {
      signalDb,
      noiseFloorDb: this.noiseFloorDb,
      openThresholdDb,
      closeThresholdDb,
      gateOpen: this.gateOpen,
      voiceLike,
      at: endMs,
    };
    // Cadencia media exacta de `levelIntervalMs` aunque no sea múltiplo del frame.
    if (this.nextLevelAt === null) this.nextLevelAt = endMs;
    if (endMs >= this.nextLevelAt) {
      this.nextLevelAt += options.levelIntervalMs;
      this.emit("level", {
        rmsDb: signalDb,
        speaking: this.gateOpen,
        noiseFloorDb: this.noiseFloorDb,
        openThresholdDb,
        at: endMs,
      });
    }
  }

  #learnNoiseFloor(signalDb) {
    if (this.gateOpen) return;
    const { options } = this;
    // Un arranque muy fuerte es voz inmediata, no ambiente para calibrar.
    if (this.noiseHistory.length === 0 && signalDb > options.maxOpenDb) return;
    const maxSamples = Math.ceil(options.noiseHistoryMs / options.frameMs);
    this.noiseHistory.push(signalDb);
    if (this.noiseHistory.length > maxSamples) {
      this.noiseHistory.splice(0, this.noiseHistory.length - maxSamples);
    }
    const candidate = percentile(this.noiseHistory, options.noisePercentile);
    if (this.noiseHistory.length <= Math.ceil(500 / options.frameMs)) {
      this.noiseFloorDb = candidate;
      return;
    }
    const seconds = options.frameMs / 1000;
    this.noiseFloorDb = candidate > this.noiseFloorDb
      ? Math.min(candidate, this.noiseFloorDb + options.noiseRiseDbPerSec * seconds)
      : Math.max(candidate, this.noiseFloorDb - options.noiseFallDbPerSec * seconds);
  }

  #pushPreRoll(frame) {
    const { preRollMs, attackMs, frameMs } = this.options;
    // El pre-roll debe cubrir el attack (frames ya con voz) más el margen previo pedido.
    const capacityMs = preRollMs + attackMs;
    this.preRoll.push(frame);
    this.preRollTotalMs += frameMs;
    while (this.preRollTotalMs > capacityMs && this.preRoll.length > 1) {
      this.preRoll.shift();
      this.preRollTotalMs -= frameMs;
    }
  }

  #openTurn() {
    const frames = this.preRoll;
    this.preRoll = [];
    this.preRollTotalMs = 0;
    this.turn = {
      startedAt: frames[0].startMs,
      frames: [],
      voicedMs: 0,
      silenceRunMs: 0,
      sumSquares: 0,
    };
    for (const frame of frames) this.#appendFrame(frame);
    this.emit('turn-start', { startedAt: this.turn.startedAt });
  }

  #appendFrame(frame) {
    const { frameMs } = this.options;
    const turn = this.turn;
    turn.frames.push(frame);
    turn.sumSquares += frame.sumSquares;
    if (frame.voiced) {
      turn.voicedMs += frameMs;
      turn.silenceRunMs = 0;
    } else {
      turn.silenceRunMs += frameMs;
    }
  }

  #checkEndpoint(endMs) {
    const { options, turn } = this;
    const durationMs = endMs - turn.startedAt;
    if (turn.silenceRunMs >= options.endSilenceMs) {
      this.#closeTurn("silence");
      return;
    }
    if (durationMs >= options.maxTurnMs + options.maxTurnGraceMs) {
      this.#closeTurn("max-length");
      return;
    }
    const inSoftWindow = durationMs >= options.maxTurnMs - options.softCutWindowMs;
    if (inSoftWindow && turn.silenceRunMs >= options.softCutSilenceMs && turn.voicedMs >= options.minTurnMs) {
      this.#closeTurn("pause");
    }
  }

  #closeTurn(reason) {
    const { options } = this;
    const turn = this.turn;
    this.turn = null;
    const frames = turn.frames;

    // Recorta el silencio final más allá de `tailSilenceMs`; lo recortado vuelve al pre-roll para
    // que un turno inmediatamente posterior conserve continuidad.
    if (reason !== "max-length") {
      const keepMs = Math.min(turn.silenceRunMs, options.tailSilenceMs);
      const dropFrames = Math.floor((turn.silenceRunMs - keepMs) / options.frameMs);
      if (dropFrames > 0) {
        const dropped = frames.splice(frames.length - dropFrames, dropFrames);
        for (const frame of dropped) {
          turn.sumSquares -= frame.sumSquares;
          this.#pushPreRoll(frame);
        }
      }
    }

    if (frames.length === 0 || turn.voicedMs < options.minTurnMs) {
      this.emit('turn-discarded', { startedAt: turn.startedAt });
      return;
    }

    const pcm = Buffer.concat(frames.map((frame) => frame.pcm));
    const sampleCount = pcm.length / 2;
    const rmsDb = rmsToDb(Math.sqrt(Math.max(0, turn.sumSquares) / sampleCount));
    const last = frames[frames.length - 1];
    this.emit("turn", {
      pcm,
      sampleRate: options.sampleRate,
      startedAt: turn.startedAt,
      endedAt: last.startMs + options.frameMs,
      voicedMs: turn.voicedMs,
      rmsDb,
      reason,
    });
  }
}
