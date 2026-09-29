// Estado de la UI + persistencia de ajustes en el motor.
//
// Los ajustes se guardan al cambiar (settings.set con debounce), no solo al
// iniciar la sesión. El retraso usa delay.set (lo aplica en caliente al audio y
// el shell al video en la misma acción).

import { engine } from './bridge.js';
import { debounce, toastError } from './dom.js';

export const state = {
  app: {},
  engine: { state: 'starting', message: '' },
  settings: null,               // settings.get del motor (normalizados)
  keys: { groq: false, elevenlabs: false },
  devices: { received: false, cameras: [], mics: [], renderEndpoints: [], virtualMic: null, virtualCamera: null },
  session: { state: 'idle', startedAt: 0 },
  // Cámara virtual (evento nativo `camera`, también fuera de la sesión si cameraAlwaysOn).
  //   state: off | starting | live | lost | error ('standby' se tolera como «lista»; el shell actual
  //   no lo emite) · mode: off | live | dubbing
  //   delayMs: retraso aplicado ahora al video · alwaysOn: el ajuste según el shell (null = aún no lo dijo)
  //   hostRunning: Meet lista «VOXORA Meet Camera» · stats: último camera.stats (cada 1 s)
  camera: { state: 'off', name: '', message: '', mode: 'off', delayMs: 0, alwaysOn: null, hostRunning: false, stats: null },
  stats: null,
  vox: { total: 0, remaining: null, limitReached: false, warned: false },
  voices: { list: [], currentVoiceId: null, loading: false, loaded: false, error: null },
  lastSaved: { keys: [], at: 0 },  // último settings.set confirmado por el motor
  activeTab: 'meeting',
  uiMode: 'simple',                // 'simple' | 'advanced' (ajuste `uiMode`; mode.js)
};

const subscribers = new Map();

/** Suscribe a un tema ('settings' | 'saved' | 'devices' | 'session' | 'camera' | 'camera.stats' | 'engine' | 'voices' | 'stats' | 'vox' | 'keys' | 'tab' | 'mode' | 'models'). */
export function subscribe(topic, fn) {
  if (!subscribers.has(topic)) subscribers.set(topic, new Set());
  subscribers.get(topic).add(fn);
  return () => subscribers.get(topic).delete(fn);
}

export function notify(topic) {
  for (const fn of subscribers.get(topic) ?? []) {
    try { fn(state); } catch (error) { console.error(error); }
  }
}

// ── Ajustes ─────────────────────────────────────────────────────────────────
let pendingPatch = {};
let inflight = null;

// Campos que el motor solo toma al iniciar la sesión. El resto se aplica en caliente: el retraso
// al instante y los modelos (protocolo v3: modelo, temperatura, esfuerzo, memoria, ajustes de voz)
// desde el siguiente turno.
const RESTART_FIELDS = new Set(['sourceLanguage', 'targetLanguage', 'tone', 'styleInstruction', 'micDeviceId', 'virtualMicDevice', 'monitorDevice', 'maxVoxPerSession', 'warnAtVox']);
export const needsRestart = { value: false, fields: new Set() };

async function sendPatch() {
  if (!Object.keys(pendingPatch).length) return;
  const patch = pendingPatch;
  pendingPatch = {};
  try {
    const result = await engine('settings.set', { settings: patch });
    if (result?.settings) {
      // Lo que el usuario siguió editando mientras tanto manda sobre la respuesta.
      state.settings = { ...result.settings, ...pendingPatch };
    }
    if (result?.providerKeys) {
      state.keys = { ...state.keys, ...result.providerKeys };
      notify('keys');
    }
    notify('settings');
    state.lastSaved = { keys: Object.keys(patch), at: Date.now() };
    notify('saved');
  } catch (error) {
    // Reintento en el próximo cambio; el usuario ve por qué no se guardó.
    pendingPatch = { ...patch, ...pendingPatch };
    toastError(error, 'No se pudieron guardar los ajustes');
  }
}

const schedule = debounce(() => { inflight = sendPatch().finally(() => { inflight = null; }); }, 450);

/** Aplica localmente y persiste con debounce. */
export function patchSettings(patch) {
  if (!state.settings) state.settings = {};
  Object.assign(state.settings, patch);
  Object.assign(pendingPatch, patch);
  const restartKeys = Object.keys(patch).filter((k) => RESTART_FIELDS.has(k));
  if (state.session.state === 'running' && restartKeys.length) {
    needsRestart.value = true;
    restartKeys.forEach((k) => needsRestart.fields.add(k));
    notify('session');
  }
  notify('settings');
  schedule();
}

/** Fuerza el guardado pendiente (antes de iniciar la sesión). */
export async function flushSettings() {
  schedule.cancel();
  if (inflight) await inflight;
  await sendPatch();
}

// ── Retraso de sincronía ────────────────────────────────────────────────────
const sendDelay = debounce(async (delayMs) => {
  try {
    const result = await engine('delay.set', { delayMs });
    if (state.settings && Number.isFinite(result?.delayMs)) state.settings.delayMs = result.delayMs;
    notify('settings');
  } catch (error) {
    toastError(error, 'No se pudo cambiar el retraso');
  }
}, 160);

export function setDelay(delayMs) {
  if (!state.settings) state.settings = {};
  state.settings.delayMs = delayMs;
  sendDelay(delayMs);
}

// ── Cámara virtual ──────────────────────────────────────────────────────────
/** «Cámara virtual siempre activa» tal como la aplica el shell. Un shell que no lo informa
 *  (contrato anterior) solo crea la cámara virtual durante la sesión. */
export function cameraAlwaysOn() {
  return typeof state.camera.alwaysOn === 'boolean' ? state.camera.alwaysOn : false;
}

/** La cámara virtual existe ahora (Meet lista «VOXORA Meet Camera»): la webcam física es del shell. */
export function virtualCameraUp() {
  return Boolean(state.camera.hostRunning) || state.camera.state !== 'off';
}

/** Retraso que se aplica ahora al video de la cámara virtual (0 = en vivo, sin retraso). */
export function cameraDelayMs() {
  const cam = state.camera;
  if (cam.mode !== 'dubbing') return 0;
  const d = Number(cam.delayMs);
  return Number.isFinite(d) && d > 0 ? d : (state.settings?.delayMs ?? 3000);
}

// ── Carga inicial ───────────────────────────────────────────────────────────
export async function loadSettings() {
  const result = await engine('settings.get');
  state.settings = { ...result.settings, ...pendingPatch };
  state.keys = { groq: false, elevenlabs: false, ...(result.providerKeys || {}) };
  state.app.dataDir = result.dataDir || state.app.dataDir;
  notify('settings');
  notify('keys');
  return state.settings;
}
