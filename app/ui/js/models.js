// Modelos (protocolo v3, docs/CONTRACTS.md): elección y ajuste del proveedor y el modelo de transcripción
// (Groq Whisper, ElevenLabs Scribe u OpenAI), traducción (LLM de Groq u OpenAI) y voz (ElevenLabs),
// vocabulario del STT, glosario del traductor, prueba de voz y costo estimado en vivo.
//   - Simple: nada (valores guardados o recomendados).
//   - Avanzado › Modelos: costo estimado y el modelo de cada etapa (ficha, precio, disponibilidad).
//   - Avanzado › Traducción: temperaturas, razonamiento, memoria, tono, estilo, vocabulario y glosario.
//   - Avanzado › Voz: ajustes de ElevenLabs, prueba de voz y Voice ID manual.
//
// Los ajustes se guardan con settings.set (debounce del store) y el motor los aplica desde el
// siguiente turno aunque haya una sesión en curso. Tono y estilo se siguen tomando al iniciar.

import { openAccounts, PROVIDER_LABELS } from './accounts.js';
import { engine } from './bridge.js';
import { $, bindSegmented, debounce, fillSelect, fmtDec, fmtInt, fmtUsd, h, icon, setBusy, setIcon, setSegmented, toast, toastError } from './dom.js';
import { reveal } from './nav.js';
import { errorAction } from './session.js';
import { flushSettings, needsRestart, patchSettings, state, subscribe } from './store.js';

/** Defaults del contrato v3 (si el motor aún no devolvió settings ni `defaults`). */
export const MODEL_DEFAULTS = Object.freeze({
  sttProvider: 'groq',
  sttModel: 'whisper-large-v3',
  sttTemperature: 0,
  translateProvider: 'groq',
  translateModel: 'openai/gpt-oss-120b',
  translateTemperature: 0.2,
  translateReasoningEffort: 'low',
  memoryTurns: 8,
  ttsModel: 'eleven_multilingual_v2',
  ttsStability: 0.5,
  ttsSimilarityBoost: 0.75,
  ttsStyle: 0,
  ttsSpeed: 1,
  ttsSpeakerBoost: true,
  ttsTextNormalization: 'auto',
});
const MODEL_KEYS = Object.keys(MODEL_DEFAULTS);
const VOICE_KEYS = ['ttsStability', 'ttsSimilarityBoost', 'ttsStyle', 'ttsSpeed', 'ttsSpeakerBoost', 'ttsTextNormalization'];
// Tarjeta (data-card de su .apply-chip) donde vive cada ajuste: Modelos (stt / translate / tts),
// Traducción (stt-tune / tr-tune / glossary) y Voz (tts-char / tts-read).
const CARD_OF = {
  sttProvider: 'stt', translateProvider: 'translate',
  sttModel: 'stt', sttTemperature: 'stt-tune', vocabulary: 'stt-tune',
  translateModel: 'translate', translateTemperature: 'tr-tune', translateReasoningEffort: 'tr-tune',
  memoryTurns: 'tr-tune', tone: 'tr-tune', styleInstruction: 'tr-tune', glossary: 'glossary',
  ttsModel: 'tts', ttsStability: 'tts-char', ttsSimilarityBoost: 'tts-char', ttsStyle: 'tts-char',
  ttsSpeed: 'tts-read', ttsSpeakerBoost: 'tts-read', ttsTextNormalization: 'tts-read',
};
/** Pestañas de Avanzado que pintan este módulo. */
const MODEL_TABS = new Set(['models', 'translation', 'voice']);
const RESTART_ONLY = new Set(['tone', 'styleInstruction']);
const EFFORT_LABELS = { none: 'Sin razonar', minimal: 'Mínimo', low: 'Bajo', medium: 'Medio', high: 'Alto', default: 'Normal' };
const PRESET_NAMES = ['Creativo', 'Natural', 'Robusto'];
const MAX_VOCAB = 200;
const MAX_GLOSSARY = 500;

const els = {};
const models = { catalog: null, loading: false, loaded: false, error: null, unsupported: false };
const lists = { vocabulary: [], glossary: [], vocabLoaded: false, glossLoaded: false, vocabError: '', glossError: '' };
let estimatedOnce = false;

const isUnsupported = (error) => error?.code === 'unknown_command';

/** Valor efectivo de un ajuste de modelo: settings → defaults del catálogo → contrato. */
function current(key) {
  const s = state.settings || {};
  if (s[key] !== undefined && s[key] !== null && s[key] !== '') return s[key];
  const d = models.catalog?.defaults;
  if (d && d[key] !== undefined) return d[key];
  return MODEL_DEFAULTS[key];
}

// Proveedor por etapa (la voz es siempre ElevenLabs). El catálogo trae las listas de todos los
// proveedores (`sttByProvider`, `translateByProvider`): cambiar de proveedor no espera al motor.
const PROVIDER_OF = { stt: 'sttProvider', translate: 'translateProvider' };
const PROVIDER_FALLBACK = { stt: ['groq', 'elevenlabs', 'openai'], translate: ['groq', 'openai'] };
const STAGE_KIND = { stt: { groq: 'Whisper', elevenlabs: 'Scribe', openai: 'Transcripción' }, translate: {} };
const providerLabel = (id) => models.catalog?.providers?.labels?.[id] || PROVIDER_LABELS[id] || id;

function listOf(kind) {
  const byProvider = PROVIDER_OF[kind] && models.catalog?.[`${kind}ByProvider`];
  const list = byProvider ? byProvider[current(PROVIDER_OF[kind])] : models.catalog?.[kind];
  return Array.isArray(list) ? list : [];
}
const findModel = (kind, id) => listOf(kind).find((m) => m.id === id) || null;

function patchModel(patch) {
  patchSettings(patch);
  requestEstimate();
}

// ── Selectores de modelo y fichas ───────────────────────────────────────────
function modelOptions(kind, value) {
  const list = listOf(kind);
  const opts = list.map((m) => ({
    value: m.id,
    label: `${m.label || m.id}${m.recommended ? ' · recomendado' : ''}${m.available === false ? ' (no disponible)' : ''}`,
  }));
  if (value && !list.some((m) => m.id === value)) opts.push({ value, label: list.length ? `${value} (no disponible)` : value });
  if (!opts.length) opts.push({ value: '', label: models.loading ? 'Cargando modelos…' : 'Sin modelos', disabled: true });
  return opts;
}

const fmtPrice = (n) => `US$${fmtDec(n, 2, 3)}`;

function priceText(price) {
  if (!price || !Number.isFinite(Number(price.usd))) return '';
  if (Number.isFinite(Number(price.usdOutput))) {
    return `${fmtPrice(price.usd)} entrada · ${fmtPrice(price.usdOutput)} salida / 1M tokens`;
  }
  return `${fmtPrice(price.usd)} / ${price.unit || 'uso'}`;
}

const badge = (tone, ...content) => h('span', { class: 'badge', dataset: { tone } }, ...content);

const SETTING_OF = { stt: 'sttModel', translate: 'translateModel', tts: 'ttsModel' };

function providerOptions(kind) {
  const ids = models.catalog?.providers?.[kind] || PROVIDER_FALLBACK[kind];
  return ids.map((id) => ({ value: id, label: `${providerLabel(id)}${state.keys[id] ? '' : ' (falta la key)'}` }));
}

/** Cambia el proveedor de una etapa y, con él, el modelo: el recomendado de su lista. */
function changeProvider(kind, provider) {
  const list = models.catalog?.[`${kind}ByProvider`]?.[provider] || [];
  const pick = list.find((m) => m.recommended && m.available !== false) || list.find((m) => m.available !== false);
  // Sin lista, el motor pone el modelo por defecto del proveedor al guardar.
  const model = pick?.id || models.catalog?.providers?.defaults?.[kind]?.[provider];
  patchModel({ [PROVIDER_OF[kind]]: provider, ...(model ? { [SETTING_OF[kind]]: model } : {}) });
  if (!state.keys[provider]) {
    toast({ kind: 'warn', title: `Falta la key de ${providerLabel(provider)}`, message: 'Conecta esa cuenta para poder usar este proveedor.', action: { label: 'Conectar', run: openAccounts } });
  }
}

function renderProviders() {
  for (const [kind, select] of [['stt', els.sttProvider], ['translate', els.trProvider]]) {
    const provider = String(current(PROVIDER_OF[kind]));
    fillSelect(select, providerOptions(kind), provider);
    const text = [providerLabel(provider), STAGE_KIND[kind][provider] || (kind === 'translate' ? 'LLM' : '')].filter(Boolean).join(' · ');
    for (const el of els.eyebrows[kind]) el.textContent = text;
  }
}

/** Aviso para un modelo guardado que ya no está en la cuenta: sugiere el recomendado. */
function unavailableNote(kind, m) {
  const rec = listOf(kind).find((x) => x.recommended && x.available !== false && x.id !== m.id)
    || listOf(kind).find((x) => x.available !== false && x.id !== m.id);
  const note = h('p', { class: 'model-info__warn' }, icon('alert'), h('span', {}, 'Este modelo ya no está disponible en tu cuenta: el doblaje fallará con él.'));
  if (rec) {
    const use = h('button', { class: 'link', type: 'button' }, `Usar ${rec.label || rec.id}`);
    use.addEventListener('click', () => patchModel({ [SETTING_OF[kind]]: rec.id }));
    note.append(use);
  }
  return note;
}

function renderInfo(el, kind, m) {
  if (!m) {
    el.hidden = true;
    el.dataset.sig = '';
    return;
  }
  // Solo se reconstruye si cambia la ficha (settings notifica en cada tecla del estilo).
  const sig = JSON.stringify([m, m.available === false ? listOf(kind).map((x) => x.id) : 0]);
  if (el.dataset.sig === sig && !el.hidden) return;
  el.dataset.sig = sig;
  const meta = [];
  if (m.recommended) meta.push(badge('brand', 'Recomendado'));
  if (m.available === false) meta.push(badge('bad', 'No disponible'));
  const price = priceText(m.price);
  if (price) meta.push(badge('cyan', price));
  if (kind === 'translate') {
    if (Number(m.contextWindow) > 0) meta.push(badge('muted', `${fmtInt(m.contextWindow / 1024)}k de contexto`));
    if (m.supportsReasoningEffort) meta.push(badge('violet', 'Razona'));
  }
  if (kind === 'tts') {
    if (Number(m.languages) > 0) meta.push(badge('violet', `${fmtInt(m.languages)} ${Number(m.languages) === 1 ? 'idioma' : 'idiomas'}`));
    const mult = Number(m.costMultiplier);
    if (Number.isFinite(mult)) meta.push(badge(mult < 1 ? 'ok' : mult > 1 ? 'warn' : 'muted', `Costo ×${fmtDec(mult, 0, 2)}`));
  }
  el.replaceChildren(...[
    m.available === false ? unavailableNote(kind, m) : null,
    m.description ? h('p', { class: 'model-info__desc' }, m.description) : null,
    meta.length ? h('div', { class: 'model-info__meta' }, ...meta) : null,
  ].filter(Boolean));
  el.dataset.tone = m.available === false ? 'bad' : '';
  el.hidden = false;
}

// ── Sliders ─────────────────────────────────────────────────────────────────
const ranges = [];

function bindRange(input, output, key, format) {
  const r = { input, output, key, format };
  input.addEventListener('input', () => {
    paintRange(r);
    patchModel({ [key]: Number(input.value) });
  });
  ranges.push(r);
  return r;
}

function paintRange(r) {
  const v = Number(r.input.value);
  const min = Number(r.input.min);
  const max = Number(r.input.max);
  r.output.textContent = r.format(v);
  r.input.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`);
}

function syncRange(r) {
  if (document.activeElement !== r.input) r.input.value = String(current(r.key));
  paintRange(r);
}

// ── Render ──────────────────────────────────────────────────────────────────
function renderEffort(m) {
  const efforts = m?.supportsReasoningEffort
    ? (Array.isArray(m.reasoningEfforts) && m.reasoningEfforts.length ? m.reasoningEfforts : ['low', 'medium', 'high'])
    : [];
  els.effortField.hidden = !efforts.length;
  if (!efforts.length) return;
  const sig = efforts.join('|');
  if (els.effortSeg.dataset.sig !== sig) {
    els.effortSeg.dataset.sig = sig;
    els.effortSeg.replaceChildren(...efforts.map((e) => h('button', { type: 'button', role: 'radio', 'data-value': e }, EFFORT_LABELS[e] || e)));
    bindSegmented(els.effortSeg, (value) => patchModel({ translateReasoningEffort: value }));
  }
  const value = String(current('translateReasoningEffort'));
  // Si el esfuerzo guardado no existe en este modelo, el motor usa el más ligero.
  setSegmented(els.effortSeg, efforts.includes(value) ? value : efforts.includes('low') ? 'low' : efforts[0]);
}

function renderStability(m) {
  const presets = Array.isArray(m?.stabilityPresets) && m.stabilityPresets.length ? m.stabilityPresets.map(Number) : null;
  els.stabilityField.hidden = Boolean(presets);
  els.presetsField.hidden = !presets;
  if (!presets) return;
  const sig = presets.join('|');
  if (els.presetsSeg.dataset.sig !== sig) {
    els.presetsSeg.dataset.sig = sig;
    els.presetsSeg.replaceChildren(...presets.map((p, i) => h('button', {
      type: 'button', role: 'radio', 'data-value': String(p), title: `Estabilidad ${fmtDec(p, 1, 2)}`,
    }, presets.length === PRESET_NAMES.length ? PRESET_NAMES[i] : fmtDec(p, 1, 2))));
    bindSegmented(els.presetsSeg, (value) => patchModel({ ttsStability: Number(value) }));
  }
  const v = Number(current('ttsStability'));
  const nearest = presets.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
  setSegmented(els.presetsSeg, String(nearest));
}

function renderTts(m) {
  renderStability(m);
  // Sin catálogo se muestran todos los controles (el motor ignora lo que el modelo no admite).
  const known = Boolean(m);
  els.styleField.hidden = known && !m.supportsStyle;
  els.boostField.hidden = known && !m.supportsSpeakerBoost;
  els.speedField.hidden = known && m.supportsSpeed === false;
  els.boost.checked = Boolean(current('ttsSpeakerBoost'));
  const noForce = known && m.supportsNormalizationOn === false;
  const onBtn = els.normSeg.querySelector('[data-value="on"]');
  onBtn.disabled = noForce;
  onBtn.title = noForce ? 'Este modelo no admite forzar la normalización' : '';
  setSegmented(els.normSeg, String(current('ttsTextNormalization')));
}

function renderModels() {
  renderProviders();
  const stt = String(current('sttModel'));
  const tr = String(current('translateModel'));
  const tts = String(current('ttsModel'));
  fillSelect(els.sttModel, modelOptions('stt', stt), stt);
  fillSelect(els.trModel, modelOptions('translate', tr), tr);
  fillSelect(els.ttsModel, modelOptions('tts', tts), tts);
  renderInfo(els.sttInfo, 'stt', findModel('stt', stt));
  renderInfo(els.trInfo, 'translate', findModel('translate', tr));
  renderInfo(els.ttsInfo, 'tts', findModel('tts', tts));
  renderEffort(findModel('translate', tr));
  renderTts(findModel('tts', tts));
  ranges.forEach(syncRange);

  const s = state.settings || {};
  setSegmented(els.tone, s.tone || 'professional');
  if (document.activeElement !== els.style) els.style.value = s.styleInstruction || '';
  els.styleCounter.textContent = `${els.style.value.length}/400`;
}

function fetchedLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const today = new Date().toDateString() === date.toDateString();
  return today ? `Lista de las ${time}` : `Lista del ${date.toLocaleDateString('es-ES')} ${time}`;
}

function renderNote() {
  const running = state.session.state === 'running';
  const errors = Object.values(models.catalog?.errors || {}).map((e) => e?.message).filter(Boolean);
  let text;
  let live = false;
  if (models.unsupported) text = 'Tu motor de doblaje aún no permite elegir modelos: actualiza VOXORA Meet.';
  else if (models.error && !models.catalog) text = `No se pudo leer la lista de modelos: ${models.error}`;
  else if (running) {
    text = 'En vivo: los cambios se aplican desde la siguiente frase, sin reiniciar el doblaje.';
    live = true;
  } else text = 'Los cambios se guardan solos y se aplican desde la siguiente frase.';
  els.noteText.textContent = text;
  els.note.dataset.live = String(live);
  els.offline.hidden = !models.catalog?.offline;
  els.offline.title = errors.length ? errors.join(' ') : 'No se pudo consultar a algún proveedor: se muestra el catálogo de referencia de la app.';
  els.fetched.textContent = fetchedLabel(models.catalog?.fetchedAt);
  els.trRestart.hidden = !(running && (needsRestart.fields.has('tone') || needsRestart.fields.has('styleInstruction')));
}

// ── Costo estimado (cost.estimate) ──────────────────────────────────────────
let estimateSeq = 0;
const partUsd = (v) => (typeof v === 'number' ? v : Number(v?.usdPerHour ?? v?.usd ?? 0) || 0);
const partVox = (v) => (typeof v === 'number' ? v : v && typeof v === 'object' ? Number(v.voxPerHour ?? v.vox) : NaN);

function renderCost(r) {
  if (!r) {
    els.voxMin.textContent = '—';
    els.voxH.textContent = '—';
    els.usdH.textContent = '—';
    for (const li of els.legend.querySelectorAll('li')) li.querySelector('strong').textContent = '—';
    for (const span of els.bar.children) span.style.flexGrow = '1';
    return;
  }
  const perMin = Number(r.voxPerMinute);
  els.voxMin.textContent = Number.isFinite(perMin) ? fmtDec(perMin, perMin < 10 ? 1 : 0, perMin < 10 ? 2 : 0) : '—';
  els.voxH.textContent = Number.isFinite(Number(r.voxPerHour)) ? fmtInt(r.voxPerHour) : '—';
  const usd = Number(r.usdPerHour);
  els.usdH.textContent = Number.isFinite(usd) ? `$${fmtDec(usd, 2, usd > 0 && usd < 0.1 ? 3 : 2)}` : '—';
  const parts = ['stt', 'translate', 'tts'];
  const b = r.breakdown || {};
  const bv = r.breakdownVox || {};
  const values = parts.map((p) => partUsd(b[p]));
  const total = values.reduce((a, c) => a + c, 0);
  // breakdown = USD/h de proveedor sin margen; breakdownVox = VOX/h que se cobran.
  parts.forEach((p, i) => {
    els.bar.querySelector(`[data-part="${p}"]`).style.flexGrow = String(total > 0 ? values[i] : 1);
    const li = els.legend.querySelector(`[data-part="${p}"]`);
    li.querySelector('strong').textContent = fmtUsd(values[i]);
    const vox = partVox(bv[p]);
    li.title = Number.isFinite(vox) ? `Proveedor: ${fmtUsd(values[i])}/h · te cuesta ${fmtInt(vox)} VOX/h` : `Proveedor: ${fmtUsd(values[i])}/h`;
  });
  const ratio = Number(r.speakingRatio);
  els.assume.textContent = `Supone que hablas el ${fmtInt((Number.isFinite(ratio) ? ratio : 0.5) * 100)} % del tiempo de la reunión.`;
}

async function runEstimate() {
  if (state.engine.state !== 'ready' || models.unsupported) return;
  const seq = ++estimateSeq;
  estimatedOnce = true;
  els.costTiles.dataset.loading = 'true';
  const overrides = Object.fromEntries(MODEL_KEYS.map((k) => [k, current(k)]));
  try {
    const result = await engine('cost.estimate', { minutes: 60, speakingRatio: 0.5, overrides }, 20000);
    if (seq === estimateSeq) renderCost(result);
  } catch (error) {
    if (seq !== estimateSeq) return;
    if (isUnsupported(error)) {
      models.unsupported = true;
      renderNote();
    }
    renderCost(null);
  } finally {
    if (seq === estimateSeq) delete els.costTiles.dataset.loading;
  }
}
const requestEstimate = debounce(runEstimate, 350);

// ── Aviso sutil de guardado / aplicación ────────────────────────────────────
function flashApplied(card, keys) {
  const chip = els.chips[card];
  if (!chip) return;
  const running = state.session.state === 'running';
  const restartOnly = keys.length > 0 && keys.every((k) => RESTART_ONLY.has(k));
  const text = running ? (restartOnly ? 'Al reiniciar' : 'Desde la próxima frase') : 'Guardado';
  chip.replaceChildren(icon(running && !restartOnly ? 'zap' : 'check'), text);
  chip.dataset.tone = running && restartOnly ? 'violet' : 'ok';
  chip.hidden = false;
  clearTimeout(chip.hideTimer);
  chip.hideTimer = setTimeout(() => { chip.hidden = true; }, running ? 3200 : 1800);
}

function onSaved() {
  const byCard = new Map();
  for (const key of state.lastSaved.keys) {
    const card = CARD_OF[key];
    if (!card) continue;
    if (!byCard.has(card)) byCard.set(card, []);
    byCard.get(card).push(key);
  }
  for (const [card, keys] of byCard) flashApplied(card, keys);
}

// ── Vocabulario (STT) ───────────────────────────────────────────────────────
function renderVocab() {
  els.vocabCount.textContent = `${lists.vocabulary.length} / ${MAX_VOCAB}`;
  const chips = lists.vocabulary.map((term, index) => {
    const x = h('button', { class: 'chip__x', type: 'button', 'aria-label': `Quitar ${term}`, title: 'Quitar' }, icon('x'));
    x.addEventListener('click', () => {
      lists.vocabulary.splice(index, 1);
      renderVocab();
      saveVocab();
    });
    return h('span', { class: 'chip' }, h('span', { class: 'chip__text', title: term }, term), x);
  });
  if (!chips.length) {
    chips.push(h('p', { class: 'chips__empty' }, lists.vocabLoaded ? 'Aún no hay términos.' : lists.vocabError || 'Cargando…'));
  }
  els.vocabChips.replaceChildren(...chips);
  const disabled = !lists.vocabLoaded;
  els.vocabInput.disabled = disabled;
  els.vocabAdd.disabled = disabled;
}

function addVocab(raw) {
  const incoming = String(raw).split(/[,;\n]/).map((t) => t.trim().replace(/\s+/g, ' ')).filter(Boolean);
  const seen = new Set(lists.vocabulary.map((t) => t.toLocaleLowerCase()));
  let added = 0;
  let overflow = 0;
  for (const term of incoming) {
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    if (lists.vocabulary.length >= MAX_VOCAB) {
      overflow += 1;
      continue;
    }
    seen.add(key);
    lists.vocabulary.push(term.slice(0, 80));
    added += 1;
  }
  if (overflow) toast({ kind: 'warn', title: 'Vocabulario lleno', message: `Caben hasta ${MAX_VOCAB} términos: quita alguno para añadir más.` });
  if (added) {
    renderVocab();
    saveVocab();
  }
  return added || !incoming.length;
}

const saveVocab = debounce(async () => {
  try {
    const result = await engine('vocabulary.set', { terms: lists.vocabulary }, 15000);
    if (Array.isArray(result?.terms)) lists.vocabulary = result.terms;
    renderVocab();
    flashApplied('stt', ['vocabulary']);
  } catch (error) {
    toastError(error, 'No se pudo guardar el vocabulario');
  }
}, 600);

// ── Glosario (traducción) ───────────────────────────────────────────────────
function renderGloss() {
  els.glossCount.textContent = String(lists.glossary.length);
  const rows = lists.glossary.map((entry, index) => {
    const remove = h('button', { class: 'btn btn--ghost btn--icon', type: 'button', title: 'Quitar', 'aria-label': `Quitar ${entry.term} del glosario` }, icon('trash'));
    remove.addEventListener('click', () => {
      lists.glossary.splice(index, 1);
      renderGloss();
      saveGloss();
    });
    const edit = () => editGloss(entry);
    const term = h('span', { class: 'gloss__term', title: `${entry.term} · pulsa para editar` }, entry.term);
    const to = h('span', { class: 'gloss__to', title: entry.translation ? `${entry.translation} · pulsa para editar` : 'Se mantiene sin traducir' },
      entry.translation ? entry.translation : badge('muted', 'No traducir'));
    term.addEventListener('click', edit);
    to.addEventListener('click', edit);
    return h('li', { class: 'gloss__row' }, term, h('span', { class: 'gloss__arrow' }, icon('arrow-right')), to, remove);
  });
  if (!rows.length) {
    rows.push(h('li', {}, h('p', { class: 'gloss__empty' }, lists.glossLoaded
      ? 'Sin entradas. Ej.: «VOXORA» → no traducir; «tablero» → «dashboard».'
      : lists.glossError || 'Cargando…')));
  }
  els.glossList.replaceChildren(...rows);
  const disabled = !lists.glossLoaded;
  for (const el of [els.glossTerm, els.glossTo, els.glossKeep, els.glossAdd]) el.disabled = disabled;
  syncKeep();
}

function syncKeep() {
  const keep = els.glossKeep.checked;
  if (lists.glossLoaded) els.glossTo.disabled = keep;
  els.glossTo.placeholder = keep ? 'Se dice igual' : 'Traducción fija';
  if (keep) els.glossTo.removeAttribute('aria-invalid');
}

function editGloss(entry) {
  els.glossTerm.value = entry.term;
  els.glossKeep.checked = !entry.translation;
  els.glossTo.value = entry.translation || '';
  syncKeep();
  (entry.translation ? els.glossTo : els.glossTerm).focus();
}

function submitGloss(event) {
  event.preventDefault();
  const term = els.glossTerm.value.trim().replace(/\s+/g, ' ');
  const keep = els.glossKeep.checked;
  const translation = keep ? null : els.glossTo.value.trim();
  if (!term) {
    els.glossTerm.setAttribute('aria-invalid', 'true');
    els.glossTerm.focus();
    return;
  }
  if (!keep && !translation) {
    els.glossTo.setAttribute('aria-invalid', 'true');
    els.glossTo.focus();
    return;
  }
  const at = lists.glossary.findIndex((e) => e.term.toLocaleLowerCase() === term.toLocaleLowerCase());
  const entry = { ...(at >= 0 ? lists.glossary[at] : {}), term, translation: translation || null };
  if (at >= 0) lists.glossary[at] = entry;
  else if (lists.glossary.length >= MAX_GLOSSARY) {
    toast({ kind: 'warn', title: 'Glosario lleno', message: `Caben hasta ${MAX_GLOSSARY} términos.` });
    return;
  } else lists.glossary.push(entry);
  els.glossTerm.value = '';
  els.glossTo.value = '';
  els.glossKeep.checked = false;
  renderGloss();
  saveGloss();
  els.glossTerm.focus();
}

const saveGloss = debounce(async () => {
  try {
    const entries = lists.glossary.map((e) => ({ term: e.term, translation: e.translation || null, ...(e.note ? { note: e.note } : {}) }));
    const result = await engine('glossary.set', { entries }, 15000);
    if (Array.isArray(result?.entries)) lists.glossary = result.entries;
    renderGloss();
    flashApplied('translate', ['glossary']);
  } catch (error) {
    toastError(error, 'No se pudo guardar el glosario');
  }
}, 600);

async function loadLists() {
  const [gloss, vocab] = await Promise.allSettled([engine('glossary.get', {}, 15000), engine('vocabulary.get', {}, 15000)]);
  const why = (e) => (isUnsupported(e) ? 'Tu motor aún no admite esta lista: actualiza VOXORA Meet.' : e?.message || 'No se pudo leer.');
  if (gloss.status === 'fulfilled') {
    lists.glossary = Array.isArray(gloss.value?.entries) ? gloss.value.entries.filter((e) => e?.term) : [];
    lists.glossLoaded = true;
    lists.glossError = '';
  } else lists.glossError = why(gloss.reason);
  if (vocab.status === 'fulfilled') {
    lists.vocabulary = Array.isArray(vocab.value?.terms) ? vocab.value.terms.map(String) : [];
    lists.vocabLoaded = true;
    lists.vocabError = '';
  } else lists.vocabError = why(vocab.reason);
  renderGloss();
  renderVocab();
}

// ── Prueba de voz (tts.preview) ─────────────────────────────────────────────
let previewAudio = null;
let previewUrl = '';

/** data:audio/…;base64 → blob: (la CSP admite blob: en media-src, no data:). */
function dataUrlToBlobUrl(dataUrl) {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(String(dataUrl || ''));
  if (!match) throw Object.assign(new Error('El motor no devolvió audio.'), { code: 'internal' });
  const bytes = match[2]
    ? Uint8Array.from(atob(match[3]), (c) => c.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(match[3]));
  return URL.createObjectURL(new Blob([bytes], { type: match[1] || 'audio/wav' }));
}

function stopTtsPreview() {
  if (previewAudio) {
    previewAudio.onended = null;
    previewAudio.pause();
    previewAudio = null;
  }
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = '';
  }
  if (!els.previewBtn.classList.contains('is-busy')) {
    setIcon(els.previewBtn, 'play');
    els.previewBtn.querySelector('span').textContent = 'Probar voz';
  }
}

async function previewVoice(event) {
  event.preventDefault();
  if (previewAudio) {
    stopTtsPreview();
    return;
  }
  if (state.engine.state !== 'ready') {
    toast({ kind: 'warn', title: 'El motor no está listo', message: 'Espera a que el motor arranque para probar la voz.' });
    return;
  }
  if (!state.keys.elevenlabs) {
    toast({ kind: 'warn', title: 'Falta la key de ElevenLabs', message: 'Conecta tu cuenta de ElevenLabs para probar la voz.', action: { label: 'Conectar', run: openAccounts } });
    return;
  }
  if (!state.settings?.voiceId) {
    toast({ kind: 'warn', title: 'Elige una voz', message: 'Elige o clona tu voz en Reunión › Tu voz para probarla.', action: { label: 'Elegir voz', run: () => reveal('#field-voice') } });
    return;
  }
  const btn = els.previewBtn;
  setBusy(btn, true, 'Generando…');
  btn.disabled = true;
  try {
    await flushSettings();
    const text = els.previewText.value.trim();
    const result = await engine('tts.preview', { ...(text ? { text } : {}), voiceId: state.settings.voiceId }, 60000);
    previewUrl = dataUrlToBlobUrl(result.audioDataUrl);
    previewAudio = new Audio(previewUrl);
    previewAudio.onended = stopTtsPreview;
    previewAudio.onerror = () => {
      stopTtsPreview();
      toast({ kind: 'warn', title: 'No se pudo reproducir la prueba' });
    };
    await previewAudio.play();
    const model = findModel('tts', result.model)?.label || result.model || '';
    els.previewNote.textContent = `Usó ${fmtInt(result.chars)} caracteres de ElevenLabs${model ? ` · ${model}` : ''}.`;
  } catch (error) {
    stopTtsPreview();
    toast({ kind: 'error', title: 'No se pudo probar la voz', message: error.message, action: errorAction(error) });
  } finally {
    setBusy(btn, false);
    btn.disabled = false;
    if (previewAudio) {
      setIcon(btn, 'stop');
      btn.querySelector('span').textContent = 'Detener';
    }
  }
}

function resetVoice() {
  const defaults = { ...MODEL_DEFAULTS, ...(models.catalog?.defaults || {}) };
  patchModel(Object.fromEntries(VOICE_KEYS.map((k) => [k, defaults[k]])));
  toast({ kind: 'info', title: 'Valores recomendados', message: 'Estabilidad, similitud, estilo, velocidad y normalización vuelven a sus valores por defecto.', timeout: 3500 });
}

// ── Carga ───────────────────────────────────────────────────────────────────
/** models.list (+ glosario y vocabulario la primera vez). `refresh` fuerza consultar a los proveedores. */
export async function loadModels({ refresh = false, quiet = true } = {}) {
  if (state.engine.state !== 'ready' || models.loading) return;
  models.loading = true;
  if (refresh) setBusy(els.refresh, true, 'Actualizando…');
  renderModels();
  try {
    const firstLoad = !models.loaded;
    const [catalog] = await Promise.all([
      engine('models.list', { refresh }, 30000),
      firstLoad ? loadLists() : null,
    ]);
    models.catalog = catalog;
    models.loaded = true;
    models.error = null;
    models.unsupported = false;
    if (refresh && !quiet) {
      toast(catalog?.offline
        ? { kind: 'warn', title: 'Sin conexión con los proveedores', message: 'Se muestra el catálogo de referencia de la app.' }
        : { kind: 'success', title: 'Lista de modelos actualizada', message: `${listOf('stt').length + listOf('translate').length + listOf('tts').length} modelos disponibles en tus cuentas.`, timeout: 3000 });
    }
  } catch (error) {
    models.error = error.message;
    if (isUnsupported(error)) models.unsupported = true;
    else if (!quiet) toastError(error, 'No se pudo leer la lista de modelos');
  } finally {
    models.loading = false;
    if (refresh) setBusy(els.refresh, false);
    renderModels();
    renderNote();
    requestEstimate();
  }
}

export function initModels() {
  Object.assign(els, {
    note: $('#models-note'), noteText: $('#models-note-text'), offline: $('#models-offline'), fetched: $('#models-fetched'),
    refresh: $('#btn-models-refresh'), costTiles: $('#cost-tiles'),
    voxMin: $('#cost-voxmin'), voxH: $('#cost-voxh'), usdH: $('#cost-usdh'),
    bar: $('#cost-bar'), legend: $('#cost-legend'), assume: $('#cost-assume'),
    sttProvider: $('#sel-stt-provider'), sttModel: $('#sel-stt-model'), sttInfo: $('#stt-info'),
    trProvider: $('#sel-tr-provider'), trModel: $('#sel-tr-model'), trInfo: $('#tr-info'), effortField: $('#field-tr-effort'), effortSeg: $('#seg-tr-effort'),
    tone: $('#seg-tone'), style: $('#inp-style'), styleCounter: $('#style-counter'), trRestart: $('#tr-restart-hint'),
    ttsModel: $('#sel-tts-model'), ttsInfo: $('#tts-info'),
    stabilityField: $('#field-tts-stability'), presetsField: $('#field-tts-presets'), presetsSeg: $('#seg-tts-presets'),
    styleField: $('#field-tts-style'), speedField: $('#rng-tts-speed').closest('.field'), boostField: $('#field-tts-boost'), boost: $('#chk-tts-boost'),
    normSeg: $('#seg-tts-norm'),
    previewForm: $('#tts-preview-form'), previewText: $('#inp-tts-preview'), previewBtn: $('#btn-tts-preview'), previewNote: $('#tts-preview-note').querySelector('span'),
    reset: $('#btn-tts-reset'),
    vocabCount: $('#vocab-count'), vocabChips: $('#vocab-chips'), vocabForm: $('#vocab-form'), vocabInput: $('#inp-vocab'),
    glossCount: $('#gloss-count'), glossList: $('#gloss-list'), glossForm: $('#gloss-form'), glossTerm: $('#inp-gloss-term'),
    glossTo: $('#inp-gloss-to'), glossKeep: $('#chk-gloss-keep'),
  });
  els.vocabAdd = els.vocabForm.querySelector('button[type="submit"]');
  els.glossAdd = els.glossForm.querySelector('button[type="submit"]');
  els.eyebrows = { stt: Array.from(document.querySelectorAll('[data-eyebrow="stt"]')), translate: Array.from(document.querySelectorAll('[data-eyebrow="translate"]')) };
  els.chips = Object.fromEntries(Array.from(document.querySelectorAll('.apply-chip')).map((c) => [c.dataset.card, c]));

  const two = (v) => fmtDec(v, 2);
  bindRange($('#rng-stt-temp'), $('#stt-temp-value'), 'sttTemperature', two);
  bindRange($('#rng-tr-temp'), $('#tr-temp-value'), 'translateTemperature', two);
  bindRange($('#rng-tr-memory'), $('#tr-memory-value'), 'memoryTurns', (v) => (v === 0 ? 'Sin memoria' : `${fmtInt(v)} ${v === 1 ? 'turno' : 'turnos'}`));
  bindRange($('#rng-tts-stability'), $('#tts-stability-value'), 'ttsStability', two);
  bindRange($('#rng-tts-similarity'), $('#tts-similarity-value'), 'ttsSimilarityBoost', two);
  bindRange($('#rng-tts-style'), $('#tts-style-value'), 'ttsStyle', two);
  bindRange($('#rng-tts-speed'), $('#tts-speed-value'), 'ttsSpeed', (v) => `${fmtDec(v, 2)}×`);

  els.sttProvider.addEventListener('change', () => changeProvider('stt', els.sttProvider.value));
  els.trProvider.addEventListener('change', () => changeProvider('translate', els.trProvider.value));
  els.sttModel.addEventListener('change', () => patchModel({ sttModel: els.sttModel.value }));
  els.trModel.addEventListener('change', () => patchModel({ translateModel: els.trModel.value }));
  els.ttsModel.addEventListener('change', () => patchModel({ ttsModel: els.ttsModel.value }));
  els.boost.addEventListener('change', () => patchModel({ ttsSpeakerBoost: els.boost.checked }));
  bindSegmented(els.normSeg, (value) => patchModel({ ttsTextNormalization: value }));
  bindSegmented(els.tone, (value) => patchSettings({ tone: value }));
  els.style.addEventListener('input', () => {
    els.styleCounter.textContent = `${els.style.value.length}/400`;
    patchSettings({ styleInstruction: els.style.value });
  });

  els.refresh.addEventListener('click', () => loadModels({ refresh: true, quiet: false }));
  els.previewForm.addEventListener('submit', previewVoice);
  els.reset.addEventListener('click', resetVoice);

  els.vocabForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (addVocab(els.vocabInput.value)) els.vocabInput.value = '';
  });
  els.vocabInput.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text') || '';
    if (!/[,;\n]/.test(text)) return;
    event.preventDefault();
    addVocab(text);
  });
  els.glossForm.addEventListener('submit', submitGloss);
  els.glossKeep.addEventListener('change', syncKeep);
  els.glossTerm.addEventListener('input', () => els.glossTerm.removeAttribute('aria-invalid'));
  els.glossTo.addEventListener('input', () => els.glossTo.removeAttribute('aria-invalid'));

  subscribe('settings', () => {
    renderModels();
    if (!estimatedOnce && state.settings) requestEstimate();
  });
  subscribe('saved', onSaved);
  subscribe('session', renderNote);
  subscribe('engine', () => {
    // El catálogo se pide al arrancar (caché de 10 min en el motor): las pestañas abren ya pintadas.
    if (state.engine.state === 'ready' && !models.loaded && !models.loading) loadModels();
    renderNote();
  });
  let keysSig = JSON.stringify(state.keys);
  subscribe('keys', () => {
    // `keys` también se notifica en cada guardado de ajustes: solo importa si cambió alguna.
    const sig = JSON.stringify(state.keys);
    if (sig === keysSig) return;
    keysSig = sig;
    renderProviders();
    // Con una key nueva la lista de ese proveedor pasa de «de referencia» a «en vivo».
    if (models.loaded && state.engine.state === 'ready') loadModels({ refresh: true });
  });
  subscribe('tab', () => {
    if (MODEL_TABS.has(state.activeTab) && !models.loaded && !models.loading) loadModels();
    if (state.activeTab !== 'voice') stopTtsPreview();
  });

  renderModels();
  renderNote();
  renderVocab();
  renderGloss();
  renderCost(null);
}
