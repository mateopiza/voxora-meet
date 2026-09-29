// Ciclo de vida de la sesión de doblaje (iniciar / detener) y comprobaciones previas.

import { openAccounts } from './accounts.js';
import { engine, native } from './bridge.js';
import { toast, toastError } from './dom.js';
import { reveal } from './nav.js';
import { flushSettings, needsRestart, notify, state } from './store.js';

// Ganchos para que la vista previa de cámara / prueba de micrófono suelten los
// dispositivos antes de que el motor y el shell los abran.
export const hooks = { beforeStart: [], afterStart: [], afterStop: [] };

async function runHooks(list) {
  for (const fn of list) {
    try { await fn(); } catch (error) { console.error(error); }
  }
}

export function setSessionState(next) {
  if (state.session.state === next) return;
  state.session.state = next;
  if (next === 'running' && !state.session.startedAt) state.session.startedAt = Date.now();
  if (next === 'idle') {
    state.session.startedAt = 0;
    needsRestart.value = false;
    needsRestart.fields.clear();
  }
  notify('session');
}

/** Estado de los requisitos para iniciar (se muestra como checklist en Reunión). */
export function preflight() {
  const s = state.settings || {};
  const vmic = state.devices.virtualMic;
  const engineOk = state.engine.state === 'ready';
  const keysOk = Boolean(state.keys.groq && state.keys.elevenlabs);
  const missingKeys = ['groq', 'elevenlabs'].filter((k) => !state.keys[k]).map((k) => (k === 'groq' ? 'Groq' : 'ElevenLabs'));
  return [
    {
      id: 'engine', blocking: true, ok: engineOk,
      label: engineOk ? 'Motor de doblaje listo' : state.engine.state === 'starting' ? 'Iniciando el motor…' : 'El motor no está en marcha',
      detail: state.engine.message || 'El motor de doblaje no está en marcha.',
      action: engineOk || state.engine.state === 'starting' ? null : { label: 'Reiniciar', run: () => native('native.engine.restart').catch(toastError) },
    },
    {
      id: 'keys', blocking: true, ok: keysOk, short: 'cuentas conectadas',
      label: keysOk ? 'Cuentas de Groq y ElevenLabs conectadas' : `Falta la clave de ${missingKeys.join(' y ')}`,
      detail: `Conecta tu cuenta de ${missingKeys.join(' y ')} (API key) para poder doblar.`,
      action: { label: 'Conectar', run: openAccounts },
    },
    {
      id: 'voice', blocking: true, ok: Boolean(s.voiceId), short: `voz «${s.voiceName || s.voiceId}»`,
      label: s.voiceId ? `Voz: ${s.voiceName || s.voiceId}` : 'Elige o clona tu voz',
      detail: 'Elige una voz de tu cuenta o clona la tuya en «Tu voz».',
      action: { label: 'Elegir voz', run: () => reveal('#field-voice') },
    },
    {
      id: 'output', blocking: true, ok: Boolean(!state.devices.received || vmic?.resolvedDevice), short: 'micrófono virtual',
      label: vmic?.resolvedDevice ? `Salida: ${vmic.resolvedDevice}` : 'No hay micrófono virtual para Meet',
      detail: 'Instala VB-Audio Virtual Cable (gratis) o el driver de VOXORA Meet para que Meet pueda oír el doblaje.',
      action: { label: 'Descargar VB-Cable', run: () => native('native.openExternal', { url: 'https://vb-audio.com/Cable/' }).catch(toastError) },
    },
  ];
}

const ROUTES = {
  voice_missing: { label: 'Elegir voz', run: () => reveal('#field-voice') },
  missing_key: { label: 'Revisar cuentas', run: openAccounts },
  provider_auth: { label: 'Revisar cuentas', run: openAccounts },
  virtual_mic_missing: { label: 'Ver salida', run: () => reveal('#sel-output') },
  model_unavailable: { label: 'Elegir modelo', run: () => reveal('.models-summary', 'models') },
};

export function errorAction(error) {
  return ROUTES[error?.code];
}

export async function startSession() {
  if (state.session.state !== 'idle') return;
  const missing = preflight().find((p) => p.blocking && !p.ok);
  if (missing) {
    toast({ kind: 'warn', title: 'Antes de empezar', message: missing.detail, action: missing.action || undefined });
    return;
  }
  setSessionState('starting');
  try {
    await flushSettings();
    await runHooks(hooks.beforeStart);
    await engine('session.start', {}, 45000);
    state.session.startedAt = Date.now();
    state.vox = { total: 0, remaining: null, limitReached: false, warned: false };
    notify('vox');
    setSessionState('running');
    await runHooks(hooks.afterStart);
  } catch (error) {
    setSessionState('idle');
    toast({ kind: 'error', title: 'No se pudo iniciar el doblaje', message: error.message, action: errorAction(error) });
    await runHooks(hooks.afterStop);
  }
}

export async function stopSession() {
  if (state.session.state !== 'running') return;
  setSessionState('stopping');
  try {
    await engine('session.stop', {}, 20000);
  } catch (error) {
    if (error.code !== 'engine_unavailable') toastError(error, 'No se pudo detener limpiamente');
  } finally {
    setSessionState('idle');
    await runHooks(hooks.afterStop);
  }
}

export function toggleSession() {
  if (state.session.state === 'idle') startSession();
  else if (state.session.state === 'running') stopSession();
}
