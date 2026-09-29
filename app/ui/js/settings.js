// Avanzado › Ajustes: cámara virtual permanente, límites de VOX y aplicación (acerca de y acciones).
// Las API keys viven en accounts.js; la escucha local (monitor) la pinta meeting.js.

import { native } from './bridge.js';
import { $, debounce, h, toast, toastError } from './dom.js';
import { patchSettings, state, subscribe } from './store.js';

const els = {};

function renderLimits() {
  const s = state.settings || {};
  if (document.activeElement !== els.warn) els.warn.value = String(s.warnAtVox ?? 0);
  if (document.activeElement !== els.max) els.max.value = String(s.maxVoxPerSession ?? 0);
}

function renderAbout() {
  const rows = [
    ['Versión', state.app.version || '—'],
    ['Motor', state.engine.state === 'ready' ? 'En marcha' : state.engine.state === 'starting' ? 'Iniciando…' : 'Detenido'],
    ['WebView2', state.app.webviewVersion || '—'],
    ['Datos', state.app.dataDir || '—'],
  ];
  els.about.replaceChildren(...rows.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', { title: v }, v))));
}

// Cámara virtual permanente (ajuste en caliente que aplica el shell al ver la respuesta de settings.set).
function renderCameraSetting() {
  const on = state.settings?.cameraAlwaysOn !== false;
  els.camAlways.checked = on;
  const running = state.session.state === 'running';
  const vcam = state.devices.virtualCamera;
  let text = on
    ? 'Tu webcam queda encendida mientras la app esté abierta (también en la bandeja) y Meet ve tu cámara en vivo; al doblar, se retrasa lo mismo que tu voz.'
    : 'La webcam y la cámara virtual solo se usan mientras doblas: fuera del doblaje, Meet no verá VOXORA Meet Camera.';
  if (!on && running) text += ' Ahora siguen activas y se apagarán al detener el doblaje.';
  let tone = '';
  if (state.devices.received && vcam && !vcam.installed) {
    text = 'No se encontró la cámara virtual de VOXORA Meet: reinstala la app para que Meet pueda recibir tu video.';
    tone = 'warn';
  }
  els.camAlwaysHint.textContent = text;
  if (tone) els.camAlwaysHint.dataset.tone = tone;
  else delete els.camAlwaysHint.dataset.tone;
}

const saveLimits = debounce(() => {
  const warn = Math.max(0, Math.round(Number(els.warn.value) || 0));
  const max = Math.max(0, Math.round(Number(els.max.value) || 0));
  if (max && warn && warn >= max) {
    toast({ kind: 'warn', title: 'Revisa los límites', message: 'El aviso debería llegar antes del tope de la sesión.' });
  }
  patchSettings({ warnAtVox: warn, maxVoxPerSession: max });
}, 500);

export function initSettings() {
  els.warn = $('#inp-warn-vox');
  els.max = $('#inp-max-vox');
  els.about = $('#about');
  els.warn.addEventListener('input', saveLimits);
  els.max.addEventListener('input', saveLimits);
  els.camAlways = $('#chk-camera-always');
  els.camAlwaysHint = $('#camera-always-hint');
  els.camAlways.addEventListener('change', () => patchSettings({ cameraAlwaysOn: els.camAlways.checked }));

  $('#btn-restart-engine').addEventListener('click', () => native('native.engine.restart').catch(toastError));
  $('#btn-hide').addEventListener('click', () => native('native.window.hide').catch(toastError));
  let quitArmed = 0;
  const quit = $('#btn-quit');
  quit.addEventListener('click', () => {
    if (state.session.state === 'running' && !quitArmed) {
      quitArmed = setTimeout(() => { quitArmed = 0; }, 4000);
      toast({ kind: 'warn', title: 'El doblaje está en vivo', message: 'Pulsa «Salir» otra vez para detenerlo y cerrar VOXORA Meet.', timeout: 4000 });
      return;
    }
    native('native.window.quit').catch(toastError);
  });

  subscribe('engine', renderAbout);
  subscribe('settings', () => { renderLimits(); renderAbout(); renderCameraSetting(); });
  subscribe('session', renderCameraSetting);
  subscribe('devices', renderCameraSetting);
  renderLimits();
  renderAbout();
  renderCameraSetting();
}
