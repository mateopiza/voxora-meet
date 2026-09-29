// Perfil de costos "reunión" de VOXORA Meet.
//
// Este módulo es la única fuente de verdad para convertir consumo de proveedores
// (segundos de audio, tokens, caracteres) en créditos VOX. Es deliberadamente
// independiente de la tabla del Plugin OBS: el perfil de reunión usa modelos más
// caros y se cobra por minuto de reunión, no por stream.
//
// Los precios dependen del modelo elegido en cada etapa (protocolo v3): la tabla
// por modelo está abajo (STT_PRICES, CHAT_PRICES, TTS_COST_MULTIPLIERS) y
// `pricingFor()` arma la tabla efectiva de una combinación de modelos.
//
// Sobre esa base se aplica un factor de margen configurable y una conversión
// fija USD → VOX. Todos los créditos que salen de aquí son enteros.

import { EventEmitter } from "node:events";

/** Créditos VOX por dólar: 1 VOX = 0.01 USD de costo base (antes del margen). */
export const VOX_PER_USD = 100;

/** Margen por defecto sobre el costo de proveedor (1.5 = +50 %). */
export const DEFAULT_MARGIN_FACTOR = 1.5;

/** Modelos por defecto de cada etapa (coinciden con los defaults de settings del engine). */
export const DEFAULT_MODELS = Object.freeze({
  stt: "whisper-large-v3",
  translate: "openai/gpt-oss-120b",
  tts: "eleven_multilingual_v2",
});

// ── Precios por modelo (USD) ────────────────────────────────────────────────

/**
 * Groq Whisper, USD por hora de audio transcripta.
 * Fuente: https://groq.com/pricing (consultado 2026-09-28). Groq factura como
 * mínimo 10 s por request de transcripción (se modela con `minBillableMs`).
 */
export const STT_PRICES = Object.freeze({
  "whisper-large-v3": 0.111,
  "whisper-large-v3-turbo": 0.04,
});
/** STT desconocido: se asume el Whisper más caro (estimación conservadora). */
export const DEFAULT_STT_USD_PER_HOUR = 0.111;
export const STT_MIN_BILLABLE_MS = 10_000;

/**
 * Groq chat completions, USD por 1M tokens de entrada / salida.
 * Fuentes:
 *   - gpt-oss-120b, gpt-oss-20b, qwen3.6-27b, qwen3.8-27b: campo `pricing` de
 *     `GET https://api.groq.com/openai/v1/models` (consultado 2026-09-28).
 *   - llama-3.3-70b-versatile, llama-3.1-8b-instant, kimi-k2, qwen3-32b:
 *     https://groq.com/pricing (tabla publicada 2025-09; ya no aparecen en el
 *     listado en vivo de la cuenta, se conservan por si el usuario los tiene).
 * Los tokens de razonamiento se facturan como salida.
 */
export const CHAT_PRICES = Object.freeze({
  "openai/gpt-oss-120b": Object.freeze({ input: 0.15, output: 0.6 }),
  "openai/gpt-oss-20b": Object.freeze({ input: 0.075, output: 0.3 }),
  "qwen/qwen3.6-27b": Object.freeze({ input: 0.6, output: 3.0 }),
  "qwen/qwen3.8-27b": Object.freeze({ input: 0.8, output: 4.0 }),
  "qwen/qwen3-32b": Object.freeze({ input: 0.29, output: 0.59 }),
  "llama-3.3-70b-versatile": Object.freeze({ input: 0.59, output: 0.79 }),
  "llama-3.1-8b-instant": Object.freeze({ input: 0.05, output: 0.08 }),
  "moonshotai/kimi-k2-instruct": Object.freeze({ input: 1.0, output: 3.0 }),
  "moonshotai/kimi-k2-instruct-0905": Object.freeze({ input: 1.0, output: 3.0 }),
});
/** Modelo de chat sin precio conocido: igual o más caro que el más caro de la tabla. */
export const DEFAULT_CHAT_PRICE = Object.freeze({ input: 1.0, output: 4.0 });

/**
 * ElevenLabs: 1 crédito por carácter × `character_cost_multiplier` del modelo.
 * El costo por crédito depende del plan (Creator 22 USD/100k ≈ 0.22, Pro
 * 99 USD/500k ≈ 0.198, Scale 330 USD/2M ≈ 0.165); se toma 0.18 USD por 1k
 * caracteres como base (banda Pro/Scale, la que usa VOXORA).
 * Multiplicadores: `model_rates.character_cost_multiplier` de
 * `GET https://api.elevenlabs.io/v1/models` (consultado 2026-09-28).
 */
export const TTS_BASE_USD_PER_1K_CHARS = 0.18;
export const TTS_COST_MULTIPLIERS = Object.freeze({
  eleven_multilingual_v2: 1,
  eleven_v3: 1,
  eleven_v3_conversational: 0.5,
  eleven_v4: 1,
  eleven_v4_turbo: 0.5,
  eleven_flash_v2_5: 0.5,
  eleven_turbo_v2_5: 0.5,
  eleven_flash_v2: 0.5,
  eleven_turbo_v2: 0.5,
});
export const DEFAULT_TTS_COST_MULTIPLIER = 1;

function cleanModelId(id, fallback) {
  const s = typeof id === "string" ? id.trim() : "";
  return s || fallback;
}

/** USD por hora de audio del modelo de STT (desconocido → el más caro). */
export function sttPriceFor(model) {
  const id = cleanModelId(model, DEFAULT_MODELS.stt);
  const known = Object.hasOwn(STT_PRICES, id.toLowerCase());
  return { model: id, usdPerHour: known ? STT_PRICES[id.toLowerCase()] : DEFAULT_STT_USD_PER_HOUR, known };
}

/**
 * Precio de un modelo de chat de Groq: `{ model, input, output, known }` en USD
 * por 1M tokens. Acepta el id con o sin prefijo de proveedor (`gpt-oss-120b`).
 */
export function chatPriceFor(model) {
  const id = cleanModelId(model, DEFAULT_MODELS.translate);
  const key = id.toLowerCase();
  let price = CHAT_PRICES[key];
  if (!price) {
    const tail = key.split("/").at(-1);
    const match = Object.keys(CHAT_PRICES).find((k) => k.split("/").at(-1) === tail);
    if (match) price = CHAT_PRICES[match];
    else if (/kimi-k2/.test(key)) price = CHAT_PRICES["moonshotai/kimi-k2-instruct"];
  }
  return price ? { model: id, input: price.input, output: price.output, known: true } : { model: id, ...DEFAULT_CHAT_PRICE, known: false };
}

/** Multiplicador de costo por carácter del modelo TTS (`override` = dato en vivo del catálogo). */
export function ttsCostMultiplierFor(model, override) {
  const n = Number(override);
  if (override != null && Number.isFinite(n) && n > 0) return n;
  const id = cleanModelId(model, DEFAULT_MODELS.tts);
  return TTS_COST_MULTIPLIERS[id] ?? DEFAULT_TTS_COST_MULTIPLIER;
}

/**
 * Tabla de precios efectiva para una combinación de modelos. Acepta las claves
 * planas de settings (`sttModel`, `translateModel`, `ttsModel`) y
 * `ttsCostMultiplier` (multiplicador en vivo de ElevenLabs, si se conoce).
 */
export function pricingFor({ sttModel, translateModel, ttsModel, ttsCostMultiplier } = {}) {
  const stt = sttPriceFor(sttModel);
  const chat = chatPriceFor(translateModel);
  const ttsId = cleanModelId(ttsModel, DEFAULT_MODELS.tts);
  const multiplier = ttsCostMultiplierFor(ttsId, ttsCostMultiplier);
  return Object.freeze({
    stt: Object.freeze({
      provider: "groq",
      model: stt.model,
      unit: "hora de audio",
      usdPerUnit: stt.usdPerHour,
      minBillableMs: STT_MIN_BILLABLE_MS,
    }),
    translate: Object.freeze({
      provider: "groq",
      model: chat.model,
      unit: "1M tokens",
      usdPerInputUnit: chat.input,
      usdPerOutputUnit: chat.output,
      knownPrice: chat.known,
    }),
    tts: Object.freeze({
      provider: "elevenlabs",
      model: ttsId,
      unit: "1k caracteres",
      usdPerUnit: Math.round(TTS_BASE_USD_PER_1K_CHARS * multiplier * 1e6) / 1e6,
      costMultiplier: multiplier,
    }),
  });
}

/**
 * Tabla de precios base en USD de los modelos por defecto. `unit` documenta la
 * unidad de facturación y `usdPerUnit` el precio público de referencia. Se
 * exporta congelada; para variantes usar `createPricing()` o `pricingFor()`.
 */
export const PRICING = pricingFor();

const MS_PER_HOUR = 3_600_000;

function nonNegativeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function hasModelOptions(options) {
  return ["sttModel", "translateModel", "ttsModel", "ttsCostMultiplier"].some((k) => options?.[k] != null);
}

/** `pricing` explícito, o la tabla de los modelos pedidos, o la de por defecto. */
function resolvePricing(options = {}) {
  if (options.pricing) return options.pricing;
  return hasModelOptions(options) ? pricingFor(options) : PRICING;
}

/** Convierte USD de proveedor a créditos VOX enteros aplicando el margen. */
export function usdToVox(usd, { marginFactor = DEFAULT_MARGIN_FACTOR, voxPerUsd = VOX_PER_USD } = {}) {
  const amount = nonNegativeNumber(usd);
  if (amount === 0) return 0;
  // Nunca se regala consumo real: cualquier uso positivo cuesta al menos 1 VOX.
  // El redondeo previo evita que el ruido de coma flotante (p. ej. 150.00000000000003)
  // sume un VOX de más.
  return Math.max(1, Math.ceil(Math.round(amount * marginFactor * voxPerUsd * 1e6) / 1e6));
}

/** Inverso aproximado (sin margen) para mostrar equivalencias en la UI. */
export function voxToUsd(vox, { voxPerUsd = VOX_PER_USD } = {}) {
  return nonNegativeNumber(vox) / voxPerUsd;
}

/**
 * Costo en USD (sin margen) de cada etapa de un turno. Se expone por separado
 * para poder auditar la tabla sin pasar por el redondeo a VOX. `pricing` puede
 * ser una tabla (`PRICING`, `pricingFor()`) o las opciones de modelo planas.
 */
export function estimateTurnUsd({ audioMs = 0, inputTokens = 0, outputTokens = 0, ttsChars = 0 } = {}, pricing = PRICING) {
  const table = pricing?.stt ? pricing : resolvePricing(pricing);
  const audio = nonNegativeNumber(audioMs);
  const billableAudioMs = audio > 0 ? Math.max(audio, table.stt.minBillableMs ?? 0) : 0;
  const stt = (billableAudioMs / MS_PER_HOUR) * table.stt.usdPerUnit;
  const translate =
    (nonNegativeNumber(inputTokens) / 1_000_000) * table.translate.usdPerInputUnit +
    (nonNegativeNumber(outputTokens) / 1_000_000) * table.translate.usdPerOutputUnit;
  const tts = (nonNegativeNumber(ttsChars) / 1_000) * table.tts.usdPerUnit;
  return { stt, translate, tts, total: stt + translate + tts };
}

/**
 * Costo de un turno en créditos VOX enteros, por etapa y total.
 * Contrato (docs/CONTRACTS.md): `{ stt, translate, tts, totalVox }`.
 * `options`: `{ marginFactor, voxPerUsd, pricing }` o los modelos planos
 * (`sttModel`, `translateModel`, `ttsModel`, `ttsCostMultiplier`).
 */
export function estimateTurnCost(usage = {}, options = {}) {
  const { marginFactor = DEFAULT_MARGIN_FACTOR, voxPerUsd = VOX_PER_USD } = options;
  const usd = estimateTurnUsd(usage, resolvePricing(options));
  const conv = { marginFactor, voxPerUsd };
  const stt = usdToVox(usd.stt, conv);
  const translate = usdToVox(usd.translate, conv);
  const tts = usdToVox(usd.tts, conv);
  return { stt, translate, tts, totalVox: stt + translate + tts };
}

/**
 * Supuestos de una reunión típica para proyectar consumo a partir de minutos.
 * Habla natural ~140 palabras/min, ~5.5 caracteres por palabra (con espacios),
 * ~1.4 tokens por palabra para idiomas europeos y turnos de ~8 s de habla. Cada
 * turno manda el prompt de sistema (~300 tokens) + la memoria de contexto
 * (`memoryTurns` pares origen/traducción) + el turno actual.
 * `reasoningTokensPerTurn`: tokens de razonamiento (facturados como salida)
 * según el esfuerzo, estimación gruesa para modelos que razonan.
 */
export const MEETING_ASSUMPTIONS = Object.freeze({
  speakingRatio: 0.5,
  wordsPerMinute: 140,
  charsPerWord: 5.5,
  tokensPerWord: 1.4,
  systemPromptTokens: 300,
  memoryTurns: 8,
  avgTurnMs: 8_000,
  reasoningTokensPerTurn: Object.freeze({ none: 0, low: 80, medium: 300, high: 1000, default: 300 }),
});

/** Tokens de razonamiento por turno según modelo y esfuerzo (0 si el modelo no razona). */
export function reasoningTokensPerTurn(translateModel, effort, table = MEETING_ASSUMPTIONS.reasoningTokensPerTurn) {
  const id = String(translateModel ?? DEFAULT_MODELS.translate).toLowerCase();
  const level = String(effort ?? "low").toLowerCase();
  if (/gpt-oss/.test(id)) {
    const e = level === "none" ? "low" : level === "default" ? "medium" : level;
    return table[e] ?? table.low;
  }
  if (/qwen-?3/.test(id)) return level === "none" || level === "low" ? 0 : table.default ?? table.medium;
  return 0;
}

/**
 * Estima el costo de una reunión de `minutes` minutos donde el usuario habla
 * `speakingRatio` del tiempo. Acepta los modelos planos de settings
 * (`sttModel`, `translateModel`, `ttsModel`, `ttsCostMultiplier`) y los ajustes
 * que cambian el consumo (`translateReasoningEffort`, `memoryTurns`).
 */
export function estimateMeetingCost({
  minutes,
  speakingRatio = MEETING_ASSUMPTIONS.speakingRatio,
  assumptions = {},
  translateReasoningEffort,
  memoryTurns,
  ...options
} = {}) {
  const a = { ...MEETING_ASSUMPTIONS, ...assumptions };
  const pricing = resolvePricing(options);
  const totalMinutes = nonNegativeNumber(minutes);
  const ratio = Math.min(1, Math.max(0, Number(speakingRatio) || 0));
  const speakingMinutes = totalMinutes * ratio;
  const words = speakingMinutes * a.wordsPerMinute;
  const turns = a.avgTurnMs > 0 ? Math.ceil((speakingMinutes * 60_000) / a.avgTurnMs) : 0;
  const tokensPerTurn = (a.avgTurnMs / 60_000) * a.wordsPerMinute * a.tokensPerWord;
  const memory = Math.max(0, Number.isFinite(Number(memoryTurns)) ? Number(memoryTurns) : a.memoryTurns);
  // La memoria se llena en los primeros turnos: se promedia al tope (estimación conservadora).
  const overheadPerTurn = a.systemPromptTokens + memory * 2 * tokensPerTurn;
  const reasoningPerTurn = reasoningTokensPerTurn(pricing.translate.model, translateReasoningEffort, a.reasoningTokensPerTurn);
  const usage = {
    audioMs: Math.round(speakingMinutes * 60_000),
    inputTokens: Math.round(words * a.tokensPerWord + turns * overheadPerTurn),
    outputTokens: Math.round(words * a.tokensPerWord + turns * reasoningPerTurn),
    ttsChars: Math.round(words * a.charsPerWord),
    turns,
  };
  const cost = estimateTurnCost(usage, { ...options, pricing });
  const usd = estimateTurnUsd(usage, pricing);
  return {
    minutes: totalMinutes,
    speakingRatio: ratio,
    models: { stt: pricing.stt.model, translate: pricing.translate.model, tts: pricing.tts.model },
    usage,
    cost,
    usd,
    voxPerMinute: totalMinutes > 0 ? cost.totalVox / totalMinutes : 0,
  };
}

const round = (n, digits) => Math.round(n * 10 ** digits) / 10 ** digits;

/**
 * Tarifas por hora de reunión para la UI (comando `cost.estimate`):
 * `{ minutes, speakingRatio, voxPerMinute, voxPerHour, usdPerHour,
 *    breakdown: { stt, translate, tts } (USD/h de proveedor, sin margen),
 *    breakdownVox: { stt, translate, tts } (VOX/h), models, prices, total: { vox, usd } }`.
 */
export function estimateCostRates({ minutes = 60, speakingRatio = MEETING_ASSUMPTIONS.speakingRatio, ...options } = {}) {
  const est = estimateMeetingCost({ minutes, speakingRatio, ...options });
  const pricing = resolvePricing(options);
  const perHour = est.minutes > 0 ? 60 / est.minutes : 0;
  return {
    minutes: est.minutes,
    speakingRatio: est.speakingRatio,
    voxPerMinute: round(est.voxPerMinute, 2),
    voxPerHour: Math.round(est.voxPerMinute * 60),
    usdPerHour: round(est.usd.total * perHour, 4),
    breakdown: {
      stt: round(est.usd.stt * perHour, 4),
      translate: round(est.usd.translate * perHour, 4),
      tts: round(est.usd.tts * perHour, 4),
    },
    breakdownVox: {
      stt: Math.round(est.cost.stt * perHour),
      translate: Math.round(est.cost.translate * perHour),
      tts: Math.round(est.cost.tts * perHour),
    },
    models: est.models,
    prices: {
      stt: { unit: pricing.stt.unit, usd: pricing.stt.usdPerUnit },
      translate: { unit: pricing.translate.unit, usdInput: pricing.translate.usdPerInputUnit, usdOutput: pricing.translate.usdPerOutputUnit, known: pricing.translate.knownPrice },
      tts: { unit: pricing.tts.unit, usd: pricing.tts.usdPerUnit, costMultiplier: pricing.tts.costMultiplier },
    },
    total: { vox: est.cost.totalVox, usd: round(est.usd.total, 4) },
    usage: est.usage,
  };
}

/** Crea una tabla derivada de `PRICING` (por ejemplo, para overrides por tier). */
export function createPricing(overrides = {}) {
  return Object.freeze({
    stt: Object.freeze({ ...PRICING.stt, ...(overrides.stt ?? {}) }),
    translate: Object.freeze({ ...PRICING.translate, ...(overrides.translate ?? {}) }),
    tts: Object.freeze({ ...PRICING.tts, ...(overrides.tts ?? {}) }),
  });
}

/**
 * Acumulador de consumo de una sesión (una reunión). Aplica límites y emite:
 *   - `warn`  → `{ totalVox, warnAtVox, remainingVox }` una sola vez al cruzar `warnAtVox`.
 *   - `limit` → `{ totalVox, maxVoxPerSession }` una sola vez al alcanzar el tope.
 *   - `cost`  → `{ cost, totalVox }` en cada `add()`.
 * `now` es inyectable (ms monotónicos) para calcular el ritmo por minuto en tests.
 */
export class SessionMeter extends EventEmitter {
  #totals = { stt: 0, translate: 0, tts: 0, totalVox: 0 };
  #turns = 0;
  #maxVoxPerSession;
  #warnAtVox;
  #warned = false;
  #limited = false;
  #now;
  #startedAt;

  constructor({ maxVoxPerSession = Infinity, warnAtVox = null, now = () => performance.now() } = {}) {
    super();
    this.#maxVoxPerSession = nonNegativeNumber(maxVoxPerSession) || Infinity;
    this.#warnAtVox = warnAtVox == null ? Math.floor(this.#maxVoxPerSession * 0.8) : nonNegativeNumber(warnAtVox);
    this.#now = now;
    this.#startedAt = now();
  }

  get totals() {
    return { ...this.#totals };
  }

  get totalVox() {
    return this.#totals.totalVox;
  }

  get turns() {
    return this.#turns;
  }

  get maxVoxPerSession() {
    return this.#maxVoxPerSession;
  }

  get warnAtVox() {
    return this.#warnAtVox;
  }

  get remainingVox() {
    return Number.isFinite(this.#maxVoxPerSession) ? Math.max(0, this.#maxVoxPerSession - this.#totals.totalVox) : Infinity;
  }

  get limitReached() {
    return this.#limited;
  }

  get elapsedMs() {
    return Math.max(0, this.#now() - this.#startedAt);
  }

  /** ¿Alcanza el presupuesto para un turno que costaría `vox`? */
  canAfford(vox) {
    return this.#totals.totalVox + nonNegativeNumber(vox) <= this.#maxVoxPerSession;
  }

  /** Suma el costo de un turno (`{ stt, translate, tts, totalVox }`) y evalúa límites. */
  add(cost = {}) {
    const stt = Math.round(nonNegativeNumber(cost.stt));
    const translate = Math.round(nonNegativeNumber(cost.translate));
    const tts = Math.round(nonNegativeNumber(cost.tts));
    const totalVox = cost.totalVox != null ? Math.round(nonNegativeNumber(cost.totalVox)) : stt + translate + tts;
    this.#totals = {
      stt: this.#totals.stt + stt,
      translate: this.#totals.translate + translate,
      tts: this.#totals.tts + tts,
      totalVox: this.#totals.totalVox + totalVox,
    };
    this.#turns += 1;
    this.emit("cost", { cost: { stt, translate, tts, totalVox }, totalVox: this.#totals.totalVox });

    if (!this.#warned && this.#warnAtVox > 0 && this.#totals.totalVox >= this.#warnAtVox && this.#totals.totalVox < this.#maxVoxPerSession) {
      this.#warned = true;
      this.emit("warn", { totalVox: this.#totals.totalVox, warnAtVox: this.#warnAtVox, remainingVox: this.remainingVox });
    }
    if (!this.#limited && this.#totals.totalVox >= this.#maxVoxPerSession) {
      this.#limited = true;
      this.emit("limit", { totalVox: this.#totals.totalVox, maxVoxPerSession: this.#maxVoxPerSession });
    }
    return this.snapshot();
  }

  /** Ritmo de consumo observado (VOX por minuto de reunión transcurrido). */
  voxPerMinute() {
    const minutes = this.elapsedMs / 60_000;
    return minutes > 0 ? this.#totals.totalVox / minutes : 0;
  }

  /** Minutos que quedan al ritmo actual antes de tocar el tope (null si no hay tope o ritmo). */
  estimateRemainingMinutes() {
    const rate = this.voxPerMinute();
    if (!Number.isFinite(this.#maxVoxPerSession) || rate <= 0) return null;
    return this.remainingVox / rate;
  }

  /** Proyección para `minutes` minutos más al ritmo actual (o al supuesto de reunión). */
  projectVox(minutes, { speakingRatio, ...models } = {}) {
    const rate = this.voxPerMinute();
    if (rate > 0) return Math.ceil(rate * nonNegativeNumber(minutes));
    return estimateMeetingCost({ minutes, speakingRatio, ...models }).cost.totalVox;
  }

  snapshot() {
    return {
      totals: this.totals,
      turns: this.#turns,
      totalVox: this.#totals.totalVox,
      remainingVox: this.remainingVox,
      maxVoxPerSession: this.#maxVoxPerSession,
      warnAtVox: this.#warnAtVox,
      warned: this.#warned,
      limitReached: this.#limited,
      elapsedMs: this.elapsedMs,
      voxPerMinute: this.voxPerMinute(),
    };
  }

  reset() {
    this.#totals = { stt: 0, translate: 0, tts: 0, totalVox: 0 };
    this.#turns = 0;
    this.#warned = false;
    this.#limited = false;
    this.#startedAt = this.#now();
  }
}
