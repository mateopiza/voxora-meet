// Barra superior: pastillas de estado (motor / cámara virtual / mic virtual)
// con explicación de qué falta y cómo resolverlo, contador VOX, banner del
// motor y chip de sesión junto a las pestañas.

import { openAccounts } from './accounts.js';
import { native } from './bridge.js';
import { $, $$, fmtClock, fmtInt, fmtSeconds1, h, setBusy, setIcon, toastError } from './dom.js';
import { setMode } from './mode.js';
import { reveal } from './nav.js';
import { toggleSession } from './session.js';
import { cameraAlwaysOn, cameraDelayMs, state, subscribe } from './store.js';

const els = {};

function pill(el, tone, value) {
  el.dataset.tone = tone;
  el.querySelector('.pill__value').textContent = value;
}

function popover(el, title, ...body) {
  const next = h('div', {}, h('p', { class: 'popover__title' }, title), ...body.filter(Boolean));
  // Sin cambios no se reconstruye: la cámara re-renderiza a menudo (eventos, retraso en caliente) y
  // un botón del popover con foco lo perdería.
  if (next.innerHTML === el.innerHTML) return;
  el.replaceChildren(...next.childNodes);
  const wrap = el.closest('.pill-wrap');
  if (wrap && isShown(wrap)) placePopover(wrap);
}

// El popover se centra bajo su pastilla; si se saldría de la ventana (960 px, pastillas en los
// extremos) se desplaza en horizontal lo justo para quedar dentro, con 12 px de margen.
const isShown = (wrap) => wrap.matches(':hover, :focus-within, .open');
function placePopover(wrap) {
  const pop = wrap.querySelector('.popover');
  if (!pop) return;
  // Se calcula desde la pastilla (no desde el popover, que puede estar a mitad de su transición).
  const r = wrap.getBoundingClientRect();
  const half = pop.offsetWidth / 2;
  const center = r.left + r.width / 2;
  const margin = 12;
  const max = document.documentElement.clientWidth - margin;
  const shift = center - half < margin ? margin - (center - half) : center + half > max ? max - (center + half) : 0;
  pop.style.setProperty('--pop-shift', `${Math.round(shift)}px`);
}

const button = (label, run, variant = 'btn--glass') => h('button', { class: `btn ${variant} btn--sm`, type: 'button', onclick: run }, label);
const openUrl = (url) => () => native('native.openExternal', { url }).catch(toastError);
const refreshDevices = () => native('native.devices.refresh').catch(toastError);

function renderEngine() {
  const e = state.engine;
  const missing = ['groq', 'elevenlabs'].filter((k) => !state.keys[k]);
  if (e.state === 'starting') {
    pill(els.engine, 'wait', 'Iniciando');
    popover(els.popEngine, 'Iniciando el motor', h('p', {}, 'El motor de doblaje (transcripción, traducción y voz) está arrancando. Tarda unos segundos.'));
  } else if (e.state === 'ready') {
    if (missing.length) {
      pill(els.engine, 'warn', 'Faltan claves');
      popover(els.popEngine, 'Motor listo, faltan claves',
        h('p', {}, `Para doblar necesitas la API key de ${missing.map((k) => (k === 'groq' ? 'Groq' : 'ElevenLabs')).join(' y ')}.`),
        h('div', { class: 'row' }, button('Conectar cuentas', openAccounts, 'btn--brand')));
    } else {
      pill(els.engine, 'ok', 'Listo');
      popover(els.popEngine, 'Motor en marcha',
        h('p', {}, 'Groq transcribe y traduce cada frase; ElevenLabs la dice con tu voz clonada.'));
    }
  } else {
    pill(els.engine, 'bad', 'Detenido');
    popover(els.popEngine, 'El motor no está en marcha',
      h('p', {}, e.message || 'El motor de doblaje se detuvo.'),
      h('div', { class: 'row' }, button('Reiniciar motor', () => native('native.engine.restart').catch(toastError))));
  }
  els.banner.hidden = !(e.state === 'exited' || e.state === 'failed');
  els.bannerText.textContent = e.message || 'El motor de doblaje no está en marcha.';
}

function renderVcam() {
  const d = state.devices;
  const cam = state.camera;
  if (!d.received) {
    pill(els.vcam, 'wait', 'Buscando');
    popover(els.popVcam, 'Cámara virtual', h('p', {}, 'Comprobando los componentes de VOXORA Meet…'));
    return;
  }
  if (!d.virtualCamera?.installed) {
    pill(els.vcam, 'bad', 'No instalada');
    popover(els.popVcam, 'Falta la cámara virtual',
      h('p', {}, 'No se encontró el componente de cámara virtual de VOXORA Meet (VoxoraMeetVCamHost.exe).'),
      h('p', {}, 'Reinstala VOXORA Meet para que Meet pueda recibir tu video sincronizado con el doblaje.'));
    return;
  }
  const running = state.session.state === 'running';
  const alwaysOn = cameraAlwaysOn();
  const name = cam.name || 'Tu cámara';
  const how = h('p', {}, 'En Meet › Configuración › Video elige ', h('strong', {}, 'VOXORA Meet Camera'), '.');

  if (cam.state === 'error' && !cam.hostRunning) {
    // El shell informa `error` con hostRunning:false cuando el host de la cámara virtual cayó o no arranca.
    pill(els.vcam, 'bad', 'Detenida');
    popover(els.popVcam, 'Sin cámara virtual',
      h('p', {}, cam.message || 'La cámara virtual no está en marcha: Meet no verá VOXORA Meet Camera hasta que vuelva.'),
      h('p', {}, 'VOXORA Meet lo reintenta solo; si no se recupera, reinicia la app.'));
  } else if (cam.state === 'lost' || cam.state === 'error') {
    pill(els.vcam, 'warn', cam.state === 'lost' ? 'Sin señal' : 'Sin webcam');
    popover(els.popVcam, cam.state === 'lost' ? 'Se perdió la cámara' : 'La cámara no abrió',
      h('p', {}, cam.message || 'Meet ve la imagen de espera de VOXORA.'),
      h('p', {}, 'Conecta la cámara o elige otra en Reunión: se reanuda sola.'),
      h('div', { class: 'row' }, button('Actualizar dispositivos', refreshDevices)));
  } else if (cam.state === 'starting' || (running && (cam.state === 'off' || cam.state === 'standby'))) {
    pill(els.vcam, 'wait', 'Conectando');
    popover(els.popVcam, 'Conectando la cámara', h('p', {}, 'Abriendo tu webcam y la cámara virtual…'));
  } else if (cam.state === 'live' && cam.mode === 'dubbing') {
    pill(els.vcam, 'ok', 'Sincronizada');
    popover(els.popVcam, 'Meet recibe tu cámara sincronizada',
      h('p', {}, `${name} sale con `, h('strong', {}, `+${fmtSeconds1(cameraDelayMs())}`), ' de retraso, lo mismo que tu voz doblada, para que los labios coincidan.'),
      how);
  } else if (cam.state === 'live') {
    pill(els.vcam, 'ok', 'En vivo');
    popover(els.popVcam, 'Meet ve tu cámara en vivo',
      h('p', {}, `${name} sale sin retraso mientras no doblas; al doblar, el video se retrasa lo mismo que tu voz.`),
      alwaysOn ? h('p', {}, 'Tu webcam queda encendida mientras VOXORA Meet esté abierto (también en la bandeja). Puedes cambiarlo en modo Avanzado.') : null,
      how);
  } else if (cam.state === 'standby') {
    // El shell actual no emite 'standby' (abre la webcam en cuanto hay cámara virtual); se trata como lista.
    pill(els.vcam, 'ok', 'Lista');
    popover(els.popVcam, 'Cámara virtual lista',
      h('p', {}, 'Meet ve tu cámara en vivo; al doblar, el video se retrasa lo mismo que tu voz.'),
      how);
  } else if (alwaysOn) {
    // off con la cámara permanente activada: el host de la cámara virtual no está en marcha.
    pill(els.vcam, 'warn', 'Detenida');
    popover(els.popVcam, 'Sin cámara virtual',
      h('p', {}, cam.message || 'La cámara virtual no está en marcha: Meet no verá VOXORA Meet Camera hasta que vuelva.'),
      h('p', {}, 'Si no se recupera sola, reinicia VOXORA Meet.'),
      h('div', { class: 'row' }, button('Actualizar dispositivos', refreshDevices)));
  } else {
    pill(els.vcam, 'ok', 'Lista');
    popover(els.popVcam, 'Cámara virtual lista',
      h('p', {}, 'Se activa al iniciar el doblaje y retrasa tu video lo mismo que tu voz. Mientras no doblas, Meet no ve VOXORA Meet Camera: puedes dejarla siempre disponible en modo Avanzado.'),
      how,
      h('div', { class: 'row' }, button('Cambiar en Avanzado', () => { setMode('advanced'); reveal('#chk-camera-always', 'settings'); })));
  }
}

function renderVmic() {
  const d = state.devices;
  const vm = d.virtualMic;
  if (!d.received) {
    pill(els.vmic, 'wait', 'Buscando');
    popover(els.popVmic, 'Micrófono virtual', h('p', {}, 'Buscando el dispositivo por el que Meet oirá el doblaje…'));
    return;
  }
  const resolved = vm?.resolvedDevice || '';
  if (!resolved) {
    pill(els.vmic, 'bad', 'No instalado');
    popover(els.popVmic, 'Falta el micrófono virtual',
      h('p', {}, 'Meet necesita un micrófono virtual para oír tu voz doblada. Tienes dos opciones:'),
      h('ol', {},
        h('li', {}, 'Instala ', h('strong', {}, 'VB-Audio Virtual Cable'), ' (gratis) y reinicia Windows si te lo pide.'),
        h('li', {}, 'O instala el driver de ', h('strong', {}, 'VOXORA Meet'), ' cuando esté disponible.')),
      h('div', { class: 'row' }, button('Descargar VB-Cable', openUrl('https://vb-audio.com/Cable/'), 'btn--brand'), button('Actualizar', refreshDevices)));
    return;
  }
  const own = /voxora/i.test(resolved);
  pill(els.vmic, 'ok', own ? 'VOXORA' : 'VB-Cable');
  const capture = vm?.captureName || (own ? 'VOXORA Meet Microphone' : 'CABLE Output');
  popover(els.popVmic, own ? 'Micrófono VOXORA listo' : 'Usando VB-Cable',
    h('p', {}, 'El doblaje sale por ', h('strong', {}, resolved), '.'),
    h('p', {}, 'En Meet › Configuración › Audio elige como micrófono ', h('strong', {}, capture), '.'),
    vm?.fallback ? h('p', {}, `«${vm.device}» no está instalado, así que se usa ${resolved}.`) : null);
}

function renderVox() {
  const v = state.vox;
  const max = Number(state.settings?.maxVoxPerSession) || 0;
  els.voxValue.textContent = fmtInt(v.total);
  const idleWithTotal = state.session.state === 'idle' && v.total > 0;
  els.voxLabel.textContent = max ? `de ${fmtInt(max)} VOX` : idleWithTotal ? 'VOX · última sesión' : 'VOX · sesión';
  const tone = v.limitReached ? 'bad' : v.warned || (max && v.total >= max * 0.8) ? 'warn' : '';
  if (tone) els.vox.dataset.tone = tone;
  else delete els.vox.dataset.tone;
  els.vox.title = v.limitReached ? 'Límite de VOX alcanzado: los turnos nuevos no se doblan'
    : v.remaining != null ? `Quedan ${fmtInt(v.remaining)} VOX en esta sesión` : 'Créditos VOX consumidos en esta sesión';
}

let chipTimer = 0;
function renderSessionChip() {
  const st = state.session.state;
  els.chip.dataset.state = st;
  const btn = els.mini;
  const label = btn.querySelector('span');
  setBusy(btn, false);
  btn.classList.toggle('btn--brand', st === 'idle' || st === 'starting');
  btn.classList.toggle('btn--stop', st === 'running' || st === 'stopping');
  if (st === 'idle') { setIcon(btn, 'play'); label.textContent = 'Iniciar'; }
  if (st === 'running') { setIcon(btn, 'stop'); label.textContent = 'Detener'; }
  if (st === 'starting') setBusy(btn, true, 'Iniciando');
  if (st === 'stopping') setBusy(btn, true, 'Deteniendo');
  btn.disabled = st === 'starting' || st === 'stopping';
  clearInterval(chipTimer);
  const tick = () => {
    els.chipText.textContent = st === 'running' ? `En vivo · ${fmtClock(Date.now() - state.session.startedAt)}`
      : st === 'starting' ? 'Iniciando…' : st === 'stopping' ? 'Deteniendo…'
        : state.engine.state === 'ready' ? 'Listo' : 'Sin motor';
    els.chip.title = st === 'idle' ? (state.engine.state === 'ready' ? 'Listo para empezar el doblaje' : 'Esperando al motor de doblaje') : '';
  };
  tick();
  if (st === 'running') chipTimer = setInterval(tick, 1000);
}

function renderDots() {
  // Punto en «Reunión» si falta algo para empezar (voz o cuentas) y se está en otra pestaña.
  const missing = !state.settings?.voiceId || !(state.keys.groq && state.keys.elevenlabs);
  els.dotMeeting.hidden = !missing || state.engine.state !== 'ready' || state.activeTab === 'meeting';
}

export function initStatus() {
  Object.assign(els, {
    engine: $('#pill-engine'), popEngine: $('#pop-engine'), vcam: $('#pill-vcam'), popVcam: $('#pop-vcam'),
    vmic: $('#pill-vmic'), popVmic: $('#pop-vmic'),
    vox: $('#vox'), voxValue: $('#vox-value'), voxLabel: $('#vox-label'),
    banner: $('#engine-banner'), bannerText: $('#engine-banner-text'),
    chip: $('#session-chip'), chipText: $('#session-chip-text'), mini: $('#btn-session-mini'),
    dotMeeting: $('#dot-meeting'),
  });

  // Pastillas: hover/foco muestran la explicación; clic la fija (útil con teclado o para pulsar sus botones).
  for (const wrap of $$('.pill-wrap')) {
    wrap.addEventListener('mouseenter', () => placePopover(wrap));
    wrap.addEventListener('focusin', () => placePopover(wrap));
    wrap.querySelector('.pill').addEventListener('click', (event) => {
      event.stopPropagation();
      const open = !wrap.classList.contains('open');
      $$('.pill-wrap.open').forEach((w) => w.classList.remove('open'));
      wrap.classList.toggle('open', open);
      placePopover(wrap);
    });
  }
  window.addEventListener('resize', () => $$('.pill-wrap').forEach(placePopover));
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.pill-wrap')) $$('.pill-wrap.open').forEach((w) => w.classList.remove('open'));
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      $$('.pill-wrap.open').forEach((w) => w.classList.remove('open'));
      if (document.activeElement?.closest('.pill-wrap')) document.activeElement.blur();
    }
  });

  $('#btn-engine-restart').addEventListener('click', () => native('native.engine.restart').catch(toastError));
  els.mini.addEventListener('click', toggleSession);

  subscribe('engine', () => { renderEngine(); renderSessionChip(); renderDots(); });
  subscribe('keys', () => { renderEngine(); renderDots(); });
  subscribe('devices', () => { renderVcam(); renderVmic(); });
  subscribe('session', () => { renderVcam(); renderSessionChip(); renderVox(); });
  subscribe('camera', renderVcam);
  subscribe('settings', () => { renderVox(); renderDots(); renderVcam(); });
  subscribe('vox', renderVox);
  subscribe('tab', renderDots);

  renderEngine();
  renderVcam();
  renderVmic();
  renderVox();
  renderSessionChip();
  renderDots();
}
