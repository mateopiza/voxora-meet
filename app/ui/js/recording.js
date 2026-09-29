// «Grabar prueba» (tarjeta Salida a Meet): graba 10–30 s de exactamente lo que recibe Meet — el video
// que el shell publica en la cámara virtual (con la imagen y el retraso vigentes) y el audio del
// micrófono virtual — en un MP4 (IMFSinkWriter, H.264 + AAC) y lo reproduce en una hoja con
// «Abrir carpeta» y «Borrar». Sin sesión de doblaje se oye lo que oye Meet ahora: silencio.
//
// Comandos nativos: native.recording.start|stop|list|delete|reveal · eventos recording.progress|done.

import { native, on } from './bridge.js';
import { $, bindSegmented, fmtBytes, fmtClock, h, onSheetClose, openSheet, closeSheet, setSegmented, toast, toastError } from './dom.js';
import { state, subscribe } from './store.js';

const els = {};
let phase = 'idle';  // idle | countdown | recording | finishing
let seconds = 10;
let countdownTimer = 0;
let startedAt = 0;
let tickTimer = 0;
let last = null;     // último resultado/archivo mostrable { path, url, name, durationMs, sizeBytes, … }
let deleteArmed = 0;

function setPhase(next) {
  phase = next;
  const busy = next !== 'idle';
  els.progress.hidden = !busy;
  els.btn.classList.toggle('btn--stop', next === 'recording' || next === 'countdown');
  els.btn.classList.toggle('btn--glass', next === 'idle' || next === 'finishing');
  els.btn.disabled = next === 'finishing';
  els.btnLabel.textContent = next === 'countdown' ? 'Cancelar' : next === 'recording' ? 'Detener' : next === 'finishing' ? 'Guardando…' : 'Grabar prueba';
  els.rec.dataset.phase = next;
  for (const b of els.seconds.querySelectorAll('button')) b.disabled = busy;
  if (!busy) {
    clearInterval(tickTimer);
    els.count.textContent = '';
    setMeter(els.timeFill, 0);
    setMeter(els.levelFill, 0);
    renderHint();
  }
}

function setMeter(fill, ratio) {
  fill.style.setProperty('--level', `${Math.max(0, Math.min(1, ratio)) * 100}%`);
}

function renderHint() {
  if (phase !== 'idle') return;
  const vmic = state.devices.virtualMic;
  const running = state.session.state === 'running';
  let text = 'Graba exactamente lo que recibe Meet (cámara y micrófono virtuales) y te lo enseña.';
  if (state.devices.received && !vmic?.resolvedDevice) text = 'Sin micrófono virtual la prueba solo tendrá imagen.';
  else if (!running) text = 'Sin doblaje en marcha Meet no oye nada: la prueba grabará tu imagen y silencio. Inicia el doblaje para oírte doblado.';
  els.hint.textContent = text;
}

// ── Grabar ──────────────────────────────────────────────────────────────────
function startCountdown() {
  if (state.session.state === 'starting' || state.session.state === 'stopping') {
    toast({ kind: 'info', title: 'Un momento', message: 'Espera a que el doblaje termine de iniciarse o detenerse.' });
    return;
  }
  setPhase('countdown');
  let n = 3;
  els.count.textContent = String(n);
  els.hint.textContent = 'Prepárate: la grabación empieza en…';
  countdownTimer = setInterval(() => {
    n -= 1;
    if (n > 0) {
      els.count.textContent = String(n);
      return;
    }
    clearInterval(countdownTimer);
    beginRecording();
  }, 1000);
}

async function beginRecording() {
  els.count.textContent = '●';
  try {
    const r = await native('native.recording.start', { seconds }, 20000);
    setPhase('recording');
    startedAt = performance.now();
    els.hint.textContent = 'Grabando lo que recibe Meet…';
    if (r?.warning) toast({ kind: 'warn', title: 'Prueba incompleta', message: r.warning });
    const tick = () => {
      const elapsed = (performance.now() - startedAt) / 1000;
      els.count.textContent = String(Math.max(0, Math.ceil(seconds - elapsed)));
      setMeter(els.timeFill, elapsed / seconds);
    };
    tick();
    tickTimer = setInterval(tick, 200);
  } catch (error) {
    setPhase('idle');
    if (error.code === 'unknown_command') toast({ kind: 'warn', title: 'Función no disponible', message: 'Esta versión de VOXORA Meet no puede grabar pruebas: actualízala.' });
    else toast({ kind: 'error', title: 'No se pudo grabar la prueba', message: error.message });
  }
}

function onButton() {
  if (phase === 'idle') startCountdown();
  else if (phase === 'countdown') {
    clearInterval(countdownTimer);
    setPhase('idle');
  } else if (phase === 'recording') {
    setPhase('finishing');
    native('native.recording.stop').catch(() => {});
  }
}

function onProgress(data) {
  if (phase !== 'recording') return;
  const db = Number(data.levelDb);
  setMeter(els.levelFill, Number.isFinite(db) ? (db + 60) / 60 : 0);
  if (Number.isFinite(Number(data.elapsedMs))) startedAt = performance.now() - Number(data.elapsedMs);
}

function onDone(data) {
  if (phase === 'idle' && !data?.ok) return;  // p. ej. un error de arranque ya avisado
  setPhase('idle');
  if (!data?.ok) {
    toast({ kind: 'error', title: 'La prueba no se pudo guardar', message: data?.message || 'Inténtalo de nuevo.' });
    return;
  }
  last = data;
  els.last.hidden = false;
  showRecording(data);
}

// ── Hoja «Así te ve y te oye Meet» ──────────────────────────────────────────
function showRecording(item) {
  if (!item) return;
  last = item;
  const dialog = openSheet('sheet-recording');
  if (!dialog) return;
  clearTimeout(deleteArmed);
  deleteArmed = 0;
  els.del.lastChild.textContent = 'Borrar';
  if (item.url) {
    els.video.hidden = false;
    els.empty.hidden = true;
    els.video.src = item.url;
    els.video.play().catch(() => {});
  } else {
    els.video.hidden = true;
    els.empty.hidden = false;
    els.empty.textContent = 'Aquí verás tu prueba (en el simulador no hay video).';
  }
  const rows = [
    ['Duración', Number.isFinite(Number(item.durationMs)) ? fmtClock(item.durationMs) : '—'],
    ['Tamaño', Number.isFinite(Number(item.sizeBytes)) ? fmtBytes(Number(item.sizeBytes)) : '—'],
    ['Audio', item.hasAudio === false ? 'Sin audio' : item.audioDevice || (item.hasAudio ? 'Micrófono virtual' : '—')],
    ['Imagen', item.hasVideo === false ? 'Sin imagen' : item.cameraFrames === 0 ? 'En negro (la cámara virtual no publicaba)' : 'VOXORA Meet Camera'],
    ['Archivo', item.name || '—'],
  ];
  els.meta.replaceChildren(...rows.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', { title: v }, v))));
  els.note.textContent = item.message || (state.session.state === 'running' || item.hasAudio === false
    ? '' : 'Grabada sin doblaje en marcha: el audio es lo que Meet oye ahora mismo (silencio).');
}

function releaseVideo() {
  els.video.pause();
  els.video.removeAttribute('src');
  els.video.load();
}

async function deleteLast() {
  if (!last?.path) return;
  if (!deleteArmed) {
    els.del.lastChild.textContent = '¿Borrar? Pulsa otra vez';
    deleteArmed = setTimeout(() => { deleteArmed = 0; els.del.lastChild.textContent = 'Borrar'; }, 4000);
    return;
  }
  clearTimeout(deleteArmed);
  deleteArmed = 0;
  releaseVideo();  // WebView2 suelta el archivo antes de borrarlo
  try {
    await native('native.recording.delete', { path: last.path }, 10000);
    closeSheet('sheet-recording');
    toast({ kind: 'info', title: 'Prueba borrada', timeout: 2500 });
    last = null;
    await loadLast();
  } catch (error) {
    toastError(error, 'No se pudo borrar la prueba');
  }
}

async function loadLast() {
  try {
    const r = await native('native.recording.list', {}, 8000);
    last = Array.isArray(r?.items) && r.items.length ? r.items[0] : null;
  } catch {
    last = null;
  }
  els.last.hidden = !last;
}

export function initRecording() {
  Object.assign(els, {
    rec: $('#rec-test'), hint: $('#rec-test-hint'), seconds: $('#seg-rec-seconds'), btn: $('#btn-rec-test'), last: $('#btn-rec-last'),
    progress: $('#rec-progress'), count: $('#rec-count'), timeFill: $('#rec-time .meter__fill'), levelFill: $('#rec-level .meter__fill'),
    video: $('#rec-video'), empty: $('#rec-video-empty'), meta: $('#rec-meta'), note: $('#rec-note'),
    folder: $('#btn-rec-folder'), del: $('#btn-rec-delete'), again: $('#btn-rec-again'),
  });
  els.btnLabel = els.btn.querySelector('span:last-child');
  try { seconds = [10, 20, 30].includes(Number(localStorage.getItem('voxora.recSeconds'))) ? Number(localStorage.getItem('voxora.recSeconds')) : 10; } catch { /* opcional */ }
  setSegmented(els.seconds, String(seconds));
  bindSegmented(els.seconds, (value) => {
    seconds = Number(value);
    setSegmented(els.seconds, value);
    try { localStorage.setItem('voxora.recSeconds', value); } catch { /* opcional */ }
  });
  els.btn.addEventListener('click', onButton);
  els.last.addEventListener('click', () => showRecording(last));
  els.folder.addEventListener('click', () => native('native.recording.reveal', { path: last?.path || '' }).catch(toastError));
  els.del.addEventListener('click', deleteLast);
  els.again.addEventListener('click', () => {
    closeSheet('sheet-recording');
    if (phase === 'idle') startCountdown();
  });
  onSheetClose('sheet-recording', releaseVideo);

  on('native-event', ({ event, data }) => {
    if (event === 'recording.progress') onProgress(data || {});
    else if (event === 'recording.done') onDone(data || {});
  });
  subscribe('devices', renderHint);
  subscribe('session', renderHint);
  setPhase('idle');
  // Con el motor listo el shell ya respondió a native.hello: se busca la última prueba guardada.
  setTimeout(loadLast, 800);
}

