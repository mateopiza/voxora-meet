// «Imagen» de la cámara: espejo y voltear sobre la vista previa (Simple y Reunión) y, en la pestaña
// Cámara de Avanzado, además 16:9 / 9:16, rotación, zoom, encuadre, brillo, contraste, saturación y
// temperatura.
//
// El shell procesa cada frame antes de publicarlo en la cámara virtual (video_effects.cpp), así que la
// vista previa de «VOXORA Meet Camera» muestra la salida real. Cada cambio va:
//   - al shell al instante con `native.camera.effects` (sin esperar al debounce de settings.set), y
//   - al motor con settings.set (lo persiste en settings.json y el shell lo relee de la respuesta).
// Con la webcam física en la vista previa (cámara virtual apagada) se aproxima con CSS.

import { native } from './bridge.js';
import { $, $$, bindSegmented, fmtDec, setSegmented } from './dom.js';
import { patchSettings, state, subscribe } from './store.js';

export const FX_DEFAULTS = Object.freeze({
  camMirror: false, camFlip: false, camRotation: 0, camAspect: '16:9', camZoom: 1, camPanX: 0, camPanY: 0,
  camBrightness: 0, camContrast: 0, camSaturation: 0, camTemperature: 0,
});
const FX_KEYS = Object.keys(FX_DEFAULTS);
const els = {};

/** Valores vigentes (ajustes del motor, o los neutros si aún no llegaron / motor sin estas claves). */
export function currentFx() {
  const s = state.settings || {};
  return Object.fromEntries(FX_KEYS.map((k) => [k, s[k] ?? FX_DEFAULTS[k]]));
}

const isNeutral = (fx) => FX_KEYS.every((k) => fx[k] === FX_DEFAULTS[k]);

// ── Envío en vivo al shell (uno en vuelo; el último cambio siempre llega) ────
let inFlight = false;
let queued = false;
let unsupported = false;
async function pushFx() {
  if (unsupported) return;
  if (inFlight) {
    queued = true;
    return;
  }
  inFlight = true;
  try {
    await native('native.camera.effects', currentFx(), 5000);
  } catch (error) {
    if (error?.code === 'unknown_command') unsupported = true;  // shell anterior: basta con settings.set
  } finally {
    inFlight = false;
    if (queued) {
      queued = false;
      pushFx();
    }
  }
}

function applyFx(patch) {
  patchSettings(patch);
  pushFx();
  render();
}

// ── Aproximación CSS para la webcam física (sin cámara virtual todavía) ──────
export function previewCss(fx = currentFx()) {
  const t = [];
  if (fx.camRotation) t.push(`rotate(${fx.camRotation}deg)`);
  if (fx.camZoom > 1) t.push(`scale(${fx.camZoom})`, `translate(${(-fx.camPanX * (1 - 1 / fx.camZoom) * 50).toFixed(2)}%, ${(-fx.camPanY * (1 - 1 / fx.camZoom) * 50).toFixed(2)}%)`);
  if (fx.camMirror) t.push('scaleX(-1)');
  if (fx.camFlip) t.push('scaleY(-1)');
  const f = [];
  if (fx.camBrightness) f.push(`brightness(${(1 + fx.camBrightness * 0.45).toFixed(3)})`);
  if (fx.camContrast) f.push(`contrast(${(2 ** fx.camContrast).toFixed(3)})`);
  if (fx.camSaturation) f.push(`saturate(${(1 + fx.camSaturation).toFixed(3)})`);
  if (fx.camTemperature > 0) f.push(`sepia(${(fx.camTemperature * 0.3).toFixed(3)})`);
  if (fx.camTemperature < 0) f.push(`hue-rotate(${(fx.camTemperature * 12).toFixed(1)}deg)`);
  return {
    transform: t.join(' ') || 'none',
    filter: f.join(' ') || 'none',
    // 9:16: franja central de ancho H·9/16 dentro del cuadro 16:9 (≈31,6 % del ancho).
    clip: fx.camAspect === '9:16' ? 'inset(0 34.18% 0 34.18%)' : 'none',
  };
}

// ── Render ──────────────────────────────────────────────────────────────────
const signed = (v) => {
  const n = Math.round(Number(v) * 100);
  return n > 0 ? `+${n}` : String(n);
};
const FORMAT = {
  camZoom: (v) => `${fmtDec(v, 2)}×`,
  camPanX: signed, camPanY: signed, camBrightness: signed, camContrast: signed, camSaturation: signed, camTemperature: signed,
};

function paint(input) {
  const v = Number(input.value);
  const min = Number(input.min);
  const max = Number(input.max);
  const pct = ((v - min) / (max - min)) * 100;
  input.style.setProperty('--fill', `${pct}%`);
  // Barras con el cero en el centro: el relleno va del centro al valor.
  input.style.setProperty('--fill-from', `${Math.min(50, pct)}%`);
  input.style.setProperty('--fill-to', `${Math.max(50, pct)}%`);
  const out = input.parentElement.querySelector('output');
  if (out) out.textContent = FORMAT[input.dataset.key]?.(v) ?? String(v);
}

function render() {
  const fx = currentFx();
  // Espejo / Voltear: chips de la pestaña Cámara y botones sobre la vista previa (Simple y Reunión).
  for (const btn of els.toggles) btn.setAttribute('aria-pressed', String(Boolean(fx[btn.dataset.fxToggle])));
  setSegmented(els.aspect, fx.camAspect);
  setSegmented(els.rotation, String(fx.camRotation));
  for (const input of els.sliders) {
    if (document.activeElement !== input) input.value = String(fx[input.dataset.key]);
    paint(input);
  }
  // Encuadre: sin margen (16:9 sin zoom en una webcam 16:9) no hay nada que desplazar.
  const noSlack = fx.camZoom <= 1 && fx.camAspect === '16:9' && (fx.camRotation === 0 || fx.camRotation === 180);
  for (const input of [els.panX, els.panY]) input.closest('.fx-slider').classList.toggle('is-idle', noSlack);
  els.panX.title = els.panY.title = noSlack ? 'Sube el zoom (o usa 9:16) para poder mover el encuadre' : '';
  els.reset.hidden = isNeutral(fx);

  // Aviso: en sesión el video va retrasado, así que los cambios llegan a Meet con ese retraso.
  const cam = state.camera;
  let hint = '';
  if (cam.mode === 'dubbing' && cam.state === 'live') hint = `Durante el doblaje los cambios llegan a Meet con el mismo retraso que tu voz (+${fmtDec((cam.delayMs || 0) / 1000, 1)} s).`;
  else if (!cam.hostRunning && state.devices.received) hint = 'Se aplican a la cámara virtual; la vista previa los simula hasta que esté activa.';
  els.hint.textContent = hint;
  els.hint.hidden = !hint;
}

function renderPerf() {
  const s = state.camera.stats;
  if (!s || !Number.isFinite(Number(s.effectsMs)) || !s.width) {
    els.perf.textContent = '';
    return;
  }
  const out = s.outputWidth && s.outputHeight ? ` · salida ${s.outputWidth}×${s.outputHeight}` : '';
  els.perf.textContent = `Procesado: ${fmtDec(s.effectsMs, 1)} ms por frame (máx. ${fmtDec(s.effectsPeakMs ?? s.effectsMs, 1)} ms) · webcam ${s.width}×${s.height}${out}`;
}

export function initCameraFx() {
  Object.assign(els, {
    aspect: $('#seg-fx-aspect'), rotation: $('#seg-fx-rotation'),
    reset: $('#btn-fx-reset'), hint: $('#fx-hint'), perf: $('#fx-perf'),
    panX: $('#rng-fx-panx'), panY: $('#rng-fx-pany'),
  });
  els.sliders = $$('#cam-fx input[type="range"][data-key]');
  els.toggles = $$('[data-fx-toggle]');

  for (const btn of els.toggles) {
    const key = btn.dataset.fxToggle;
    btn.addEventListener('click', () => applyFx({ [key]: !currentFx()[key] }));
  }
  bindSegmented(els.aspect, (value) => applyFx({ camAspect: value }));
  bindSegmented(els.rotation, (value) => applyFx({ camRotation: Number(value) }));
  for (const input of els.sliders) {
    input.addEventListener('input', () => {
      paint(input);
      applyFx({ [input.dataset.key]: Number(input.value) });
    });
    // Doble clic en la barra: vuelve al valor neutro de ese ajuste.
    input.addEventListener('dblclick', () => applyFx({ [input.dataset.key]: FX_DEFAULTS[input.dataset.key] }));
  }
  els.reset.addEventListener('click', () => applyFx({ ...FX_DEFAULTS }));

  subscribe('settings', render);
  subscribe('camera', render);
  subscribe('devices', render);
  subscribe('camera.stats', renderPerf);
  render();
}
