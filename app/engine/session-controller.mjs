// Orquestación de una sesión de doblaje:
//   MicCapture → DubbingPipeline → SyncBuffer (solo audio) → VirtualMic
//
// Todo llega por inyección de dependencias (fábricas), de modo que la lógica
// se testea sin hardware, sin red y sin Windows. `engine.mjs` construye las
// fábricas reales; los tests pasan dobles.
//
// Eventos que emite (el motor los reenvía al shell tal cual):
//   status      { state, reason? }
//   level       { rmsDb, speaking }
//   transcript  { turnId, text, startedAt, endedAt }
//   translation { turnId, text }
//   dub         { turnId, durationMs, late, placedStart, driftMs }
//   stats       { delayMs, queuedFrames, queuedAudioMs, dubsPending, driftMs, lateDubs, totalVox, remainingVox, turns, pendingTurns, state }
//   cost        { turnId, cost, totalVox }
//   warn        { kind: 'vox'|'drift'|'late-dub', ... }
//   limit       { totalVox, maxVoxPerSession }
//   error       { scope, message }

import { EventEmitter } from 'node:events';
import { friendlyError } from './errors.mjs';

export const STATES = Object.freeze(['idle', 'starting', 'running', 'stopping']);

// Presupuesto de frase (ver turnBudgetMs): latencia inicial estimada fin-de-voz → doblaje listo
// (700 ms de silencio de cierre + ~2,5 s de STT+traducción+TTS), margen y límites.
const INITIAL_TURN_LATENCY_MS = 3200;
const TURN_SAFETY_MARGIN_MS = 400;
const MIN_TURN_BUDGET_MS = 1500;
const MAX_TURN_MS = 15000;

/**
 * Reloj de muestras para sellar el audio original que se copia al SyncBuffer:
 * ancla el origen al reloj de pared en el primer chunk y solo re-ancla hacia
 * adelante si el flujo se retrasa (misma política que PhraseSegmenter).
 */
export class SampleClock {
  constructor({ sampleRate = 16000, resyncToleranceMs = 250 } = {}) {
    this.sampleRate = sampleRate;
    this.resyncToleranceMs = resyncToleranceMs;
    this.originMs = null;
    this.consumedSamples = 0;
  }

  /** Devuelve el timestamp de inicio del chunk (ms) y avanza el cursor. */
  stamp(byteLength, nowMs) {
    const samples = Math.floor(byteLength / 2);
    const chunkMs = (samples / this.sampleRate) * 1000;
    if (this.originMs === null) {
      this.originMs = nowMs - chunkMs;
    } else {
      const expectedEnd = this.originMs + (this.consumedSamples / this.sampleRate) * 1000 + chunkMs;
      const gap = nowMs - expectedEnd;
      if (gap > this.resyncToleranceMs) this.originMs += gap;
    }
    const start = this.originMs + (this.consumedSamples / this.sampleRate) * 1000;
    this.consumedSamples += samples;
    return start;
  }
}

export class SessionController extends EventEmitter {
  /**
   * @param {object} deps
   * @param {(opts: { deviceId: string, source?: any }) => any} deps.createMicCapture
   * @param {(opts: { deviceId: string }) => any} [deps.createAudioSource]  Readable PCM s16le 16 kHz (tee del original)
   * @param {(opts: { settings: object, keys: object }) => { processTurn(turn): Promise<any> }} deps.createPipeline
   * @param {(opts: object) => any} deps.createSyncBuffer
   * @param {() => { open(): any, write(pcm): any, close(): any }} deps.createVirtualMic
   * @param {(opts: { maxVoxPerSession: number, warnAtVox: number }) => any} deps.createMeter
   * @param {{ load(): Promise<object>, getProviderKeys(): Promise<object> }} deps.settingsStore
   * @param {() => number} [deps.now]
   * @param {number} [deps.tickIntervalMs=20]
   * @param {number} [deps.statsIntervalMs=500]
   */
  constructor(deps) {
    super();
    const required = ['createMicCapture', 'createPipeline', 'createSyncBuffer', 'createVirtualMic', 'createMeter', 'settingsStore'];
    for (const name of required) {
      if (!deps?.[name]) throw new TypeError(`SessionController: falta la dependencia ${name}`);
    }
    this.deps = deps;
    this.now = deps.now ?? (() => performance.now());
    this.tickIntervalMs = deps.tickIntervalMs ?? 20;
    this.statsIntervalMs = deps.statsIntervalMs ?? 500;
    this.state = 'idle';
    this.settings = null;
    this.session = null;
    this.lastLevel = { rmsDb: -100, speaking: false };
    this.turnCounter = 0;
  }

  #setState(state, extra = {}) {
    this.state = state;
    this.emit('status', { state, ...extra });
  }

  #error(scope, error) {
    const { code, message } = friendlyError(error);
    this.emit('error', { scope, code, message });
  }

  /** Arranca la sesión. `overrides` pisa los ajustes persistidos solo para esta sesión. */
  async start(overrides = {}) {
    if (this.state !== 'idle') throw Object.assign(new Error(`no se puede iniciar en estado ${this.state}`), { code: 'bad_state' });
    this.#setState('starting');
    const session = { pendingTurns: 0, turns: 0, statsTimer: null };
    this.session = session;
    try {
      const stored = await this.deps.settingsStore.load();
      const settings = { ...stored, ...overrides };
      this.settings = settings;
      const keys = await this.deps.settingsStore.getProviderKeys();

      // Salida: micrófono virtual (driver WaveRT) — se abre primero para
      // fallar rápido si el driver no está instalado.
      if (!settings.voiceId && !overrides.allowMissingVoice) {
        throw Object.assign(new Error('Todavía no hay una voz seleccionada. Elígela o clónala en la pestaña Voz.'), { code: 'voice_missing' });
      }
      // Resuelve el endpoint real (driver propio → VB-Cable) antes de abrirlo.
      const output = this.deps.resolveOutputDevice
        ? await this.deps.resolveOutputDevice(settings)
        : { deviceName: settings.virtualMicDevice || undefined };
      if (output.warning) this.emit('warn', { kind: 'output', message: output.warning });
      session.output = output;
      session.virtualMic = this.deps.createVirtualMic({
        sampleRate: 48000,
        channels: 1,
        ...(output.deviceId ? { deviceId: output.deviceId } : {}),
        ...(output.deviceName ? { deviceName: output.deviceName } : {}),
      });
      await session.virtualMic.open();

      // Monitor opcional: el mismo audio doblado también por los altavoces
      // del usuario. Un fallo aquí nunca impide la sesión.
      if (settings.monitorDevice) {
        try {
          session.monitor = this.deps.createVirtualMic({ sampleRate: 48000, channels: 1, deviceName: settings.monitorDevice });
          await session.monitor.open();
        } catch (error) {
          session.monitor = null;
          this.emit('warn', { kind: 'monitor', message: `No se pudo abrir "${settings.monitorDevice}" para escuchar el doblaje.` });
          this.#error('monitor', error);
        }
      }

      session.meter = this.deps.createMeter({
        maxVoxPerSession: settings.maxVoxPerSession > 0 ? settings.maxVoxPerSession : Infinity,
        warnAtVox: settings.warnAtVox > 0 ? settings.warnAtVox : null,
      });
      session.meter.on?.('warn', (data) => this.emit('warn', { kind: 'vox', ...data }));
      session.meter.on?.('limit', (data) => this.emit('limit', data));

      session.pipeline = await this.deps.createPipeline({ settings, keys });

      session.syncBuffer = this.deps.createSyncBuffer({
        delayMs: settings.delayMs,
        fallbackMode: settings.fallbackMode,
        lateDubPolicy: settings.lateDubPolicy,
        maxDriftMs: settings.maxDriftMs,
        outputSampleRate: 48000,
        now: this.now,
      });
      session.syncBuffer.on('release', ({ audio }) => {
        try {
          session.virtualMic.write(audio.pcm);
        } catch (error) {
          this.#error('virtual-mic', error);
        }
        if (session.monitor) {
          try { session.monitor.write(audio.pcm); } catch { /* el monitor es opcional */ }
        }
      });
      session.syncBuffer.on('drift-exceeded', (data) => this.emit('warn', { kind: 'drift', ...data }));
      session.syncBuffer.on('late-dub', (data) => this.emit('warn', { kind: 'late-dub', ...data }));
      session.syncBuffer.on('error', (error) => this.#error('sync-buffer', error));

      // Entrada: fuente PCM opcional (tee del original) + MicCapture.
      const deviceId = settings.micDeviceId || undefined;
      session.source = this.deps.createAudioSource ? await this.deps.createAudioSource({ deviceId }) : null;
      if (session.source) {
        const clock = new SampleClock({ sampleRate: 16000 });
        session.onSourceData = (chunk) => {
          const timestamp = clock.stamp(chunk.length, this.now());
          try {
            session.syncBuffer.pushAudio({ pcm: chunk, sampleRate: 16000, timestamp });
          } catch (error) {
            this.#error('original-audio', error);
          }
        };
        session.source.on('data', session.onSourceData);
      }
      session.mic = this.deps.createMicCapture({ deviceId, source: session.source ?? undefined });
      session.mic.on('level', (level) => {
        this.lastLevel = { rmsDb: level.rmsDb, speaking: Boolean(level.speaking) };
        this.emit('level', this.lastLevel);
      });
      session.mic.on('turn', (turn) => this.#onTurn(turn));
      session.mic.on('error', (error) => this.#error('mic', error));
      this.#applyTurnBudget(session);
      session.mic.start();

      session.syncBuffer.start(this.tickIntervalMs);
      session.statsTimer = setInterval(() => this.emit('stats', this.stats()), this.statsIntervalMs);
      session.statsTimer.unref?.();
      this.#setState('running');
      return this.stats();
    } catch (error) {
      await this.#teardown(session);
      this.session = null;
      this.#setState('idle', { reason: 'start-failed' });
      throw error;
    }
  }

  async stop() {
    if (this.state === 'idle' || !this.session) return this.stats();
    const session = this.session;
    this.#setState('stopping');
    await this.#teardown(session);
    this.session = null;
    this.#setState('idle', { reason: 'stopped' });
    return this.stats();
  }

  async #teardown(session) {
    if (session.statsTimer) clearInterval(session.statsTimer);
    try { session.mic?.stop(); } catch (error) { this.#error('mic', error); }
    if (session.source) {
      session.source.off?.('data', session.onSourceData);
      try { session.source.destroy?.(); } catch { /* best-effort */ }
    }
    try { session.syncBuffer?.stop(); } catch { /* best-effort */ }
    try { await session.pipeline?.close?.(); } catch (error) { this.#error('pipeline', error); }
    try { await session.virtualMic?.close(); } catch (error) { this.#error('virtual-mic', error); }
    try { await session.monitor?.close(); } catch { /* opcional */ }
  }

  #onTurn(turn) {
    const session = this.session;
    if (!session || this.state !== 'running') return;
    const turnId = ++this.turnCounter;
    session.turns += 1;

    // Sin fuente PCM continua, el original solo se conoce al cerrar el turno:
    // se copia igualmente (útil cuando el turno es más corto que el delay).
    if (!session.source && turn?.pcm) {
      try {
        session.syncBuffer.pushAudio({ pcm: turn.pcm, sampleRate: turn.sampleRate ?? 16000, timestamp: turn.startedAt });
      } catch (error) {
        this.#error('original-audio', error);
      }
    }

    if (session.meter.limitReached) {
      this.emit('warn', { kind: 'vox', reason: 'limit-reached', turnId, skipped: true });
      return;
    }

    session.pendingTurns += 1;
    Promise.resolve()
      .then(() => session.pipeline.processTurn(turn))
      .then((result) => {
        if (this.session !== session) return; // la sesión ya se cerró
        if (!result) return; // turno descartado por el pipeline
        if (result.transcript) {
          this.emit('transcript', { turnId, text: result.transcript, startedAt: turn.startedAt, endedAt: turn.endedAt });
        }
        if (result.translation) this.emit('translation', { turnId, text: result.translation });
        // Latencia real fin-de-voz → doblaje listo: recalibra la longitud máxima de las frases.
        if (Number.isFinite(result.readyAt) && Number.isFinite(turn.endedAt)) {
          this.#observeLatency(session, result.readyAt - turn.endedAt);
        }
        const placement = session.syncBuffer.pushDub(result);
        const durationMs = result.audioDub && result.sampleRate
          ? (result.audioDub.byteLength / 2 / result.sampleRate) * 1000
          : 0;
        this.emit('dub', {
          turnId,
          durationMs: Math.round(durationMs),
          late: Boolean(placement?.late),
          scheduled: Boolean(placement?.scheduled),
          placedStart: placement?.placedStart ?? null,
          driftMs: placement?.driftMs ?? 0,
        });
        if (result.cost) {
          const snapshot = session.meter.add(result.cost);
          this.emit('cost', { turnId, cost: result.cost, totalVox: snapshot?.totalVox ?? session.meter.totalVox });
        }
      })
      .catch((error) => this.#error('pipeline', error))
      .finally(() => {
        if (this.session === session) session.pendingTurns -= 1;
      });
  }

  /**
   * Presupuesto de frase: para que el doblaje esté listo ANTES de que el retraso alcance el inicio
   * de la frase, hace falta  duración + (fin de voz → doblaje listo) ≤ delay. Con frases de hasta
   * 15 s y un delay de 2–6 s el doblaje llegaba casi siempre tarde (y con el modo "original" se oía
   * la voz en español). Se limita la frase a lo que cabe y se recalibra con la latencia medida.
   */
  turnBudgetMs(session = this.session) {
    const delayMs = this.settings?.delayMs ?? 3000;
    const latency = session?.latencyEmaMs ?? INITIAL_TURN_LATENCY_MS;
    return Math.round(Math.min(MAX_TURN_MS, Math.max(MIN_TURN_BUDGET_MS, delayMs - latency - TURN_SAFETY_MARGIN_MS)));
  }

  #applyTurnBudget(session) {
    if (typeof session?.mic?.setSegmenterLimits !== 'function') return;
    const maxTurnMs = this.turnBudgetMs(session);
    if (maxTurnMs === session.appliedMaxTurnMs) return;
    try {
      session.mic.setSegmenterLimits({ maxTurnMs, softCutWindowMs: Math.min(3000, maxTurnMs) });
      session.appliedMaxTurnMs = maxTurnMs;
    } catch (error) {
      this.#error('mic', error);
    }
  }

  #observeLatency(session, latencyMs) {
    if (!(latencyMs > 0) || latencyMs > 60_000) return;
    session.latencyEmaMs = session.latencyEmaMs == null
      ? latencyMs
      : session.latencyEmaMs * 0.7 + latencyMs * 0.3;
    this.#applyTurnBudget(session);
  }

  /** Cambia el delay en caliente (si hay sesión) y lo devuelve clampeado. */
  setDelay(ms) {
    const session = this.session;
    if (session?.syncBuffer) {
      const applied = session.syncBuffer.setDelay(ms);
      if (this.settings) this.settings.delayMs = applied;
      this.#applyTurnBudget(session);
      return applied;
    }
    const n = Math.round(Number(ms));
    return Number.isFinite(n) ? Math.min(6000, Math.max(2000, n)) : 3000;
  }

  /**
   * Ajustes que se pueden cambiar sin reiniciar la sesión. Además de los del
   * SyncBuffer, los de modelo (protocolo v3: STT, traducción, TTS y voice
   * settings) se delegan en `pipeline.applySettings` y rigen desde el siguiente turno.
   */
  applyLiveSettings(patch = {}) {
    const session = this.session;
    if (!session?.syncBuffer) return false;
    if (patch.fallbackMode) session.syncBuffer.fallbackMode = patch.fallbackMode;
    if (patch.lateDubPolicy) session.syncBuffer.lateDubPolicy = patch.lateDubPolicy;
    if (Number.isFinite(patch.maxDriftMs)) session.syncBuffer.maxDriftMs = patch.maxDriftMs;
    if (patch.delayMs !== undefined) this.setDelay(patch.delayMs);
    const pipeline = session.pipeline;
    if (typeof pipeline?.applySettings === 'function') {
      try {
        pipeline.applySettings(patch);
      } catch (error) {
        this.#error('pipeline', error);
      }
    } else if (patch.voiceId && typeof pipeline?.setVoiceId === 'function') {
      pipeline.setVoiceId(patch.voiceId);
    }
    if (this.settings) {
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined && key !== 'ttsCapabilities' && key !== 'delayMs') this.settings[key] = value;
      }
    }
    return true;
  }

  stats() {
    const session = this.session;
    const base = session?.syncBuffer
      ? session.syncBuffer.stats()
      : { delayMs: this.settings?.delayMs ?? 3000, queuedFrames: 0, queuedAudioMs: 0, dubsPending: 0, driftMs: 0, lateDubs: 0 };
    const meter = session?.meter;
    const remaining = meter?.remainingVox;
    return {
      ...base,
      state: this.state,
      totalVox: meter?.totalVox ?? 0,
      remainingVox: Number.isFinite(remaining) ? remaining : null,
      limitReached: Boolean(meter?.limitReached),
      turnBudgetMs: session ? this.turnBudgetMs(session) : null,
      latencyMs: session?.latencyEmaMs != null ? Math.round(session.latencyEmaMs) : null,
      turns: session?.turns ?? 0,
      pendingTurns: session?.pendingTurns ?? 0,
      level: this.lastLevel,
    };
  }
}

export default SessionController;
