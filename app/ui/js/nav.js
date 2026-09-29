// Vistas: en modo Simple una sola pantalla («simple», sin pestañas); en Avanzado, pestañas (patrón ARIA
// tabs con tabindex itinerante y atajos Ctrl+1…7): Reunión, En vivo, Cámara, Modelos, Traducción, Voz y
// Ajustes. `state.activeTab` es la vista visible ('simple' o el id de la pestaña).
//
// Controles compartidos (vista previa, cámara, micrófono, idiomas, voz, botón de inicio y subtítulos):
// son un único nodo (mismo id y listeners) que se mueve al hueco [data-slot] de la vista visible.

import { $$ } from './dom.js';
import { setMode } from './mode.js';
import { notify, state } from './store.js';

const ALL_TABS = ['meeting', 'live', 'camera', 'models', 'translation', 'voice', 'settings'];
// Destinos antiguos o genéricos → pestaña donde viven ahora.
const ALIASES = { advanced: 'models', text: 'translation', accounts: 'settings', limits: 'settings', image: 'camera' };
let lastTab = 'meeting';

/** Pestañas visibles en el modo actual (ninguna en Simple). */
export const visibleTabs = () => (state.uiMode === 'advanced' ? ALL_TABS : []);

/** Lleva cada control compartido al hueco de la vista `view` (si esa vista tiene hueco para él). */
function placeShared(view) {
  const panel = document.getElementById(`panel-${view}`);
  if (!panel) return;
  for (const slot of panel.querySelectorAll('[data-slot]')) {
    const node = document.getElementById(slot.dataset.slot);
    if (!node || node.parentElement === slot) continue;
    slot.append(node);
    // Mover un <video> o una lista con scroll reinicia su estado: se recupera.
    for (const video of node.querySelectorAll('video')) if (video.srcObject && video.paused) video.play().catch(() => {});
    for (const feed of node.querySelectorAll('.feed')) feed.scrollTop = feed.scrollHeight;
  }
}

export function goTab(name) {
  let target;
  if (state.uiMode !== 'advanced') target = 'simple';
  else {
    target = ALIASES[name] || name;
    if (!ALL_TABS.includes(target)) target = lastTab;
    lastTab = target;
  }
  const visible = visibleTabs();
  document.getElementById('panel-simple').hidden = target !== 'simple';
  for (const id of ALL_TABS) {
    const tab = document.getElementById(`tab-${id}`);
    const selected = id === target;
    tab.hidden = !visible.includes(id);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    document.getElementById(`panel-${id}`).hidden = !selected;
  }
  placeShared(target);
  if (state.activeTab !== target) {
    state.activeTab = target;
    notify('tab');
  }
}

/** ¿Se ve ahora mismo este elemento? */
const shown = (el) => Boolean(el && el.getClientRects().length);

/** Lleva a un control concreto (vista + scroll + foco), p. ej. desde un toast o la checklist. Si el
 *  control no existe en Simple (salida, modelos, límites…), pasa a Avanzado para enseñarlo. */
export function reveal(selector, tab = 'meeting') {
  goTab(tab);
  if (!shown(document.querySelector(selector)) && state.uiMode !== 'advanced') {
    setMode('advanced');
    goTab(tab);
  }
  requestAnimationFrame(() => {
    const el = document.querySelector(selector);
    if (!shown(el)) return;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const focusable = el.matches('select, input, button, textarea') ? el : el.querySelector('select, input, button, textarea');
    focusable?.focus({ preventScroll: true });
    el.classList.add('is-flash');
    setTimeout(() => el.classList.remove('is-flash'), 1400);
  });
}

export function initNav() {
  const tabs = () => $$('.tab').filter((t) => !t.hidden);
  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => goTab(tab.id.slice(4)));
    tab.addEventListener('keydown', (event) => {
      const list = tabs();
      const index = list.indexOf(tab);
      let next = null;
      if (event.key === 'ArrowRight') next = list[(index + 1) % list.length];
      else if (event.key === 'ArrowLeft') next = list[(index - 1 + list.length) % list.length];
      else if (event.key === 'Home') next = list[0];
      else if (event.key === 'End') next = list[list.length - 1];
      if (!next) return;
      event.preventDefault();
      goTab(next.id.slice(4));
      next.focus();
    });
  }
  document.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || event.altKey || event.metaKey) return;
    const n = Number(event.key);
    const visible = visibleTabs();
    if (n >= 1 && n <= visible.length) {
      event.preventDefault();
      goTab(visible[n - 1]);
      document.getElementById(`tab-${visible[n - 1]}`).focus();
    }
  });
}
