// Ajustes del motor: JSON plano en %APPDATA%\VOXORA Meet\settings.json.
//
// Las API keys de proveedor NO van en el JSON: se guardan aparte, cifradas con
// DPAPI (`provider-keys.dpapi`). Sin dependencias nativas, el cifrado se delega
// a PowerShell ([System.Security.Cryptography.ProtectedData], ámbito
// CurrentUser). El shell nativo puede escribir el mismo archivo con
// CryptProtectData: el formato es el blob DPAPI crudo (mismo que produce
// ProtectedData.Protect), sin envoltorio.
//
// Todo el I/O y el cifrado son inyectables para poder testear sin Windows.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';


export const APP_DIR_NAME = 'VOXORA Meet';
export const SETTINGS_FILE = 'settings.json';
export const PROVIDER_KEYS_FILE = 'provider-keys.dpapi';

// groq: STT (Whisper) + traducción (chat). elevenlabs: TTS con voz clonada.
export const PROVIDER_KEY_NAMES = Object.freeze(['groq', 'elevenlabs']);

export const DEFAULTS = Object.freeze({
  delayMs: 3000,
  targetLanguage: 'en',
  sourceLanguage: 'es',
  tone: 'professional',
  styleInstruction: '',
  fallbackMode: 'silence',
  memoryTurns: 8,
  micDeviceId: '',
  cameraDeviceId: '',
  // Cámara virtual «VOXORA Meet Camera» disponible mientras la app esté abierta (lo aplica el
  // shell nativo, que lee este ajuste de las respuestas de settings.get/set): la webcam queda
  // abierta y sale en vivo (retraso 0); al doblar pasa a `delayMs`. false = la webcam y la cámara
  // virtual solo se usan durante la sesión de doblaje. Se aplica en caliente.
  cameraAlwaysOn: true,
  // ── Imagen de la cámara (la procesa el shell antes de publicarla en la cámara virtual; en caliente) ──
  camMirror: false,       // espejo horizontal (lo que ven los demás en Meet)
  camFlip: false,         // volteo vertical
  camRotation: 0,         // 0 | 90 | 180 | 270 (sentido horario)
  camAspect: '16:9',      // '16:9' = llena el lienzo · '9:16' = recorte vertical centrado con laterales difuminados
  camZoom: 1,             // 1–2
  camPanX: 0,             // -1 (izquierda) … 1 (derecha): desplaza el encuadre dentro del margen que deja el zoom
  camPanY: 0,             // -1 (arriba) … 1 (abajo)
  camBrightness: 0,       // -1…1 (curva de gamma: levanta sombras sin quemar blancos)
  camContrast: 0,         // -1…1 (×0,5 … ×2 alrededor del gris medio)
  camSaturation: 0,       // -1 (blanco y negro) … 1 (×2)
  camTemperature: 0,      // -1 (fría) … 1 (cálida)
  // Modo de la interfaz: 'simple' (lo básico con valores predeterminados) | 'advanced' (todos los ajustes).
  uiMode: 'simple',
  voiceId: '',
  voiceName: '',
  lateDubPolicy: 'play',
  maxDriftMs: 1500,
  maxVoxPerSession: 0,
  warnAtVox: 0,
  nodePath: '',
  // Endpoint de render donde se escribe el doblaje. Por defecto el driver
  // propio; mientras no esté firmado se puede usar 'CABLE Input' (VB-Cable).
  virtualMicDevice: 'VOXORA Meet Speaker',
  // Endpoint donde además se escucha el doblaje localmente ('' = apagado).
  monitorDevice: '',
  // ── Protocolo v3: modelos y parámetros por etapa ──
  sttModel: 'whisper-large-v3',
  sttTemperature: 0,
  translateModel: 'openai/gpt-oss-120b',
  translateTemperature: 0.2,
  translateReasoningEffort: 'low',
  ttsModel: 'eleven_multilingual_v2',
  ttsStability: 0.5,
  ttsSimilarityBoost: 0.75,
  ttsStyle: 0,
  ttsSpeed: 1,
  ttsSpeakerBoost: true,
  ttsTextNormalization: 'auto',
});

/** Claves de ajustes de modelo (protocolo v3): las que acepta `cost.estimate` en `overrides`. */
export const MODEL_SETTING_KEYS = Object.freeze([
  'sttModel', 'sttTemperature', 'translateModel', 'translateTemperature', 'translateReasoningEffort', 'memoryTurns',
  'ttsModel', 'ttsStability', 'ttsSimilarityBoost', 'ttsStyle', 'ttsSpeed', 'ttsSpeakerBoost', 'ttsTextNormalization',
]);

// Debe coincidir con TONES de pipeline/src/translate/groq-translate.mjs.
const TONES = new Set(['professional', 'formal', 'neutral']);
const STYLE_INSTRUCTION_MAX = 400;
const FALLBACKS = new Set(['silence', 'original', 'duck']);
const LATE_POLICIES = new Set(['play', 'drop']);
// low|medium|high (gpt-oss); none|default (Qwen3). Debe coincidir con
// REASONING_EFFORTS de pipeline/src/translate/groq-translate.mjs.
export const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'none', 'default']);
export const TEXT_NORMALIZATION = Object.freeze(['auto', 'on', 'off']);
export const CAM_ROTATIONS = Object.freeze([0, 90, 180, 270]);
export const CAM_ASPECTS = Object.freeze(['16:9', '9:16']);
export const UI_MODES = Object.freeze(['simple', 'advanced']);
/** Claves de imagen de la cámara que aplica el shell en caliente (también `native.camera.effects`). */
export const CAMERA_EFFECT_KEYS = Object.freeze([
  'camMirror', 'camFlip', 'camRotation', 'camAspect', 'camZoom', 'camPanX', 'camPanY',
  'camBrightness', 'camContrast', 'camSaturation', 'camTemperature',
]);
const MODEL_ID_MAX = 128;

/** Directorio de datos por defecto (%APPDATA%\VOXORA Meet; fallback al home). */
export function defaultDataDir(env = process.env) {
  const base = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, APP_DIR_NAME);
}

function cleanString(value, fallback, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : fallback;
}

function cleanInt(value, fallback, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Número recortado a [min, max] con 3 decimales; `null`/''/no numérico → fallback. */
function cleanFloat(value, fallback, min, max) {
  if (value === null || value === '' || typeof value === 'boolean') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(max, Math.max(min, n)) * 1000) / 1000;
}

function cleanBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 'true' || value === '1') return true;
  if (value === 0 || value === 'false' || value === '0') return false;
  return fallback;
}

/**
 * Id de modelo saneado: sin espacios ni caracteres raros (letras, dígitos y
 * `. _ - / :`), ≤128. Inválido o vacío → fallback. `mustMatch` opcional.
 */
export function cleanModelId(value, fallback, mustMatch = null) {
  if (typeof value !== 'string') return fallback;
  const id = value.trim();
  if (!id || id.length > MODEL_ID_MAX || !/^[A-Za-z0-9][A-Za-z0-9._\-/:]*$/.test(id)) return fallback;
  if (mustMatch && !mustMatch.test(id)) return fallback;
  return id;
}

function cleanEnum(value, allowed, fallback) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : value;
  return allowed.includes(v) ? v : fallback;
}

/** Rotación en pasos de 90° (acepta número o texto; -90 → 270, 450 → 90). Otro valor → fallback. */
function cleanRotation(value, fallback) {
  if (value === null || value === '' || typeof value === 'boolean') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n % 90 !== 0) return fallback;
  return ((n % 360) + 360) % 360;
}

/** Relación de aspecto de la imagen: '16:9' | '9:16' (también '16/9', 'vertical', 'horizontal'). */
function cleanAspect(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const v = value.trim().toLowerCase().replace('/', ':');
  if (v === 'vertical' || v === 'portrait') return '9:16';
  if (v === 'horizontal' || v === 'landscape') return '16:9';
  return CAM_ASPECTS.includes(v) ? v : fallback;
}

/** Normaliza un objeto de ajustes: tipos, rangos y valores permitidos. */
export function normalizeSettings(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    delayMs: cleanInt(input.delayMs, DEFAULTS.delayMs, 2000, 6000),
    targetLanguage: cleanString(input.targetLanguage, DEFAULTS.targetLanguage, 16) || DEFAULTS.targetLanguage,
    sourceLanguage: cleanString(input.sourceLanguage, DEFAULTS.sourceLanguage, 16) || DEFAULTS.sourceLanguage,
    tone: TONES.has(input.tone) ? input.tone : DEFAULTS.tone,
    styleInstruction: cleanString(input.styleInstruction, DEFAULTS.styleInstruction, STYLE_INSTRUCTION_MAX),
    fallbackMode: FALLBACKS.has(input.fallbackMode) ? input.fallbackMode : DEFAULTS.fallbackMode,
    memoryTurns: cleanInt(input.memoryTurns, DEFAULTS.memoryTurns, 0, 64),
    micDeviceId: cleanString(input.micDeviceId, DEFAULTS.micDeviceId, 512),
    cameraDeviceId: cleanString(input.cameraDeviceId, DEFAULTS.cameraDeviceId, 512),
    cameraAlwaysOn: cleanBool(input.cameraAlwaysOn, DEFAULTS.cameraAlwaysOn),
    camMirror: cleanBool(input.camMirror, DEFAULTS.camMirror),
    camFlip: cleanBool(input.camFlip, DEFAULTS.camFlip),
    camRotation: cleanRotation(input.camRotation, DEFAULTS.camRotation),
    camAspect: cleanAspect(input.camAspect, DEFAULTS.camAspect),
    camZoom: cleanFloat(input.camZoom, DEFAULTS.camZoom, 1, 2),
    camPanX: cleanFloat(input.camPanX, DEFAULTS.camPanX, -1, 1),
    camPanY: cleanFloat(input.camPanY, DEFAULTS.camPanY, -1, 1),
    camBrightness: cleanFloat(input.camBrightness, DEFAULTS.camBrightness, -1, 1),
    camContrast: cleanFloat(input.camContrast, DEFAULTS.camContrast, -1, 1),
    camSaturation: cleanFloat(input.camSaturation, DEFAULTS.camSaturation, -1, 1),
    camTemperature: cleanFloat(input.camTemperature, DEFAULTS.camTemperature, -1, 1),
    uiMode: cleanEnum(input.uiMode, UI_MODES, DEFAULTS.uiMode),
    voiceId: cleanString(input.voiceId, DEFAULTS.voiceId, 128),
    voiceName: cleanString(input.voiceName, DEFAULTS.voiceName, 80),
    lateDubPolicy: LATE_POLICIES.has(input.lateDubPolicy) ? input.lateDubPolicy : DEFAULTS.lateDubPolicy,
    maxDriftMs: cleanInt(input.maxDriftMs, DEFAULTS.maxDriftMs, 0, 60000),
    maxVoxPerSession: cleanInt(input.maxVoxPerSession, DEFAULTS.maxVoxPerSession, 0, 1e9),
    warnAtVox: cleanInt(input.warnAtVox, DEFAULTS.warnAtVox, 0, 1e9),
    nodePath: cleanString(input.nodePath, DEFAULTS.nodePath, 1024),
    virtualMicDevice: cleanString(input.virtualMicDevice, DEFAULTS.virtualMicDevice, 256) || DEFAULTS.virtualMicDevice,
    monitorDevice: cleanString(input.monitorDevice, DEFAULTS.monitorDevice, 256),
    sttModel: cleanModelId(input.sttModel, DEFAULTS.sttModel, /whisper/i),
    sttTemperature: cleanFloat(input.sttTemperature, DEFAULTS.sttTemperature, 0, 1),
    translateModel: cleanModelId(input.translateModel, DEFAULTS.translateModel),
    translateTemperature: cleanFloat(input.translateTemperature, DEFAULTS.translateTemperature, 0, 1),
    translateReasoningEffort: cleanEnum(input.translateReasoningEffort, REASONING_EFFORTS, DEFAULTS.translateReasoningEffort),
    ttsModel: cleanModelId(input.ttsModel, DEFAULTS.ttsModel),
    ttsStability: cleanFloat(input.ttsStability, DEFAULTS.ttsStability, 0, 1),
    ttsSimilarityBoost: cleanFloat(input.ttsSimilarityBoost, DEFAULTS.ttsSimilarityBoost, 0, 1),
    ttsStyle: cleanFloat(input.ttsStyle, DEFAULTS.ttsStyle, 0, 1),
    ttsSpeed: cleanFloat(input.ttsSpeed, DEFAULTS.ttsSpeed, 0.7, 1.2),
    ttsSpeakerBoost: cleanBool(input.ttsSpeakerBoost, DEFAULTS.ttsSpeakerBoost),
    ttsTextNormalization: cleanEnum(input.ttsTextNormalization, TEXT_NORMALIZATION, DEFAULTS.ttsTextNormalization),
  };
}

/** Filtra un objeto de keys a los proveedores conocidos (strings no vacíos). */
export function normalizeProviderKeys(raw = {}) {
  const out = {};
  for (const name of PROVIDER_KEY_NAMES) {
    const value = raw?.[name];
    if (typeof value === 'string' && value.trim()) out[name] = value.trim();
  }
  return out;
}

// ── DPAPI vía PowerShell ────────────────────────────────────────────────────

// El dato viaja por stdin, nunca por la línea de comandos: los argumentos de un
// proceso son visibles para otros procesos del usuario, y además `-Command
// <script> <arg>` concatena el argumento al script y rompe el parser.
const PS_PROTECT = `
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$out = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($out))
`.trim();

const PS_UNPROTECT = `
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$out = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($out))
`.trim();

function runPowerShell(script, base64Input, { timeoutMs = 20_000 } = {}) {
  const exe = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('DPAPI: PowerShell no respondió a tiempo'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) resolve(stdout.trim());
      else {
        const firstLine = stderr.trim().split(/\r?\n/)[0];
        reject(new Error(`DPAPI: PowerShell terminó con código ${code}${firstLine ? `: ${firstLine}` : ''}`));
      }
    });
    child.stdin.end(base64Input);
  });
}

/** Cifrador DPAPI (CurrentUser) usando PowerShell. Sólo Windows. */
export const dpapiCrypto = {
  available: () => process.platform === 'win32',
  async protect(plain) {
    const b64 = await runPowerShell(PS_PROTECT, Buffer.from(plain, 'utf8').toString('base64'));
    return Buffer.from(b64, 'base64');
  },
  async unprotect(blob) {
    const b64 = await runPowerShell(PS_UNPROTECT, Buffer.from(blob).toString('base64'));
    return Buffer.from(b64, 'base64').toString('utf8');
  },
};

// ── Store ───────────────────────────────────────────────────────────────────

/**
 * @param {object} [options]
 * @param {string} [options.dir]     Directorio de datos (default %APPDATA%\VOXORA Meet).
 * @param {object} [options.fs]      Reemplazo de node:fs/promises (tests).
 * @param {object} [options.crypto]  `{ available(), protect(str)→Buffer, unprotect(Buffer)→str }`.
 */
export function createSettingsStore({ dir = defaultDataDir(), fs: fsImpl = fs, crypto = dpapiCrypto } = {}) {
  const settingsPath = path.join(dir, SETTINGS_FILE);
  const keysPath = path.join(dir, PROVIDER_KEYS_FILE);
  let cache = null;
  let keysCache = null;

  async function ensureDir() {
    await fsImpl.mkdir(dir, { recursive: true });
  }

  async function load() {
    if (cache) return { ...cache };
    let parsed = {};
    try {
      parsed = JSON.parse(await fsImpl.readFile(settingsPath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // JSON corrupto: se conserva una copia y se arranca con defaults.
        try { await fsImpl.copyFile(settingsPath, `${settingsPath}.corrupt`); } catch { /* best-effort */ }
      }
    }
    cache = normalizeSettings({ ...DEFAULTS, ...parsed });
    return { ...cache };
  }

  async function persist(next) {
    await ensureDir();
    const tmp = `${settingsPath}.tmp`;
    await fsImpl.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await fsImpl.rename(tmp, settingsPath);
  }

  /** Aplica un parche (solo claves conocidas) y persiste. Devuelve los ajustes resultantes. */
  async function save(patch = {}) {
    const current = await load();
    const merged = { ...current };
    for (const key of Object.keys(DEFAULTS)) {
      if (patch[key] !== undefined) merged[key] = patch[key];
    }
    cache = normalizeSettings(merged);
    await persist(cache);
    return { ...cache };
  }

  async function getProviderKeys() {
    if (keysCache) return { ...keysCache };
    try {
      const blob = await fsImpl.readFile(keysPath);
      if (!crypto.available()) throw new Error('DPAPI no disponible en esta plataforma');
      keysCache = normalizeProviderKeys(JSON.parse(await crypto.unprotect(blob)));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        keysCache = {};
        return { ...keysCache, __error: String(error.message ?? error) };
      }
      keysCache = {};
    }
    return { ...keysCache };
  }

  /** Fusiona keys (string vacío = borrar esa key) y persiste cifradas. */
  async function setProviderKeys(patch = {}) {
    const current = await getProviderKeys();
    delete current.__error;
    for (const name of PROVIDER_KEY_NAMES) {
      const value = patch?.[name];
      if (value === undefined) continue;
      if (typeof value === 'string' && value.trim()) current[name] = value.trim();
      else delete current[name];
    }
    keysCache = normalizeProviderKeys(current);
    await ensureDir();
    if (Object.keys(keysCache).length === 0) {
      await fsImpl.rm(keysPath, { force: true });
      return { ...keysCache };
    }
    if (!crypto.available()) throw new Error('No se pueden guardar keys: DPAPI no disponible');
    const blob = await crypto.protect(JSON.stringify(keysCache));
    const tmp = `${keysPath}.tmp`;
    await fsImpl.writeFile(tmp, blob);
    await fsImpl.rename(tmp, keysPath);
    return { ...keysCache };
  }

  /** Estado de keys apto para la UI: nunca devuelve los valores. */
  async function providerKeyStatus() {
    const keys = await getProviderKeys();
    const status = {};
    for (const name of PROVIDER_KEY_NAMES) status[name] = Boolean(keys[name]);
    return status;
  }

  function invalidate() {
    cache = null;
    keysCache = null;
  }

  return { dir, settingsPath, keysPath, DEFAULTS, load, save, getProviderKeys, setProviderKeys, providerKeyStatus, invalidate };
}

export default createSettingsStore;
