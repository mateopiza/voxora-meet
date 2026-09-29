// Voz: selector de voces de la cuenta de ElevenLabs en Simple y Reunión (escuchar la muestra y usarla),
// Voice ID manual (Avanzado › Voz) y asistente «Clonar mi voz» en una hoja (grabar tomas o importar audio).

import { openAccounts } from './accounts.js';
import { engine, native } from './bridge.js';
import { $, closeSheet, fillSelect, fmtBytes, fmtClock, h, icon, openSheet, setBusy, setIcon, toast, toastError } from './dom.js';
import { CATEGORY_LABELS, langName, scriptsFor } from './data.js';
import { errorAction } from './session.js';
import { notify, state, subscribe } from './store.js';

const els = {};
const MIN_MS = 60000;
const IDEAL_MS = 120000;
const FULL_MS = 180000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const OWN = new Set(['cloned', 'professional', 'generated']);

// ── Voces de la cuenta ──────────────────────────────────────────────────────
export async function loadVoices({ quiet = false } = {}) {
  if (state.engine.state !== 'ready') return;
  if (!state.keys.elevenlabs) {
    Object.assign(state.voices, { list: [], loading: false, loaded: true, error: { code: 'missing_key', message: 'Conecta tu cuenta de ElevenLabs para ver tus voces.' } });
    notify('voices');
    return;
  }
  state.voices.loading = true;
  state.voices.error = null;
  notify('voices');
  try {
    const result = await engine('voices.list', {}, 30000);
    state.voices.list = Array.isArray(result.voices) ? result.voices : [];
    state.voices.currentVoiceId = result.currentVoiceId ?? state.settings?.voiceId ?? null;
    state.voices.loaded = true;
  } catch (error) {
    state.voices.error = { code: error.code, message: error.message };
    if (!quiet) toast({ kind: 'error', title: 'No se pudieron cargar tus voces', message: error.message, action: errorAction(error) });
  } finally {
    state.voices.loading = false;
    notify('voices');
  }
}

let audio = null;
let playingId = null;

function stopPreviewAudio() {
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  playingId = null;
  for (const b of document.querySelectorAll('[data-play]')) {
    b.setAttribute('aria-pressed', 'false');
    setIcon(b, 'play');
  }
}

function togglePlay(id, url, button) {
  if (playingId === id) {
    stopPreviewAudio();
    return;
  }
  stopPreviewAudio();
  if (!url) return;
  audio = audio || new Audio();
  audio.src = url;
  audio.onended = stopPreviewAudio;
  audio.onerror = () => {
    stopPreviewAudio();
    toast({ kind: 'warn', title: 'No se pudo reproducir la muestra', message: 'Comprueba tu conexión a internet e inténtalo de nuevo.' });
  };
  audio.play().catch(() => {});
  playingId = id;
  button.setAttribute('aria-pressed', 'true');
  setIcon(button, 'pause');
}

async function useVoice(voiceId, name) {
  els.voiceSel.disabled = true;
  try {
    const result = await engine('voice.set', { voiceId, name }, 30000);
    applyCurrentVoice(result.voiceId || voiceId, result.name || name);
    toast({ kind: 'success', title: 'Voz activa', message: `Meet te oirá con «${result.name || name}».`, timeout: 3000 });
  } catch (error) {
    toast({ kind: 'error', title: 'No se pudo usar esa voz', message: error.message, action: errorAction(error) });
    renderVoiceSelect();  // vuelve a la voz que sigue activa
  } finally {
    els.voiceSel.disabled = false;
  }
}

function applyCurrentVoice(voiceId, name) {
  if (!state.settings) state.settings = {};
  state.settings.voiceId = voiceId;
  state.settings.voiceName = name;
  state.voices.currentVoiceId = voiceId;
  for (const v of state.voices.list) v.isCurrent = v.voiceId === voiceId;
  notify('settings');
  notify('voices');
}

const selectedVoice = () => state.voices.list.find((v) => v.voiceId === (state.settings?.voiceId || '')) || null;

// Selector de Reunión: «Tus voces» (clonadas, profesionales, diseñadas) y «Biblioteca».
function renderVoiceSelect() {
  const { list, loading, error, loaded } = state.voices;
  const s = state.settings || {};
  const current = s.voiceId || '';
  const opts = [];
  if (!current) opts.push({ value: '', label: loading ? 'Cargando voces…' : 'Elige una voz…', disabled: true });
  const own = list.filter((v) => OWN.has(v.category));
  const library = list.filter((v) => !OWN.has(v.category));
  for (const v of own) opts.push({ value: v.voiceId, label: v.name, group: 'Tus voces' });
  for (const v of library) opts.push({ value: v.voiceId, label: v.name, group: 'Biblioteca de ElevenLabs' });
  if (current && !list.some((v) => v.voiceId === current)) opts.unshift({ value: current, label: s.voiceName || `Voice ID ${current}` });
  fillSelect(els.voiceSel, opts, current);
  els.voiceSel.dataset.tone = !current && loaded ? 'warn' : '';
  // Sin voz elegida ni voces propias: en Simple el campo es solo el botón «Clonar mi voz».
  els.field.dataset.empty = String(loaded && !loading && !error && !current && !own.length);

  const voice = selectedVoice();
  els.voicePlay.disabled = !voice?.previewUrl;
  els.voicePlay.title = voice?.previewUrl ? `Escuchar ${voice.name}` : 'Sin muestra disponible';

  let hint = '';
  let tone = '';
  if (loading && !list.length) hint = 'Cargando las voces de tu cuenta…';
  else if (error?.code === 'missing_key' || error?.code === 'provider_auth') {
    hint = error.message;
    tone = 'warn';
  } else if (error && !list.length) {
    hint = error.message;
    tone = 'bad';
  } else if (loaded && !own.length) hint = 'Aún no tienes tu voz clonada: créala en un par de minutos.';
  else if (voice) hint = CATEGORY_LABELS[voice.category] || '';
  else if (current) hint = 'Voz por Voice ID';
  els.voiceHint.textContent = hint;
  if (tone) els.voiceHint.dataset.tone = tone;
  else delete els.voiceHint.dataset.tone;
  els.voiceHint.classList.toggle('is-action', error?.code === 'missing_key' || error?.code === 'provider_auth');
}

async function submitVoiceId(event) {
  event.preventDefault();
  const voiceId = els.idInput.value.trim();
  if (!/^[A-Za-z0-9]{8,64}$/.test(voiceId)) {
    els.idInput.setAttribute('aria-invalid', 'true');
    els.idHint.dataset.tone = 'bad';
    els.idHint.textContent = 'El Voice ID son 8–64 letras y números, sin espacios (cópialo tal cual de ElevenLabs).';
    els.idInput.focus();
    return;
  }
  els.idInput.removeAttribute('aria-invalid');
  setBusy(els.idSave, true);
  els.idSave.disabled = true;
  try {
    const result = await engine('voice.set', { voiceId }, 30000);
    applyCurrentVoice(result.voiceId || voiceId, result.name || '');
    els.idInput.value = '';
    els.idHint.dataset.tone = 'ok';
    els.idHint.textContent = `Listo: «${result.name || voiceId}» es tu voz activa.`;
    if (!state.voices.list.some((v) => v.voiceId === voiceId)) loadVoices({ quiet: true });
  } catch (error) {
    els.idInput.setAttribute('aria-invalid', 'true');
    els.idHint.dataset.tone = 'bad';
    els.idHint.textContent = error.message;
  } finally {
    setBusy(els.idSave, false);
    els.idSave.disabled = false;
  }
}

/** Abre el asistente «Clonar mi voz». */
export function openClone() {
  if (!state.keys.elevenlabs && state.engine.state === 'ready') {
    toast({ kind: 'warn', title: 'Conecta ElevenLabs', message: 'Para clonar tu voz hace falta la API key de ElevenLabs.', action: { label: 'Conectar', run: openAccounts } });
  }
  renderClone();
  openSheet('sheet-clone');
}

// ── Asistente de clonación ──────────────────────────────────────────────────
const samples = [];  // { kind: 'take'|'file', path, url?, name, durationMs|null, sizeBytes? }
let recording = false;
let recordBusy = false;
let cloning = false;
let scriptIndex = 0;
let takeCounter = 0;
let lastKeyState = null;

function totalMs() {
  return samples.reduce((sum, s) => sum + (Number.isFinite(s.durationMs) ? s.durationMs : 0), 0);
}

function renderScript() {
  const lang = state.settings?.sourceLanguage || 'es';
  const scripts = scriptsFor(lang);
  els.scriptLang.textContent = langName(scripts === scriptsFor('en') && lang !== 'en' ? 'en' : lang);
  els.script.textContent = scripts[scriptIndex % scripts.length];
}

function renderProgress(liveMs = 0) {
  const total = totalMs() + liveMs;
  els.progressFill.style.setProperty('--progress', `${Math.min(1, total / FULL_MS) * 100}%`);
  els.total.textContent = fmtClock(total);
  const hint = els.totalHint;
  if (total < MIN_MS) {
    hint.textContent = `Faltan ${fmtClock(MIN_MS - total)} para el mínimo · ideal 2:00–3:00`;
    delete hint.dataset.tone;
  } else if (total < IDEAL_MS) {
    hint.textContent = 'Mínimo alcanzado · con 2–3 min sonará más natural';
    hint.dataset.tone = 'ok';
  } else {
    hint.textContent = '¡Muestra ideal! Ya puedes crear tu voz';
    hint.dataset.tone = 'ok';
  }
}

function sampleProblem(s) {
  if (Number.isFinite(s.sizeBytes) && s.sizeBytes > MAX_FILE_BYTES) return 'supera 10 MB';
  return '';
}

function renderSamples() {
  els.takes.replaceChildren(...samples.map((s, index) => {
    const problem = sampleProblem(s);
    const play = s.url ? h('button', { class: 'voice__play', type: 'button', 'data-play': s.path, 'aria-pressed': 'false', 'aria-label': `Escuchar ${s.name}` }, icon('play')) : null;
    if (play) play.addEventListener('click', () => togglePlay(s.path, s.url, play));
    const remove = h('button', { class: 'btn btn--ghost btn--icon', type: 'button', title: 'Quitar', 'aria-label': `Quitar ${s.name}`, disabled: cloning }, icon('trash'));
    remove.addEventListener('click', async () => {
      samples.splice(index, 1);
      if (s.kind === 'take') native('native.voice.record.discard', { path: s.path }).catch(() => {});
      renderClone();
    });
    const duration = Number.isFinite(s.durationMs) ? fmtClock(s.durationMs) : 'duración ?';
    return h('li', { class: 'take', dataset: { tone: problem ? 'bad' : '' } },
      icon(s.kind === 'take' ? 'mic' : 'music', 'take__icon'),
      h('span', { class: 'take__name', title: s.path }, s.name),
      h('span', { class: 'take__dur', title: problem || (Number.isFinite(s.durationMs) ? '' : 'Duración no medible: ElevenLabs la validará') },
        problem ? problem : s.sizeBytes ? `${duration} · ${fmtBytes(s.sizeBytes)}` : duration),
      play, remove);
  }));
}

function cloneBlocker() {
  const total = totalMs();
  const unmeasured = samples.some((s) => !Number.isFinite(s.durationMs));
  if (!state.keys.elevenlabs) return 'Añade tu API key de ElevenLabs en Ajustes.';
  if (!samples.length) return 'Graba al menos una toma o importa audio de tu voz.';
  if (samples.some(sampleProblem)) return 'Quita los archivos de más de 10 MB.';
  if (total < MIN_MS && !unmeasured) return `Necesitas al menos 1:00 de voz (tienes ${fmtClock(total)}).`;
  if (!els.name.value.trim()) return 'Ponle un nombre a tu voz.';
  if (!els.consent.checked) return 'Confirma que es tu voz para continuar.';
  return '';
}

function renderClone() {
  renderSamples();
  renderProgress();
  const running = state.session.state !== 'idle';
  els.record.disabled = recordBusy || cloning || (running && !recording);
  els.import.disabled = cloning || recording;
  if (!recording) {
    els.recState.textContent = running ? 'Detén el doblaje para grabar muestras (usa el mismo micrófono).'
      : samples.length ? `Graba otra toma o crea tu voz (${samples.length} ${samples.length === 1 ? 'muestra' : 'muestras'}).`
        : 'Pulsa para grabar una toma (hasta 1:40)';
  }
  const blocker = cloneBlocker();
  els.clone.disabled = Boolean(blocker) || cloning || recording;
  if (!cloning) {
    els.status.textContent = blocker || 'Todo listo: tu voz se creará en tu cuenta de ElevenLabs.';
    els.status.dataset.tone = blocker ? '' : 'ok';
  }
}

async function toggleRecord() {
  if (recordBusy) return;
  recordBusy = true;
  els.record.classList.add('is-busy');
  try {
    if (!recording) {
      stopPreviewAudio();
      await native('native.voice.record.start', { deviceId: state.settings?.micDeviceId || '' }, 15000);
      recording = true;
      els.record.setAttribute('aria-pressed', 'true');
      els.record.setAttribute('aria-label', 'Detener toma');
      els.recState.textContent = 'Grabando… lee el texto con tu tono natural.';
      els.timer.textContent = '0:00';
    } else {
      const result = await native('native.voice.record.stop', {}, 15000);
      finishTake(result);
    }
  } catch (error) {
    if (recording) resetRecorderUi();
    toast({ kind: 'error', title: recording ? 'No se pudo guardar la toma' : 'No se pudo grabar', message: error.message });
  } finally {
    recordBusy = false;
    els.record.classList.remove('is-busy');
    renderClone();
  }
}

function resetRecorderUi() {
  recording = false;
  els.record.setAttribute('aria-pressed', 'false');
  els.record.setAttribute('aria-label', 'Grabar toma');
  els.recMeterFill.style.setProperty('--level', '0%');
}

function finishTake(result) {
  resetRecorderUi();
  if (!result?.ok) {
    toast({ kind: 'warn', title: 'Toma vacía', message: result?.message || 'No llegó audio del micrófono.' });
    return;
  }
  if (result.durationMs < 3000) {
    native('native.voice.record.discard', { path: result.path }).catch(() => {});
    toast({ kind: 'warn', title: 'Toma demasiado corta', message: 'Graba al menos unos segundos seguidos.' });
    return;
  }
  takeCounter += 1;
  samples.push({ kind: 'take', path: result.path, url: result.url, name: `Toma ${takeCounter}`, durationMs: result.durationMs });
  scriptIndex += 1;
  renderScript();
  if (result.reason === 'max') toast({ kind: 'info', title: 'Toma completa', message: 'Llegaste al máximo por toma (1:40). Graba otra si quieres sumar más voz.' });
}

export function onRecordLevel(data) {
  if (!recording) return;
  const db = Number(data.levelDb);
  els.recMeterFill.style.setProperty('--level', `${Math.max(0, Math.min(1, (db + 60) / 60)) * 100}%`);
  const ms = (Number(data.seconds) || 0) * 1000;
  const max = (Number(data.maxSeconds) || 100) * 1000;
  els.timer.textContent = `${fmtClock(ms)} / ${fmtClock(max)}`;
  renderProgress(ms);
  if (db < -50 && ms > 3000) els.recState.textContent = 'No te oímos bien: acércate al micrófono o revisa cuál está elegido.';
  else els.recState.textContent = 'Grabando… lee el texto con tu tono natural.';
}

export function onRecordStopped(data) {
  if (!recording) return;
  finishTake(data);
  renderClone();
}

async function importFiles() {
  try {
    const result = await native('native.pickAudioFiles', {}, 600000);
    const files = Array.isArray(result.files) ? result.files : [];
    for (const f of files) {
      if (samples.some((s) => s.path === f.path)) continue;
      samples.push({ kind: 'file', path: f.path, name: f.name, durationMs: Number.isFinite(f.durationMs) ? f.durationMs : null, sizeBytes: f.sizeBytes });
    }
    if (files.some((f) => f.sizeBytes > MAX_FILE_BYTES)) {
      toast({ kind: 'warn', title: 'Archivo demasiado grande', message: 'ElevenLabs acepta archivos de hasta 10 MB: recórtalo o expórtalo en MP3.' });
    }
    renderClone();
  } catch (error) {
    toastError(error, 'No se pudieron importar los archivos');
  }
}

async function createVoice() {
  if (cloneBlocker() || cloning) return;
  cloning = true;
  setBusy(els.clone, true, 'Creando voz…');
  els.status.textContent = 'Subiendo tus muestras a ElevenLabs… puede tardar un minuto.';
  delete els.status.dataset.tone;
  renderClone();
  const name = els.name.value.trim();
  try {
    const result = await engine('voice.clone', {
      name,
      description: 'Voz clonada con VOXORA Meet para doblaje de reuniones',
      wavPaths: samples.filter((s) => s.kind === 'take').map((s) => s.path),
      filePaths: samples.filter((s) => s.kind === 'file').map((s) => s.path),
    }, 240000);
    applyCurrentVoice(result.voiceId, result.name || name);
    samples.length = 0;
    els.consent.checked = false;
    els.status.textContent = `¡Listo! «${result.name || name}» ya es tu voz activa.`;
    els.status.dataset.tone = 'ok';
    toast({ kind: 'success', title: 'Tu voz está lista', message: `«${result.name || name}» se creó en tu cuenta y ya es la voz activa.` });
    setTimeout(() => closeSheet('sheet-clone'), 1200);
    loadVoices({ quiet: true });
  } catch (error) {
    els.status.textContent = error.message;
    els.status.dataset.tone = 'bad';
    toast({ kind: 'error', title: 'No se pudo crear la voz', message: error.message, action: errorAction(error) });
  } finally {
    cloning = false;
    setBusy(els.clone, false);
    renderClone();
  }
}

export function initVoice() {
  Object.assign(els, {
    field: $('#field-voice'), voiceSel: $('#sel-voice'), voicePlay: $('#btn-voice-play'), voiceHint: $('#voice-hint'), refresh: $('#btn-voices-refresh'),
    openClone: $('#btn-open-clone'),
    idForm: $('#voice-id-form'), idInput: $('#inp-voice-id'), idSave: $('#btn-voice-id-save'), idHint: $('#voice-id-hint'),
    progressFill: $('#clone-progress-fill'), total: $('#clone-total'), totalHint: $('#clone-total-hint'),
    script: $('#clone-script'), scriptLang: $('#clone-script-lang'), scriptNext: $('#btn-script-next'),
    record: $('#btn-record'), timer: $('#rec-timer'), recState: $('#rec-state'), recMeter: $('#rec-meter'),
    import: $('#btn-import'), takes: $('#takes'), name: $('#inp-clone-name'), consent: $('#chk-consent'),
    clone: $('#btn-clone'), status: $('#clone-status'),
  });
  els.recMeterFill = els.recMeter.querySelector('.meter__fill');

  els.voiceSel.addEventListener('change', () => {
    const v = state.voices.list.find((x) => x.voiceId === els.voiceSel.value);
    if (v) useVoice(v.voiceId, v.name);
  });
  els.voicePlay.addEventListener('click', () => {
    const v = selectedVoice();
    if (v) togglePlay('selected', v.previewUrl, els.voicePlay);
  });
  els.voiceHint.addEventListener('click', () => { if (els.voiceHint.classList.contains('is-action')) openAccounts(); });
  els.refresh.addEventListener('click', () => loadVoices());
  els.openClone.addEventListener('click', openClone);
  els.idForm.addEventListener('submit', submitVoiceId);
  els.idInput.addEventListener('input', () => {
    els.idInput.removeAttribute('aria-invalid');
    delete els.idHint.dataset.tone;
    els.idHint.textContent = 'Lo encuentras en ElevenLabs › Voices › (tu voz) › ID.';
  });
  els.scriptNext.addEventListener('click', () => { scriptIndex += 1; renderScript(); });
  els.record.addEventListener('click', toggleRecord);
  els.import.addEventListener('click', importFiles);
  els.name.addEventListener('input', renderClone);
  els.consent.addEventListener('change', renderClone);
  els.clone.addEventListener('click', createVoice);

  subscribe('voices', renderVoiceSelect);
  subscribe('settings', () => { renderVoiceSelect(); renderScript(); renderClone(); });
  subscribe('keys', () => {
    renderClone();
    // La key de ElevenLabs acaba de guardarse (o borrarse): recargar la lista de voces.
    const hasKey = Boolean(state.keys.elevenlabs);
    if (lastKeyState !== null && hasKey !== lastKeyState && state.engine.state === 'ready') loadVoices({ quiet: true });
    lastKeyState = hasKey;
  });
  subscribe('session', renderClone);
  // El selector de voz vive en Simple y en Reunión: fuera de ellas, la muestra se calla.
  subscribe('tab', () => { if (state.activeTab !== 'meeting' && state.activeTab !== 'simple') stopPreviewAudio(); });

  renderVoiceSelect();
  renderScript();
  renderClone();
}

/** Para el botón de la bandeja / atajos: ¿hay una grabación en curso? */
export const isRecording = () => recording;
