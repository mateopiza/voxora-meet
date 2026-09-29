// Traducción con contexto para doblaje de reunión, sobre Groq Chat Completions
// (`openai/gpt-oss-120b` por defecto, configurable con VOXORA_MEET_GROQ_MODEL; se ignora GROQ_MODEL del Plugin OBS a propósito).
//
// Qué aporta frente a una traducción frase a frase:
//   - Memoria de los últimos N turnos (origen → traducción) como mensajes previos,
//     para consistencia terminológica y de referentes ("eso", "lo anterior").
//   - Glosario persistente por usuario (GlossaryStore): términos que no se
//     traducen o se traducen siempre igual, inyectados en el prompt de sistema.
//   - Control de tono (formal | professional | neutral) e instrucción de estilo
//     libre del usuario.
//   - Reintentos con backoff en 429/5xx, timeout y cancelación por AbortSignal.

import { fetchWithRetry, HttpError, isAbortError, parseRetryAfter, safeText, truncate } from "../util/http.mjs";
import { languageName, normalizeLanguage } from "../languages.mjs";

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
export const DEFAULT_TRANSLATE_MODEL = "openai/gpt-oss-120b";

/** Valores de esfuerzo de razonamiento que acepta el ajuste `translateReasoningEffort`. */
export const REASONING_EFFORTS = Object.freeze(["low", "medium", "high", "none", "default"]);

/**
 * Cómo razona cada familia de modelos de chat de Groq:
 *   - gpt-oss (openai/gpt-oss-*): `reasoning_effort` low | medium | high.
 *   - Qwen3 (qwen/qwen3-*): `reasoning_effort` none | default; con `default` el
 *     razonamiento se oculta (`reasoning_format: hidden`) para que no llegue al TTS.
 *   - Resto: no admite razonamiento configurable (no se manda nada).
 * Debe coincidir con `reasoningEfforts` del catálogo del engine (app/engine/models.mjs).
 */
export function chatReasoningProfile(model) {
  const id = String(model ?? "").toLowerCase();
  if (/gpt-oss/.test(id)) return { family: "gpt-oss", efforts: ["low", "medium", "high"] };
  if (/qwen-?3/.test(id)) return { family: "qwen3", efforts: ["none", "default"] };
  return { family: null, efforts: [] };
}

/**
 * Parámetros de razonamiento para el body de chat completions según el modelo
 * y el esfuerzo pedido. Traduce entre escalas: en gpt-oss `none` → low y
 * `default` → medium; en Qwen3 `low` → none y `medium`/`high` → default.
 */
export function reasoningParamsFor(model, effort = "low") {
  const { family } = chatReasoningProfile(model);
  const level = String(effort ?? "low").toLowerCase();
  if (family === "gpt-oss") {
    const mapped = level === "none" ? "low" : level === "default" ? "medium" : level;
    return { reasoning_effort: ["low", "medium", "high"].includes(mapped) ? mapped : "low" };
  }
  if (family === "qwen3") {
    return { reasoning_effort: level === "none" || level === "low" ? "none" : "default", reasoning_format: "hidden" };
  }
  return {};
}

/** Tokens extra de salida reservados para el razonamiento según el esfuerzo enviado. */
export const REASONING_TOKEN_BUDGET = Object.freeze({ none: 0, low: 1024, medium: 2048, default: 2048, high: 4096 });

/** Tope de `max_completion_tokens`: traducción (≥256) + razonamiento, acotado a 8192. */
export function maxCompletionTokens(source, reasoningEffort) {
  const translation = Math.max(256, Math.ceil(String(source ?? "").length * 1.5));
  const reasoning = reasoningEffort ? REASONING_TOKEN_BUDGET[reasoningEffort] ?? REASONING_TOKEN_BUDGET.low : 0;
  return Math.min(8192, translation + reasoning);
}

/** Temperatura de chat acotada a 0..1 (la traducción no gana nada por encima). */
export function clampTranslateTemperature(value, fallback = 0.2) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/** ¿El 400 de Groq se queja de los parámetros de razonamiento? */
function rejectsReasoningParams(status, body) {
  return (status === 400 || status === 422) && /reasoning_(effort|format)|reasoning is not supported|does not support reasoning/i.test(String(body ?? ""));
}

export const TONES = Object.freeze({
  formal: "Registro formal: trato de usted, sin coloquialismos ni contracciones informales; vocabulario cuidado.",
  professional: "Registro profesional de reunión de trabajo: claro, cortés y directo; se admite un tono cercano pero nunca vulgar.",
  neutral: "Registro neutro: conserva exactamente el nivel de formalidad del original, sin subirlo ni bajarlo.",
});

export class TranslationError extends Error {
  constructor(message, { cause, status, model } = {}) {
    super(message, { cause });
    this.name = "TranslationError";
    this.status = status;
    this.stage = "translate";
    if (model) this.model = model;
  }
}

/**
 * Prompt de sistema para doblaje en vivo. Es deliberadamente estricto: la
 * salida va directa al TTS, así que cualquier explicación o comilla se oiría.
 */
export function buildSystemPrompt({ sourceLanguage, targetLanguage, tone = "professional", styleInstruction = "", glossaryLines = [] }) {
  const src = languageName(sourceLanguage);
  const dst = languageName(targetLanguage);
  const toneText = TONES[tone] ?? TONES.professional;
  const parts = [
    `Eres el intérprete de voz de una persona en una reunión de trabajo por videollamada. Traduces de ${src} a ${dst} lo que esa persona acaba de decir, y tu traducción se convierte en audio con su propia voz clonada.`,
    "",
    "Reglas obligatorias:",
    `1. Responde ÚNICAMENTE con la traducción en ${dst}. Sin comillas, sin prefijos, sin notas, sin explicaciones, sin alternativas.`,
    "2. Habla en primera persona, como si fueras la persona: nunca la describas en tercera persona ni añadas \"dice que\".",
    "3. Conserva exactamente números, cifras, fechas, horas, importes, unidades, siglas, nombres propios, nombres de productos y direcciones de correo o URLs. No los conviertas ni los redondees.",
    "4. Mantén el significado completo: no resumas, no amplíes, no suavices ni endurezcas lo dicho.",
    "5. Produce texto natural para ser leído en voz alta: puntuación normal, sin listas, sin markdown, sin emojis, sin etiquetas.",
    "6. Si el original es una frase incompleta o interrumpida, traduce igualmente de forma fluida sin completarla con contenido inventado.",
    "7. Si el texto es ruido, muletillas sin contenido o no hay nada traducible, responde con una cadena vacía.",
    "8. Usa los turnos anteriores de la conversación solo como contexto para mantener terminología y referencias consistentes; traduce únicamente el último mensaje.",
    "",
    `Tono: ${toneText}`,
  ];
  if (glossaryLines.length) {
    parts.push("", "Glosario del usuario (respétalo siempre, aunque contradiga la traducción habitual):", ...glossaryLines);
  }
  const style = String(styleInstruction ?? "").trim();
  if (style) {
    parts.push("", `Instrucción de estilo del usuario (respétala siempre): ${style}`);
  }
  return parts.join("\n");
}

/** Limpia comillas envolventes y prefijos tipo "Traducción:" que a veces cuela el modelo. */
export function cleanTranslation(raw) {
  // Modelos con razonamiento en formato "raw" (Qwen3) pueden colar <think>…</think>.
  let text = String(raw ?? "").replace(/<think>[\s\S]*?(<\/think>|$)/gi, "").trim();
  text = text.replace(/^(traducci[oó]n|translation)\s*:\s*/i, "");
  const wrapped = /^(["'“«])(.*)(["'”»])$/s.exec(text);
  if (wrapped && wrapped[2].length && !wrapped[2].includes(wrapped[1])) text = wrapped[2].trim();
  return text;
}

export class ContextTranslator {
  #apiKey;
  #fetch;
  #memory = [];
  /** Modelos que rechazaron los parámetros de razonamiento: no se vuelven a mandar. */
  #noReasoning = new Set();

  constructor({
    apiKey = process.env.GROQ_API_KEY,
    model = process.env.VOXORA_MEET_GROQ_MODEL || DEFAULT_TRANSLATE_MODEL,
    temperature = 0.2,
    memoryTurns = 8,
    glossary = null,
    userId = "default",
    sourceLanguage = "es",
    targetLanguage = "en",
    tone = "professional",
    styleInstruction = "",
    baseUrl = GROQ_BASE_URL,
    timeoutMs = 20_000,
    retries = 2,
    sleep,
    fetch: fetchImpl,
    reasoningEffort = "low",
    logger = null,
  } = {}) {
    if (!apiKey) throw new TypeError("ContextTranslator: falta `apiKey` (GROQ_API_KEY)");
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.model = String(model || DEFAULT_TRANSLATE_MODEL);
    this.temperature = clampTranslateTemperature(temperature);
    this.memoryTurns = Math.max(0, Number(memoryTurns) || 0);
    this.glossary = glossary;
    this.userId = userId;
    this.sourceLanguage = normalizeLanguage(sourceLanguage);
    this.targetLanguage = normalizeLanguage(targetLanguage, "en");
    this.tone = TONES[tone] ? tone : "professional";
    this.styleInstruction = styleInstruction;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.sleep = sleep;
    this.reasoningEffort = reasoningEffort;
    this.logger = logger;
  }

  /** Copia de la memoria actual: `[{ source, translation }]`, del más antiguo al más reciente. */
  get memory() {
    return this.#memory.map((t) => ({ ...t }));
  }

  remember(source, translation) {
    if (!source || !translation) return;
    this.#memory.push({ source, translation });
    if (this.#memory.length > this.memoryTurns) this.#memory.splice(0, this.#memory.length - this.memoryTurns);
  }

  clearMemory() {
    this.#memory = [];
  }

  setTone(tone) {
    if (!TONES[tone]) throw new TypeError(`Tono desconocido: ${tone}`);
    this.tone = tone;
  }

  setStyleInstruction(text) {
    this.styleInstruction = String(text ?? "");
  }

  /** Cambia el modelo en caliente; la memoria se conserva (es texto, sirve a cualquier modelo). */
  setModel(model) {
    if (model) this.model = String(model);
    return this.model;
  }

  setTemperature(value) {
    this.temperature = clampTranslateTemperature(value, this.temperature);
    return this.temperature;
  }

  /** `low|medium|high` (gpt-oss) o `none|default` (Qwen3); se traduce por familia al enviar. */
  setReasoningEffort(effort) {
    const level = String(effort ?? "").toLowerCase();
    if (REASONING_EFFORTS.includes(level)) this.reasoningEffort = level;
    return this.reasoningEffort;
  }

  /** Cambia cuántos turnos se recuerdan; si baja, descarta los más antiguos. */
  setMemoryTurns(n) {
    const value = Math.max(0, Math.round(Number(n)));
    if (!Number.isFinite(value)) return this.memoryTurns;
    this.memoryTurns = value;
    if (this.#memory.length > value) this.#memory.splice(0, this.#memory.length - value);
    return this.memoryTurns;
  }

  /** Parámetros de razonamiento que se mandarán con el modelo actual (vacío si no aplica). */
  reasoningParams(model = this.model) {
    if (!this.reasoningEffort || this.#noReasoning.has(model)) return {};
    return reasoningParamsFor(model, this.reasoningEffort);
  }

  /** Construye la lista de mensajes (sistema + memoria + turno actual). */
  async buildMessages({ text, sourceLanguage, targetLanguage, tone, styleInstruction, userId }) {
    const glossaryLines = this.glossary ? await this.glossary.toPromptLines(userId ?? this.userId) : [];
    const system = buildSystemPrompt({
      sourceLanguage: sourceLanguage ?? this.sourceLanguage,
      targetLanguage: targetLanguage ?? this.targetLanguage,
      tone: tone ?? this.tone,
      styleInstruction: styleInstruction ?? this.styleInstruction,
      glossaryLines,
    });
    const messages = [{ role: "system", content: system }];
    for (const turn of this.#memory) {
      messages.push({ role: "user", content: turn.source });
      messages.push({ role: "assistant", content: turn.translation });
    }
    messages.push({ role: "user", content: text });
    return messages;
  }

  /**
   * Traduce `text`. Devuelve `{ translation, usage: { inputTokens, outputTokens },
   * model, discarded }`. Si el modelo responde vacío, `translation` es "" y
   * `discarded` true (no se guarda en memoria).
   */
  async translate({ text, sourceLanguage, targetLanguage, tone, styleInstruction, signal, userId } = {}) {
    const source = String(text ?? "").trim();
    if (!source) return { translation: "", usage: { inputTokens: 0, outputTokens: 0 }, model: this.model, discarded: true };

    const messages = await this.buildMessages({ text: source, sourceLanguage, targetLanguage, tone, styleInstruction, userId });
    // Se congela el modelo del turno: un cambio en caliente aplica desde el siguiente.
    const model = this.model;
    const reasoning = this.reasoningParams(model);
    const body = {
      model,
      temperature: this.temperature,
      messages,
      // Presupuesto holgado: una traducción rara vez supera 2-3x el original,
      // más el margen de razonamiento (esos tokens cuentan como salida: sin él,
      // gpt-oss con esfuerzo alto agota el tope pensando y devuelve vacío).
      max_completion_tokens: maxCompletionTokens(source, reasoning.reasoning_effort),
      stream: false,
      ...reasoning,
    };

    const url = `${this.baseUrl}/chat/completions`;
    let res = await this.#post(url, body, signal, model);
    if (!res.ok && Object.keys(reasoning).length) {
      // Un modelo que no admite los parámetros de razonamiento responde 400: se
      // recuerda y se reintenta una vez sin ellos (sin romper el turno).
      const errorBody = await safeText(res);
      if (rejectsReasoningParams(res.status, errorBody)) {
        this.#noReasoning.add(model);
        this.logger?.debug?.("translate.reasoning_unsupported", { model });
        for (const key of Object.keys(reasoning)) delete body[key];
        body.max_completion_tokens = maxCompletionTokens(source, null);
        res = await this.#post(url, body, signal, model);
      } else {
        this.#throwHttp(res, errorBody, url, model);
      }
    }
    if (!res.ok) this.#throwHttp(res, await safeText(res), url, model);
    let data;
    try {
      data = await res.json();
    } catch (error) {
      throw new TranslationError("Groq Chat devolvió una respuesta no JSON", { cause: error, model });
    }
    const translation = cleanTranslation(data?.choices?.[0]?.message?.content);
    const usage = {
      inputTokens: Number(data?.usage?.prompt_tokens) || 0,
      outputTokens: Number(data?.usage?.completion_tokens) || 0,
    };
    if (!translation) {
      this.logger?.debug?.("translate.empty", { source });
      return { translation: "", usage, model: data?.model ?? model, discarded: true };
    }
    this.remember(source, translation);
    return { translation, usage, model: data?.model ?? model, discarded: false };
  }

  async #post(url, body, signal, model) {
    try {
      return await fetchWithRetry(
        url,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        { retries: this.retries, timeoutMs: this.timeoutMs, signal, sleep: this.sleep, provider: "Groq Chat", fetch: this.#fetch },
      );
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      throw new TranslationError(`Groq Chat: ${error.message}`, { cause: error, status: error.status, model });
    }
  }

  #throwHttp(res, body, url, model) {
    const cause = new HttpError(`Groq Chat ${res.status}: ${truncate(body)}`, {
      status: res.status, body, url: String(url), provider: "Groq Chat", retryAfterMs: parseRetryAfter(res.headers),
    });
    throw new TranslationError(cause.message, { cause, status: res.status, model });
  }
}
