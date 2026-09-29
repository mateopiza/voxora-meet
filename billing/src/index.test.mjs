import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRICING,
  VOX_PER_USD,
  DEFAULT_MARGIN_FACTOR,
  usdToVox,
  voxToUsd,
  estimateTurnUsd,
  estimateTurnCost,
  estimateMeetingCost,
  estimateCostRates,
  createPricing,
  pricingFor,
  sttPriceFor,
  chatPriceFor,
  ttsCostMultiplierFor,
  reasoningTokensPerTurn,
  DEFAULT_CHAT_PRICE,
  TTS_BASE_USD_PER_1K_CHARS,
  SessionMeter,
} from "./index.mjs";

test("precios por modelo: Whisper v3 vs turbo, chat por 1M tokens y multiplicador TTS", () => {
  assert.deepEqual(sttPriceFor("whisper-large-v3"), { model: "whisper-large-v3", usdPerHour: 0.111, known: true });
  assert.equal(sttPriceFor("whisper-large-v3-turbo").usdPerHour, 0.04);
  assert.equal(sttPriceFor("whisper-nuevo").usdPerHour, 0.111, "STT desconocido → el más caro");
  assert.equal(sttPriceFor("whisper-nuevo").known, false);

  assert.deepEqual(chatPriceFor("openai/gpt-oss-120b"), { model: "openai/gpt-oss-120b", input: 0.15, output: 0.6, known: true });
  assert.equal(chatPriceFor("gpt-oss-20b").input, 0.075, "acepta el id sin prefijo");
  assert.equal(chatPriceFor("llama-3.3-70b-versatile").output, 0.79);
  assert.equal(chatPriceFor("llama-3.1-8b-instant").input, 0.05);
  assert.equal(chatPriceFor("moonshotai/kimi-k2-instruct-0905").input, 1);
  assert.equal(chatPriceFor("moonshotai/kimi-k2-nueva").output, 3, "familia kimi-k2");
  assert.equal(chatPriceFor("qwen/qwen3-32b").output, 0.59);
  const unknown = chatPriceFor("acme/modelo-x");
  assert.equal(unknown.known, false);
  assert.equal(unknown.input, DEFAULT_CHAT_PRICE.input);
  assert.ok(DEFAULT_CHAT_PRICE.output >= 4, "default conservador: no más barato que el más caro conocido");

  assert.equal(ttsCostMultiplierFor("eleven_multilingual_v2"), 1);
  assert.equal(ttsCostMultiplierFor("eleven_flash_v2_5"), 0.5);
  assert.equal(ttsCostMultiplierFor("eleven_turbo_v2_5"), 0.5);
  assert.equal(ttsCostMultiplierFor("eleven_desconocido"), 1);
  assert.equal(ttsCostMultiplierFor("eleven_multilingual_v2", 0.3), 0.3, "el dato en vivo manda");
  assert.equal(ttsCostMultiplierFor("eleven_flash_v2_5", "x"), 0.5);

  const p = pricingFor({ sttModel: "whisper-large-v3-turbo", translateModel: "openai/gpt-oss-20b", ttsModel: "eleven_flash_v2_5" });
  assert.equal(p.stt.usdPerUnit, 0.04);
  assert.equal(p.translate.usdPerOutputUnit, 0.3);
  assert.equal(p.tts.usdPerUnit, TTS_BASE_USD_PER_1K_CHARS * 0.5);
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.tts));
  assert.deepEqual(pricingFor(), PRICING);
});

test("estimateTurnCost y estimateTurnUsd aceptan los modelos planos de settings", () => {
  const usage = { audioMs: 3_600_000, inputTokens: 1_000_000, outputTokens: 1_000_000, ttsChars: 10_000 };
  const base = estimateTurnUsd(usage);
  const cheap = estimateTurnUsd(usage, { sttModel: "whisper-large-v3-turbo", translateModel: "llama-3.1-8b-instant", ttsModel: "eleven_flash_v2_5" });
  assert.ok(Math.abs(base.stt - 0.111) < 1e-9);
  assert.ok(Math.abs(cheap.stt - 0.04) < 1e-9);
  assert.ok(Math.abs(cheap.translate - 0.13) < 1e-9);
  assert.ok(Math.abs(cheap.tts - base.tts / 2) < 1e-9);

  const costBase = estimateTurnCost(usage);
  const costFlash = estimateTurnCost(usage, { ttsModel: "eleven_flash_v2_5" });
  assert.equal(costFlash.stt, costBase.stt);
  assert.ok(costFlash.tts < costBase.tts);
  // Modelo de chat desconocido: nunca más barato que el default.
  assert.ok(estimateTurnCost(usage, { translateModel: "acme/x" }).translate > costBase.translate);
  // 1000 caracteres a 0.18 USD × 1.5 = 27 VOX exactos (sin ruido de coma flotante).
  assert.equal(estimateTurnCost({ ttsChars: 1000 }).tts, 27);
});

test("estimateMeetingCost: modelos, esfuerzo de razonamiento y memoria cambian el consumo", () => {
  const base = estimateMeetingCost({ minutes: 60, speakingRatio: 0.5 });
  assert.deepEqual(base.models, { stt: "whisper-large-v3", translate: "openai/gpt-oss-120b", tts: "eleven_multilingual_v2" });
  const turbo = estimateMeetingCost({ minutes: 60, speakingRatio: 0.5, sttModel: "whisper-large-v3-turbo", ttsModel: "eleven_flash_v2_5" });
  assert.ok(turbo.usd.stt < base.usd.stt && turbo.usd.tts < base.usd.tts);
  assert.equal(turbo.models.tts, "eleven_flash_v2_5");

  const high = estimateMeetingCost({ minutes: 60, translateReasoningEffort: "high" });
  const low = estimateMeetingCost({ minutes: 60, translateReasoningEffort: "low" });
  assert.ok(high.usage.outputTokens > low.usage.outputTokens);
  const llama = estimateMeetingCost({ minutes: 60, translateModel: "llama-3.3-70b-versatile", translateReasoningEffort: "high" });
  assert.equal(llama.usage.outputTokens, estimateMeetingCost({ minutes: 60, translateModel: "llama-3.3-70b-versatile" }).usage.outputTokens);

  const noMemory = estimateMeetingCost({ minutes: 60, memoryTurns: 0 });
  assert.ok(noMemory.usage.inputTokens < base.usage.inputTokens);

  assert.equal(reasoningTokensPerTurn("openai/gpt-oss-120b", "medium"), 300);
  assert.equal(reasoningTokensPerTurn("qwen/qwen3-32b", "low"), 0);
  assert.ok(reasoningTokensPerTurn("qwen/qwen3-32b", "default") > 0);
  assert.equal(reasoningTokensPerTurn("llama-3.3-70b-versatile", "high"), 0);
});

test("estimateCostRates devuelve la forma de cost.estimate (USD/h por etapa y VOX)", () => {
  const r = estimateCostRates({ minutes: 60, speakingRatio: 0.5 });
  for (const key of ["voxPerMinute", "voxPerHour", "usdPerHour"]) assert.equal(typeof r[key], "number");
  assert.deepEqual(Object.keys(r.breakdown), ["stt", "translate", "tts"]);
  const sum = r.breakdown.stt + r.breakdown.translate + r.breakdown.tts;
  assert.ok(Math.abs(sum - r.usdPerHour) < 1e-3, "el desglose suma el total por hora");
  assert.equal(r.voxPerHour, r.total.vox, "a 60 min el total es la tarifa por hora");
  assert.ok(r.breakdown.tts > r.breakdown.stt, "el TTS domina el costo");
  assert.equal(r.prices.tts.costMultiplier, 1);

  // 30 minutos proyectan la misma tarifa por hora (±redondeo).
  const half = estimateCostRates({ minutes: 30, speakingRatio: 0.5 });
  assert.ok(Math.abs(half.usdPerHour - r.usdPerHour) / r.usdPerHour < 0.02);

  const flash = estimateCostRates({ minutes: 60, ttsModel: "eleven_flash_v2_5" });
  assert.ok(Math.abs(flash.breakdown.tts - r.breakdown.tts / 2) < 1e-3);
  assert.equal(flash.models.tts, "eleven_flash_v2_5");

  const zero = estimateCostRates({ minutes: 0 });
  assert.equal(zero.usdPerHour, 0);
  assert.equal(zero.voxPerHour, 0);
});

test("PRICING expone precios base documentados y está congelada", () => {
  assert.equal(PRICING.stt.model, "whisper-large-v3");
  assert.equal(PRICING.stt.usdPerUnit, 0.111);
  assert.equal(PRICING.translate.model, "openai/gpt-oss-120b");
  assert.equal(PRICING.translate.usdPerInputUnit, 0.15);
  assert.equal(PRICING.translate.usdPerOutputUnit, 0.6);
  assert.equal(PRICING.tts.model, "eleven_multilingual_v2");
  assert.equal(PRICING.tts.usdPerUnit, 0.18);
  assert.ok(Object.isFrozen(PRICING) && Object.isFrozen(PRICING.stt));
  assert.equal(VOX_PER_USD, 100);
  assert.equal(DEFAULT_MARGIN_FACTOR, 1.5);
});

test("usdToVox aplica margen, redondea hacia arriba y nunca cobra 0 por uso real", () => {
  assert.equal(usdToVox(0), 0);
  assert.equal(usdToVox(-1), 0);
  assert.equal(usdToVox(NaN), 0);
  assert.equal(usdToVox(0.0001), 1);
  // 1 USD * 1.5 * 100 = 150 VOX
  assert.equal(usdToVox(1), 150);
  assert.equal(usdToVox(1, { marginFactor: 2 }), 200);
  assert.equal(usdToVox(1, { marginFactor: 1, voxPerUsd: 10 }), 10);
  assert.equal(voxToUsd(150), 1.5);
});

test("estimateTurnUsd calcula cada etapa con la tabla base y el mínimo de 10 s de Groq", () => {
  const usd = estimateTurnUsd({ audioMs: 60_000, inputTokens: 1_000_000, outputTokens: 1_000_000, ttsChars: 1000 });
  assert.ok(Math.abs(usd.stt - 0.111 / 60) < 1e-9);
  assert.ok(Math.abs(usd.translate - 0.75) < 1e-9);
  assert.ok(Math.abs(usd.tts - 0.18) < 1e-9);
  assert.ok(Math.abs(usd.total - (usd.stt + usd.translate + usd.tts)) < 1e-12);

  // 3 s de audio se facturan como 10 s.
  const short = estimateTurnUsd({ audioMs: 3000 });
  const tenSec = estimateTurnUsd({ audioMs: 10_000 });
  assert.equal(short.stt, tenSec.stt);
  assert.equal(estimateTurnUsd({}).total, 0);
});

test("estimateTurnCost devuelve créditos VOX enteros por etapa y total coherente", () => {
  const cost = estimateTurnCost({ audioMs: 8000, inputTokens: 400, outputTokens: 60, ttsChars: 180 });
  for (const key of ["stt", "translate", "tts", "totalVox"]) {
    assert.ok(Number.isInteger(cost[key]), `${key} debe ser entero`);
    assert.ok(cost[key] >= 0);
  }
  assert.equal(cost.totalVox, cost.stt + cost.translate + cost.tts);
  // Cada etapa con uso real cuesta al menos 1 VOX.
  assert.ok(cost.stt >= 1 && cost.translate >= 1 && cost.tts >= 1);
  // Un turno vacío no cuesta nada.
  assert.deepEqual(estimateTurnCost({}), { stt: 0, translate: 0, tts: 0, totalVox: 0 });
});

test("estimateTurnCost respeta margen y tabla custom", () => {
  const pricing = createPricing({ tts: { usdPerUnit: 1 } });
  const cost = estimateTurnCost({ ttsChars: 1000 }, { marginFactor: 1, pricing });
  assert.equal(cost.tts, 100);
  const doubled = estimateTurnCost({ ttsChars: 1000 }, { marginFactor: 2, pricing });
  assert.equal(doubled.tts, 200);
  // createPricing no toca la tabla original.
  assert.equal(PRICING.tts.usdPerUnit, 0.18);
});

test("estimateMeetingCost proyecta consumo y VOX por minuto según speakingRatio", () => {
  const full = estimateMeetingCost({ minutes: 60, speakingRatio: 1 });
  const half = estimateMeetingCost({ minutes: 60, speakingRatio: 0.5 });
  assert.equal(full.usage.audioMs, 3_600_000);
  assert.equal(half.usage.audioMs, 1_800_000);
  assert.ok(full.cost.totalVox > half.cost.totalVox);
  assert.ok(full.usage.ttsChars > 0 && full.usage.inputTokens > full.usage.outputTokens);
  assert.ok(full.voxPerMinute > 0);
  assert.equal(full.cost.totalVox, full.cost.stt + full.cost.translate + full.cost.tts);
  // Sin minutos → todo 0.
  const none = estimateMeetingCost({ minutes: 0 });
  assert.equal(none.cost.totalVox, 0);
  assert.equal(none.voxPerMinute, 0);
  // Una hora de reunión con margen por defecto queda en un rango razonable
  // (orden de magnitud: pocos dólares). Protege contra errores de unidades.
  assert.ok(half.usd.total > 0.5 && half.usd.total < 10, `usd.total=${half.usd.total}`);
});

test("SessionMeter acumula, emite warn una vez y limit una vez", () => {
  let clock = 0;
  const meter = new SessionMeter({ maxVoxPerSession: 100, warnAtVox: 60, now: () => clock });
  const warns = [];
  const limits = [];
  const costs = [];
  meter.on("warn", (e) => warns.push(e));
  meter.on("limit", (e) => limits.push(e));
  meter.on("cost", (e) => costs.push(e));

  meter.add({ stt: 10, translate: 10, tts: 10, totalVox: 30 });
  assert.equal(meter.totalVox, 30);
  assert.equal(meter.remainingVox, 70);
  assert.equal(warns.length, 0);
  assert.ok(meter.canAfford(70));
  assert.ok(!meter.canAfford(71));

  meter.add({ stt: 10, translate: 10, tts: 15 }); // totalVox implícito = 35 → 65
  assert.equal(meter.totalVox, 65);
  assert.equal(warns.length, 1);
  assert.equal(warns[0].remainingVox, 35);

  meter.add({ totalVox: 20 }); // 85, no repite warn
  assert.equal(warns.length, 1);
  assert.equal(limits.length, 0);

  clock = 120_000; // 2 min
  meter.add({ totalVox: 20 }); // 105 ≥ 100 → limit
  assert.equal(limits.length, 1);
  assert.equal(limits[0].totalVox, 105);
  assert.ok(meter.limitReached);
  assert.equal(meter.remainingVox, 0);

  meter.add({ totalVox: 1 });
  assert.equal(limits.length, 1, "limit se emite una sola vez");
  assert.equal(costs.length, 5);
  assert.equal(meter.turns, 5);
  assert.deepEqual(meter.totals, { stt: 20, translate: 20, tts: 25, totalVox: 106 });
});

test("SessionMeter estima ritmo por minuto y minutos restantes", () => {
  let clock = 0;
  const meter = new SessionMeter({ maxVoxPerSession: 1000, now: () => clock });
  assert.equal(meter.warnAtVox, 800, "warnAtVox por defecto = 80 % del tope");
  assert.equal(meter.voxPerMinute(), 0);
  assert.equal(meter.estimateRemainingMinutes(), null);
  // Sin ritmo observado usa la proyección teórica de reunión.
  assert.ok(meter.projectVox(10) > 0);

  clock = 60_000;
  meter.add({ totalVox: 50 });
  assert.equal(meter.voxPerMinute(), 50);
  assert.equal(meter.estimateRemainingMinutes(), 19);
  assert.equal(meter.projectVox(4), 200);

  const snap = meter.snapshot();
  assert.equal(snap.totalVox, 50);
  assert.equal(snap.elapsedMs, 60_000);
  assert.equal(snap.warned, false);

  meter.reset();
  assert.equal(meter.totalVox, 0);
  assert.equal(meter.turns, 0);
});

test("SessionMeter sin tope nunca emite limit y reporta remaining infinito", () => {
  const meter = new SessionMeter();
  let limited = false;
  meter.on("limit", () => { limited = true; });
  meter.add({ totalVox: 1_000_000 });
  assert.equal(limited, false);
  assert.equal(meter.remainingVox, Infinity);
  assert.equal(meter.estimateRemainingMinutes(), null);
});
