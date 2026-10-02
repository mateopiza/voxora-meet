// Cuentas de proveedores (API keys de Groq, ElevenLabs y OpenAI): hoja «Conecta tus cuentas» (en ambos
// modos) y tarjeta «Cuentas» de Avanzado › Ajustes. Las keys se envían al motor, que las cifra con DPAPI y
// nunca las devuelve (la UI solo ve booleanos). Las tres se piden por igual (aviso bajo la barra superior
// y hoja de cuentas); para iniciar el doblaje solo bloquean las de los proveedores elegidos en Modelos
// (transcripción y traducción) más ElevenLabs (voz).

import { engine, native } from './bridge.js';
import { $, $$, openSheet, setBusy, setIcon, toast, toastError } from './dom.js';
import { notify, state, subscribe } from './store.js';

const PROVIDERS = [
  { id: 'groq', name: 'Groq', desc: 'Transcripción (Whisper) y traducción.', placeholder: 'gsk_…', url: 'https://console.groq.com/keys' },
  { id: 'elevenlabs', name: 'ElevenLabs', desc: 'Tu voz clonada (síntesis y clonación) y transcripción con Scribe.', placeholder: 'sk_…', url: 'https://elevenlabs.io/app/settings/api-keys' },
  { id: 'openai', name: 'OpenAI', desc: 'Traducción con GPT y transcripción, si lo eliges en Modelos.', placeholder: 'sk-…', url: 'https://platform.openai.com/api-keys' },
];
const LABELS = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.name]));
const blocks = [];  // { provider, block, input, clear, save }
const els = {};

/** Proveedores cuya key hace falta con los ajustes actuales: transcripción, traducción y ElevenLabs (voz). */
export function requiredProviders() {
  const s = state.settings || {};
  const ids = new Set([s.sttProvider || 'groq', s.translateProvider || 'groq', 'elevenlabs']);
  return PROVIDERS.filter((p) => ids.has(p.id));
}

export const missingKeys = () => requiredProviders().filter((p) => !state.keys[p.id]).map((p) => p.name);

/** «A», «A y B», «A, B y C». */
export const joinNames = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} y ${names.at(-1)}` : names[0] || '');

const nextMissing = () => blocks.find((b) => b.host === 'sheet' && !state.keys[b.provider]);

/** Abre la hoja de cuentas (con foco en la primera key que falte). */
export function openAccounts() {
  const dialog = openSheet('sheet-accounts');
  if (!dialog) return;
  const first = nextMissing() || blocks.find((b) => b.host === 'sheet');
  first?.input.focus();
}

async function saveKey(provider, value) {
  const result = await engine('settings.set', { settings: {}, providerKeys: { [provider]: value } }, 30000);
  state.keys = { ...state.keys, ...(result.providerKeys || {}) };
  notify('keys');
}

function buildBlock(provider, host) {
  const tpl = $('#tpl-key');
  const block = tpl.content.firstElementChild.cloneNode(true);
  block.dataset.provider = provider.id;
  block.querySelector('.key__name').textContent = provider.name;
  block.querySelector('.key__desc').textContent = provider.desc;
  const form = block.querySelector('[data-role="form"]');
  const input = block.querySelector('[data-role="input"]');
  const reveal = block.querySelector('[data-role="reveal"]');
  const save = block.querySelector('[data-role="save"]');
  const clear = block.querySelector('[data-role="clear"]');
  const link = block.querySelector('[data-role="link"]');
  input.setAttribute('aria-label', `API key de ${provider.name}`);
  clear.setAttribute('aria-label', `Borrar key de ${provider.name}`);
  link.querySelector('span').textContent = `Conseguir una key de ${provider.name}`;

  reveal.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    reveal.setAttribute('aria-label', show ? 'Ocultar key' : 'Mostrar key');
    reveal.title = show ? 'Ocultar' : 'Mostrar';
    setIcon(reveal, show ? 'eye-off' : 'eye');
    input.focus();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) {
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    if (/\s/.test(value)) {
      input.setAttribute('aria-invalid', 'true');
      toast({ kind: 'warn', title: 'Revisa la key', message: 'La key no puede tener espacios: cópiala de nuevo desde el panel del proveedor.' });
      return;
    }
    input.removeAttribute('aria-invalid');
    setBusy(save, true);
    save.disabled = true;
    try {
      await saveKey(provider.id, value);
      input.value = '';
      input.type = 'password';
      setIcon(reveal, 'eye');
      toast({ kind: 'success', title: `Key de ${provider.name} guardada`, message: 'Se cifró en este equipo y no se volverá a mostrar.' });
      // En la hoja: pasar a la siguiente key que falte, o cerrar si ya están todas.
      if (host === 'sheet') {
        const next = nextMissing();
        if (next) next.input.focus();
        else setTimeout(() => $('#sheet-accounts')?.close(), 600);
      }
    } catch (error) {
      toastError(error, 'No se pudo guardar la key');
    } finally {
      setBusy(save, false);
      save.disabled = state.engine.state !== 'ready';
    }
  });
  input.addEventListener('input', () => input.removeAttribute('aria-invalid'));

  // Borrado en dos pasos (sin diálogos del navegador).
  let armed = 0;
  clear.addEventListener('click', async () => {
    if (!armed) {
      armed = setTimeout(() => { armed = 0; clear.classList.remove('btn--danger'); clear.title = 'Borrar key guardada'; }, 4000);
      clear.classList.add('btn--danger');
      clear.title = 'Pulsa otra vez para borrar';
      toast({ kind: 'warn', title: `¿Borrar la key de ${provider.name}?`, message: 'Pulsa otra vez la papelera para confirmar.', timeout: 4000 });
      return;
    }
    clearTimeout(armed);
    armed = 0;
    clear.classList.remove('btn--danger');
    try {
      await saveKey(provider.id, '');
      toast({ kind: 'info', title: `Key de ${provider.name} borrada` });
    } catch (error) {
      toastError(error, 'No se pudo borrar la key');
    }
  });

  link.addEventListener('click', () => native('native.openExternal', { url: provider.url }).catch(toastError));
  blocks.push({ provider: provider.id, host, block, input, clear, save });
  return block;
}

function renderKeys() {
  for (const b of blocks) {
    const saved = Boolean(state.keys[b.provider]);
    const badge = b.block.querySelector('[data-role="status"]');
    badge.textContent = saved ? 'Conectada' : 'Falta';
    badge.dataset.tone = saved ? 'ok' : 'bad';
    b.clear.hidden = !saved;
    b.input.placeholder = saved ? 'Guardada · pega otra para cambiarla' : PROVIDERS.find((p) => p.id === b.provider).placeholder;
    b.save.disabled = state.engine.state !== 'ready';
  }
  // Aviso bajo la barra superior: solo con el motor listo (si no, no sabemos si faltan).
  const missing = PROVIDERS.filter((p) => !state.keys[p.id]).map((p) => p.name);
  const show = state.engine.state === 'ready' && missing.length > 0;
  els.banner.hidden = !show;
  if (show) {
    els.bannerText.textContent = missing.length > 1
      ? `Faltan las claves de ${joinNames(missing)}.`
      : `Falta la clave de ${missing[0]}.`;
  }
}

export function initAccounts() {
  els.banner = $('#keys-banner');
  els.bannerText = $('#keys-banner-text');
  for (const host of $$('[data-keys-host]')) {
    host.replaceChildren(...PROVIDERS.map((p) => buildBlock(p, host.dataset.keysHost)));
  }
  $('#btn-keys-banner').addEventListener('click', openAccounts);
  subscribe('keys', renderKeys);
  subscribe('engine', renderKeys);
  renderKeys();
}

export const PROVIDER_LABELS = LABELS;
