// Traduce errores internos (HTTP de proveedores, helpers nativos, validación)
// a `{ code, message }` estables y en español, listos para mostrar en la UI.
// El shell nunca debe enseñar volcados técnicos: si un error no se reconoce,
// se devuelve un mensaje genérico y el detalle viaja aparte en `detail`.

const PROVIDERS = [
  { id: 'elevenlabs', label: 'ElevenLabs', match: /elevenlabs|tts|voices/i },
  { id: 'groq', label: 'Groq', match: /groq|whisper|stt|chat|translat/i },
];

function collectText(error) {
  const parts = [];
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (typeof current === 'string') { parts.push(current); break; }
    if (current.message) parts.push(String(current.message));
    if (current.body) parts.push(typeof current.body === 'string' ? current.body : JSON.stringify(current.body));
    current = current.cause;
  }
  return parts.join(' | ');
}

function findStatus(error) {
  let current = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth += 1) {
    if (Number.isInteger(current.status)) return current.status;
    current = current.cause;
  }
  const m = /\b(4\d\d|5\d\d)\b/.exec(collectText(error));
  return m ? Number(m[1]) : null;
}

function providerOf(error, text) {
  if (error?.stage === 'tts') return PROVIDERS[0];
  if (error?.stage === 'stt' || error?.stage === 'translate') return PROVIDERS[1];
  if (error?.provider) return PROVIDERS.find((p) => p.id === error.provider) ?? null;
  return PROVIDERS.find((p) => p.match.test(text)) ?? null;
}

/** Códigos ya "amigables" que se respetan tal cual si traen mensaje. */
const PASSTHROUGH = new Set([
  'missing_key', 'provider_auth', 'provider_payment', 'provider_quota', 'virtual_mic_missing',
  'voice_missing', 'samples_too_short', 'bad_request', 'bad_state', 'unknown_command', 'module_missing',
  'clone_failed', 'model_unavailable',
]);

// Modelo inexistente, retirado o sin acceso (Groq: 404 model_not_found,
// model_decommissioned, permisos por organización/proyecto, términos sin aceptar;
// ElevenLabs: model_not_found / modelo que no hace TTS).
const MODEL_UNAVAILABLE = /model_not_found|model_decommissioned|model_terms_required|model_permission|permission_blocked|invalid_model|model_id_not_found|does not exist or you do not have access|has been decommissioned|can_not_do_text_to_speech|cannot do text[- ]to[- ]speech|model\b[^|]{0,80}\b(not found|does not exist|is not available|not available for|no longer (available|supported)|deprecated|decommissioned)/i;

const STAGE_LABEL = { stt: 'de transcripción', translate: 'de traducción', tts: 'de voz' };

function findField(error, key) {
  let current = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth += 1) {
    if (typeof current[key] === 'string' && current[key]) return current[key];
    current = current.cause;
  }
  return null;
}

function modelIdFrom(error, text) {
  const direct = findField(error, 'model');
  if (direct) return direct;
  const m = /model[\s`'"«]+([A-Za-z0-9][\w./:-]{1,127})[`'"»]/i.exec(text);
  return m ? m[1] : null;
}

/**
 * @param {unknown} error
 * @returns {{ code: string, message: string, detail?: string }}
 */
export function friendlyError(error) {
  if (error && typeof error === 'object' && PASSTHROUGH.has(error.code) && error.message) {
    return { code: error.code, message: String(error.message) };
  }
  const text = collectText(error);
  const status = findStatus(error);
  const provider = providerOf(error, text);
  const who = provider?.label ?? 'El proveedor';
  const detail = text.slice(0, 500);

  if (/payment_issue|payment_required|failed or incomplete payment|quota_exceeded.*payment/i.test(text) || status === 402) {
    return {
      code: 'provider_payment',
      message: `${who} rechazó la solicitud porque la cuenta tiene un pago pendiente. Completa la factura en el panel de ${who} y vuelve a intentarlo.`,
      detail,
    };
  }
  if (/quota_exceeded|character_limit|insufficient.*(credits|quota)|rate.?limit/i.test(text) || status === 429) {
    return {
      code: 'provider_quota',
      message: `${who} alcanzó su límite de uso o de velocidad. Espera un momento o amplía el plan.`,
      detail,
    };
  }
  if (MODEL_UNAVAILABLE.test(text)) {
    const model = modelIdFrom(error, text);
    const stage = STAGE_LABEL[findField(error, 'stage')] ?? '';
    const name = model ? ` ${stage ? `${stage} ` : ''}«${model}»` : stage ? ` ${stage}` : '';
    return {
      code: 'model_unavailable',
      message: `El modelo${name} no está disponible en tu cuenta de ${provider?.label ?? 'el proveedor'} (no existe, fue retirado o no tienes acceso). Elige otro en Ajustes → Modelos.`,
      detail,
    };
  }
  if (status === 401 || status === 403 || /invalid_api_key|invalid api key|unauthorized/i.test(text)) {
    return {
      code: 'provider_auth',
      message: `${who} no aceptó la API key. Revísala en Ajustes.`,
      detail,
    };
  }
  if (/voice_not_found|voice.*(not found|does not exist)/i.test(text) || (status === 404 && provider?.id === 'elevenlabs')) {
    return { code: 'voice_missing', message: 'La voz seleccionada ya no existe en tu cuenta de ElevenLabs. Elige otra en la pestaña Voz.', detail };
  }
  if (/no tiene voz clonada|falta `voiceId`/i.test(text)) {
    return { code: 'voice_missing', message: 'Todavía no hay una voz seleccionada. Elígela o clónala en la pestaña Voz.', detail };
  }
  if (/device-not-found|0x80070490/i.test(text)) {
    return {
      code: 'virtual_mic_missing',
      message: 'No se encontró la salida de audio configurada para el doblaje. Elige otra en "Salida del doblaje".',
      detail,
    };
  }
  if (/ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|network/i.test(text)) {
    return { code: 'network', message: `No hay conexión con ${who}. Revisa tu internet.`, detail };
  }
  if (error?.name === 'TimeoutError' || /ETIMEDOUT|aborted due to timeout|timed? ?out/i.test(text)) {
    return { code: 'network', message: `${who} no respondió a tiempo. Revisa tu internet o vuelve a intentarlo.`, detail };
  }
  if (status && status >= 500) {
    return { code: 'provider_down', message: `${who} está fallando en este momento (error ${status}). Se reintentará en el próximo turno.`, detail };
  }
  const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'internal';
  const message = error && typeof error === 'object' && error.message ? String(error.message) : String(error ?? 'Error desconocido');
  return { code, message, detail };
}
