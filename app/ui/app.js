// VOXORA Meet — UI local (WebView2). Punto de entrada: arranca los módulos de
// cada pestaña y enruta los mensajes del shell nativo / motor.

import { initAccounts, openAccounts } from './js/accounts.js';
import { engine, isMock, native, on, ready } from './js/bridge.js';
import { initCameraFx } from './js/camera-fx.js';
import { openSheet, toast } from './js/dom.js';
import { initLive, onCost, onDub, onLevel, onTranscript, onTranslation, renderCamera } from './js/live.js';
import { initMeeting } from './js/meeting.js';
import { initMode, setMode } from './js/mode.js';
import { initModels } from './js/models.js';
import { goTab, initNav, reveal } from './js/nav.js';
import { initRecording } from './js/recording.js';
import { errorAction, setSessionState, toggleSession } from './js/session.js';
import { initSettings } from './js/settings.js';
import { initStatus } from './js/status.js';
import { loadSettings, notify, state } from './js/store.js';
import { initVoice, loadVoices, onRecordLevel, onRecordStopped } from './js/voice.js';
import './js/update.js'; // actualizaciones, carpeta de registros y avisos de reinicio del motor (autocontenido)

// ── Dispositivos (push del shell al arrancar, al conectar/desconectar y a petición) ──
function onDevices(msg) {
  const prev = state.devices;
  const next = {
    received: true,
    cameras: Array.isArray(msg.cameras) ? msg.cameras : [],
    mics: Array.isArray(msg.mics) ? msg.mics : [],
    renderEndpoints: Array.isArray(msg.renderEndpoints) ? msg.renderEndpoints : [],
    virtualMic: msg.virtualMic || null,
    virtualCamera: msg.virtualCamera || null,
  };
  // Avisos de conexión/desconexión (solo ante cambios reales de hardware).
  // Durante la sesión, la cámara y el micrófono en uso ya avisan con sus propios eventos; fuera de
  // ella, la webcam que está usando la cámara virtual también (evento `camera`: lost / live).
  if (prev.received && msg.reason === 'change') {
    const diff = (before, after, on, off, skip = () => false) => {
      const key = (d) => d.id || d.name;
      const ids = new Set(after.map(key));
      const old = new Set(before.map(key));
      for (const d of after) if (!old.has(key(d)) && !skip(d)) toast({ kind: 'info', title: on, message: d.name });
      for (const d of before) if (!ids.has(key(d)) && !skip(d)) toast({ kind: 'warn', title: off, message: d.name });
    };
    const live = state.session.state !== 'idle';
    const camInUse = CAMERA_ACTIVE.has(state.camera.state) && state.camera.name;
    // La propia «VOXORA Meet Camera» (si Windows la lista) aparece y desaparece con la cámara virtual.
    const skipCam = (d) => /voxora meet camera/i.test(d.name || '') || (Boolean(camInUse) && d.name === state.camera.name);
    if (!live) diff(prev.cameras, next.cameras, 'Cámara conectada', 'Cámara desconectada', skipCam);
    if (!live) diff(prev.mics, next.mics, 'Micrófono conectado', 'Micrófono desconectado');
    diff(prev.renderEndpoints, next.renderEndpoints, 'Salida de audio conectada', 'Salida de audio desconectada');
  }
  if (msg.reason === 'manual') toast({ kind: 'success', title: 'Dispositivos actualizados', message: `${next.cameras.length} cámara(s) · ${next.mics.length} micrófono(s) · ${next.renderEndpoints.length} salida(s)`, timeout: 3000 });
  state.devices = next;
  notify('devices');
}

// ── Eventos del motor ───────────────────────────────────────────────────────
let lastDriftToast = 0;

function onEngineEvent({ event, data = {}, engineNowMs }) {
  switch (event) {
    case 'level': onLevel(data); break;
    case 'transcript': onTranscript(data); break;
    case 'translation': onTranslation(data); break;
    case 'dub': onDub(data, engineNowMs); break;
    case 'cost': {
      onCost(data);
      if (Number.isFinite(data.totalVox)) { state.vox.total = data.totalVox; notify('vox'); }
      break;
    }
    case 'stats': {
      state.stats = data;
      state.vox.total = Number(data.totalVox) || state.vox.total;
      state.vox.remaining = data.remainingVox ?? null;
      state.vox.limitReached = Boolean(data.limitReached);
      notify('stats');
      notify('vox');
      break;
    }
    case 'status': {
      const st = data.state;
      if (st === 'running' && state.session.state !== 'running') setSessionState('running');
      if (st === 'idle' && state.session.state === 'running') {
        setSessionState('idle');
        if (data.reason && data.reason !== 'stopped') toast({ kind: 'warn', title: 'El doblaje se detuvo', message: 'La sesión terminó inesperadamente. Puedes volver a iniciarla.' });
      }
      break;
    }
    case 'warn': {
      if (data.kind === 'audio-delivery' || data.kind === 'latency-budget') {
        toast({ kind: 'warn', title: data.kind === 'latency-budget' ? 'Ajusta el retraso' : 'Entrega de voz', message: data.message });
      } else if (data.kind === 'output' || data.kind === 'monitor') {
        toast({ kind: 'info', title: data.kind === 'output' ? 'Salida del doblaje' : 'Escucha local', message: data.message });
      } else if (data.kind === 'vox') {
        state.vox.warned = true;
        notify('vox');
        if (!data.skipped) toast({ kind: 'warn', title: 'Créditos VOX', message: data.message || 'Te acercas al límite de VOX de esta sesión.' });
      } else if (data.kind === 'drift' && Date.now() - lastDriftToast > 60000) {
        lastDriftToast = Date.now();
        toast({ kind: 'warn', title: 'Sincronía inestable', message: data.message || 'El doblaje se está desfasando. Si pasa a menudo, sube el retraso de sincronía.' });
      }
      break;
    }
    case 'limit': {
      state.vox.limitReached = true;
      notify('vox');
      toast({ kind: 'warn', title: 'Límite de VOX alcanzado', message: 'La reunión sigue, pero las frases nuevas ya no se doblan. Puedes subir el tope en Avanzado › Ajustes.', action: { label: 'Límites', run: () => { setMode('advanced'); reveal('#inp-max-vox', 'settings'); } } });
      break;
    }
    case 'error': {
      toast({ kind: 'error', title: 'Algo falló en el doblaje', message: data.message, action: errorAction(data) });
      break;
    }
    default: break;
  }
}

// ── Cámara virtual (evento nativo `camera`, en sesión y fuera de ella) ──────
const CAMERA_STATES = new Set(['off', 'standby', 'starting', 'live', 'lost', 'error']);
const CAMERA_MODES = new Set(['off', 'live', 'dubbing']);
// Estados en los que el shell tiene (o intenta tener) la webcam abierta para la cámara virtual.
const CAMERA_ACTIVE = new Set(['starting', 'live', 'lost', 'error']);

/** Aplica un estado de cámara del shell. `quiet`: sin toasts (estado inicial de native.hello). */
function applyCamera(data = {}, { quiet = false } = {}) {
  const cam = state.camera;
  const prev = cam.state;
  const next = CAMERA_STATES.has(data.state) ? data.state : 'off';
  cam.state = next;
  if (data.name) cam.name = String(data.name);
  cam.message = data.message ? String(data.message) : '';
  // Un shell del contrato anterior solo emite `camera` durante la sesión (= sincronizada).
  cam.mode = CAMERA_MODES.has(data.mode) ? data.mode : next === 'off' ? 'off' : 'dubbing';
  const delay = Number(data.delayMs);
  cam.delayMs = Number.isFinite(delay) ? delay : cam.mode === 'dubbing' ? (state.settings?.delayMs ?? 3000) : 0;
  if (typeof data.alwaysOn === 'boolean') cam.alwaysOn = data.alwaysOn;
  cam.hostRunning = typeof data.hostRunning === 'boolean' ? data.hostRunning : next !== 'off';
  if (next === 'off') cam.stats = null;

  // Toasts solo en transiciones relevantes (nunca al arrancar la app sin webcam o en espera).
  if (!quiet && prev !== next) {
    const inSession = state.session.state === 'running' || state.session.state === 'starting';
    if (prev === 'live' && next === 'lost') {
      toast({ kind: 'warn', title: 'Cámara desconectada', message: cam.message || 'Meet ve la imagen de espera de VOXORA hasta que vuelva. Se reanuda sola.' });
    } else if ((prev === 'lost' || prev === 'error') && next === 'live') {
      toast({ kind: 'success', title: 'Cámara recuperada', message: cam.message || 'Meet vuelve a recibir tu cámara.' });
    } else if (next === 'error' && inSession) {
      // Con el host caído el shell informa `error` + hostRunning:false: no es la webcam, es la cámara virtual.
      toast(cam.hostRunning
        ? { kind: 'warn', title: 'La cámara no abrió', message: cam.message || 'Meet ve la imagen de espera de VOXORA. Se reintenta sola.', action: { label: 'Reunión', run: () => goTab('meeting') } }
        : { kind: 'warn', title: 'La cámara virtual no arrancó', message: cam.message || 'Meet no ve VOXORA Meet Camera. Se reintenta sola.' });
    }
  }
  notify('camera');
}

function onCameraStats(data = {}) {
  const cam = state.camera;
  cam.stats = data;
  const delay = Number(data.delayMs);
  // El retraso cambia en caliente (delay.set) sin evento `camera`: las estadísticas lo traen cada 1 s.
  if (Number.isFinite(delay) && delay !== cam.delayMs && cam.state !== 'off') {
    cam.delayMs = delay;
    notify('camera');
  }
  notify('camera.stats');
}

// ── Eventos nativos ─────────────────────────────────────────────────────────
function onNativeEvent({ event, data = {} }) {
  switch (event) {
    case 'camera': applyCamera(data); break;
    case 'camera.stats': onCameraStats(data); break;
    case 'device-lost':
      if (data.kind === 'mic') toast({ kind: 'warn', title: 'Micrófono desconectado', message: 'El micrófono elegido ya no está. Reconéctalo, o elige otro y reinicia el doblaje.', action: { label: 'Reunión', run: () => goTab('meeting') } });
      break;
    case 'device-restored':
      if (data.kind === 'mic') toast({ kind: 'success', title: 'Micrófono reconectado', message: 'Si el doblaje dejó de oírte, deténlo y vuelve a iniciarlo.' });
      break;
    case 'record.level': onRecordLevel(data); break;
    case 'record.stopped': onRecordStopped(data); break;
    case 'tray.toggleSession': toggleSession(); break;
    default: break;
  }
}

// ── Motor listo: ajustes, sesión en curso y voces ───────────────────────────
let loading = null;
async function onEngineReady() {
  if (loading) return loading;
  loading = (async () => {
    try {
      await loadSettings();
      const stats = await engine('stats.get').catch(() => null);
      if (stats?.state === 'running' && state.session.state !== 'running') {
        state.session.startedAt = Date.now();
        setSessionState('running');
      }
      loadVoices({ quiet: true });
    } catch (error) {
      toast({ kind: 'error', title: 'No se pudieron leer los ajustes', message: error.message });
    } finally {
      loading = null;
    }
  })();
  return loading;
}

function onEngineState({ state: st, message }) {
  const was = state.engine.state;
  state.engine = { state: st, message: message || '' };
  notify('engine');
  if (st === 'ready' && was !== 'ready') onEngineReady();
  if ((st === 'exited' || st === 'failed') && state.session.state !== 'idle') setSessionState('idle');
}

// ── Arranque ────────────────────────────────────────────────────────────────
async function boot() {
  initNav();
  initMode();       // Simple | Avanzado (pestañas visibles y controles .adv-only)
  initAccounts();   // hoja «Cuentas» + aviso si faltan keys
  initStatus();
  initCameraFx();
  initMeeting();
  initRecording();
  initLive();
  initVoice();
  initModels();
  initSettings();
  goTab('meeting');

  await ready();
  on('devices', onDevices);
  on('engine-state', onEngineState);
  on('engine-event', onEngineEvent);
  on('native-event', onNativeEvent);

  try {
    const hello = await native('native.hello');
    state.app = { ...state.app, ...(hello.app || {}) };
    if (hello.session?.running) {
      state.session.startedAt = Date.now();
      setSessionState('running');
    }
    // Estado de la cámara virtual aunque no haya sesión (cameraAlwaysOn); sin toasts.
    if (hello.camera) applyCamera(hello.camera, { quiet: true });
    else if (hello.session?.running) applyCamera({ state: hello.session.camera || 'off', name: hello.session.cameraName || '' }, { quiet: true });
    onEngineState(hello.engine || { state: 'starting' });
  } catch (error) {
    toast({ kind: 'error', title: 'No se pudo conectar con la app', message: error.message });
  }
  renderCamera();
  document.body.classList.add('is-ready');

  // Solo en el backend simulado (navegador normal): ?mode=advanced&tab=live&autostart=1&sheet=accounts
  // para revisar estados y diseño.
  if (isMock()) {
    const params = new URLSearchParams(location.search);
    if (params.get('tab')) goTab(params.get('tab'));
    if (params.get('autostart')) setTimeout(toggleSession, 400);
    const sheet = params.get('sheet');
    if (sheet === 'accounts') setTimeout(openAccounts, 300);
    else if (sheet) setTimeout(() => openSheet(`sheet-${sheet}`), 300);
  }
}

boot();
