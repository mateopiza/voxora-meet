// Utilidades de DOM, formato y toasts. Todo el texto dinámico se inserta con
// textContent (nunca innerHTML): transcripciones, nombres de voces y mensajes
// del motor no pueden inyectar marcado.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Crea un elemento: h('button', { class: 'btn', onclick }, 'Texto', otroNodo). */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'text') el.textContent = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Icono del sprite de index.html. */
export function icon(name, extraClass = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `i ${extraClass}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/** Cambia el icono (<use>) de un botón existente. */
export function setIcon(el, name) {
  const use = el?.querySelector('use');
  if (use) use.setAttribute('href', `#i-${name}`);
}

/** Reconstruye un <select> solo si cambian las opciones (no molesta si está abierto). */
export function fillSelect(select, options, value) {
  const signature = JSON.stringify(options);
  if (select.dataset.sig !== signature) {
    select.dataset.sig = signature;
    const groups = new Map();
    select.replaceChildren();
    for (const opt of options) {
      const node = h('option', { value: opt.value, disabled: opt.disabled }, opt.label);
      if (opt.group) {
        if (!groups.has(opt.group)) {
          const g = h('optgroup', { label: opt.group });
          groups.set(opt.group, g);
          select.append(g);
        }
        groups.get(opt.group).append(node);
      } else {
        select.append(node);
      }
    }
  }
  if (select.value !== value) select.value = value;
  // Solo hay una opción deshabilitada («Elige una voz…»): el navegador no la selecciona sola.
  if (select.selectedIndex < 0) {
    const option = Array.from(select.options).find((o) => o.value === value);
    if (option) option.selected = true;
  }
}

/** Radiogroup segmentado (SegmentedTabs): clic y flechas. Devuelve los botones enlazados. */
export function bindSegmented(group, onChange) {
  const buttons = Array.from(group.querySelectorAll('button'));
  buttons.forEach((btn, i) => {
    btn.addEventListener('click', () => onChange(btn.dataset.value));
    btn.addEventListener('keydown', (event) => {
      const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
      if (!delta) return;
      event.preventDefault();
      const next = buttons[(i + delta + buttons.length) % buttons.length];
      onChange(next.dataset.value);
      next.focus();
    });
  });
  return buttons;
}

export function setSegmented(group, value) {
  const buttons = Array.from(group.querySelectorAll('button'));
  const match = buttons.some((b) => b.dataset.value === value);
  buttons.forEach((btn, i) => {
    const on = btn.dataset.value === value;
    btn.setAttribute('aria-checked', String(on));
    btn.tabIndex = on || (!match && i === 0) ? 0 : -1;
  });
}

export function debounce(fn, ms) {
  let timer = 0;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

const nf1 = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });
export const fmtSeconds1 = (ms) => `${nf1.format(ms / 1000)} s`;
export const fmtInt = (n) => nf0.format(Math.round(Number(n) || 0));
/** Número con `min`–`max` decimales en formato es-ES (0,25). */
export const fmtDec = (n, min = 2, max = min) => (Number(n) || 0).toLocaleString('es-ES', { minimumFractionDigits: min, maximumFractionDigits: max });
/** Dólares: US$0,42 · US$0,040 si es menos de 10 centavos. */
export const fmtUsd = (usd) => {
  const n = Number(usd);
  if (!Number.isFinite(n)) return '—';
  return `US$${fmtDec(n, 2, n > 0 && n < 0.1 ? 3 : 2)}`;
};

/** 75_000 → "1:15"; 3_725_000 → "1:02:05". */
export function fmtClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes >= 1024 * 1024) return `${nf1.format(bytes / (1024 * 1024))} MB`;
  return `${nf0.format(bytes / 1024)} KB`;
}

export function initials(name) {
  const parts = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

export function setBusy(button, busy, busyLabel) {
  if (!button) return;
  const label = button.querySelector('span');
  if (busy) {
    if (label && busyLabel) {
      button.dataset.label = button.dataset.label || label.textContent;
      label.textContent = busyLabel;
    }
    button.dataset.icon = button.dataset.icon || button.querySelector('use')?.getAttribute('href')?.slice(3) || '';
    setIcon(button, 'loader');
    button.classList.add('is-busy');
    button.setAttribute('aria-busy', 'true');
  } else {
    if (label && button.dataset.label) label.textContent = button.dataset.label;
    if (button.dataset.icon) setIcon(button, button.dataset.icon);
    delete button.dataset.label;
    delete button.dataset.icon;
    button.classList.remove('is-busy');
    button.removeAttribute('aria-busy');
  }
}

// ── Hojas (dialog modal: Cuentas, Clonar mi voz, Tu prueba) ─────────────────
const sheetClosers = new Map();  // id → [fn] al cerrarse

function bindSheet(dialog) {
  if (dialog.dataset.bound) return;
  dialog.dataset.bound = '1';
  // Clic fuera del panel (en el fondo) o en un botón [data-close] → cerrar. Esc lo gestiona <dialog>.
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  for (const b of dialog.querySelectorAll('[data-close]')) b.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    const toasts = document.getElementById('toasts');
    if (toasts && toasts.parentElement === dialog) document.body.append(toasts);
    for (const fn of sheetClosers.get(dialog.id) ?? []) {
      try { fn(); } catch (error) { console.error(error); }
    }
  });
}

/** Abre una hoja modal por id (idempotente). Devuelve el <dialog>. */
export function openSheet(id) {
  const dialog = document.getElementById(id);
  if (!dialog) return null;
  bindSheet(dialog);
  if (!dialog.open) dialog.showModal();
  return dialog;
}

export function closeSheet(id) {
  const dialog = document.getElementById(id);
  if (dialog?.open) dialog.close();
}

/** Ejecuta `fn` cada vez que se cierre la hoja `id`. */
export function onSheetClose(id, fn) {
  if (!sheetClosers.has(id)) sheetClosers.set(id, []);
  sheetClosers.get(id).push(fn);
  const dialog = document.getElementById(id);
  if (dialog) bindSheet(dialog);
}

// ── Toasts ──────────────────────────────────────────────────────────────────
const TOAST_ICONS = { info: 'info', success: 'check-circle', warn: 'alert', error: 'alert' };
const recent = new Map();

/**
 * toast({ kind: 'info'|'success'|'warn'|'error', title, message, action: { label, run }, timeout })
 * Deduplica el mismo texto durante 8 s para no apilar el mismo error.
 */
export function toast({ kind = 'info', title, message = '', action, timeout } = {}) {
  const key = `${kind}|${title}|${message}`;
  const now = Date.now();
  if (recent.has(key) && now - recent.get(key) < 8000) return null;
  recent.set(key, now);

  const host = document.getElementById('toasts');
  // Con una hoja modal abierta el resto de la página queda inerte: los avisos van dentro de ella.
  const openDialog = document.querySelector('dialog[open]');
  if (openDialog && host.parentElement !== openDialog) openDialog.append(host);
  else if (!openDialog && host.parentElement !== document.body) document.body.append(host);
  const close = () => {
    if (!el.isConnected || el.classList.contains('is-leaving')) return;
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 200);
  };
  const el = h('div', { class: 'toast', role: kind === 'error' ? 'alert' : 'status', dataset: { kind } },
    icon(TOAST_ICONS[kind] || 'info'),
    h('div', {},
      title ? h('p', { class: 'toast__title', text: title }) : null,
      message ? h('p', { class: 'toast__msg', text: message }) : null,
      action ? h('div', { class: 'toast__actions' },
        h('button', { class: 'btn btn--glass btn--sm', type: 'button', onclick: () => { close(); action.run(); } }, action.label)) : null,
    ),
    h('button', { class: 'toast__close', type: 'button', 'aria-label': 'Cerrar aviso', onclick: close }, icon('x')),
  );
  host.append(el);
  while (host.children.length > 4) host.firstElementChild.remove();
  const ms = timeout ?? (kind === 'error' ? 10000 : kind === 'warn' ? 8000 : 5000);
  if (ms > 0) {
    let timer = setTimeout(close, ms);
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('mouseleave', () => { timer = setTimeout(close, 2500); });
  }
  return el;
}

/** Toast a partir de un error del puente/motor ({ code, message }). */
export function toastError(error, title = 'No se pudo completar') {
  const message = error?.message || 'Ocurrió un error inesperado.';
  return toast({ kind: 'error', title, message });
}
