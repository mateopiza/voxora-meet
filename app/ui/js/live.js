// «En vivo»: medidor de nivel, turnos (lo que dijiste → lo que oye Meet) con latencia y costo, métricas
// de sincronía/costo y estado de la cámara para Meet. La tarjeta de turnos (#card-feed) es la misma en
// Avanzado › En vivo y en la pantalla Simple («Subtítulos en vivo»): nav.js la mueve a la vista visible.

import { $, fmtInt, fmtSeconds1, h, icon } from './dom.js';
import { langName } from './data.js';
import { cameraAlwaysOn, cameraDelayMs, state, subscribe } from './store.js';

const els = {};
const turns = new Map();  // turnId → { el, endedAt, … }
const MAX_TURNS = 200;
let unseen = 0;
let sessionMarkerPending = false;

// ── Medidor ─────────────────────────────────────────────────────────────────
let levelFrame = 0;
let lastLevel = { rmsDb: -100, speaking: false };

export function onLevel(data) {
  lastLevel = data || lastLevel;
  if (levelFrame) return;
  levelFrame = requestAnimationFrame(() => {
    levelFrame = 0;
    const db = Number(lastLevel.rmsDb);
    const pct = Math.max(0, Math.min(1, (db + 60) / 60)) * 100;
    els.meterFill.style.setProperty('--level', `${pct}%`);
    els.meter.dataset.speaking = String(Boolean(lastLevel.speaking));
    els.meter.setAttribute('aria-valuenow', String(Math.round(Math.max(-60, db))));
    els.db.textContent = Number.isFinite(db) && db > -99 ? `${Math.round(db)} dB` : '— dB';
    els.speaking.textContent = lastLevel.speaking ? 'Hablando' : 'En silencio';
    els.speaking.dataset.tone = lastLevel.speaking ? 'ok' : 'muted';
  });
}

function resetMeter() {
  onLevel({ rmsDb: -100, speaking: false });
}

// ── Turnos ──────────────────────────────────────────────────────────────────
function nearBottom() {
  return els.feed.scrollHeight - els.feed.scrollTop - els.feed.clientHeight < 80;
}

function scrollToEnd() {
  els.feed.scrollTop = els.feed.scrollHeight;
  els.jump.hidden = true;
}

function renderEmpty() {
  const empty = turns.size === 0 && !els.feed.querySelector('.feed__marker');
  els.empty.hidden = !empty;
  els.emptyText.textContent = state.session.state === 'running'
    ? 'Empieza a hablar y verás aquí lo que dices y cómo lo oye Meet.'
    : 'Inicia el doblaje y empieza a hablar: verás aquí lo que dices y cómo lo oye Meet.';
}

/** Los turnos se ven en En vivo (Avanzado) y en la pantalla Simple. */
const feedVisible = () => state.activeTab === 'live' || state.activeTab === 'simple';

function metaBadges(turn) {
  const items = [];
  if (Number.isFinite(turn.latencyMs)) items.push(h('span', { class: 'badge', dataset: { tone: turn.latencyMs > (state.settings?.delayMs ?? 3000) ? 'warn' : 'cyan' }, title: 'Tiempo desde que terminaste la frase hasta que el doblaje estuvo listo' }, icon('clock'), fmtSeconds1(turn.latencyMs)));
  if (Number.isFinite(turn.costVox)) items.push(h('span', { class: 'badge', dataset: { tone: 'violet' }, title: 'Créditos VOX de este turno' }, `${fmtInt(turn.costVox)} VOX`));
  if (turn.late) items.push(h('span', { class: 'badge', dataset: { tone: 'warn' }, title: 'El doblaje llegó después del retraso de sincronía' }, 'Tardío'));
  return items;
}

function renderTurn(turn) {
  const s = state.settings || {};
  const time = new Date(turn.receivedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const meta = h('div', { class: 'turn__meta' }, h('span', {}, `#${turn.id} · ${time}`), h('span', { class: 'grow' }), ...metaBadges(turn));
  const tag = (who, lang) => h('span', { class: 'turn__lang' }, h('span', { class: 'turn__who', text: who }), (lang || '').toUpperCase());
  const src = h('p', { class: 'turn__src' }, tag('Dijiste', s.sourceLanguage), turn.transcript || '');
  const dst = h('p', { class: 'turn__dst' }, tag('Meet oye', s.targetLanguage),
    turn.translation ? turn.translation : h('span', { class: 'turn__pending', text: 'Traduciendo…' }));
  turn.el.replaceChildren(meta, src, dst);
  turn.el.dataset.late = String(Boolean(turn.late));
}

function ensureTurn(turnId) {
  let turn = turns.get(turnId);
  if (turn) return turn;
  const stick = nearBottom();
  if (sessionMarkerPending) {
    sessionMarkerPending = false;
    const s = state.settings || {};
    els.feed.append(h('p', { class: 'turn__meta feed__marker' },
      h('span', { class: 'grow' }), `Sesión ${new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })} · ${langName(s.sourceLanguage)} → ${langName(s.targetLanguage)}`, h('span', { class: 'grow' })));
  }
  turn = { id: turnId, el: h('article', { class: 'turn' }), receivedAt: Date.now() };
  turns.set(turnId, turn);
  els.feed.append(turn.el);
  while (turns.size > MAX_TURNS) {
    const [firstId, first] = turns.entries().next().value;
    first.el.remove();
    turns.delete(firstId);
  }
  if (stick) requestAnimationFrame(scrollToEnd);
  else els.jump.hidden = false;
  if (!feedVisible()) {
    unseen += 1;
    els.badge.textContent = unseen > 99 ? '99+' : String(unseen);
    els.badge.hidden = false;
  }
  renderEmpty();
  return turn;
}

export function onTranscript(data) {
  const turn = ensureTurn(data.turnId);
  turn.transcript = data.text;
  turn.endedAt = data.endedAt;
  renderTurn(turn);
}

export function onTranslation(data) {
  const turn = ensureTurn(data.turnId);
  turn.translation = data.text;
  renderTurn(turn);
}

export function onDub(data, engineNowMs) {
  const turn = ensureTurn(data.turnId);
  turn.late = Boolean(data.late);
  // engineNowMs: llegada del evento convertida por el shell al reloj del motor (performance.now()).
  const latency = Number(engineNowMs) - Number(turn.endedAt);
  if (Number.isFinite(latency) && latency > 0 && latency < 120000) turn.latencyMs = latency;
  renderTurn(turn);
}

export function onCost(data) {
  const turn = ensureTurn(data.turnId);
  turn.costVox = Number(data.cost?.totalVox);
  renderTurn(turn);
}

// ── Métricas ────────────────────────────────────────────────────────────────
function setStat(el, text, tone) {
  el.textContent = text;
  if (tone) el.parentElement.dataset.tone = tone;
  else delete el.parentElement.dataset.tone;
}

export function renderStats() {
  const st = state.stats || {};
  const delayMs = st.delayMs ?? state.settings?.delayMs ?? 3000;
  setStat(els.stDelay, fmtSeconds1(delayMs));
  const drift = Math.round(Number(st.driftMs) || 0);
  setStat(els.stDrift, `${drift > 0 ? '+' : ''}${fmtInt(drift)} ms`, Math.abs(drift) > 800 ? 'warn' : '');
  setStat(els.stLate, fmtInt(st.lateDubs || 0), (st.lateDubs || 0) > 0 ? 'warn' : '');
  const minutes = state.session.startedAt ? Math.max(1, (Date.now() - state.session.startedAt) / 60000) : 1;
  const perMin = (state.vox.total || 0) / minutes;
  setStat(els.stVoxMin, perMin.toLocaleString('es-ES', { maximumFractionDigits: perMin < 10 ? 1 : 0 }));
  setStat(els.stTurns, fmtInt(st.turns || 0));
  setStat(els.stPending, fmtInt(st.pendingTurns || 0), (st.pendingTurns || 0) > 2 ? 'warn' : '');
}

// ── Cámara para Meet ────────────────────────────────────────────────────────
function cameraLine() {
  const cam = state.camera;
  const running = state.session.state === 'running';
  const name = cam.name || 'tu cámara';
  switch (cam.state) {
    case 'starting':
      return ['Conectando tu cámara con Meet…', ''];
    case 'live': {
      const s = cam.stats;
      const res = s?.width ? `${s.width}×${s.height}` : '';
      const fps = s?.fps ? ` a ${Math.round(s.fps)} fps` : '';
      const detail = res ? ` (${res}${fps})` : '';
      if (cam.mode === 'dubbing') return [`Meet recibe ${name}${detail} sincronizada con tu voz: +${fmtSeconds1(cameraDelayMs())} de retraso.`, 'ok'];
      return [`Meet ve ${name}${detail} en vivo, sin retraso. Al iniciar el doblaje se retrasa lo mismo que tu voz.`, 'ok'];
    }
    case 'standby':  // el shell actual no lo emite; se trata como «lista»
      return ['Cámara virtual lista: Meet ve tu cámara en vivo; al doblar, se retrasa lo mismo que tu voz.', ''];
    case 'lost':
      return [cam.message || 'Se perdió la señal de la cámara: Meet ve la imagen de espera hasta que vuelva.', 'warn'];
    case 'error':
      return [cam.message || 'No se pudo abrir la cámara: Meet ve la imagen de espera.', 'bad'];
    default: {
      if (running) return ['Conectando tu cámara con Meet…', ''];
      if (state.devices.received && state.devices.virtualCamera && !state.devices.virtualCamera.installed) return ['Falta la cámara virtual de VOXORA Meet: Meet no puede recibir tu video.', 'bad'];
      if (cameraAlwaysOn()) return [cam.message || 'La cámara virtual no está en marcha: Meet no ve VOXORA Meet Camera por ahora.', 'warn'];
      return ['La cámara para Meet se activa al iniciar el doblaje.', ''];
    }
  }
}

export function renderCamera() {
  const [text, tone] = cameraLine();
  els.camText.textContent = text;
  if (tone) els.camLine.dataset.tone = tone;
  else delete els.camLine.dataset.tone;
}

function renderHeader() {
  const s = state.settings || {};
  els.pair.textContent = `${(s.sourceLanguage || 'es').toUpperCase()} → ${(s.targetLanguage || 'en').toUpperCase()}`;
  els.voiceName.textContent = s.voiceId ? `Voz: ${s.voiceName || s.voiceId}` : 'Sin voz elegida';
}

export function initLive() {
  Object.assign(els, {
    meter: $('#live-meter'), db: $('#live-db'), speaking: $('#speaking-badge'), pair: $('#live-pair'), voiceName: $('#live-voice-name'),
    feed: $('#feed'), empty: $('#feed-empty'), emptyText: $('#feed-empty-text'), jump: $('#btn-feed-jump'), clear: $('#btn-feed-clear'),
    badge: $('#badge-live'),
    stDelay: $('#st-delay'), stDrift: $('#st-drift'), stLate: $('#st-late'), stVoxMin: $('#st-voxmin'), stTurns: $('#st-turns'), stPending: $('#st-pending'),
    camLine: $('#cam-line'), camText: $('#cam-line-text'),
  });
  els.meterFill = els.meter.querySelector('.meter__fill');
  els.feed.addEventListener('scroll', () => { if (nearBottom()) els.jump.hidden = true; });
  els.jump.addEventListener('click', scrollToEnd);
  els.clear.addEventListener('click', () => {
    turns.clear();
    els.feed.replaceChildren();
    els.jump.hidden = true;
    renderEmpty();
  });

  subscribe('tab', () => {
    if (feedVisible()) {
      unseen = 0;
      els.badge.hidden = true;
    }
  });
  subscribe('settings', () => { renderHeader(); renderStats(); renderCamera(); });
  subscribe('stats', renderStats);
  subscribe('vox', renderStats);
  subscribe('session', () => {
    if (state.session.state === 'running') sessionMarkerPending = turns.size > 0;
    if (state.session.state === 'idle') resetMeter();
    renderEmpty();
    renderCamera();
    renderStats();
  });
  subscribe('camera', renderCamera);
  subscribe('camera.stats', renderCamera);
  subscribe('devices', renderCamera);
  renderHeader();
  renderStats();
  renderCamera();
  renderEmpty();
  resetMeter();
}
