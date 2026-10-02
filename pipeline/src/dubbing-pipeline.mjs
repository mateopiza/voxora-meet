// Pipeline de doblaje por turnos: STT → traducción → TTS.
//
// Contrato (docs/CONTRACTS.md): `processTurn(turn)` → `Promise<DubResult>`:
//   { audioDub, sampleRate, sourceTimestamp, sourceEndedAt, readyAt,
//     transcript, translation, cost: { stt, translate, tts, totalVox } }
// y `null` cuando el turno se descarta (sin voz / alucinación / traducción vacía).
//
// Ejecución por etapas: cada etapa tiene su propia cola con concurrencia 1, de
// modo que el orden de los turnos se conserva dentro de cada etapa pero el STT
// del turno N+1 arranca mientras la traducción o el TTS del turno N siguen en
// vuelo. El resultado de una etapa se encadena con el de la anterior por
// promesa, así los turnos descartados atraviesan el resto de etapas sin costo.

import { EventEmitter } from "node:events";
import { estimateTurnCost as defaultEstimateTurnCost } from "../../billing/src/index.mjs";
import { isAbortError } from "./util/http.mjs";
import { voiceSettingsFromFlat } from "./tts/elevenlabs.mjs";

export class DubbingError extends Error {
  constructor(message, { stage, cause } = {}) {
    super(message, { cause });
    this.name = "DubbingError";
    this.stage = stage;
  }
}

/** Cola FIFO con concurrencia 1: `run(fn)` ejecuta `fn` cuando terminó la anterior. */
export class StageQueue {
  #tail = Promise.resolve();
  #pending = 0;

  get pending() {
    return this.#pending;
  }

  run(fn) {
    this.#pending += 1;
    const next = this.#tail.then(fn, fn);
    // La cola nunca se bloquea por un fallo: el siguiente arranca igual.
    this.#tail = next.then(
      () => { this.#pending -= 1; },
      () => { this.#pending -= 1; },
    );
    return next;
  }

  /** Promesa que resuelve cuando todo lo encolado hasta ahora terminó. */
  idle() {
    return this.#tail;
  }
}

function throwIfAborted(signal, stage) {
  if (signal?.aborted) {
    const reason = signal.reason ?? new DOMException("Turno cancelado", "AbortError");
    throw reason instanceof Error ? reason : new DOMException(String(reason), "AbortError");
  }
  void stage;
}

export class DubbingPipeline extends EventEmitter {
  #stt;
  #translator;
  #tts;
  #voiceId;
  #profiles;
  #userId;
  #estimateTurnCost;
  #meter;
  #now;
  #controller = new AbortController();
  #queues = { stt: new StageQueue(), translate: new StageQueue(), tts: new StageQueue() };
  #inflight = 0;
  #pendingAudioMs = 0;
  #stats = { processed: 0, dubbed: 0, discarded: 0, failed: 0, cancelled: 0, sumMs: { stt: 0, translate: 0, tts: 0, total: 0 }, last: null };

  /**
   * @param {object} options
   * @param {{ transcribeTurn: Function }} options.stt   GroqWhisperStt o compatible.
   * @param {{ translate: Function }} options.translator ContextTranslator o compatible.
   * @param {{ synthesize: Function }} options.tts       ElevenLabsTts o compatible.
   * @param {string} [options.voiceId]                   Voz clonada; si falta se lee de `profiles` por `userId`.
   */
  constructor({
    stt,
    translator,
    tts,
    voiceId = null,
    profiles = null,
    userId = "default",
    sourceLanguage = "es",
    targetLanguage = "en",
    minVoicedMs = 250,
    voiceSettings = null,
    estimateTurnCost = defaultEstimateTurnCost,
    ttsCostMultiplier = null,
    meter = null,
    allowMp3 = false,
    now = () => performance.now(),
    logger = null,
  } = {}) {
    super();
    if (!stt?.transcribeTurn) throw new TypeError("DubbingPipeline: `stt.transcribeTurn` obligatorio");
    if (!translator?.translate) throw new TypeError("DubbingPipeline: `translator.translate` obligatorio");
    if (!tts?.synthesize) throw new TypeError("DubbingPipeline: `tts.synthesize` obligatorio");
    if (!voiceId && !profiles) throw new TypeError("DubbingPipeline: se requiere `voiceId` o `profiles`");
    this.#stt = stt;
    this.#translator = translator;
    this.#tts = tts;
    this.#voiceId = voiceId;
    this.#profiles = profiles;
    this.#userId = userId;
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.minVoicedMs = minVoicedMs;
    this.voiceSettings = voiceSettings;
    this.#estimateTurnCost = estimateTurnCost;
    // Multiplicador de costo por carácter del modelo TTS (dato en vivo del catálogo; null = tabla de billing).
    this.ttsCostMultiplier = Number(ttsCostMultiplier) > 0 ? Number(ttsCostMultiplier) : null;
    this.#meter = meter;
    this.allowMp3 = allowMp3;
    this.#now = now;
    this.logger = logger;
  }

  get signal() {
    return this.#controller.signal;
  }

  get userId() {
    return this.#userId;
  }

  /** Métricas agregadas (promedios por etapa en ms) y del último turno. */
  get metrics() {
    const n = this.#stats.dubbed || 1;
    return {
      processed: this.#stats.processed,
      dubbed: this.#stats.dubbed,
      discarded: this.#stats.discarded,
      failed: this.#stats.failed,
      cancelled: this.#stats.cancelled,
      queued: { stt: this.#queues.stt.pending, translate: this.#queues.translate.pending, tts: this.#queues.tts.pending },
      avgMs: {
        stt: this.#stats.sumMs.stt / n,
        translate: this.#stats.sumMs.translate / n,
        tts: this.#stats.sumMs.tts / n,
        total: this.#stats.sumMs.total / n,
      },
      last: this.#stats.last,
    };
  }

  setVoiceId(voiceId) {
    this.#voiceId = voiceId || null;
  }

  /**
   * Cambia en caliente el cliente de STT y/o el traductor (cambio de proveedor);
   * rige desde el siguiente turno. La memoria de contexto pasa al traductor nuevo.
   */
  replaceStages({ stt, translator } = {}) {
    if (stt) {
      if (!stt.transcribeTurn) throw new TypeError("DubbingPipeline: `stt.transcribeTurn` obligatorio");
      this.#stt = stt;
    }
    if (translator) {
      if (!translator.translate) throw new TypeError("DubbingPipeline: `translator.translate` obligatorio");
      for (const turn of this.#translator.memory ?? []) translator.remember?.(turn.source, turn.translation);
      this.#translator = translator;
    }
    return this.currentSettings();
  }

  /**
   * Aplica en caliente los ajustes planos del engine (protocolo v3); rige desde
   * el siguiente turno (cada etapa congela sus parámetros al arrancar el turno).
   * Claves: sttModel, sttTemperature, translateModel, translateTemperature,
   * translateReasoningEffort, memoryTurns, ttsModel (+ ttsCapabilities del
   * catálogo), ttsStability, ttsSimilarityBoost, ttsStyle, ttsSpeed,
   * ttsSpeakerBoost, ttsTextNormalization, ttsCostMultiplier, voiceId.
   * Devuelve la configuración resultante (`currentSettings()`).
   */
  applySettings(patch = {}) {
    const p = patch ?? {};
    const stt = this.#stt;
    const tr = this.#translator;
    const tts = this.#tts;
    if (p.sttModel) stt.setModel?.(p.sttModel);
    if (p.sttTemperature !== undefined) stt.setTemperature?.(p.sttTemperature);
    if (p.translateModel) tr.setModel?.(p.translateModel);
    if (p.translateTemperature !== undefined) tr.setTemperature?.(p.translateTemperature);
    if (p.translateReasoningEffort) tr.setReasoningEffort?.(p.translateReasoningEffort);
    if (p.memoryTurns !== undefined) tr.setMemoryTurns?.(p.memoryTurns);
    if (p.ttsModel || p.ttsCapabilities) tts.setModel?.(p.ttsModel || tts.modelId, p.ttsCapabilities ?? null);
    const voiceSettings = voiceSettingsFromFlat(p);
    if (Object.keys(voiceSettings).length) tts.setVoiceSettings?.(voiceSettings);
    if (p.ttsTextNormalization) tts.setTextNormalization?.(p.ttsTextNormalization);
    if (p.ttsCostMultiplier !== undefined) this.ttsCostMultiplier = Number(p.ttsCostMultiplier) > 0 ? Number(p.ttsCostMultiplier) : null;
    if (p.voiceId) this.setVoiceId(p.voiceId);
    return this.currentSettings();
  }

  /** Foto de los modelos y parámetros activos en cada etapa. */
  currentSettings() {
    const stt = this.#stt;
    const tr = this.#translator;
    const tts = this.#tts;
    return {
      sttProvider: stt.provider ?? null,
      sttModel: stt.model ?? null,
      sttTemperature: stt.temperature ?? null,
      translateProvider: tr.provider ?? null,
      translateModel: tr.model ?? null,
      translateTemperature: tr.temperature ?? null,
      translateReasoningEffort: tr.reasoningEffort ?? null,
      memoryTurns: tr.memoryTurns ?? null,
      ttsModel: tts.modelId ?? null,
      ttsCapabilities: tts.capabilities ? { ...tts.capabilities } : null,
      voiceSettings: tts.voiceSettings ? { ...tts.voiceSettings } : null,
      ttsTextNormalization: tts.textNormalization ?? null,
      ttsCostMultiplier: this.ttsCostMultiplier ?? null,
      voiceId: this.#voiceId,
    };
  }

  async resolveVoiceId() {
    if (this.#voiceId) return this.#voiceId;
    const profile = await this.#profiles.get(this.#userId);
    if (!profile?.voiceId) throw new DubbingError("El usuario no tiene voz clonada configurada", { stage: "tts" });
    return profile.voiceId;
  }

  /** Cancela todos los turnos en vuelo y los futuros hasta `reset()`. */
  abort(reason = new DOMException("Pipeline abortado", "AbortError")) {
    this.#controller.abort(reason);
  }

  /** Rearma el controlador tras un `abort()`. */
  reset() {
    this.#controller = new AbortController();
  }

  /** Espera a que todas las etapas queden vacías. */
  async drain() {
    await Promise.all([this.#queues.stt.idle(), this.#queues.translate.idle(), this.#queues.tts.idle()]);
  }

  /**
   * Procesa un turno (`{ pcm, sampleRate, startedAt, endedAt, voicedMs, rmsDb }`).
   * Resuelve `DubResult` o `null` si se descarta. Rechaza con AbortError si se
   * cancela, o con DubbingError/SttError/TranslationError/TtsError si falla.
   */
  processTurn(turn, { signal, shouldSynthesize = () => true } = {}) {
    if (!turn?.pcm) return Promise.reject(new DubbingError("Turno sin `pcm`", { stage: "stt" }));
    const combined = signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal;
    const timings = { enqueuedAt: this.#now(), stt: 0, translate: 0, tts: 0, sttWaitMs: 0 };
    const audioMs = turn.endedAt != null && turn.startedAt != null ? Math.max(0, turn.endedAt - turn.startedAt) : Math.round((turn.pcm.byteLength / 2 / (turn.sampleRate || 16_000)) * 1000);
    if (this.#inflight >= 4 || this.#pendingAudioMs + audioMs > 15000) {
      return Promise.reject(Object.assign(new DubbingError('Hay demasiadas frases pendientes.', { stage: 'stt' }), { code: 'pipeline_overload' }));
    }
    this.#inflight++;
    this.#pendingAudioMs += audioMs;
    this.#stats.processed += 1;

    // Etapa 1: STT
    const sttPromise = this.#queues.stt.run(async () => {
      throwIfAborted(combined, "stt");
      if (Number.isFinite(turn.voicedMs) && turn.voicedMs < this.minVoicedMs) {
        return { discarded: true, reason: "too_short", text: "" };
      }
      const started = this.#now();
      timings.sttWaitMs = started - timings.enqueuedAt;
      const result = await this.#stt.transcribeTurn({
        pcm: turn.pcm,
        sampleRate: turn.sampleRate ?? 16_000,
        language: this.sourceLanguage,
        signal: combined,
        evidence: { voicedMs: turn.voicedMs, rmsDb: turn.rmsDb },
        userId: this.#userId,
      });
      timings.stt = this.#now() - started;
      return result;
    });

    // Etapa 2: traducción (espera el STT de ESTE turno, pero encola en orden).
    const translatePromise = this.#queues.translate.run(async () => {
      const stt = await sttPromise;
      if (stt.discarded || !stt.text) return { stt, discarded: true, reason: stt.reason ?? "empty_transcript" };
      throwIfAborted(combined, "translate");
      const started = this.#now();
      const translation = await this.#translator.translate({
        text: stt.text,
        sourceLanguage: this.sourceLanguage,
        targetLanguage: this.targetLanguage,
        signal: combined,
        userId: this.#userId,
      });
      timings.translate = this.#now() - started;
      if (translation.discarded || !translation.translation) return { stt, translation, discarded: true, reason: "empty_translation" };
      return { stt, translation, discarded: false };
    });

    // Etapa 3: TTS + costo.
    const ttsPromise = this.#queues.tts.run(async () => {
      const prev = await translatePromise;
      if (prev.discarded) return prev;
      throwIfAborted(combined, "tts");
      if (!shouldSynthesize()) return { ...prev, discarded: true, reason: 'delivery-expired' };
      const voiceId = await this.resolveVoiceId();
      const started = this.#now();
      const synth = await this.#tts.synthesize({
        text: prev.translation.translation,
        voiceId,
        voiceSettings: this.voiceSettings ?? undefined,
        languageCode: this.targetLanguage,
        signal: combined,
        allowMp3Fallback: this.allowMp3,
      });
      timings.tts = this.#now() - started;
      if (synth.audioFormat !== "pcm_s16le" && !this.allowMp3) {
        throw new DubbingError(`El TTS devolvió ${synth.audioFormat}; el sync-buffer requiere PCM s16le`, { stage: "tts" });
      }
      return { ...prev, synth, discarded: false };
    });

    return ttsPromise.then(
      (outcome) => this.#finish(turn, outcome, { timings, audioMs }),
      (error) => this.#fail(turn, error),
    ).finally(() => { this.#inflight--; this.#pendingAudioMs -= audioMs; });
  }

  #finish(turn, outcome, { timings, audioMs }) {
    const readyAt = this.#now();
    if (outcome.discarded) {
      this.#stats.discarded += 1;
      const info = { reason: outcome.reason, transcript: outcome.stt?.text ?? "", sourceTimestamp: turn.startedAt, metrics: { sttMs: timings.stt, translateMs: timings.translate } };
      this.logger?.debug?.("pipeline.discard", info);
      this.emit("discard", info);
      return null;
    }
    const { stt, translation, synth } = outcome;
    // Se cobra con los modelos que realmente atendieron este turno.
    const models = {
      sttModel: stt.model ?? this.#stt.model,
      translateModel: translation.model ?? this.#translator.model,
      ttsModel: synth.modelId ?? this.#tts.modelId,
      ...(this.ttsCostMultiplier && (synth.modelId ?? this.#tts.modelId) === this.#tts.modelId ? { ttsCostMultiplier: this.ttsCostMultiplier } : {}),
    };
    const cost = this.#estimateTurnCost({
      audioMs,
      inputTokens: translation.usage?.inputTokens ?? 0,
      outputTokens: translation.usage?.outputTokens ?? 0,
      ttsChars: synth.chars ?? translation.translation.length,
    }, models);
    this.#meter?.add?.(cost);
    const totalMs = readyAt - timings.enqueuedAt;
    const metrics = { sttMs: timings.stt, translateMs: timings.translate, ttsMs: timings.tts, queueWaitMs: timings.sttWaitMs, totalMs };
    this.#stats.dubbed += 1;
    this.#stats.sumMs.stt += timings.stt;
    this.#stats.sumMs.translate += timings.translate;
    this.#stats.sumMs.tts += timings.tts;
    this.#stats.sumMs.total += totalMs;
    this.#stats.last = metrics;

    const result = {
      audioDub: synth.audio,
      sampleRate: synth.sampleRate,
      audioFormat: synth.audioFormat,
      sourceTimestamp: turn.startedAt,
      sourceEndedAt: turn.endedAt,
      readyAt,
      transcript: stt.text,
      translation: translation.translation,
      confidence: stt.confidence ?? null,
      cost,
      metrics,
      usage: {
        audioMs,
        inputTokens: translation.usage?.inputTokens ?? 0,
        outputTokens: translation.usage?.outputTokens ?? 0,
        ttsChars: synth.chars ?? translation.translation.length,
      },
    };
    this.emit("turn", result);
    return result;
  }

  #fail(turn, error) {
    if (isAbortError(error)) {
      this.#stats.cancelled += 1;
      this.emit("cancel", { sourceTimestamp: turn.startedAt, reason: error.message });
    } else {
      this.#stats.failed += 1;
      this.logger?.error?.("pipeline.error", { sourceTimestamp: turn.startedAt, error: error.message, stage: error.stage });
      // Solo se emite si alguien escucha: un `error` sin listener tumbaría el proceso.
      if (this.listenerCount("error")) this.emit("error", error);
    }
    throw error;
  }
}
