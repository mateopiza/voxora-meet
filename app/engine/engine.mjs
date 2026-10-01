#!/usr/bin/env node
// Motor VOXORA Meet: proceso headless que el shell nativo (VoxoraMeet.exe)
// lanza con pipes stdio y controla por JSON-lines (ver protocol.mjs).
//
//   node engine/engine.mjs [--data-dir <dir>]
//
// Comandos: ping, session.start, session.stop, settings.get, settings.set,
//           devices.list, voice.clone, delay.set, stats.get,
//           voices.list, voice.set (v2),
//           models.list, tts.preview, cost.estimate, glossary.get/set,
//           vocabulary.get/set (v3)
// Eventos:  status, level, transcript, translation, dub, stats, cost, warn,
//           limit, error, ready
//
// Los módulos hermanos (capture, pipeline, billing, windows-driver) se cargan
// de forma perezosa y tolerante: si alguno falta, el motor arranca igual y lo
// reporta en `devices.list` / al iniciar sesión, para que la UI lo muestre.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createFileLogger, defaultLogsDir } from './logger.mjs';
import { JsonLinesServer, ProtocolError } from './protocol.mjs';
import { SessionController } from './session-controller.mjs';
import { createSettingsStore, normalizeSettings, PROVIDER_KEY_NAMES, MODEL_SETTING_KEYS } from './settings-store.mjs';
import { SyncBuffer } from '../../sync-buffer/src/sync-buffer.mjs';
import { describeOutput, resolveOutputDevice, validateAudioRoutes } from './output-device.mjs';
import { friendlyError } from './errors.mjs';
import { ModelCatalog } from './models.mjs';

// Voces: primero las del usuario, luego las de la biblioteca.
const CATEGORY_ORDER = { cloned: 0, professional: 1, generated: 2, premade: 3 };
const AUDIO_MIME = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
};
const MAX_SAMPLE_BYTES = 10 * 1024 * 1024; // límite por archivo de ElevenLabs IVC
const MIN_CLONE_MS = 60_000;
const USER_ID = 'default';

// `tts.preview`: frase corta fija en el idioma destino (se sintetiza tal cual, sin traducir).
const PREVIEW_TEXTS = {
  en: 'Hello everyone, this is how my voice will sound in the meeting.',
  es: 'Hola a todos, así sonará mi voz en la reunión.',
  pt: 'Olá a todos, é assim que a minha voz vai soar na reunião.',
  fr: 'Bonjour à tous, voici comment ma voix sonnera pendant la réunion.',
  de: 'Hallo zusammen, so wird meine Stimme in der Besprechung klingen.',
  it: 'Ciao a tutti, ecco come suonerà la mia voce nella riunione.',
  nl: 'Hallo allemaal, zo klinkt mijn stem tijdens de vergadering.',
  pl: 'Cześć wszystkim, tak będzie brzmiał mój głos na spotkaniu.',
};
const PREVIEW_MAX_CHARS = 300;
const GLOSSARY_MAX_ENTRIES = 500;
const VOCABULARY_MAX_TERMS = 200;

/** Frase de prueba para el idioma destino (inglés si no hay traducción en la tabla). */
export function previewTextFor(language) {
  const key = String(language ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return PREVIEW_TEXTS[key] ?? PREVIEW_TEXTS.en;
}

function clampNumber(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Entrada de glosario del store → forma del protocolo (`translation`/`note` solo si hay). */
function glossaryEntryOut(entry) {
  const out = { term: entry.term };
  if (entry.translation) out.translation = entry.translation;
  if (entry.note) out.note = entry.note;
  return out;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

// Especificadores literales: en desarrollo se cargan perezosamente desde el árbol del repo y
// scripts/release.mjs (esbuild) los incluye en el engine.mjs empaquetado de un solo archivo.
const SIBLINGS = {
  capture: () => import('../../capture/src/mic-capture.mjs'),
  pipeline: () => import('../../pipeline/src/dubbing-pipeline.mjs'),
  pipelineIndex: () => import('../../pipeline/src/index.mjs'),
  billing: () => import('../../billing/src/index.mjs'),
  virtualMic: () => import('../../windows-driver/src/virtual-mic.mjs'),
};

/**
 * Ruta del host de la cámara virtual: junto a VoxoraMeet.exe en la app instalada
 * (<instalación>\engine\engine.mjs → <instalación>\VoxoraMeetVCamHost.exe) o en el árbol de desarrollo.
 */
export function vcamHostPath() {
  const candidates = [
    process.env.VOXORA_MEET_BIN_DIR && path.join(process.env.VOXORA_MEET_BIN_DIR, 'VoxoraMeetVCamHost.exe'),
    path.join(ROOT, 'windows-camera', 'native', 'bin', 'VoxoraMeetVCamHost.exe'),
    path.resolve(HERE, '..', 'VoxoraMeetVCamHost.exe'),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? candidates[candidates.length - 2];
}

const moduleCache = new Map();

/** Importa un módulo hermano; devuelve `{ module, error }` sin lanzar. */
async function loadSibling(name) {
  if (moduleCache.has(name)) return moduleCache.get(name);
  let entry;
  try {
    entry = { module: await SIBLINGS[name](), error: null };
  } catch (error) {
    entry = { module: null, error: `${name}: ${error?.code === 'ERR_MODULE_NOT_FOUND' ? 'módulo no encontrado' : error.message}` };
  }
  moduleCache.set(name, entry);
  return entry;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data-dir' && argv[i + 1]) out.dataDir = argv[++i];
    else if (argv[i] === '--log-dir' && argv[i + 1]) out.logDir = argv[++i];
  }
  return out;
}

// Eventos que también quedan en engine.log (el resto —niveles, transcripciones— no: son de alta
// frecuencia o contienen lo que dice el usuario).
const LOGGED_EVENTS = new Set(['error', 'warn', 'limit', 'status', 'log', 'ready']);

function describeForLog(event, data) {
  if (event === 'status') return `sesión ${data?.state ?? '?'}${data?.reason ? ` (${data.reason})` : ''}`;
  if (event === 'log') return `[${data?.scope ?? 'log'}] ${data?.line ?? JSON.stringify(data)}`;
  const text = data?.message ?? JSON.stringify(data ?? null);
  return `${event}${data?.scope ? ` [${data.scope}]` : ''}${data?.code ? ` ${data.code}` : ''}: ${text}`;
}

export async function createEngine({ input = process.stdin, output = process.stdout, dataDir, crypto, fetch: fetchImpl } = {}) {
  const store = createSettingsStore({ ...(dataDir ? { dir: dataDir } : {}), ...(crypto ? { crypto } : {}) });
  const models = new ModelCatalog({ getKeys: () => store.getProviderKeys(), fetch: fetchImpl });

  // Glosario/vocabulario/perfiles compartidos entre los comandos y el pipeline:
  // una sola instancia por archivo, así `glossary.set` se ve en el siguiente turno.
  let sharedStores = null;
  async function pipelineStores() {
    const { module: index, error } = await loadSibling('pipelineIndex');
    if (!index) throw new ProtocolError('module_missing', error);
    if (!sharedStores) {
      sharedStores = {
        vocabulary: new index.VocabularyStore({ dir: store.dir, maxTerms: VOCABULARY_MAX_TERMS }),
        glossary: new index.GlossaryStore({ dir: store.dir }),
        profiles: new index.ProfileStore({ dir: store.dir }),
      };
    }
    return { index, ...sharedStores };
  }

  const controller = new SessionController({
    settingsStore: store,
    createMicCapture: ({ deviceId, source }) => {
      const { module, error } = moduleCache.get('capture') ?? {};
      if (!module) throw new ProtocolError('module_missing', error ?? 'capture no cargado');
      return new module.MicCapture({ deviceId, source });
    },
    // Tee del original: se lanza el helper WASAPI del módulo capture una sola
    // vez y su stdout alimenta a MicCapture (como `source`) y al SyncBuffer.
    createAudioSource: async ({ deviceId }) => {
      const { module } = await loadSibling('capture');
      const helperPath = module?.DEFAULT_HELPER_PATH;
      if (!helperPath) return null;
      try {
        await fs.access(helperPath);
      } catch {
        return null; // sin helper: MicCapture reportará el error con detalle
      }
      // Preserve the original voice at delivery rate; downsample only the STT branch.
      const args = ['--rate', '48000'];
      if (deviceId) args.push('--device', deviceId);
      const child = spawn(helperPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      child.stderr.on('data', (line) => server.emitEvent('log', { scope: 'wasapi', line: String(line).trim() }));
      child.on('exit', (code) => server.emitEvent('log', { scope: 'wasapi', line: `helper terminó (${code})` }));
      const stream = child.stdout;
      stream.sampleRate = 48000;
      const destroy = stream.destroy.bind(stream);
      child.on('error', (error) => stream.destroy(error));
      stream.destroy = (error) => {
        try { child.kill(); } catch { /* ya cerrado */ }
        return destroy(error);
      };
      return stream;
    },
    createPipeline: async ({ settings: rawSettings, keys }) => {
      const { index: module, vocabulary, glossary, profiles } = await pipelineStores();
      if (!keys.groq) throw new ProtocolError('missing_key', 'falta la API key de Groq (STT + traducción)');
      if (!keys.elevenlabs) throw new ProtocolError('missing_key', 'falta la API key de ElevenLabs (TTS)');
      // Los overrides de session.start llegan sin normalizar: mismos rangos que settings.set.
      const settings = normalizeSettings(rawSettings);
      const userId = USER_ID;
      const { ttsCapabilities, ttsCostMultiplier } = models.capabilitiesFor(settings);
      const stt = new module.GroqWhisperStt({
        apiKey: keys.groq,
        model: settings.sttModel,
        temperature: settings.sttTemperature,
        language: settings.sourceLanguage,
        vocabulary,
        userId,
      });
      const translator = new module.ContextTranslator({
        apiKey: keys.groq,
        model: settings.translateModel,
        temperature: settings.translateTemperature,
        reasoningEffort: settings.translateReasoningEffort,
        memoryTurns: settings.memoryTurns,
        glossary,
        userId,
        sourceLanguage: settings.sourceLanguage,
        targetLanguage: settings.targetLanguage,
        tone: settings.tone,
        styleInstruction: settings.styleInstruction || '',
      });
      const tts = new module.ElevenLabsTts({
        apiKey: keys.elevenlabs,
        modelId: settings.ttsModel,
        voiceSettings: module.voiceSettingsFromFlat(settings),
        capabilities: ttsCapabilities,
        textNormalization: settings.ttsTextNormalization,
      });
      // El medidor VOX lo lleva el SessionController (evita cobrar dos veces).
      return new module.DubbingPipeline({
        stt,
        translator,
        tts,
        voiceId: settings.voiceId || null,
        profiles,
        userId,
        sourceLanguage: settings.sourceLanguage,
        targetLanguage: settings.targetLanguage,
        ttsCostMultiplier,
      });
    },
    createSyncBuffer: (opts) => new SyncBuffer(opts),
    createVirtualMic: (opts) => {
      const { module, error } = moduleCache.get('virtualMic') ?? {};
      if (!module) throw new ProtocolError('module_missing', error ?? 'windows-driver no cargado');
      return new module.VirtualMic(opts);
    },
    resolveOutputDevice: async (settings) => {
      const { module, error } = await loadSibling('virtualMic');
      if (!module) throw new ProtocolError('module_missing', error ?? 'windows-driver no cargado');
      return resolveOutputDevice(() => module.listRenderEndpoints(), settings.virtualMicDevice);
    },
    validateAudioRoutes: async (settings, output) => {
      const [{ module: capture }, { module: render }] = await Promise.all([loadSibling('capture'), loadSibling('virtualMic')]);
      const [captures, renders] = await Promise.all([capture.MicCapture.listDevices(), render.listRenderEndpoints()]);
      return validateAudioRoutes({ settings, output, captures, renders });
    },
    createMeter: (opts) => {
      const { module } = moduleCache.get('billing') ?? {};
      if (module?.SessionMeter) return new module.SessionMeter(opts);
      // Sin billing: contador mínimo compatible.
      let totalVox = 0;
      return {
        add(cost) { totalVox += Number(cost?.totalVox) || 0; return { totalVox }; },
        get totalVox() { return totalVox; },
        get remainingVox() { return Infinity; },
        get limitReached() { return false; },
      };
    },
  });

  const handlers = {
    ping: () => ({ pong: true, pid: process.pid, node: process.version }),

    'settings.get': async () => ({
      settings: await store.load(),
      providerKeys: await store.providerKeyStatus(),
      dataDir: store.dir,
    }),

    // Acepta ajustes y, opcionalmente, `providerKeys` en claro (vienen del
    // shell por el pipe local): se cifran con DPAPI y nunca se devuelven.
    'settings.set': async (params) => {
      const patch = params?.settings ?? params ?? {};
      const settings = await store.save(patch);
      if (params?.providerKeys && typeof params.providerKeys === 'object') {
        const clean = {};
        for (const name of PROVIDER_KEY_NAMES) if (name in params.providerKeys) clean[name] = params.providerKeys[name];
        await store.setProviderKeys(clean);
      }
      // Modelos/parámetros en caliente: rigen desde el siguiente turno de la sesión en curso.
      controller.applyLiveSettings({ ...settings, ...models.capabilitiesFor(settings) });
      return { settings, providerKeys: await store.providerKeyStatus() };
    },

    // ── Protocolo v3 ──────────────────────────────────────────────────────

    // { refresh? } → catálogo en vivo (caché 10 min por key) o de respaldo (`offline: true`).
    'models.list': async (params) => models.list({ refresh: Boolean(params?.refresh), settings: await store.load() }),

    // { minutes?: 60, speakingRatio?: 0.5, overrides?: {…ajustes de modelo} } → tarifas por hora.
    // Los overrides solo afectan al cálculo: no se guardan.
    'cost.estimate': async (params) => {
      const { module: billing, error } = await loadSibling('billing');
      if (!billing?.estimateCostRates) throw new ProtocolError('module_missing', error ?? 'billing no cargado');
      const stored = await store.load();
      const overrides = params?.overrides && typeof params.overrides === 'object' ? params.overrides : {};
      const picked = {};
      for (const key of MODEL_SETTING_KEYS) if (overrides[key] !== undefined) picked[key] = overrides[key];
      const s = normalizeSettings({ ...stored, ...picked });
      return billing.estimateCostRates({
        minutes: clampNumber(params?.minutes, 60, 1, 24 * 60),
        speakingRatio: clampNumber(params?.speakingRatio, 0.5, 0, 1),
        sttModel: s.sttModel,
        translateModel: s.translateModel,
        ttsModel: s.ttsModel,
        ttsCostMultiplier: models.ttsInfo(s.ttsModel).costMultiplier,
        translateReasoningEffort: s.translateReasoningEffort,
        memoryTurns: s.memoryTurns,
      });
    },

    // { text?, voiceId? } → WAV (data URL) sintetizado con los ajustes TTS actuales. Gasta caracteres.
    'tts.preview': async (params) => {
      const keys = await store.getProviderKeys();
      if (!keys.elevenlabs) throw new ProtocolError('missing_key', 'Falta la API key de ElevenLabs (Ajustes).');
      const settings = await store.load();
      const voiceId = String(params?.voiceId || settings.voiceId || '').trim();
      if (!voiceId) throw new ProtocolError('voice_missing', 'Todavía no hay una voz seleccionada. Elígela o clónala en la pestaña Voz.');
      if (!/^[A-Za-z0-9]{8,64}$/.test(voiceId)) {
        throw new ProtocolError('bad_request', 'El Voice ID no tiene un formato válido (letras y números, como aparece en ElevenLabs).');
      }
      const custom = typeof params?.text === 'string' ? params.text.trim().replace(/\s+/g, ' ') : '';
      if (custom.length > PREVIEW_MAX_CHARS) {
        throw new ProtocolError('bad_request', `El texto de prueba admite hasta ${PREVIEW_MAX_CHARS} caracteres.`);
      }
      const text = custom || previewTextFor(settings.targetLanguage);
      const { module: index, error } = await loadSibling('pipelineIndex');
      if (!index) throw new ProtocolError('module_missing', error);
      const { ttsCapabilities } = models.capabilitiesFor(settings);
      const tts = new index.ElevenLabsTts({
        apiKey: keys.elevenlabs,
        modelId: settings.ttsModel,
        voiceSettings: index.voiceSettingsFromFlat(settings),
        capabilities: ttsCapabilities,
        textNormalization: settings.ttsTextNormalization,
        retries: 1,
        fetch: fetchImpl,
      });
      const synth = await tts.synthesize({ text, voiceId, languageCode: settings.targetLanguage, allowMp3Fallback: true });
      const isPcm = synth.audioFormat === 'pcm_s16le';
      const bytes = isPcm ? index.pcmToWav(synth.audio, { sampleRate: synth.sampleRate, channels: 1, bitsPerSample: 16 }) : synth.audio;
      return {
        audioDataUrl: `data:${isPcm ? 'audio/wav' : 'audio/mpeg'};base64,${Buffer.from(bytes).toString('base64')}`,
        chars: synth.chars,
        sampleRate: synth.sampleRate,
        model: synth.modelId,
        voiceId,
        text,
        format: isPcm ? 'wav' : 'mp3',
      };
    },

    'glossary.get': async () => {
      const { glossary } = await pipelineStores();
      return { entries: (await glossary.get(USER_ID)).map(glossaryEntryOut) };
    },

    // { entries: [{ term, translation?, note? }] } → reemplaza el glosario (filas sin término se ignoran).
    'glossary.set': async (params) => {
      if (!Array.isArray(params?.entries)) throw new ProtocolError('bad_request', 'Se esperaba { entries: [{ term, translation?, note? }] }.');
      if (params.entries.length > GLOSSARY_MAX_ENTRIES) {
        throw new ProtocolError('bad_request', `El glosario admite hasta ${GLOSSARY_MAX_ENTRIES} términos.`);
      }
      const entries = [];
      for (const raw of params.entries) {
        const entry = typeof raw === 'string' ? { term: raw } : raw ?? {};
        const term = String(entry.term ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
        if (!term) continue;
        const translation = entry.translation == null ? '' : String(entry.translation).trim().slice(0, 200);
        const note = entry.note == null ? '' : String(entry.note).trim().slice(0, 200);
        entries.push({ term, translation: translation || null, ...(note ? { note } : {}) });
      }
      const { glossary } = await pipelineStores();
      const saved = await glossary.set(USER_ID, entries);
      return { entries: saved.map(glossaryEntryOut) };
    },

    'vocabulary.get': async () => {
      const { vocabulary } = await pipelineStores();
      return { terms: await vocabulary.get(USER_ID) };
    },

    // { terms: [] } → reemplaza el vocabulario del STT (nombres propios, jerga).
    'vocabulary.set': async (params) => {
      if (!Array.isArray(params?.terms)) throw new ProtocolError('bad_request', 'Se esperaba { terms: ["…"] }.');
      const terms = params.terms
        .filter((t) => typeof t === 'string' || typeof t === 'number')
        .map((t) => String(t).trim().replace(/\s+/g, ' ').slice(0, 80))
        .filter(Boolean);
      const { vocabulary } = await pipelineStores();
      return { terms: await vocabulary.set(USER_ID, terms) };
    },

    'devices.list': async () => {
      const [capture, virtualMic, pipeline, billing] = await Promise.all(
        ['capture', 'virtualMic', 'pipeline', 'billing'].map(loadSibling),
      );
      const settings = await store.load();
      const [mics, renderEndpoints] = await Promise.all([
        typeof capture.module?.MicCapture?.listDevices === 'function'
          ? capture.module.MicCapture.listDevices().catch(() => [])
          : [],
        typeof virtualMic.module?.listRenderEndpoints === 'function'
          ? virtualMic.module.listRenderEndpoints().catch(() => [])
          : [],
      ]);
      const output = describeOutput(renderEndpoints, settings.virtualMicDevice);
      await controller.revalidateRoutes(mics, renderEndpoints);
      const vcamHost = vcamHostPath();
      let virtualCameraInstalled = false;
      try { await fs.access(vcamHost); virtualCameraInstalled = true; } catch { /* no compilado */ }
      return {
        renderEndpoints,
        virtualMic: {
          installed: Boolean(output.endpoint),
          device: settings.virtualMicDevice,
          resolvedDevice: output.endpoint?.name ?? null,
          captureName: output.captureName,
          fallback: output.fallback,
          candidates: output.candidates,
          error: virtualMic.error,
        },
        virtualCamera: { installed: virtualCameraInstalled, hostPath: vcamHost },
        capture: { available: Boolean(capture.module), error: capture.error, mics },
        pipeline: { available: Boolean(pipeline.module), error: pipeline.error },
        billing: { available: Boolean(billing.module), error: billing.error },
      };
    },

    'session.start': async (params) => {
      await Promise.all(['capture', 'virtualMic', 'billing'].map(loadSibling));
      const overrides = params?.settings && typeof params.settings === 'object' ? params.settings : {};
      return controller.start(overrides);
    },

    'session.stop': () => controller.stop(),

    'delay.set': async (params) => {
      const applied = controller.setDelay(params?.delayMs);
      await store.save({ delayMs: applied });
      return { delayMs: applied };
    },

    'stats.get': () => controller.stats(),

    // Voces de la cuenta de ElevenLabs; las del usuario (clonadas) primero.
    'voices.list': async () => {
      const cloning = await voiceCloning();
      const settings = await store.load();
      const voices = (await cloning.listVoices())
        .map((v) => ({
          voiceId: v.voiceId,
          name: v.name,
          category: v.category ?? 'premade',
          previewUrl: v.previewUrl,
          isCurrent: v.voiceId === settings.voiceId,
        }))
        .sort((a, b) => (CATEGORY_ORDER[a.category] ?? 9) - (CATEGORY_ORDER[b.category] ?? 9)
          || String(a.name).localeCompare(String(b.name), 'es'));
      return { voices, currentVoiceId: settings.voiceId || null };
    },

    // { voiceId, name? } → valida que exista en la cuenta y la deja como actual.
    'voice.set': async (params) => {
      const voiceId = String(params?.voiceId ?? '').trim();
      if (!/^[A-Za-z0-9]{8,64}$/.test(voiceId)) {
        throw new ProtocolError('bad_request', 'El Voice ID no tiene un formato válido (letras y números, como aparece en ElevenLabs).');
      }
      const cloning = await voiceCloning();
      let voice;
      try {
        voice = await cloning.getVoice(voiceId);
      } catch (error) {
        const friendly = friendlyError(error);
        if (friendly.code === 'voice_missing' || /\b(400|404)\b/.test(String(error?.message))) {
          throw new ProtocolError('voice_missing', 'Ese Voice ID no existe en tu cuenta de ElevenLabs.');
        }
        throw error;
      }
      const name = String(params?.name || voice?.name || '').slice(0, 80);
      const settings = await store.save({ voiceId, voiceName: name });
      controller.applyLiveSettings({ voiceId });
      return { voiceId: settings.voiceId, name: settings.voiceName };
    },

    // { name, description?, wavPaths?: [], filePaths?: [] } → clona (IVC) y deja la voz como actual.
    'voice.clone': async (params) => {
      const wavPaths = Array.isArray(params?.wavPaths) ? params.wavPaths : params?.wavPath ? [params.wavPath] : [];
      const filePaths = Array.isArray(params?.filePaths) ? params.filePaths : [];
      const all = [...wavPaths, ...filePaths].map(String);
      if (!all.length) throw new ProtocolError('bad_request', 'Graba o elige al menos un audio para clonar tu voz.');
      const keys = await store.getProviderKeys();
      if (!keys.elevenlabs) throw new ProtocolError('missing_key', 'Falta la API key de ElevenLabs (Ajustes).');
      const { module: index, error } = await loadSibling('pipelineIndex');
      if (!index) throw new ProtocolError('module_missing', error);

      // WAV: se mide la duración; otros formatos los valida ElevenLabs.
      const files = [];
      let measuredMs = 0;
      let unmeasured = 0;
      for (const [i, filePath] of all.entries()) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeType = AUDIO_MIME[ext];
        if (!mimeType) throw new ProtocolError('bad_request', `Formato no admitido: ${path.basename(filePath)} (usa WAV, MP3, M4A, OGG o FLAC).`);
        const buffer = await fs.readFile(filePath);
        if (buffer.byteLength > MAX_SAMPLE_BYTES) {
          throw new ProtocolError('bad_request', `${path.basename(filePath)} supera 10 MB; recórtalo o expórtalo en MP3.`);
        }
        if (ext === '.wav') {
          const info = index.readWavInfo(buffer);
          measuredMs += info.durationMs;
        } else {
          unmeasured += 1;
        }
        files.push({ buffer, name: `sample-${i + 1}${ext}`, mimeType });
      }
      if (!unmeasured && measuredMs < MIN_CLONE_MS) {
        throw new ProtocolError('samples_too_short',
          `Se necesitan al menos 60 s de voz; hay ${Math.round(measuredMs / 1000)} s. Graba otra toma y vuelve a enviar.`);
      }

      const settings = await store.load();
      const name = String(params?.name || settings.voiceName || 'Mi voz VOXORA Meet').slice(0, 80);
      const cloning = new index.VoiceCloning({ apiKey: keys.elevenlabs });
      const { voiceId } = await cloning.createInstantVoice({
        name,
        description: params?.description ? String(params.description) : 'Voz clonada para doblaje de reuniones (VOXORA Meet)',
        labels: { app: 'voxora-meet' },
        files,
      });
      if (!voiceId) throw new ProtocolError('clone_failed', 'ElevenLabs no devolvió el ID de la voz nueva.');
      await (await pipelineStores()).profiles.setVoice(USER_ID, { voiceId, voiceName: name });
      await store.save({ voiceId, voiceName: name });
      controller.applyLiveSettings({ voiceId });
      return { voiceId, name, totalMs: Math.round(measuredMs) };
    },
  };

  async function voiceCloning() {
    const keys = await store.getProviderKeys();
    if (!keys.elevenlabs) throw new ProtocolError('missing_key', 'Falta la API key de ElevenLabs (Ajustes).');
    const { module: index, error } = await loadSibling('pipelineIndex');
    if (!index) throw new ProtocolError('module_missing', error);
    return new index.VoiceCloning({ apiKey: keys.elevenlabs });
  }

  const server = new JsonLinesServer({ input, output, handlers });
  for (const event of ['status', 'level', 'transcript', 'translation', 'dub', 'stats', 'cost', 'warn', 'limit', 'error', 'presentation']) {
    controller.on(event, (data) => server.emitEvent(event, data));
  }
  server.on('close', async () => {
    // El shell cerró el pipe: apagar limpio.
    try { await controller.stop(); } catch { /* best-effort */ }
    process.exit(0);
  });

  return { server, controller, store, models, handlers, loadSibling };
}

async function main() {
  const { dataDir, logDir } = parseArgs(process.argv.slice(2));
  // %LOCALAPPDATA%\VOXORA Meet\logs\engine.log (rotado); el shell además guarda nuestro stderr en shell.log.
  const logger = createFileLogger({ dir: logDir ?? defaultLogsDir(), name: 'engine' });
  logger.info(`motor iniciando (node ${process.version}, pid ${process.pid}, ${process.platform}/${process.arch})`);
  const { server, controller } = await createEngine({ dataDir });
  const emit = server.emitEvent.bind(server);
  server.emitEvent = (event, data) => {
    if (LOGGED_EVENTS.has(event)) logger.write(event === 'error' ? 'ERROR' : event === 'warn' || event === 'limit' ? 'WARN' : 'INFO', describeForLog(event, data));
    return emit(event, data);
  };
  server.on('handlerError', ({ cmd, error }) => logger.warn(`comando ${cmd} falló: ${error?.code ? `${error.code} ` : ''}${error?.message ?? error}`));
  server.on('close', () => logger.info('el shell cerró la conexión; apagando'));
  server.start();
  server.emitEvent('ready', { pid: process.pid, node: process.version, protocol: 1 });

  const shutdown = async () => {
    try { await controller.stop(); } catch { /* best-effort */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (error) => {
    logger.error(`excepción no controlada: ${error?.stack ?? error}`);
    server.emitEvent('error', { scope: 'engine', message: String(error?.message ?? error) });
  });
  process.on('unhandledRejection', (error) => {
    logger.error(`promesa rechazada sin manejar: ${error?.stack ?? error}`);
    server.emitEvent('error', { scope: 'engine', message: String(error?.message ?? error) });
  });
  process.on('exit', (code) => logger.info(`motor terminado (código ${code})`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`engine: ${error?.stack ?? error}\n`);
    try { createFileLogger({ dir: defaultLogsDir(), name: 'engine' }).error(`no arrancó: ${error?.stack ?? error}`); } catch { /* sin registro */ }
    process.exit(1);
  });
}
