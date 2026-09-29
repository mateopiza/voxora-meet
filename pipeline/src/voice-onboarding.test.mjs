import { test } from "node:test";
import assert from "node:assert/strict";
import { VoiceOnboarding, VoiceOnboardingError, validateSamples, normalizeSample } from "./voice-onboarding.mjs";
import { ProfileStore } from "./stores.mjs";
import { pcmToWav, readWavInfo } from "./util/wav.mjs";
import { makePcm, tmpDir } from "./_test-helpers.mjs";

/** Muestras de `ms` ms. La validación solo mira duración/formato, así que para
 *  clips largos (minutos) se usa silencio (Buffer.alloc) en vez de sintetizar tono. */
function samplesOf(ms, { count = 1, sampleRate = 16_000 } = {}) {
  const pcmOf = () => (ms > 60_000 ? Buffer.alloc(Math.round((ms / 1000) * sampleRate) * 2) : makePcm(ms, sampleRate));
  return Array.from({ length: count }, (_, i) => ({ pcm: pcmOf(), sampleRate, name: `s${i}.wav` }));
}

/** Doble de VoiceCloning que registra llamadas y devuelve ids fijos. */
function fakeCloning({ requiresVerification = false, fineTuningState = "fine_tuned" } = {}) {
  const calls = [];
  return {
    calls,
    async createInstantVoice(args) { calls.push(["createInstantVoice", args]); return { voiceId: "ivc-1", requiresVerification }; },
    async deleteVoice(id) { calls.push(["deleteVoice", id]); return { ok: true }; },
    async startProfessionalClone(args) { calls.push(["startProfessionalClone", args]); return { voiceId: "pvc-1" }; },
    async addProfessionalSamples(id, files) { calls.push(["addProfessionalSamples", id, files]); return { sampleIds: ["s1"] }; },
    async trainProfessionalClone(id) { calls.push(["trainProfessionalClone", id]); return { status: "ok" }; },
    async getVoice(id) { calls.push(["getVoice", id]); return { voiceId: id, fineTuning: { state: { eleven_multilingual_v2: fineTuningState } } }; },
  };
}

test("normalizeSample acepta PCM y WAV y calcula duración", () => {
  const fromPcm = normalizeSample({ pcm: makePcm(1000), sampleRate: 16_000 }, 0);
  assert.equal(Math.round(fromPcm.durationMs), 1000);
  assert.equal(fromPcm.name, "sample-1.wav");
  assert.equal(readWavInfo(fromPcm.buffer).sampleRate, 16_000);

  const wav = pcmToWav(makePcm(2500, 44_100), { sampleRate: 44_100 });
  const fromWav = normalizeSample({ wav, name: "grab.wav" }, 1);
  assert.equal(Math.round(fromWav.durationMs), 2500);
  assert.equal(fromWav.sampleRate, 44_100);
  assert.equal(fromWav.name, "grab.wav");

  assert.throws(() => normalizeSample({}, 0), VoiceOnboardingError);
  assert.throws(() => normalizeSample({ pcm: makePcm(10), sampleRate: 0 }, 0), /sampleRate/);
});

test("validateSamples IVC: exige ≥60 s en total, ≥2 s por muestra y ≥16 kHz", () => {
  const short = validateSamples(samplesOf(20_000, { count: 2 }));
  assert.equal(short.ok, false);
  assert.match(short.issues.join(" "), /al menos 60 s/);

  const ok = validateSamples(samplesOf(35_000, { count: 2 }));
  assert.equal(ok.ok, true);
  assert.equal(Math.round(ok.totalMs), 70_000);
  assert.match(ok.recommendations.join(" "), /180 s/, "recomienda 3 min");
  assert.match(ok.recommendations.join(" "), /44100 Hz/, "recomienda 44.1 kHz");

  const tiny = validateSamples([...samplesOf(70_000), { pcm: makePcm(500), sampleRate: 16_000, name: "corto.wav" }]);
  assert.equal(tiny.ok, false);
  assert.match(tiny.issues.join(" "), /"corto.wav" dura 500 ms/);

  const lowRate = validateSamples([{ pcm: makePcm(70_000, 8000), sampleRate: 8000, name: "tel.wav" }]);
  assert.equal(lowRate.ok, false);
  assert.match(lowRate.issues.join(" "), /8000 Hz/);

  assert.equal(validateSamples([]).ok, false);
  assert.equal(validateSamples([{ nada: true }]).ok, false);
});

test("validateSamples PVC: exige ≥30 min y recomienda PVC cuando IVC tiene mucho audio", () => {
  const minutes25 = validateSamples(samplesOf(5 * 60_000, { count: 5 }), { mode: "pvc" });
  assert.equal(minutes25.ok, false);
  assert.match(minutes25.issues.join(" "), /al menos 30 min/);
  const minutes30 = validateSamples(samplesOf(10 * 60_000, { count: 3 }), { mode: "pvc" });
  assert.equal(minutes30.ok, true);

  // Con ≥30 min en modo IVC solo se recomienda PVC (no bloquea por duración,
  // pero sí por los 10 MB: 30 min a 16 kHz son ~57 MB).
  const asIvc = validateSamples(samplesOf(10 * 60_000, { count: 3 }), { mode: "ivc" });
  assert.match(asIvc.recommendations.join(" "), /Professional Voice Cloning/);
  assert.match(asIvc.issues.join(" "), /MB/);
});

test("cloneInstant valida, arma WAV, clona, persiste voiceId y borra la voz previa", async (t) => {
  const dir = await tmpDir(t);
  const profiles = new ProfileStore({ dir });
  await profiles.setVoice("ana", { voiceId: "old-voice", cloneType: "ivc" });
  const cloning = fakeCloning();
  const onboarding = new VoiceOnboarding({ cloning, profiles });

  const res = await onboarding.cloneInstant({ userId: "ana", name: "Ana", samples: samplesOf(40_000, { count: 2 }) });
  assert.equal(res.voiceId, "ivc-1");
  assert.equal(res.cloneType, "ivc");
  assert.equal(Math.round(res.totalMs), 80_000);

  const [name, args] = cloning.calls[0];
  assert.equal(name, "createInstantVoice");
  assert.equal(args.name, "Ana");
  assert.equal(args.files.length, 2);
  assert.equal(args.files[0].mimeType, "audio/wav");
  assert.equal(readWavInfo(args.files[0].buffer).sampleRate, 16_000);
  assert.deepEqual(args.labels, { app: "voxora-meet", user: "ana" });
  assert.deepEqual(cloning.calls[1], ["deleteVoice", "old-voice"]);

  const profile = await profiles.get("ana");
  assert.equal(profile.voiceId, "ivc-1");
  assert.equal(profile.voiceName, "Ana");
  assert.equal(profile.cloneType, "ivc");
  assert.equal(profile.cloneStatus, "ready");
});

test("cloneInstant rechaza muestras insuficientes sin llamar a ElevenLabs", async (t) => {
  const dir = await tmpDir(t);
  const cloning = fakeCloning();
  const onboarding = new VoiceOnboarding({ cloning, profiles: new ProfileStore({ dir }) });
  await assert.rejects(onboarding.cloneInstant({ userId: "ana", samples: samplesOf(10_000) }), (e) => {
    assert.ok(e instanceof VoiceOnboardingError);
    assert.ok(e.issues.length >= 1);
    return true;
  });
  assert.equal(cloning.calls.length, 0);
  assert.equal(onboarding.validate(samplesOf(10_000)).ok, false);
});

test("cloneInstant con verificación pendiente y sin borrar la anterior", async (t) => {
  const dir = await tmpDir(t);
  const profiles = new ProfileStore({ dir });
  await profiles.setVoice("ana", { voiceId: "old-voice" });
  const cloning = fakeCloning({ requiresVerification: true });
  const onboarding = new VoiceOnboarding({ cloning, profiles });
  const res = await onboarding.cloneInstant({ userId: "ana", samples: samplesOf(70_000), replacePrevious: false });
  assert.equal(res.requiresVerification, true);
  assert.equal((await profiles.get("ana")).cloneStatus, "verification_required");
  assert.ok(!cloning.calls.some(([n]) => n === "deleteVoice"));
});

test("startProfessional sube muestras, entrena y deja la PVC pendiente hasta activarla", async (t) => {
  const dir = await tmpDir(t);
  const profiles = new ProfileStore({ dir });
  await profiles.setVoice("ana", { voiceId: "ivc-old", cloneType: "ivc" });
  const cloning = fakeCloning();
  const onboarding = new VoiceOnboarding({ cloning, profiles });

  await assert.rejects(onboarding.startProfessional({ userId: "ana", samples: samplesOf(60_000) }), /al menos 30 min/);

  const res = await onboarding.startProfessional({ userId: "ana", name: "Ana PVC", samples: samplesOf(60_000), strict: false });
  assert.equal(res.voiceId, "pvc-1");
  assert.equal(res.status, "training");
  assert.ok(res.issues.some((i) => /30 min/.test(i)), "en modo no estricto la falta de audio se informa");
  assert.deepEqual(cloning.calls.map(([n]) => n), ["startProfessionalClone", "addProfessionalSamples", "trainProfessionalClone"]);

  let profile = await profiles.get("ana");
  assert.equal(profile.voiceId, "ivc-old", "la voz activa sigue siendo la IVC");
  assert.equal(profile.pendingVoiceId, "pvc-1");
  assert.equal(profile.pendingCloneStatus, "training");

  const activated = await onboarding.activatePending("ana");
  assert.deepEqual(activated, { activated: true, voiceId: "pvc-1" });
  profile = await profiles.get("ana");
  assert.equal(profile.voiceId, "pvc-1");
  assert.equal(profile.cloneType, "pvc");
  assert.equal(profile.pendingVoiceId, null);

  const removed = await onboarding.removeVoice("ana");
  assert.deepEqual(removed, { removed: true, voiceId: "pvc-1" });
  assert.equal((await profiles.get("ana")).voiceId, null);
  assert.deepEqual(await onboarding.removeVoice("ana"), { removed: false });
});

test("activatePending no activa mientras ElevenLabs siga entrenando", async (t) => {
  const dir = await tmpDir(t);
  const profiles = new ProfileStore({ dir });
  await profiles.update("ana", { pendingVoiceId: "pvc-1", pendingVoiceName: "x" });
  const onboarding = new VoiceOnboarding({ cloning: fakeCloning({ fineTuningState: "is_fine_tuning" }), profiles });
  const res = await onboarding.activatePending("ana");
  assert.equal(res.activated, false);
  assert.equal((await profiles.get("ana")).voiceId, null);
  await assert.rejects(onboarding.activatePending("beto"), /No hay voz pendiente/);
});
