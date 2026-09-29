// Modo de la interfaz: «Simple» (una sola pantalla sin pestañas: vista previa, idiomas, voz, cámara y
// micrófono, inicio y subtítulos; el resto usa los valores recomendados) o «Avanzado» (todo, repartido
// en pestañas). Se guarda en el ajuste `uiMode` del motor; una copia en localStorage evita el parpadeo
// al arrancar (antes de que el motor devuelva los ajustes).

import { $, bindSegmented, setSegmented } from './dom.js';
import { goTab } from './nav.js';
import { notify, patchSettings, state, subscribe } from './store.js';

const MODES = new Set(['simple', 'advanced']);
const els = {};

function applyMode(mode) {
  const next = MODES.has(mode) ? mode : 'simple';
  const changed = state.uiMode !== next;
  state.uiMode = next;
  document.body.dataset.mode = next;
  setSegmented(els.seg, next);
  try { localStorage.setItem('voxora.uiMode', next); } catch { /* opcional */ }
  // Simple = la pantalla única; Avanzado = la última pestaña abierta (Reunión la primera vez).
  goTab(next === 'simple' ? 'simple' : null);
  if (changed) notify('mode');
}

/** Cambia de modo desde la UI y lo guarda. */
export function setMode(mode) {
  applyMode(mode);
  patchSettings({ uiMode: state.uiMode });
}

export function initMode() {
  els.seg = $('#seg-mode');
  let initial = 'simple';
  try { initial = localStorage.getItem('voxora.uiMode') || 'simple'; } catch { /* sin almacenamiento */ }
  // Solo en el simulador (navegador): ?mode=advanced para revisar el diseño.
  const forced = !window.chrome?.webview ? new URLSearchParams(location.search).get('mode') : null;
  applyMode(forced || initial);
  bindSegmented(els.seg, (value) => setMode(value));
  // El motor manda (p. ej. otra instalación o un settings.json editado); un motor sin `uiMode` no cambia nada.
  subscribe('settings', () => {
    const saved = state.settings?.uiMode;
    if (MODES.has(saved) && saved !== state.uiMode && !forced) applyMode(saved);
  });
}
