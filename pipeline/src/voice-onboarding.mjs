// Flujo de clonación de voz del usuario.
//
// 1. Valida las muestras (duración total, sample rate, tamaño) contra los
//    requisitos de IVC (≥ 60 s) o PVC (≥ 30 min recomendados).
// 2. Convierte PCM s16le a WAV (las muestras pueden llegar como PCM del
//    capturador o como WAV ya grabado).
// 3. Llama a `VoiceCloning` (IVC directo; PVC en tres pasos) y persiste el
//    `voiceId` en `ProfileStore`.

import { pcmToWav, pcmDurationMs, readWavInfo } from "./util/wav.mjs";
import { IVC_REQUIREMENTS, PVC_REQUIREMENTS } from "./tts/elevenlabs.mjs";

export class VoiceOnboardingError extends Error {
  constructor(message, { issues = [], cause } = {}) {
    super(message, { cause });
    this.name = "VoiceOnboardingError";
    this.issues = issues;
  }
}

const MIN_SAMPLE_MS = 2000;
const MIN_SAMPLE_RATE = 16_000;
const RECOMMENDED_SAMPLE_RATE = 44_100;

/**
 * Normaliza una muestra de entrada a `{ name, mimeType, buffer, durationMs,
 * sampleRate, channels }`. Acepta `{ pcm, sampleRate, channels? }` o `{ wav }`.
 */
export function normalizeSample(sample, index = 0) {
  if (!sample || typeof sample !== "object") throw new VoiceOnboardingError(`Muestra ${index} inválida`);
  const name = sample.name || `sample-${index + 1}.wav`;
  if (sample.wav) {
    const info = readWavInfo(sample.wav);
    return {
      name,
      mimeType: sample.mimeType || "audio/wav",
      buffer: Buffer.isBuffer(sample.wav) ? sample.wav : Buffer.from(sample.wav),
      durationMs: info.durationMs,
      sampleRate: info.sampleRate,
      channels: info.channels,
      bitsPerSample: info.bitsPerSample,
    };
  }
  if (sample.pcm) {
    const sampleRate = Number(sample.sampleRate);
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new VoiceOnboardingError(`Muestra ${index}: sampleRate inválido`);
    const channels = sample.channels ?? 1;
    return {
      name,
      mimeType: "audio/wav",
      buffer: pcmToWav(sample.pcm, { sampleRate, channels, bitsPerSample: 16 }),
      durationMs: pcmDurationMs(sample.pcm.byteLength, { sampleRate, channels, bitsPerSample: 16 }),
      sampleRate,
      channels,
      bitsPerSample: 16,
    };
  }
  throw new VoiceOnboardingError(`Muestra ${index}: se espera { pcm, sampleRate } o { wav }`);
}

/**
 * Valida un conjunto de muestras para `mode` ('ivc' | 'pvc').
 * Devuelve `{ ok, mode, totalMs, totalBytes, samples, issues, recommendations }`.
 * `issues` bloquean; `recommendations` solo se informan.
 */
export function validateSamples(samples, { mode = "ivc" } = {}) {
  const issues = [];
  const recommendations = [];
  const list = Array.isArray(samples) ? samples : [];
  if (!list.length) {
    return { ok: false, mode, totalMs: 0, totalBytes: 0, samples: [], issues: ["No se recibieron muestras de voz."], recommendations };
  }
  const normalized = [];
  list.forEach((sample, i) => {
    try {
      normalized.push(normalizeSample(sample, i));
    } catch (error) {
      issues.push(error.message);
    }
  });

  let totalMs = 0;
  let totalBytes = 0;
  for (const s of normalized) {
    totalMs += s.durationMs;
    totalBytes += s.buffer.length;
    if (s.durationMs < MIN_SAMPLE_MS) issues.push(`"${s.name}" dura ${Math.round(s.durationMs)} ms; cada muestra debe durar al menos ${MIN_SAMPLE_MS / 1000} s.`);
    if (s.sampleRate < MIN_SAMPLE_RATE) issues.push(`"${s.name}" está a ${s.sampleRate} Hz; se requieren al menos ${MIN_SAMPLE_RATE} Hz.`);
    else if (s.sampleRate < RECOMMENDED_SAMPLE_RATE) recommendations.push(`"${s.name}" está a ${s.sampleRate} Hz; para mejor fidelidad graba a ${RECOMMENDED_SAMPLE_RATE} Hz o más.`);
    if (s.channels > 1) recommendations.push(`"${s.name}" es estéreo; ElevenLabs lo mezcla a mono, mejor grabar en mono.`);
  }

  if (mode === "pvc") {
    const minMs = PVC_REQUIREMENTS.minTotalMinutes * 60_000;
    const maxMs = PVC_REQUIREMENTS.maxTotalMinutes * 60_000;
    if (totalMs < minMs) issues.push(`Professional Voice Cloning necesita al menos ${PVC_REQUIREMENTS.minTotalMinutes} min de audio; hay ${formatMinutes(totalMs)}.`);
    if (totalMs > maxMs) recommendations.push(`Hay ${formatMinutes(totalMs)}; ElevenLabs usa como máximo ${PVC_REQUIREMENTS.maxTotalMinutes} min, el resto se ignora.`);
    for (const s of normalized) {
      if (s.buffer.length > PVC_REQUIREMENTS.maxFileBytes) issues.push(`"${s.name}" supera el tamaño máximo por archivo.`);
    }
  } else {
    const minMs = IVC_REQUIREMENTS.minTotalSeconds * 1000;
    const recommendedMs = IVC_REQUIREMENTS.recommendedTotalSeconds * 1000;
    if (totalMs < minMs) issues.push(`Instant Voice Cloning necesita al menos ${IVC_REQUIREMENTS.minTotalSeconds} s de audio; hay ${Math.round(totalMs / 1000)} s.`);
    else if (totalMs < recommendedMs) recommendations.push(`Con ${Math.round(totalMs / 1000)} s funciona; con ${IVC_REQUIREMENTS.recommendedTotalSeconds} s la voz será más fiel.`);
    if (normalized.length > IVC_REQUIREMENTS.maxFiles) issues.push(`Máximo ${IVC_REQUIREMENTS.maxFiles} archivos para Instant Voice Cloning.`);
    if (totalBytes > IVC_REQUIREMENTS.maxTotalBytes) issues.push(`Las muestras suman ${(totalBytes / 1024 / 1024).toFixed(1)} MB; el máximo es ${IVC_REQUIREMENTS.maxTotalBytes / 1024 / 1024} MB. Graba a 16-24 kHz mono o divide en menos audio.`);
    if (totalMs >= PVC_REQUIREMENTS.minTotalMinutes * 60_000) recommendations.push("Tienes más de 30 min de audio: considera Professional Voice Cloning para máxima fidelidad.");
  }

  return { ok: issues.length === 0, mode, totalMs, totalBytes, samples: normalized, issues, recommendations };
}

function formatMinutes(ms) {
  return `${(ms / 60_000).toFixed(1)} min`;
}

export class VoiceOnboarding {
  constructor({ cloning, profiles, logger = null }) {
    if (!cloning) throw new TypeError("VoiceOnboarding: `cloning` (VoiceCloning) obligatorio");
    if (!profiles) throw new TypeError("VoiceOnboarding: `profiles` (ProfileStore) obligatorio");
    this.cloning = cloning;
    this.profiles = profiles;
    this.logger = logger;
  }

  /** Solo validación (para la UI antes de enviar nada). */
  validate(samples, options) {
    return validateSamples(samples, options);
  }

  /**
   * Clona con IVC y guarda el `voiceId` en el perfil. Si el usuario ya tenía
   * una voz clonada y `replacePrevious` es true, borra la anterior en ElevenLabs.
   */
  async cloneInstant({ userId, name, samples, description = "", labels = null, removeBackgroundNoise = false, replacePrevious = true, signal } = {}) {
    const validation = validateSamples(samples, { mode: "ivc" });
    if (!validation.ok) throw new VoiceOnboardingError(`Muestras inválidas: ${validation.issues.join(" ")}`, { issues: validation.issues });
    const previous = await this.profiles.get(userId);
    const voiceName = name || `VOXORA Meet · ${userId}`;
    const { voiceId, requiresVerification } = await this.cloning.createInstantVoice({
      name: voiceName,
      description: description || "Voz clonada para doblaje de reuniones (VOXORA Meet)",
      labels: labels ?? { app: "voxora-meet", user: String(userId) },
      files: validation.samples.map((s) => ({ buffer: s.buffer, name: s.name, mimeType: s.mimeType })),
      removeBackgroundNoise,
      signal,
    });
    await this.profiles.setVoice(userId, { voiceId, voiceName, cloneType: "ivc", cloneStatus: requiresVerification ? "verification_required" : "ready" });
    if (replacePrevious && previous?.voiceId && previous.voiceId !== voiceId) {
      // Borrar la voz vieja es best-effort: la nueva ya está guardada.
      await this.cloning.deleteVoice(previous.voiceId, { signal }).catch((error) => {
        this.logger?.warn?.("voice.delete_previous_failed", { voiceId: previous.voiceId, error: error.message });
      });
    }
    return { voiceId, voiceName, cloneType: "ivc", requiresVerification, totalMs: validation.totalMs, recommendations: validation.recommendations };
  }

  /**
   * Inicia PVC: crea la voz, sube muestras y lanza el entrenamiento. El perfil
   * queda en `cloneStatus: 'training'` y conserva la voz anterior (si existía)
   * como `voiceId` activo hasta que la PVC esté lista; la nueva va en `pendingVoiceId`.
   * Con `strict: false` se permite arrancar por debajo de los 30 min (solo recomendación).
   */
  async startProfessional({ userId, name, samples, language = "es", description = "", labels = null, strict = true, train = true, signal } = {}) {
    const validation = validateSamples(samples, { mode: "pvc" });
    const blocking = strict ? validation.issues : validation.issues.filter((i) => !/necesita al menos/.test(i));
    if (blocking.length) throw new VoiceOnboardingError(`Muestras inválidas: ${blocking.join(" ")}`, { issues: blocking });
    const voiceName = name || `VOXORA Meet PVC · ${userId}`;
    const { voiceId } = await this.cloning.startProfessionalClone({
      name: voiceName,
      language,
      description: description || "Voz profesional clonada para doblaje de reuniones (VOXORA Meet)",
      labels: labels ?? { app: "voxora-meet", user: String(userId) },
      signal,
    });
    const upload = await this.cloning.addProfessionalSamples(
      voiceId,
      validation.samples.map((s) => ({ buffer: s.buffer, name: s.name, mimeType: s.mimeType })),
      { signal },
    );
    let status = "samples_uploaded";
    if (train) {
      await this.cloning.trainProfessionalClone(voiceId, { signal });
      status = "training";
    }
    const previous = await this.profiles.get(userId);
    await this.profiles.update(userId, {
      pendingVoiceId: voiceId,
      pendingVoiceName: voiceName,
      pendingCloneType: "pvc",
      cloneStatus: previous.voiceId ? previous.cloneStatus : status,
      pendingCloneStatus: status,
    });
    return { voiceId, voiceName, cloneType: "pvc", status, sampleIds: upload.sampleIds, totalMs: validation.totalMs, issues: strict ? [] : validation.issues, recommendations: validation.recommendations };
  }

  /** Promueve la PVC pendiente a voz activa cuando ElevenLabs la reporta lista. */
  async activatePending(userId) {
    const profile = await this.profiles.get(userId);
    if (!profile.pendingVoiceId) throw new VoiceOnboardingError("No hay voz pendiente para activar");
    const voice = await this.cloning.getVoice(profile.pendingVoiceId);
    const state = voice.fineTuning?.state ?? voice.fineTuning?.status ?? null;
    const ready = state == null || Object.values(typeof state === "object" ? state : { s: state }).some((v) => /fine_tuned|ready|complete/i.test(String(v)));
    if (!ready) return { activated: false, state };
    await this.profiles.update(userId, {
      voiceId: profile.pendingVoiceId,
      voiceName: profile.pendingVoiceName,
      cloneType: "pvc",
      cloneStatus: "ready",
      pendingVoiceId: null,
      pendingVoiceName: null,
      pendingCloneType: null,
      pendingCloneStatus: null,
    });
    return { activated: true, voiceId: profile.pendingVoiceId };
  }

  /** Elimina la voz activa del usuario en ElevenLabs y en el perfil. */
  async removeVoice(userId, { signal } = {}) {
    const profile = await this.profiles.get(userId);
    if (!profile.voiceId) return { removed: false };
    await this.cloning.deleteVoice(profile.voiceId, { signal });
    await this.profiles.clearVoice(userId);
    return { removed: true, voiceId: profile.voiceId };
  }
}
