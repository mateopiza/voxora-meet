// Actualizaciones, registros y avisos de estabilidad (módulo autocontenido: inyecta su propio DOM y
// estilos; solo depende del puente). Protocolo con el shell (app/native-shell/src/updater.h):
//
//   native.update.status  → { state, currentVersion, enabled, reason?, available?, progress, mandatory,
//                             lastCheckAt, error?, dismissed, logsDir }
//   native.update.check   → fuerza una comprobación        native.update.dismiss → «Más tarde»
//   native.update.apply   → lanza el instalador (/S, elevado) y la app se cierra; falla con
//                           `session_running` si hay doblaje en curso
//   native.logs.open      → abre %LOCALAPPDATA%\VOXORA Meet\logs
//   evento nativo `update` (mismo objeto que status) y `engine.restarting` { attempt, delayMs, code }
//
// Reglas: el aviso «Actualización lista · Reiniciar ahora / Más tarde» nunca aparece durante una sesión
// de doblaje (espera a que termine); «Más tarde» lo pospone 12 h salvo que la actualización sea obligatoria.
// En el panel «Acerca de» (#about) añade el estado de las actualizaciones y «Abrir carpeta de registros».
// Estilos con CSSOM (adoptedStyleSheets): la CSP de index.html no admite <style> en línea.

import { engine, isMock, native, on, ready } from './bridge.js';

const SNOOZE_KEY = 'voxora.update.snooze';
const SNOOZE_MS = 12 * 60 * 60 * 1000;

const CSS = `
.vx-upd-banner {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; width: 372px; max-width: calc(100vw - 40px);
  padding: 18px 18px 16px; border-radius: var(--radius-xl, 24px);
  background: rgba(255, 255, 255, .86); border: 1px solid var(--glass-hairline, rgba(255,255,255,.6));
  box-shadow: 0 24px 60px -12px rgba(13, 8, 22, .22), 0 0 0 1px rgba(139, 92, 246, .08);
  backdrop-filter: blur(var(--blur-xl, 32px)) saturate(150%);
  font-family: var(--font-sans, 'Inter', system-ui, sans-serif); color: var(--text-primary, #07060B);
  transform: translateY(16px) scale(.98); opacity: 0; pointer-events: none;
  transition: transform .45s var(--ease-out, cubic-bezier(.22,1,.36,1)), opacity .3s;
}
.vx-upd-banner.is-open { transform: none; opacity: 1; pointer-events: auto; }
.vx-upd-banner__head { display: flex; gap: 14px; align-items: flex-start; }
.vx-upd-banner__icon {
  width: 40px; height: 40px; flex: none; border-radius: 14px; display: grid; place-items: center; color: #fff;
  background: var(--gradient-brand, linear-gradient(135deg, #22D3EE, #8B5CF6)); box-shadow: 0 10px 22px -8px rgba(139, 92, 246, .7);
}
.vx-upd-banner__icon svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.vx-upd-banner__eyebrow { margin: 0 0 3px; font-size: 10px; font-weight: 700; letter-spacing: .3em; text-transform: uppercase; color: var(--brand-violet-deep, #7C3AED); }
.vx-upd-banner__title { margin: 0; font-family: var(--font-display, 'Space Grotesk', sans-serif); font-size: 17px; font-weight: 500; letter-spacing: -.01em; }
.vx-upd-banner__text { margin: 6px 0 0; font-size: 12.5px; line-height: 1.5; color: var(--text-body, rgba(13,8,22,.6)); }
.vx-upd-banner__notes { margin: 8px 0 0; font-size: 12px; line-height: 1.45; color: var(--text-muted, rgba(13,8,22,.55));
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-line; }
.vx-upd-banner__error { margin: 8px 0 0; font-size: 12px; color: var(--danger-fg, #E11D48); }
.vx-upd-banner__actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.vx-upd-btn {
  height: 34px; padding: 0 16px; border-radius: 9999px; border: 0; cursor: pointer; font: inherit;
  font-size: 10.5px; font-weight: 700; letter-spacing: .2em; text-transform: uppercase; display: inline-flex; align-items: center; gap: 8px;
  transition: transform .15s, box-shadow .25s, background .25s, opacity .25s;
}
.vx-upd-btn:disabled { opacity: .5; cursor: default; }
.vx-upd-btn--brand { color: #fff; background: var(--gradient-brand, linear-gradient(135deg, #22D3EE, #8B5CF6)); box-shadow: var(--shadow-cta, 0 10px 25px -5px rgba(139,92,246,.4)); }
.vx-upd-btn--brand:hover:not(:disabled) { transform: translateY(-1px); }
.vx-upd-btn--ghost { background: transparent; color: var(--text-muted, rgba(13,8,22,.55)); }
.vx-upd-btn--ghost:hover { background: rgba(13, 8, 22, .05); color: var(--text-primary, #07060B); }
.vx-upd-btn--glass { background: rgba(255,255,255,.7); color: var(--text-primary, #07060B); border: 1px solid rgba(255,255,255,.6); box-shadow: 0 8px 30px rgba(13,8,22,.08); }
.vx-upd-btn--glass:hover:not(:disabled) { background: #fff; }
.vx-upd-bar { height: 4px; margin-top: 12px; border-radius: 4px; background: rgba(13, 8, 22, .07); overflow: hidden; }
.vx-upd-bar > i { display: block; height: 100%; width: 0; border-radius: 4px; background: var(--gradient-brand, linear-gradient(90deg, #22D3EE, #8B5CF6)); transition: width .4s; }

.vx-upd-about { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--divider, rgba(13,8,22,.05)); display: grid; gap: 10px; }
.vx-upd-about__row { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3, 12px); font-size: var(--text-xs, 12px); }
.vx-upd-about__label { flex: none; color: var(--ink-slate-500, #64748B); }
.vx-upd-about__status { display: inline-flex; align-items: center; gap: 8px; min-width: 0; color: var(--ink-black, #07060B); font-weight: var(--weight-semibold, 600); }
.vx-upd-about__status > span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vx-upd-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--ink-slate-400, #94A3B8); }
.vx-upd-dot[data-tone="ok"] { background: var(--brand-emerald, #10B981); box-shadow: 0 0 0 4px rgba(16,185,129,.15); }
.vx-upd-dot[data-tone="busy"] { background: var(--brand-violet, #8B5CF6); animation: vx-upd-pulse 1.2s ease-in-out infinite; }
.vx-upd-dot[data-tone="ready"] { background: var(--brand-cyan, #22D3EE); box-shadow: 0 0 0 4px rgba(34,211,238,.2); }
.vx-upd-dot[data-tone="bad"] { background: var(--warning-fg, #D97706); }
@keyframes vx-upd-pulse { 50% { opacity: .35; } }
.vx-upd-about__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; }
.vx-upd-link { border: 0; background: none; padding: 0; cursor: pointer; font: inherit; font-size: 12.5px; font-weight: 600; color: var(--brand-violet-deep, #7C3AED); display: inline-flex; align-items: center; gap: 6px; }
.vx-upd-link:hover { text-decoration: underline; }
.vx-upd-link svg, .vx-upd-btn svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

.vx-upd-notice {
  position: fixed; left: 50%; top: 16px; z-index: 2147483001; transform: translate(-50%, -12px); opacity: 0; pointer-events: none;
  padding: 10px 16px; border-radius: 9999px; font-family: var(--font-sans, system-ui); font-size: 12.5px; color: var(--text-primary, #07060B);
  background: rgba(255,255,255,.92); border: 1px solid rgba(255,255,255,.6); box-shadow: 0 12px 30px -10px rgba(13,8,22,.25);
  display: flex; align-items: center; gap: 10px; transition: transform .35s, opacity .25s;
}
.vx-upd-notice.is-open { transform: translate(-50%, 0); opacity: 1; }
@media (prefers-reduced-motion: reduce) { .vx-upd-banner, .vx-upd-notice { transition: none; } .vx-upd-dot { animation: none !important; } }
`;

const ICONS = {
  sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

function svg(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name];
  return s;
}

const state = { status: null, session: 'idle', applying: false, error: '', aboutNode: null, mock: false };

function readSnooze() {
  try { return JSON.parse(localStorage.getItem(SNOOZE_KEY) || 'null'); } catch { return null; }
}
function writeSnooze(value) {
  try { localStorage.setItem(SNOOZE_KEY, JSON.stringify(value)); } catch { /* sin almacenamiento */ }
}

function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'hace un momento';
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  return h < 24 ? `hace ${h} h` : `hace ${Math.round(h / 24)} d`;
}

function describe(st) {
  if (!st) return { tone: '', text: 'Consultando el actualizador…' };
  const v = st.available?.version;
  switch (st.state) {
    case 'disabled': return { tone: '', text: st.reason || 'Las actualizaciones automáticas están desactivadas.' };
    case 'checking': return { tone: 'busy', text: 'Buscando actualizaciones…' };
    case 'downloading': return { tone: 'busy', text: `Descargando VOXORA Meet ${v || ''}… ${Math.floor(st.progress?.percent || 0)} %` };
    case 'ready': return { tone: 'ready', text: `VOXORA Meet ${v} está lista para instalar.` };
    case 'uptodate': return { tone: 'ok', text: `Estás al día${st.lastCheckAt ? ` · comprobado ${ago(st.lastCheckAt)}` : ''}.` };
    case 'error': return { tone: 'bad', text: st.error?.message || 'No se pudo comprobar si hay actualizaciones.' };
    default: return { tone: '', text: 'Se comprobará en unos segundos.' };
  }
}

// ── Aviso «Actualización lista» ─────────────────────────────────────────────
const banner = {
  root: null,
  build() {
    this.eyebrow = el('p', { class: 'vx-upd-banner__eyebrow' }, 'Actualización lista');
    this.title = el('p', { class: 'vx-upd-banner__title' });
    this.text = el('p', { class: 'vx-upd-banner__text' });
    this.notes = el('p', { class: 'vx-upd-banner__notes' });
    this.err = el('p', { class: 'vx-upd-banner__error', role: 'alert' });
    this.later = el('button', { class: 'vx-upd-btn vx-upd-btn--ghost', type: 'button', onclick: onLater }, 'Más tarde');
    this.now = el('button', { class: 'vx-upd-btn vx-upd-btn--brand', type: 'button', onclick: onApply }, svg('refresh'), 'Reiniciar ahora');
    const icon = el('span', { class: 'vx-upd-banner__icon' }, svg('sparkles'));
    this.root = el('section', { class: 'vx-upd-banner', role: 'dialog', 'aria-live': 'polite', 'aria-label': 'Actualización de VOXORA Meet' },
      el('div', { class: 'vx-upd-banner__head' }, icon, el('div', {}, this.eyebrow, this.title, this.text)),
      this.notes, this.err, el('div', { class: 'vx-upd-banner__actions' }, this.later, this.now));
    document.body.append(this.root);
  },
  render() {
    const st = state.status;
    const ready = st?.state === 'ready' && st.available;
    const snooze = readSnooze();
    const snoozed = !st?.mandatory && snooze && snooze.version === st?.available?.version && Date.now() < snooze.until;
    // Nunca durante una sesión de doblaje: se vuelve a evaluar al terminar.
    const open = Boolean(ready) && state.session === 'idle' && (st.mandatory || (!st.dismissed && !snoozed)) || state.applying;
    if (!this.root) { if (!open) return; this.build(); }
    if (ready) {
      this.eyebrow.textContent = st.mandatory ? 'Actualización necesaria' : 'Actualización lista';
      this.title.textContent = `VOXORA Meet ${st.available.version}`;
      this.text.textContent = st.mandatory
        ? `Tu versión (${st.currentVersion}) ya no es compatible. Reinicia para instalar la nueva; tarda menos de un minuto.`
        : 'Descargada y verificada. Al reiniciar se instala sola y VOXORA Meet vuelve a abrirse.';
      this.notes.textContent = st.available.releaseNotes || '';
      this.notes.hidden = !st.available.releaseNotes;
    }
    this.err.textContent = state.error;
    this.err.hidden = !state.error;
    this.later.hidden = Boolean(st?.mandatory);
    this.now.disabled = state.applying;
    this.now.lastChild.textContent = state.applying ? 'Instalando…' : 'Reiniciar ahora';
    this.root.classList.toggle('is-open', open);
  },
};

async function onApply() {
  state.applying = true;
  state.error = '';
  banner.render();
  try {
    if (state.mock) { await new Promise((r) => setTimeout(r, 900)); throw Object.assign(new Error('Vista previa: aquí la app se cerraría para instalar la actualización.'), { code: 'mock' }); }
    await native('native.update.apply', {}, 20000);
    // La app se cierra sola: el instalador la vuelve a abrir.
  } catch (error) {
    state.applying = false;
    state.error = error.message || 'No se pudo iniciar la actualización.';
    banner.render();
  }
}

function onLater() {
  const v = state.status?.available?.version;
  if (v) writeSnooze({ version: v, until: Date.now() + SNOOZE_MS });
  state.error = '';
  if (!state.mock) native('native.update.dismiss').catch(() => {});
  if (state.status) state.status = { ...state.status, dismissed: true };
  banner.render();
}

// ── Panel «Acerca de» ───────────────────────────────────────────────────────
const about = {
  node: null,
  build() {
    this.dot = el('span', { class: 'vx-upd-dot' });
    this.text = el('span', {});
    this.check = el('button', { class: 'vx-upd-btn vx-upd-btn--glass', type: 'button', onclick: onCheck }, svg('refresh'), 'Buscar actualizaciones');
    this.install = el('button', { class: 'vx-upd-btn vx-upd-btn--brand', type: 'button', onclick: onApply, hidden: true }, 'Reiniciar y actualizar');
    this.logs = el('button', { class: 'vx-upd-link', type: 'button', onclick: onOpenLogs, title: '%LOCALAPPDATA%\\VOXORA Meet\\logs' }, svg('folder'), 'Abrir carpeta de registros');
    this.node = el('div', { class: 'vx-upd-about', id: 'vx-update-about' },
      // Misma forma que las filas dt/dd de #about: etiqueta a la izquierda, estado (punto + texto) a la derecha.
      el('div', { class: 'vx-upd-about__row' }, el('span', { class: 'vx-upd-about__label' }, 'Actualizaciones'),
        el('span', { class: 'vx-upd-about__status' }, this.dot, this.text)),
      el('div', { class: 'vx-upd-about__actions' }, this.check, this.install, this.logs));
  },
  // #about se vuelve a pintar (replaceChildren) y la UI puede reorganizarse: se engancha como hermano.
  attach() {
    const anchor = document.querySelector('#about, [data-about]');
    if (!anchor) return;
    if (!this.node) this.build();
    if (this.node.previousElementSibling === anchor) return;
    anchor.after(this.node);
    this.render();
  },
  render() {
    if (!this.node) return;
    const { tone, text } = describe(state.status);
    if (this.dot.dataset.tone !== tone) this.dot.dataset.tone = tone;
    if (this.text.textContent !== text) this.text.textContent = text;
    const st = state.status;
    this.check.disabled = !st || st.state === 'disabled' || st.state === 'checking' || st.state === 'downloading';
    this.install.hidden = !(st?.state === 'ready');
    this.install.disabled = state.session !== 'idle' || state.applying;
    this.install.title = state.session !== 'idle' ? 'Termina el doblaje para actualizar' : '';
  },
};

async function onCheck() {
  try {
    if (state.mock) { applyStatus({ ...state.status, state: 'checking' }); setTimeout(() => applyStatus({ ...state.status, state: 'uptodate', lastCheckAt: Date.now() }), 1200); return; }
    applyStatus(await native('native.update.check'));
  } catch (error) {
    applyStatus({ ...(state.status || {}), state: 'error', error: { message: error.message } });
  }
}

async function onOpenLogs() {
  if (state.mock) return;
  try { await native('native.logs.open'); } catch (error) { notice(error.message || 'No se pudo abrir la carpeta de registros.'); }
}

// ── Aviso breve (reinicio automático del motor) ─────────────────────────────
let noticeTimer = 0;
let noticeNode = null;
function notice(text, ms = 6000) {
  if (!noticeNode) { noticeNode = el('div', { class: 'vx-upd-notice', role: 'status' }); document.body.append(noticeNode); }
  noticeNode.textContent = text;
  noticeNode.classList.add('is-open');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => noticeNode.classList.remove('is-open'), ms);
}

function applyStatus(st) {
  if (!st || typeof st !== 'object') return;
  state.status = st;
  if (st.state !== 'ready') state.applying = Boolean(st.applying);
  banner.render();
  about.render();
}

function setSession(next) {
  if (state.session === next) return;
  state.session = next;
  banner.render();
  about.render();
}

// Vista previa en navegador (mock.js): ?update=ready|mandatory|downloading|uptodate|error.
function mockStatus() {
  const mode = new URLSearchParams(location.search).get('update') || 'uptodate';
  const available = { version: '0.3.0', releaseNotes: 'Voz más natural en frases largas.\nLa cámara vuelve sola si se desconecta.', size: 41_000_000 };
  const base = { currentVersion: '0.2.0', enabled: true, lastCheckAt: Date.now() - 4 * 60_000, dismissed: false, mandatory: false, progress: { percent: 0 } };
  if (mode === 'ready' || mode === 'mandatory') return { ...base, state: 'ready', available, mandatory: mode === 'mandatory', progress: { percent: 100 } };
  if (mode === 'downloading') return { ...base, state: 'downloading', available, progress: { percent: 42 } };
  if (mode === 'error') return { ...base, state: 'error', error: { message: 'No se pudo comprobar si hay actualizaciones (sin conexión).' } };
  return { ...base, state: 'uptodate' };
}

async function init() {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch { /* navegador sin hojas construibles: sin estilos propios */ }

  await ready();
  state.mock = isMock();
  on('native-event', ({ event, data }) => {
    if (event === 'update') applyStatus(data);
    else if (event === 'engine.restarting') notice(`El motor de doblaje se detuvo y se reinicia solo en ${Math.round((data?.delayMs || 0) / 1000)} s (intento ${data?.attempt || 1}).`);
    else if (event === 'tray.toggleSession') banner.render();
  });
  on('engine-event', ({ event, data }) => {
    if (event === 'status') setSession(data?.state === 'running' || data?.state === 'starting' ? 'running' : data?.state === 'idle' ? 'idle' : state.session);
  });
  on('engine-state', ({ state: st }) => {
    if (st === 'exited' || st === 'failed') setSession('idle');
    if (st === 'ready' && !state.mock) engine('stats.get').then((s) => setSession(s?.state === 'running' ? 'running' : 'idle')).catch(() => {});
  });

  // Solo cambios ajenos (la UI reconstruye #about o reorganiza pestañas); los nuestros se ignoran.
  const ours = (node) => (about.node && about.node.contains(node)) || (banner.root && banner.root.contains(node)) || (noticeNode && noticeNode.contains(node));
  const observer = new MutationObserver((records) => {
    if (records.some((r) => !ours(r.target))) about.attach();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  about.attach();

  if (state.mock) {
    applyStatus(mockStatus());
  } else {
    try { applyStatus(await native('native.update.status')); } catch { /* shell sin actualizador */ }
  }
  document.documentElement.dataset.vxUpdate = 'ready';
}

init();
