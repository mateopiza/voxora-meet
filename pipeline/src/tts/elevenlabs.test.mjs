import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ElevenLabsTts,
  VoiceCloning,
  TtsError,
  ELEVEN_PCM_FORMATS,
  DEFAULT_VOICE_SETTINGS,
  normalizeVoiceSettings,
  isUnavailablePcmFormat,
  PVC_REQUIREMENTS,
} from "./elevenlabs.mjs";
import { mockFetch, mockFetchSequence, jsonResponse, binaryResponse, textResponse, instantSleep, makePcm } from "../_test-helpers.mjs";

const apiKey = "xi_test_key";
const audio = makePcm(200, 48_000);

test("synthesize pide pcm_48000 primero con headers, model_id y voice_settings", async (t) => {
  const { calls } = mockFetch(t, () => binaryResponse(audio, { headers: { "request-id": "req-1", "x-character-count": "12" } }));
  const tts = new ElevenLabsTts({ apiKey, voiceSettings: { stability: 0.7 }, sleep: instantSleep });
  const res = await tts.synthesize({ text: "Hello there", voiceId: "voice-1", languageCode: "en" });

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, "https://api.elevenlabs.io/v1/text-to-speech/voice-1?output_format=pcm_48000");
  assert.equal(call.method, "POST");
  assert.equal(call.headers["xi-api-key"], apiKey);
  assert.equal(call.headers["Content-Type"], "application/json");
  assert.equal(call.headers.Accept, "audio/pcm");
  const body = JSON.parse(call.body);
  assert.equal(body.text, "Hello there");
  assert.equal(body.model_id, "eleven_multilingual_v2");
  assert.equal("language_code" in body, false, "multilingual_v2 no admite language_code");
  assert.equal("apply_text_normalization" in body, false, "auto es el default: no se manda");
  assert.deepEqual(body.voice_settings, { ...DEFAULT_VOICE_SETTINGS, stability: 0.7 });

  assert.ok(res.audio.equals(audio));
  assert.equal(res.audioFormat, "pcm_s16le");
  assert.equal(res.sampleRate, 48_000);
  assert.equal(res.outputFormat, "pcm_48000");
  assert.equal(res.chars, 11);
  assert.equal(res.requestId, "req-1");
  assert.equal(res.characterCost, 12);
});

test("cascada: 48000 y 44100 rechazados por plan → 24000", async (t) => {
  const { calls } = mockFetchSequence(t, [
    () => textResponse('{"detail":{"status":"output_format_not_allowed"}}', { status: 403 }),
    () => textResponse("This output format requires a subscription_required", { status: 400 }),
    () => binaryResponse(audio),
  ]);
  const tts = new ElevenLabsTts({ apiKey, sleep: instantSleep });
  const res = await tts.synthesize({ text: "hola", voiceId: "v" });
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((c) => new URL(c.url).searchParams.get("output_format")),
    ELEVEN_PCM_FORMATS.map((f) => f.outputFormat),
  );
  assert.equal(res.sampleRate, 24_000);
  assert.equal(res.outputFormat, "pcm_24000");
});

test("cascada: sin ningún PCM → fallback mp3_44100_128; con allowMp3Fallback=false lanza", async (t) => {
  const formatError = () => textResponse("output_format_not_allowed", { status: 403 });
  const { calls } = mockFetchSequence(t, [formatError, formatError, formatError, () => binaryResponse(Buffer.from("ID3mp3"), { contentType: "audio/mpeg" })]);
  const tts = new ElevenLabsTts({ apiKey, sleep: instantSleep });
  const res = await tts.synthesize({ text: "hola", voiceId: "v" });
  assert.equal(calls.length, 4);
  assert.equal(new URL(calls[3].url).searchParams.get("output_format"), "mp3_44100_128");
  assert.equal(calls[3].headers.Accept, "audio/mpeg");
  assert.equal(res.audioFormat, "mp3");
  assert.equal(res.sampleRate, null);

  mockFetchSequence(t, [formatError]);
  await assert.rejects(tts.synthesize({ text: "hola", voiceId: "v", allowMp3Fallback: false }), (e) => e instanceof TtsError && /ningún formato PCM/.test(e.message));
});

test("errores que no son de formato cortan la cascada (400 de negocio) o se reintentan (5xx)", async (t) => {
  const { calls } = mockFetch(t, () => textResponse('{"detail":"voice_not_found"}', { status: 400 }));
  const tts = new ElevenLabsTts({ apiKey, sleep: instantSleep });
  await assert.rejects(tts.synthesize({ text: "hola", voiceId: "nope" }), (e) => {
    assert.ok(e instanceof TtsError);
    assert.equal(e.status, 400);
    assert.equal(e.outputFormat, "pcm_48000");
    return true;
  });
  assert.equal(calls.length, 1, "no avanza a 44100 ante un 400 que no es de formato");

  const seq = mockFetchSequence(t, [() => textResponse("overloaded", { status: 503 }), () => binaryResponse(audio)]);
  const res = await tts.synthesize({ text: "hola", voiceId: "v" });
  assert.equal(seq.calls.length, 2);
  assert.equal(res.sampleRate, 48_000);
});

test("outputFormat explícito no usa cascada; PCM pedido pero mpeg recibido se marca mp3", async (t) => {
  const { calls } = mockFetch(t, () => binaryResponse(audio));
  const tts = new ElevenLabsTts({ apiKey, sleep: instantSleep });
  const res = await tts.synthesize({ text: "hola", voiceId: "v", outputFormat: "pcm_24000" });
  assert.equal(calls.length, 1);
  assert.equal(res.sampleRate, 24_000);

  mockFetch(t, () => textResponse("output_format_not_allowed", { status: 403 }));
  await assert.rejects(tts.synthesize({ text: "hola", voiceId: "v", outputFormat: "pcm_48000" }), (e) => e.status === 403);

  mockFetch(t, () => binaryResponse(Buffer.from("mp3"), { contentType: "audio/mpeg" }));
  const weird = await tts.synthesize({ text: "hola", voiceId: "v" });
  assert.equal(weird.audioFormat, "mp3");
});

test("validaciones: texto vacío, voiceId faltante, audio vacío y voice_settings normalizados", async (t) => {
  const tts = new ElevenLabsTts({ apiKey, sleep: instantSleep });
  await assert.rejects(tts.synthesize({ text: "  ", voiceId: "v" }), /texto vacío/);
  await assert.rejects(tts.synthesize({ text: "hola" }), /voiceId/);
  mockFetch(t, () => binaryResponse(Buffer.alloc(0)));
  await assert.rejects(tts.synthesize({ text: "hola", voiceId: "v" }), /audio vacío/);

  assert.deepEqual(normalizeVoiceSettings({ stability: 2, similarity_boost: -1, style: "x", use_speaker_boost: 0, speed: 3 }), {
    stability: 1,
    similarity_boost: 0,
    style: DEFAULT_VOICE_SETTINGS.style,
    use_speaker_boost: false,
    speed: 1.2,
  });
  assert.equal(normalizeVoiceSettings({ speed: 0.1 }).speed, 0.7);
  assert.equal(tts.setVoiceSettings({ style: 0.5 }).style, 0.5);
  assert.equal(isUnavailablePcmFormat(500, "output_format_not_allowed"), false);
  assert.throws(() => new ElevenLabsTts({ apiKey: "" }), /ELEVENLABS_API_KEY/);
});

test("VoiceCloning.createInstantVoice envía multipart a /v1/voices/add", async (t) => {
  const { calls } = mockFetch(t, () => jsonResponse({ voice_id: "cloned-1", requires_verification: false }));
  const cloning = new VoiceCloning({ apiKey, sleep: instantSleep });
  const files = [
    { buffer: Buffer.from("wav-1"), name: "a.wav", mimeType: "audio/wav" },
    { buffer: Buffer.from("wav-2"), name: "b.wav", mimeType: "audio/wav" },
  ];
  const res = await cloning.createInstantVoice({ name: "Ana", files, description: "desc", labels: { app: "meet" }, removeBackgroundNoise: true });
  assert.deepEqual(res, { voiceId: "cloned-1", requiresVerification: false });
  const [call] = calls;
  assert.equal(call.url, "https://api.elevenlabs.io/v1/voices/add");
  assert.equal(call.method, "POST");
  assert.equal(call.headers["xi-api-key"], apiKey);
  assert.ok(call.body instanceof FormData);
  assert.equal(call.body.get("name"), "Ana");
  assert.equal(call.body.get("description"), "desc");
  assert.deepEqual(JSON.parse(call.body.get("labels")), { app: "meet" });
  assert.equal(call.body.get("remove_background_noise"), "true");
  const uploaded = call.body.getAll("files");
  assert.equal(uploaded.length, 2);
  assert.equal(uploaded[0].name, "a.wav");
  assert.equal(uploaded[1].name, "b.wav");
  assert.equal(Buffer.from(await uploaded[1].arrayBuffer()).toString(), "wav-2");

  await assert.rejects(cloning.createInstantVoice({ name: "x", files: [] }), /al menos un archivo/);
  await assert.rejects(cloning.createInstantVoice({ files }), /name/);
});

test("VoiceCloning: listVoices, getVoice, deleteVoice y errores", async (t) => {
  const { calls } = mockFetch(t, (url, init) => {
    if (init.method === "DELETE") return jsonResponse({ status: "ok" });
    if (url.endsWith("/voices")) return jsonResponse({ voices: [{ voice_id: "a", name: "A", category: "cloned" }, { voice_id: "b", name: "B" }] });
    return jsonResponse({ voice_id: "a", name: "A", samples: [{ sample_id: "s1" }], fine_tuning: { state: { eleven_multilingual_v2: "fine_tuned" } } });
  });
  const cloning = new VoiceCloning({ apiKey, sleep: instantSleep });
  const list = await cloning.listVoices();
  assert.equal(calls[0].url, "https://api.elevenlabs.io/v1/voices");
  assert.equal(calls[0].method, "GET");
  assert.deepEqual(list.map((v) => v.voiceId), ["a", "b"]);
  assert.equal(list[0].category, "cloned");

  const voice = await cloning.getVoice("a");
  assert.equal(calls[1].url, "https://api.elevenlabs.io/v1/voices/a");
  assert.equal(voice.samples, 1);
  assert.deepEqual(voice.fineTuning.state, { eleven_multilingual_v2: "fine_tuned" });

  const del = await cloning.deleteVoice("a");
  assert.equal(calls[2].method, "DELETE");
  assert.equal(calls[2].url, "https://api.elevenlabs.io/v1/voices/a");
  assert.deepEqual(del, { ok: true });

  mockFetch(t, () => textResponse("not found", { status: 404 }));
  await assert.rejects(cloning.getVoice("zzz"), (e) => e instanceof TtsError && e.status === 404);
  await assert.rejects(cloning.getVoice(""), /voiceId/);
});

test("VoiceCloning: flujo PVC (crear, subir muestras, entrenar) y requisitos documentados", async (t) => {
  const { calls } = mockFetch(t, (url) => {
    if (url.endsWith("/voices/pvc")) return jsonResponse({ voice_id: "pvc-1" });
    if (url.endsWith("/samples")) return jsonResponse([{ sample_id: "s1" }, { sample_id: "s2" }]);
    if (url.endsWith("/train")) return jsonResponse({ status: "ok" });
    throw new Error(`URL inesperada ${url}`);
  });
  const cloning = new VoiceCloning({ apiKey, sleep: instantSleep });
  const started = await cloning.startProfessionalClone({ name: "Ana PVC", language: "es", description: "d", labels: { k: "v" } });
  assert.equal(started.voiceId, "pvc-1");
  assert.equal(started.requirements, PVC_REQUIREMENTS);
  assert.ok(PVC_REQUIREMENTS.minTotalMinutes === 30 && PVC_REQUIREMENTS.guidance.length >= 3);
  assert.equal(calls[0].url, "https://api.elevenlabs.io/v1/voices/pvc");
  assert.equal(calls[0].headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].body), { name: "Ana PVC", language: "es", description: "d", labels: { k: "v" } });

  const upload = await cloning.addProfessionalSamples("pvc-1", [{ buffer: Buffer.from("x"), name: "x.wav" }]);
  assert.equal(calls[1].url, "https://api.elevenlabs.io/v1/voices/pvc/pvc-1/samples");
  assert.ok(calls[1].body instanceof FormData);
  assert.deepEqual(upload.sampleIds, ["s1", "s2"]);

  const train = await cloning.trainProfessionalClone("pvc-1");
  assert.equal(calls[2].url, "https://api.elevenlabs.io/v1/voices/pvc/pvc-1/train");
  assert.deepEqual(JSON.parse(calls[2].body), { model_id: "eleven_multilingual_v2" });
  assert.equal(train.status, "ok");
});
