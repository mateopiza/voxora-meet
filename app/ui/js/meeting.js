// Reunión (y la pantalla Simple, que comparte sus controles): vista previa de lo que recibe Meet (la
// imagen la gestiona camera-fx.js), cámara y micrófono, idiomas y voz (voice.js pinta el selector),
// retraso y qué pasa si el doblaje no llega, salida hacia Meet, ayuda de qué elegir en Meet, checklist y
// botón principal de la sesión. Los ajustes finos viven en las demás pestañas de Avanzado.

import { native } from './bridge.js';
import { previewCss } from './camera-fx.js';
import { $, bindSegmented, debounce, fillSelect, fmtClock, h, icon, setBusy, setIcon, setSegmented, toast, toastError } from './dom.js';
import { langName, SOURCE_LANGS, TARGET_LANGS } from './data.js';
import { goTab, reveal } from './nav.js';
import { hooks, preflight, toggleSession } from './session.js';
import { cameraDelayMs, needsRestart, patchSettings, setDelay, state, subscribe, virtualCameraUp } from './store.js';

const els = {};
const nameCache = new Map();  // id → nombre visto (para rotular dispositivos desconectados)

function setHint(el, text, tone) {
  el.hidden = !text;
  el.textContent = text || '';
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}

const FALLBACK_HINTS = {
  silence: () => 'Si una frase no se dobla a tiempo, Meet oye silencio en ese tramo.',
  original: (lang) => `Si una frase no se dobla a tiempo, Meet oye tu voz original en ${lang} a volumen normal.`,
  duck: () => 'Si una frase no se dobla a tiempo, Meet oye tu voz original muy bajita.',
};

const isVirtualOutput = (name) => /voxora meet|cable input|vb-audio|virtual|voicemeeter/i.test(name || '');
const isRecommended = (name) => /voxora meet speaker/i.test(name || '');
const captureFor = (name) => (/voxora/i.test(name || '') ? 'VOXORA Meet Microphone' : /cable input/i.test(name || '') ? 'CABLE Output' : null);

// ── Vista previa de cámara (getUserMedia en WebView2) ───────────────────────
// Con la cámara virtual en marcha (cámara permanente o sesión) la webcam física es del shell: la
// vista previa abre «VOXORA Meet Camera», exactamente lo que ve Meet (en vivo o con el retraso del
// doblaje). Sin cámara virtual abre la webcam elegida, como siempre. Chromium la lista como
// «VOXORA Meet Camera (Windows Virtual Camera)»: se busca por inclusión.
const VCAM_NAME = 'VOXORA Meet Camera';
const isVcamLabel = (label) => /voxora meet camera/i.test(label || '');
let previewStream = null;
let previewGen = 0;
let previewPaused = false;  // mientras el shell abre la webcam física al iniciar (sin cámara virtual previa)
let previewEnabled = true;
try { previewEnabled = localStorage.getItem('voxora.preview') !== 'off'; } catch { /* sin almacenamiento */ }
// Vistas con la vista previa (nav.js la mueve a la visible). En Simple no hay botón para ocultarla.
const PREVIEW_VIEWS = new Set(['simple', 'meeting', 'camera']);
const previewOn = () => previewEnabled || state.uiMode === 'simple';

// Chromium añade " (vid:pid)" a las webcams USB; se ignora al comparar con el nombre de Windows.
const normLabel = (s) => String(s || '').toLowerCase().replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/, '').trim();

async function findMediaDevice(kind, name) {
  if (!navigator.mediaDevices?.enumerateDevices || !name) return null;
  let list = await navigator.mediaDevices.enumerateDevices();
  if (!list.some((d) => d.kind === kind && d.label)) {
    // Sin permiso aún no hay etiquetas: se pide una vez (WebView2 lo concede al origen propio).
    const probe = await navigator.mediaDevices.getUserMedia(kind === 'videoinput' ? { video: true } : { audio: true });
    probe.getTracks().forEach((t) => t.stop());
    list = await navigator.mediaDevices.enumerateDevices();
  }
  let candidates = list.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  // La cámara virtual y las webcams físicas nunca se confunden por coincidencias parciales («Camera»).
  if (kind === 'videoinput') candidates = candidates.filter((d) => isVcamLabel(d.label) === isVcamLabel(name));
  const target = normLabel(name);
  return candidates.find((d) => normLabel(d.label) === target)
    || candidates.find((d) => normLabel(d.label).includes(target) || (normLabel(d.label) && target.includes(normLabel(d.label))))
    || null;
}

/** Webcams físicas (la cámara virtual, si Windows la lista, no es una fuente elegible). */
const physicalCameras = () => state.devices.cameras.filter((c) => !isVcamLabel(c.name));

function selectedCamera() {
  const id = state.settings?.cameraDeviceId || '';
  const cams = physicalCameras();
  return id ? cams.find((c) => c.id === id) || null : cams[0] || null;
}

/** Qué debe mostrar la vista previa: la cámara virtual si existe (lo que ve Meet) o la webcam elegida. */
function previewSource() {
  const cam = selectedCamera();
  const running = state.session.state === 'running';
  // Fuera de la sesión y sin webcam no se abre la virtual (solo mostraría la imagen de espera).
  if (virtualCameraUp() && state.devices.virtualCamera?.installed !== false && (cam || running)) {
    return { kind: 'virtual', key: 'virtual', name: VCAM_NAME, cam };
  }
  return cam ? { kind: 'physical', key: `cam:${cam.id}`, name: cam.name, cam } : null;
}

function stopPreview() {
  previewGen++;
  if (previewStream) previewStream.getTracks().forEach((t) => t.stop());
  previewStream = null;
  els.video.srcObject = null;
  delete els.video.dataset.src;
  els.preview.classList.remove('has-video');
  applyPreviewFx();
}

// La cámara virtual ya trae la imagen procesada (es la salida real): se muestra tal cual. La webcam
// física (cámara virtual apagada) se aproxima con CSS para que los ajustes se vean igual.
function applyPreviewFx() {
  const physical = Boolean(previewStream?.active) && els.video.dataset.src && els.video.dataset.src !== 'virtual';
  els.preview.dataset.src = physical ? 'physical' : previewStream?.active ? 'virtual' : '';
  const css = physical ? previewCss() : { transform: 'none', filter: 'none', clip: 'none' };
  els.video.style.transform = css.transform;
  els.video.style.filter = css.filter;
  els.video.style.clipPath = css.clip;
}

function previewPlaceholder(text) {
  els.previewEmptyText.textContent = text;
  els.preview.classList.remove('has-video');
}

async function refreshPreview() {
  const src = previewSource();
  const busy = state.session.state === 'starting' || state.session.state === 'stopping';
  // La cámara virtual puede seguir abierta al iniciar/detener: no compite por la webcam con el shell.
  const wanted = previewOn() && !document.hidden && PREVIEW_VIEWS.has(state.activeTab) && src
    && (src.kind === 'virtual' || (!previewPaused && !busy));
  if (!wanted) {
    stopPreview();
    if (!previewOn()) previewPlaceholder('Vista previa oculta');
    else if (!state.devices.received) previewPlaceholder('Buscando cámaras…');
    else if (!src) previewPlaceholder(state.settings?.cameraDeviceId ? 'La cámara elegida no está conectada' : 'No hay ninguna cámara conectada');
    else if (state.session.state === 'stopping') previewPlaceholder('Cerrando la sesión…');
    else if (previewPaused || busy) previewPlaceholder('Conectando la cámara con Meet…');
    return;
  }
  // La webcam física solo sustituye a la virtual fuera de la sesión (durante ella la tiene el shell).
  const allowFallback = state.session.state === 'idle' && !previewPaused;
  const fallbackKey = src.cam ? `fallback:${src.cam.id}` : '';
  const current = previewStream?.active ? els.video.dataset.src || '' : '';
  if (current && current === src.key) return;
  let gen = previewGen;
  if (current && src.kind === 'virtual' && current === fallbackKey && allowFallback) {
    // La virtual existe pero Chromium aún no la lista: se sigue con la webcam hasta que aparezca.
    const found = await findMediaDevice('videoinput', VCAM_NAME).catch(() => null);
    if (!found || gen !== previewGen) return;
  }
  stopPreview();
  gen = ++previewGen;
  previewPlaceholder(src.kind === 'virtual' ? 'Abriendo VOXORA Meet Camera…' : 'Abriendo la cámara…');
  try {
    let key = src.key;
    let device = await findMediaDevice('videoinput', src.name);
    if (!device && src.kind === 'virtual' && allowFallback && src.cam) {
      device = await findMediaDevice('videoinput', src.cam.name);
      key = fallbackKey;
    }
    if (gen !== previewGen) return;
    if (!device) {
      previewPlaceholder(src.kind === 'virtual' && !allowFallback ? 'Meet recibe tu cámara; la vista previa aparecerá en un momento'
        : 'Vista previa no disponible para esta cámara');
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: device.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    if (gen !== previewGen) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    previewStream = stream;
    els.video.dataset.src = key;
    els.video.srcObject = stream;
    els.preview.classList.add('has-video');
    applyPreviewFx();
    stream.getVideoTracks()[0]?.addEventListener('ended', () => { if (previewStream === stream) refreshPreview(); });
  } catch (error) {
    if (gen !== previewGen) return;
    previewPlaceholder(src.kind === 'physical' && state.session.state === 'running'
      ? 'La cámara está en uso por el doblaje: Meet sí la recibe'
      : error?.name === 'NotReadableError' ? 'Otra aplicación está usando la cámara' : 'No se pudo abrir la vista previa');
  }
}
const refreshPreviewSoon = debounce(refreshPreview, 120);

const fmtDelay = (ms) => (ms / 1000).toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function renderPreviewBadge() {
  const running = state.session.state === 'running';
  const virtual = virtualCameraUp();
  const delayMs = state.camera.mode === 'dubbing' ? cameraDelayMs() : (state.settings?.delayMs ?? 3000);
  const simulated = previewStream?.active && els.video.dataset.src !== 'virtual';
  els.previewBadge.textContent = running ? `En Meet con +${fmtDelay(delayMs)} s` : virtual && !simulated ? 'En Meet · en vivo' : 'Vista previa';
  if (running || virtual) els.previewBadge.dataset.tone = 'live';
  else delete els.previewBadge.dataset.tone;
  els.previewToggle.setAttribute('aria-pressed', String(previewEnabled));
  els.previewToggle.title = previewEnabled ? 'Ocultar vista previa' : 'Mostrar vista previa';
  els.previewToggle.setAttribute('aria-label', els.previewToggle.title);
  setIcon(els.previewToggle, previewEnabled ? 'eye' : 'eye-off');
}

// ── Prueba de micrófono ─────────────────────────────────────────────────────
let micTest = null;

function stopMicTest() {
  if (!micTest) return;
  cancelAnimationFrame(micTest.raf);
  clearTimeout(micTest.timer);
  micTest.stream.getTracks().forEach((t) => t.stop());
  micTest.ctx.close().catch(() => {});
  micTest = null;
  els.micTestMeter.hidden = true;
  els.micTest.setAttribute('aria-pressed', 'false');
  els.micTest.textContent = 'Probar';
}

async function startMicTest() {
  const id = state.settings?.micDeviceId || '';
  const mic = id ? state.devices.mics.find((m) => m.id === id) : state.devices.mics.find((m) => m.default) || state.devices.mics[0];
  try {
    const device = mic ? await findMediaDevice('audioinput', mic.name) : null;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: device ? { exact: device.deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const fill = els.micTestMeter.querySelector('.meter__fill');
    micTest = { stream, ctx, raf: 0, timer: setTimeout(stopMicTest, 20000) };
    els.micTestMeter.hidden = false;
    els.micTest.setAttribute('aria-pressed', 'true');
    els.micTest.textContent = 'Parar';
    const loop = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const db = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-6);
      fill.style.setProperty('--level', `${Math.max(0, Math.min(1, (db + 60) / 60)) * 100}%`);
      micTest.raf = requestAnimationFrame(loop);
    };
    loop();
  } catch {
    stopMicTest();
    toast({ kind: 'warn', title: 'No se pudo probar el micrófono', message: 'Revisa que esté conectado y que Windows permita el acceso al micrófono.' });
  }
}

// ── Render ──────────────────────────────────────────────────────────────────
let meetLineAction = null;
/** Línea de ayuda de Simple: qué cámara y qué micrófono elegir en Meet, con estado ok / aviso. */
function renderMeetLine(capture, noVirtual) {
  const { received, virtualCamera } = state.devices;
  const name = (text) => h('strong', {}, `«${text}»`);
  let tone = '';
  let parts = ['En Meet elige: cámara ', name(VCAM_NAME), ' y micrófono ', name(capture || '…'), '.'];
  meetLineAction = null;
  if (received && noVirtual) {
    tone = 'warn';
    parts = ['Falta el micrófono virtual: sin él, Meet no puede oír tu voz doblada.'];
    meetLineAction = { label: 'Descargar VB-Cable', run: () => native('native.openExternal', { url: 'https://vb-audio.com/Cable/' }).catch(toastError) };
  } else if (received && !capture) {
    tone = 'warn';
    parts = ['La salida del doblaje no es un micrófono virtual: Meet no la oirá.'];
    meetLineAction = { label: 'Cambiarla', run: () => reveal('#sel-output') };
  } else if (received && virtualCamera?.installed === false) {
    tone = 'warn';
    parts = ['Falta la cámara virtual de VOXORA Meet. En Meet elige el micrófono ', name(capture), '.'];
  } else if (received) tone = 'ok';
  els.meetLineText.replaceChildren(...parts);
  if (tone) els.meetLine.dataset.tone = tone;
  else delete els.meetLine.dataset.tone;
  setIcon(els.meetLineIcon, tone === 'ok' ? 'check-circle' : tone === 'warn' ? 'alert' : 'info');
  els.meetLineBtn.hidden = !meetLineAction;
  els.meetLineBtn.textContent = meetLineAction?.label || '';
}

function renderDevices() {
  const { mics, renderEndpoints, virtualMic, received } = state.devices;
  const cameras = physicalCameras();
  const s = state.settings || {};
  for (const c of cameras) nameCache.set(c.id, c.name);
  for (const m of mics) nameCache.set(m.id, m.name);

  // Cámara
  const camId = s.cameraDeviceId || '';
  const camOptions = [{ value: '', label: cameras.length ? `Automática (${cameras[0].name})` : 'Automática (primera disponible)' },
    ...cameras.map((c) => ({ value: c.id, label: c.name }))];
  const camMissing = received && camId && !cameras.some((c) => c.id === camId);
  if (camMissing) camOptions.push({ value: camId, label: `${nameCache.get(camId) || 'Cámara elegida'} (desconectada)` });
  fillSelect(els.camera, camOptions, camId);
  els.camera.dataset.tone = camMissing ? 'warn' : '';
  setHint(els.cameraHint,
    camMissing ? 'Esta cámara no está conectada. Conéctala o elige otra: mientras tanto Meet verá la imagen de espera.'
      : received && !cameras.length ? 'No se detecta ninguna cámara. Conecta una y aparecerá aquí sola.' : '',
    'warn');

  // Micrófono
  const micId = s.micDeviceId || '';
  const def = mics.find((m) => m.default);
  const micOptions = [{ value: '', label: def ? `Predeterminado de Windows (${def.name})` : 'Predeterminado de Windows' },
    ...mics.map((m) => ({ value: m.id, label: m.name }))];
  const micMissing = received && micId && !mics.some((m) => m.id === micId);
  if (micMissing) micOptions.push({ value: micId, label: `${nameCache.get(micId) || 'Micrófono elegido'} (desconectado)` });
  fillSelect(els.mic, micOptions, micId);
  els.mic.dataset.tone = micMissing ? 'warn' : '';
  setHint(els.micHint,
    micMissing ? 'Este micrófono no está conectado. Conéctalo o elige otro.'
      : received && !mics.length ? 'No se detecta ningún micrófono.' : '',
    'warn');

  // Salida del doblaje
  const outputs = renderEndpoints.map((e) => e.name).filter(Boolean);
  const current = s.virtualMicDevice || '';
  const resolved = virtualMic?.resolvedDevice || '';
  const matchName = outputs.find((n) => n === current) || outputs.find((n) => current && n.toLowerCase().includes(current.toLowerCase())) || resolved;
  const recommended = outputs.find(isRecommended) || outputs.find((n) => /cable input/i.test(n));
  const outOptions = outputs.map((name) => ({
    value: name,
    label: name === recommended ? `${name} · recomendado` : name,
    group: isVirtualOutput(name) ? 'Dispositivos virtuales (para Meet)' : 'Otras salidas',
  }));
  let outValue = matchName || '';
  if (!outValue) {
    outOptions.unshift({ value: '', label: received ? 'Ningún micrófono virtual instalado' : 'Buscando salidas…', disabled: true });
  }
  fillSelect(els.output, outOptions, outValue);
  const nonVirtual = outValue && !isVirtualOutput(outValue);
  const noVirtual = received && !outputs.some(isVirtualOutput);
  els.output.dataset.tone = noVirtual ? 'bad' : nonVirtual ? 'warn' : '';
  setHint(els.outputHint,
    noVirtual ? 'No hay micrófono virtual: instala VB-Audio Virtual Cable (gratis) o el driver de VOXORA Meet y pulsa «Actualizar».'
      : nonVirtual ? 'Meet no puede oír esta salida. Úsala solo para pruebas: para reuniones elige un dispositivo virtual.'
        : virtualMic?.fallback ? `«${current}» no está disponible; se usará «${resolved}».` : '',
    noVirtual ? 'bad' : 'warn');
  els.meetMic.textContent = virtualMic?.captureName || captureFor(outValue) || '—';
  renderMeetLine(nonVirtual ? '' : virtualMic?.captureName || captureFor(outValue) || '', noVirtual);

  // Escucha local (monitor)
  const monitor = s.monitorDevice || '';
  const monOptions = [{ value: '', label: 'No escuchar' }, ...outputs.filter((n) => !isVirtualOutput(n)).map((n) => ({ value: n, label: n }))];
  if (monitor && !outputs.includes(monitor)) monOptions.push({ value: monitor, label: `${monitor} (desconectado)` });
  fillSelect(els.monitor, monOptions, monitor);
}

function renderTranslation() {
  const s = state.settings;
  if (!s) return;
  const src = s.sourceLanguage || 'es';
  const dst = s.targetLanguage || 'en';
  const srcOpts = SOURCE_LANGS.map((c) => ({ value: c, label: langName(c) }));
  if (!SOURCE_LANGS.includes(src)) srcOpts.push({ value: src, label: langName(src) });
  const dstOpts = TARGET_LANGS.map((c) => ({ value: c, label: langName(c) }));
  if (!TARGET_LANGS.includes(dst)) dstOpts.push({ value: dst, label: langName(dst) });
  fillSelect(els.src, srcOpts, src);
  fillSelect(els.dst, dstOpts, dst);
  setSegmented(els.fallback, s.fallbackMode || 'silence');
  const srcName = langName(src).toLowerCase();
  els.fallbackOriginal.textContent = `Mi voz en ${srcName}`;
  els.fallbackHint.textContent = (FALLBACK_HINTS[s.fallbackMode] || FALLBACK_HINTS.silence)(srcName);
  if (!els.delay.matches(':active')) els.delay.value = String((s.delayMs ?? 3000) / 1000);
  renderDelayLabel();
}

function renderDelayLabel() {
  const v = Number(els.delay.value);
  els.delayValue.textContent = `${v.toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
  els.delay.style.setProperty('--fill', `${((v - 2) / 4) * 100}%`);
}

// Checklist compacta: solo lo que falta (con su acción); si todo está bien, una sola línea.
function renderPreflight() {
  const items = preflight();
  const missing = items.filter((item) => !item.ok);
  const rows = missing.length ? missing : [{ ok: true, label: 'Todo listo para empezar', title: `Todo listo: ${items.filter((i) => i.ok && i.id !== 'engine').map((i) => i.short || i.label).join(' · ')}` }];
  els.preflight.replaceChildren(...rows.map((item) => h('li', { dataset: { ok: String(item.ok) } },
    icon(item.ok ? 'check-circle' : 'alert'),
    h('span', { title: item.title || item.label }, item.label),
    !item.ok && item.action ? h('button', { class: 'link', type: 'button', onclick: item.action.run }, item.action.label) : null,
  )));
}

// Campos de esta pestaña que el motor toma al iniciar la sesión (tono y estilo avisan en «Modelos»).
const MEETING_RESTART_FIELDS = new Set(['sourceLanguage', 'targetLanguage', 'micDeviceId', 'virtualMicDevice', 'monitorDevice', 'maxVoxPerSession', 'warnAtVox']);

let timer = 0;
function renderSession() {
  const st = state.session.state;
  const btn = els.main;
  btn.classList.toggle('btn--brand', st === 'idle' || st === 'starting');
  btn.classList.toggle('btn--stop', st === 'running' || st === 'stopping');
  const label = btn.querySelector('span');
  setBusy(btn, false);
  if (st === 'idle') { setIcon(btn, 'play'); label.textContent = 'Iniciar doblaje'; }
  if (st === 'running') { setIcon(btn, 'stop'); label.textContent = 'Detener doblaje'; }
  if (st === 'starting') setBusy(btn, true, 'Iniciando…');
  if (st === 'stopping') setBusy(btn, true, 'Deteniendo…');
  btn.disabled = st === 'starting' || st === 'stopping';
  btn.setAttribute('aria-live', 'polite');
  const restart = st === 'running' && [...needsRestart.fields].some((k) => MEETING_RESTART_FIELDS.has(k));
  els.restartHint.hidden = !restart;
  clearInterval(timer);
  const tick = () => {
    const s = state.settings || {};
    if (state.session.state === 'running') {
      // En Simple no hay insignia «Se aplica al reiniciar»: lo dice la línea de estado.
      const tail = restart ? 'reinicia para aplicar los cambios' : `${langName(s.sourceLanguage)} → ${langName(s.targetLanguage)}`;
      els.sub.textContent = `En vivo · ${fmtClock(Date.now() - state.session.startedAt)} · ${tail}`;
      els.sub.dataset.tone = 'ok';
    } else {
      delete els.sub.dataset.tone;
      els.sub.textContent = st === 'starting' ? 'Preparando micrófono, voz y cámara…' : st === 'stopping' ? 'Cerrando la sesión…'
        : `Meet te oirá en ${langName(s.targetLanguage || 'en').toLowerCase()} con ${(((s.delayMs ?? 3000) / 1000)).toLocaleString('es-ES', { minimumFractionDigits: 1 })} s de retraso.`;
    }
  };
  tick();
  if (st === 'running') timer = setInterval(tick, 1000);
  renderPreviewBadge();
}

// ── Init ────────────────────────────────────────────────────────────────────
export function initMeeting() {
  Object.assign(els, {
    camera: $('#sel-camera'), cameraHint: $('#camera-hint'), mic: $('#sel-mic'), micHint: $('#mic-hint'),
    micTest: $('#btn-mic-test'), micTestMeter: $('#mic-test-meter'),
    preview: $('#preview'), video: $('#cam-preview'), previewEmptyText: $('#preview-empty-text'),
    previewBadge: $('#preview-badge'), previewToggle: $('#btn-preview-toggle'),
    refresh: $('#btn-refresh-devices'),
    src: $('#sel-src'), dst: $('#sel-dst'), swap: $('#btn-swap'),
    delay: $('#rng-delay'), delayValue: $('#delay-value'), fallback: $('#seg-fallback'), fallbackHint: $('#fallback-hint'),
    fallbackOriginal: $('#fallback-original-label'),
    meetLine: $('#meet-line'), meetLineText: $('#meet-line-text'), meetLineIcon: $('#meet-line-icon'), meetLineBtn: $('#btn-meet-line'),
    output: $('#sel-output'), outputHint: $('#output-hint'), meetMic: $('#meet-mic-name'), monitor: $('#sel-monitor'),
    preflight: $('#preflight'), main: $('#btn-session-main'), sub: $('#session-sub'), restartHint: $('#restart-hint'),
  });

  els.camera.addEventListener('change', () => { patchSettings({ cameraDeviceId: els.camera.value }); refreshPreviewSoon(); });
  els.mic.addEventListener('change', () => { stopMicTest(); patchSettings({ micDeviceId: els.mic.value }); });
  els.micTest.addEventListener('click', () => (micTest ? stopMicTest() : startMicTest()));
  els.previewToggle.addEventListener('click', () => {
    previewEnabled = !previewEnabled;
    try { localStorage.setItem('voxora.preview', previewEnabled ? 'on' : 'off'); } catch { /* opcional */ }
    renderPreviewBadge();
    refreshPreview();
  });
  els.refresh.addEventListener('click', async () => {
    els.refresh.classList.add('is-busy');
    setIcon(els.refresh, 'loader');
    try { await native('native.devices.refresh'); } catch (error) { toastError(error); }
    setTimeout(() => { els.refresh.classList.remove('is-busy'); setIcon(els.refresh, 'refresh'); }, 700);
  });

  els.src.addEventListener('change', () => patchSettings({ sourceLanguage: els.src.value }));
  els.dst.addEventListener('change', () => patchSettings({ targetLanguage: els.dst.value }));
  els.swap.addEventListener('click', () => {
    const src = els.src.value;
    const dst = els.dst.value;
    if (!TARGET_LANGS.includes(src)) {
      toast({ kind: 'warn', title: 'No se puede intercambiar', message: `La voz clonada aún no puede hablar en ${langName(src).toLowerCase()}.` });
      return;
    }
    patchSettings({ sourceLanguage: dst, targetLanguage: src });
  });
  bindSegmented(els.fallback, (value) => patchSettings({ fallbackMode: value }));
  $('#btn-goto-camera').addEventListener('click', () => goTab('camera'));
  els.meetLineBtn.addEventListener('click', () => meetLineAction?.run());
  els.delay.addEventListener('input', () => {
    renderDelayLabel();
    setDelay(Math.round(Number(els.delay.value) * 1000));
  });
  els.output.addEventListener('change', async () => {
    patchSettings({ virtualMicDevice: els.output.value });
    // La resolución del endpoint (y el nombre que hay que elegir en Meet) la recalcula el motor.
    setTimeout(() => native('native.devices.refresh').catch(() => {}), 700);
  });
  els.monitor.addEventListener('change', () => patchSettings({ monitorDevice: els.monitor.value }));
  els.main.addEventListener('click', toggleSession);

  hooks.beforeStart.push(async () => {
    stopMicTest();
    // Si la vista previa ya muestra la cámara virtual, la webcam es del shell: no hay nada que soltar.
    if (previewStream?.active && els.video.dataset.src === 'virtual') return;
    previewPaused = true;
    stopPreview();
    previewPlaceholder('Conectando la cámara con Meet…');
    await new Promise((r) => setTimeout(r, 150));  // deja que Windows libere la webcam
  });
  hooks.afterStart.push(() => { setTimeout(() => { previewPaused = false; refreshPreview(); }, 1500); });
  hooks.afterStop.push(() => { previewPaused = false; refreshPreviewSoon(); });

  subscribe('devices', () => { renderDevices(); renderPreflight(); refreshPreviewSoon(); });
  subscribe('settings', () => { renderDevices(); renderTranslation(); renderPreflight(); renderSession(); applyPreviewFx(); refreshPreviewSoon(); });
  subscribe('keys', renderPreflight);
  subscribe('engine', renderPreflight);
  subscribe('session', () => { renderSession(); renderPreflight(); });
  // La cámara virtual aparece/desaparece (cámara permanente, inicio/fin de sesión): cambia el origen.
  subscribe('camera', () => { renderPreviewBadge(); refreshPreviewSoon(); });
  // «Probar» el micrófono solo existe en Reunión; la vista previa, en Simple, Reunión y Cámara.
  subscribe('tab', () => { if (state.activeTab !== 'meeting') stopMicTest(); refreshPreviewSoon(); });
  subscribe('mode', () => { renderPreviewBadge(); refreshPreviewSoon(); });
  document.addEventListener('visibilitychange', refreshPreviewSoon);
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshPreviewSoon);

  renderDevices();
  renderPreflight();
  renderSession();
  renderPreviewBadge();
}
