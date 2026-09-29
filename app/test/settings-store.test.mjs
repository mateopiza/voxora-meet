import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createSettingsStore, DEFAULTS, normalizeSettings, normalizeProviderKeys, defaultDataDir } from '../engine/settings-store.mjs';

/** fs/promises en memoria: suficiente para readFile/writeFile/rename/mkdir/rm/copyFile. */
function memoryFs() {
  const files = new Map();
  const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  return {
    files,
    async mkdir() {},
    async readFile(p, enc) {
      if (!files.has(p)) throw enoent(p);
      const data = files.get(p);
      return enc ? data.toString('utf8') : Buffer.from(data);
    },
    async writeFile(p, data) { files.set(p, Buffer.from(data)); },
    async rename(from, to) { files.set(to, files.get(from)); files.delete(from); },
    async rm(p) { files.delete(p); },
    async copyFile(from, to) { files.set(to, files.get(from)); },
  };
}

/** "DPAPI" falso: invierte bytes y marca; suficiente para verificar que el JSON no va en claro. */
function fakeCrypto(available = true) {
  return {
    available: () => available,
    async protect(plain) { return Buffer.concat([Buffer.from('DPAPI'), Buffer.from(plain, 'utf8').reverse()]); },
    async unprotect(blob) { return Buffer.from(blob.subarray(5)).reverse().toString('utf8'); },
  };
}

test('defaults y normalización de rangos/valores', async () => {
  const fs = memoryFs();
  const store = createSettingsStore({ dir: 'X', fs, crypto: fakeCrypto() });
  const loaded = await store.load();
  assert.deepEqual(loaded, { ...DEFAULTS });
  assert.equal(loaded.delayMs, 3000);
  assert.equal(loaded.targetLanguage, 'en');
  assert.equal(loaded.sourceLanguage, 'es');
  assert.equal(loaded.tone, 'professional');
  assert.equal(loaded.fallbackMode, 'silence');
  assert.equal(loaded.memoryTurns, 8);

  const n = normalizeSettings({ delayMs: 99999, tone: 'angry', fallbackMode: 'duck', memoryTurns: -3, targetLanguage: '  fr ' });
  assert.equal(n.delayMs, 6000);
  assert.equal(n.tone, 'professional');
  assert.equal(n.fallbackMode, 'duck');
  assert.equal(n.memoryTurns, 0);
  assert.equal(n.targetLanguage, 'fr');
  assert.equal(n.styleInstruction, '');

  // Solo los tonos que acepta el traductor (professional|formal|neutral).
  assert.equal(normalizeSettings({ tone: 'casual' }).tone, 'professional');
  assert.equal(normalizeSettings({ tone: 'neutral' }).tone, 'neutral');
  // styleInstruction: string recortado y limitado a 400 caracteres.
  assert.equal(normalizeSettings({ styleInstruction: '  usa tú, no usted  ' }).styleInstruction, 'usa tú, no usted');
  assert.equal(normalizeSettings({ styleInstruction: 'x'.repeat(500) }).styleInstruction.length, 400);
  assert.equal(normalizeSettings({ styleInstruction: 42 }).styleInstruction, '');
});

test('save persiste solo claves conocidas, atómico (tmp + rename) y recarga desde disco', async () => {
  const fs = memoryFs();
  const store = createSettingsStore({ dir: 'X', fs, crypto: fakeCrypto() });
  const saved = await store.save({ delayMs: 4500, tone: 'formal', hacker: 'no', providerKeys: { groq: 'leak' } });
  assert.equal(saved.delayMs, 4500);
  assert.equal(saved.tone, 'formal');
  assert.equal('hacker' in saved, false);
  const onDisk = JSON.parse(fs.files.get(path.join('X', 'settings.json')).toString('utf8'));
  assert.equal(onDisk.delayMs, 4500);
  assert.equal('providerKeys' in onDisk, false);
  assert.equal(fs.files.has(path.join('X', 'settings.json.tmp')), false);

  const store2 = createSettingsStore({ dir: 'X', fs, crypto: fakeCrypto() });
  assert.equal((await store2.load()).tone, 'formal');
});

test('JSON corrupto → defaults y copia .corrupt', async () => {
  const fs = memoryFs();
  fs.files.set(path.join('X', 'settings.json'), Buffer.from('{corrupt'));
  const store = createSettingsStore({ dir: 'X', fs, crypto: fakeCrypto() });
  const loaded = await store.load();
  assert.equal(loaded.delayMs, 3000);
  assert.ok(fs.files.has(path.join('X', 'settings.json.corrupt')));
});

test('keys de proveedor: cifradas en disco, nunca en claro, estado booleano para la UI', async () => {
  const fs = memoryFs();
  const store = createSettingsStore({ dir: 'X', fs, crypto: fakeCrypto() });
  await store.setProviderKeys({ groq: 'gsk_secret', elevenlabs: ' el_secret ', bogus: 'x' });
  const blob = fs.files.get(path.join('X', 'provider-keys.dpapi'));
  assert.ok(blob);
  assert.equal(blob.includes('gsk_secret'), false);
  assert.equal(blob.subarray(0, 5).toString(), 'DPAPI');
  const settingsJson = fs.files.get(path.join('X', 'settings.json'));
  assert.equal(settingsJson === undefined || !settingsJson.includes('gsk_secret'), true);

  assert.deepEqual(await store.providerKeyStatus(), { groq: true, elevenlabs: true });
  const store2 = createSettingsStore({ dir: 'X', fs, crypto: fakeCrypto() });
  assert.deepEqual(await store2.getProviderKeys(), { groq: 'gsk_secret', elevenlabs: 'el_secret' });

  // Borrar una key (string vacío) y borrar todas elimina el archivo.
  await store2.setProviderKeys({ groq: '' });
  assert.deepEqual(await store2.getProviderKeys(), { elevenlabs: 'el_secret' });
  await store2.setProviderKeys({ elevenlabs: '' });
  assert.equal(fs.files.has(path.join('X', 'provider-keys.dpapi')), false);
});

test('sin DPAPI disponible no se guardan keys en claro', async () => {
  const fs = memoryFs();
  const store = createSettingsStore({ dir: 'X', fs, crypto: fakeCrypto(false) });
  await assert.rejects(() => store.setProviderKeys({ groq: 'x' }), /DPAPI/);
  assert.equal(fs.files.size, 0);
});

test('normalizeProviderKeys y directorio por defecto', () => {
  assert.deepEqual(normalizeProviderKeys({ groq: ' a ', openai: 'x', deepgram: 7, elevenlabs: 'b', extra: 'c' }), { groq: 'a', elevenlabs: 'b' });
  assert.equal(defaultDataDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }), path.join('C:\\Users\\u\\AppData\\Roaming', 'VOXORA Meet'));
});

test('virtualMicDevice: default al driver propio y admite VB-Cable', async () => {
  const { normalizeSettings } = await import('../engine/settings-store.mjs');
  assert.equal(normalizeSettings({}).virtualMicDevice, 'VOXORA Meet Speaker');
  assert.equal(normalizeSettings({ virtualMicDevice: 'CABLE Input' }).virtualMicDevice, 'CABLE Input');
  assert.equal(normalizeSettings({ virtualMicDevice: '  ' }).virtualMicDevice, 'VOXORA Meet Speaker');
});

test('cameraAlwaysOn: default true, se conserva false y normaliza texto/números', () => {
  assert.equal(DEFAULTS.cameraAlwaysOn, true);
  assert.equal(normalizeSettings({}).cameraAlwaysOn, true);
  assert.equal(normalizeSettings({ cameraAlwaysOn: false }).cameraAlwaysOn, false);
  assert.equal(normalizeSettings({ cameraAlwaysOn: true }).cameraAlwaysOn, true);
  assert.equal(normalizeSettings({ cameraAlwaysOn: 'false' }).cameraAlwaysOn, false);
  assert.equal(normalizeSettings({ cameraAlwaysOn: 0 }).cameraAlwaysOn, false);
  assert.equal(normalizeSettings({ cameraAlwaysOn: '0' }).cameraAlwaysOn, false);
  assert.equal(normalizeSettings({ cameraAlwaysOn: 'true' }).cameraAlwaysOn, true);
  assert.equal(normalizeSettings({ cameraAlwaysOn: 1 }).cameraAlwaysOn, true);
  // Basura → default (activada).
  for (const junk of ['quizás', '', null, 7, {}, []]) {
    assert.equal(normalizeSettings({ cameraAlwaysOn: junk }).cameraAlwaysOn, true, `valor ${JSON.stringify(junk)}`);
  }
});

test('cameraAlwaysOn: save lo persiste en disco y sobrevive a otros parches', async () => {
  const fs = memoryFs();
  const store = createSettingsStore({ dir: 'X', fs, crypto: fakeCrypto() });
  assert.equal((await store.load()).cameraAlwaysOn, true);
  const saved = await store.save({ cameraAlwaysOn: false });
  assert.equal(saved.cameraAlwaysOn, false);
  const onDisk = JSON.parse(fs.files.get(path.join('X', 'settings.json')).toString('utf8'));
  assert.equal(onDisk.cameraAlwaysOn, false);
  // Un parche sin la clave no la toca; basura en el parche vuelve al default.
  assert.equal((await store.save({ delayMs: 4000 })).cameraAlwaysOn, false);
  const store2 = createSettingsStore({ dir: 'X', fs, crypto: fakeCrypto() });
  assert.equal((await store2.load()).cameraAlwaysOn, false);
  assert.equal((await store2.save({ cameraAlwaysOn: 'sí' })).cameraAlwaysOn, true);
  assert.equal((await store2.save({ cameraAlwaysOn: 'false' })).cameraAlwaysOn, false);
});

test('dpapiCrypto real: ida y vuelta con CurrentUser (solo Windows)', { skip: process.platform !== 'win32' }, async () => {
  const { dpapiCrypto } = await import('../engine/settings-store.mjs');
  const secret = JSON.stringify({ groq: 'gsk_prueba "con" comillas $y ;simbolos', elevenlabs: 'xi_ñ' });
  const blob = await dpapiCrypto.protect(secret);
  assert.ok(blob.length > secret.length);
  assert.equal(await dpapiCrypto.unprotect(blob), secret);
});

test('protocolo v3: defaults de modelos y parámetros', async () => {
  const { normalizeSettings: n } = await import('../engine/settings-store.mjs');
  const d = n({});
  assert.equal(d.sttModel, 'whisper-large-v3');
  assert.equal(d.sttTemperature, 0);
  assert.equal(d.translateModel, 'openai/gpt-oss-120b');
  assert.equal(d.translateTemperature, 0.2);
  assert.equal(d.translateReasoningEffort, 'low');
  assert.equal(d.memoryTurns, 8);
  assert.equal(d.ttsModel, 'eleven_multilingual_v2');
  assert.equal(d.ttsStability, 0.5);
  assert.equal(d.ttsSimilarityBoost, 0.75);
  assert.equal(d.ttsStyle, 0);
  assert.equal(d.ttsSpeed, 1);
  assert.equal(d.ttsSpeakerBoost, true);
  assert.equal(d.ttsTextNormalization, 'auto');
});

test('protocolo v3: recorte de rangos, enums y saneado de ids de modelo', async () => {
  const { normalizeSettings: n, cleanModelId, MODEL_SETTING_KEYS } = await import('../engine/settings-store.mjs');
  const s = n({
    sttTemperature: 3, translateTemperature: -1, ttsStability: 1.7, ttsSimilarityBoost: '0.33333', ttsStyle: -0.2,
    ttsSpeed: 2, ttsSpeakerBoost: 'false', ttsTextNormalization: 'ON', translateReasoningEffort: 'High', memoryTurns: 999,
  });
  assert.equal(s.sttTemperature, 1);
  assert.equal(s.translateTemperature, 0);
  assert.equal(s.ttsStability, 1);
  assert.equal(s.ttsSimilarityBoost, 0.333);
  assert.equal(s.ttsStyle, 0);
  assert.equal(s.ttsSpeed, 1.2);
  assert.equal(n({ ttsSpeed: 0.1 }).ttsSpeed, 0.7);
  assert.equal(s.ttsSpeakerBoost, false);
  assert.equal(s.ttsTextNormalization, 'on');
  assert.equal(s.translateReasoningEffort, 'high');
  assert.equal(s.memoryTurns, 64);
  // Valores inválidos → default.
  assert.equal(n({ ttsSpeakerBoost: 'quizás' }).ttsSpeakerBoost, true);
  assert.equal(n({ ttsTextNormalization: 'siempre' }).ttsTextNormalization, 'auto');
  assert.equal(n({ translateReasoningEffort: 'extremo' }).translateReasoningEffort, 'low');
  assert.equal(n({ translateReasoningEffort: 'none' }).translateReasoningEffort, 'none', 'Qwen3 usa none/default');
  assert.equal(n({ sttTemperature: null }).sttTemperature, 0);
  assert.equal(n({ ttsStability: 'abc' }).ttsStability, 0.5);
  assert.equal(n({ ttsStability: true }).ttsStability, 0.5);

  // Ids de modelo: string saneado ≤128.
  assert.equal(n({ translateModel: '  qwen/qwen3.6-27b  ' }).translateModel, 'qwen/qwen3.6-27b');
  assert.equal(n({ translateModel: 'x'.repeat(129) }).translateModel, 'openai/gpt-oss-120b');
  assert.equal(n({ translateModel: 'a'.repeat(128) }).translateModel, 'a'.repeat(128));
  assert.equal(n({ translateModel: 'bad model; rm -rf' }).translateModel, 'openai/gpt-oss-120b');
  assert.equal(n({ ttsModel: 42 }).ttsModel, 'eleven_multilingual_v2');
  assert.equal(n({ ttsModel: 'eleven_v3' }).ttsModel, 'eleven_v3');
  assert.equal(n({ sttModel: 'whisper-large-v3-turbo' }).sttModel, 'whisper-large-v3-turbo');
  assert.equal(n({ sttModel: 'openai/gpt-oss-120b' }).sttModel, 'whisper-large-v3', 'el STT debe ser Whisper');
  assert.equal(cleanModelId('-raro', 'd'), 'd');
  assert.ok(MODEL_SETTING_KEYS.includes('memoryTurns') && MODEL_SETTING_KEYS.includes('ttsModel'));
});

test('uiMode: simple por defecto, acepta advanced y normaliza mayúsculas; basura → simple', async () => {
  const { normalizeSettings: n, UI_MODES } = await import('../engine/settings-store.mjs');
  assert.deepEqual([...UI_MODES], ['simple', 'advanced']);
  assert.equal(DEFAULTS.uiMode, 'simple');
  assert.equal(n({}).uiMode, 'simple');
  assert.equal(n({ uiMode: 'advanced' }).uiMode, 'advanced');
  assert.equal(n({ uiMode: ' Advanced ' }).uiMode, 'advanced');
  for (const junk of ['sample', 'avanzado', '', null, 1, true, {}]) {
    assert.equal(n({ uiMode: junk }).uiMode, 'simple', `valor ${JSON.stringify(junk)}`);
  }
});

test('uiMode: se persiste y sobrevive a otros parches', async () => {
  const fs = memoryFs();
  const store = createSettingsStore({ dir: 'X', fs, crypto: fakeCrypto() });
  assert.equal((await store.save({ uiMode: 'advanced' })).uiMode, 'advanced');
  assert.equal((await store.save({ delayMs: 4000 })).uiMode, 'advanced');
  const onDisk = JSON.parse(fs.files.get(path.join('X', 'settings.json')).toString('utf8'));
  assert.equal(onDisk.uiMode, 'advanced');
  const store2 = createSettingsStore({ dir: 'X', fs, crypto: fakeCrypto() });
  assert.equal((await store2.load()).uiMode, 'advanced');
  assert.equal((await store2.save({ uiMode: 'otro' })).uiMode, 'simple');
});

test('imagen de la cámara: defaults neutros (la salida es la webcam tal cual)', async () => {
  const { CAMERA_EFFECT_KEYS } = await import('../engine/settings-store.mjs');
  const d = normalizeSettings({});
  assert.deepEqual(Object.fromEntries(CAMERA_EFFECT_KEYS.map((k) => [k, d[k]])), {
    camMirror: false, camFlip: false, camRotation: 0, camAspect: '16:9', camZoom: 1, camPanX: 0, camPanY: 0,
    camBrightness: 0, camContrast: 0, camSaturation: 0, camTemperature: 0,
  });
  for (const k of CAMERA_EFFECT_KEYS) assert.ok(k in DEFAULTS, `${k} en DEFAULTS`);
});

test('imagen de la cámara: normalización de booleanos, rotación, aspecto y rangos', () => {
  const s = normalizeSettings({
    camMirror: 'true', camFlip: 1, camRotation: '270', camAspect: '9/16', camZoom: 5, camPanX: -3, camPanY: '0.25',
    camBrightness: 2, camContrast: -2, camSaturation: '0.3333', camTemperature: -0.5,
  });
  assert.equal(s.camMirror, true);
  assert.equal(s.camFlip, true);
  assert.equal(s.camRotation, 270);
  assert.equal(s.camAspect, '9:16');
  assert.equal(s.camZoom, 2);
  assert.equal(s.camPanX, -1);
  assert.equal(s.camPanY, 0.25);
  assert.equal(s.camBrightness, 1);
  assert.equal(s.camContrast, -1);
  assert.equal(s.camSaturation, 0.333);
  assert.equal(s.camTemperature, -0.5);
  // Rotación: múltiplos de 90 normalizados a 0–270; el resto → 0.
  assert.equal(normalizeSettings({ camRotation: -90 }).camRotation, 270);
  assert.equal(normalizeSettings({ camRotation: 450 }).camRotation, 90);
  assert.equal(normalizeSettings({ camRotation: 360 }).camRotation, 0);
  for (const junk of [45, 'noventa', null, '', true, {}]) {
    assert.equal(normalizeSettings({ camRotation: junk }).camRotation, 0, `rotación ${JSON.stringify(junk)}`);
  }
  // Aspecto: sinónimos y basura.
  assert.equal(normalizeSettings({ camAspect: 'vertical' }).camAspect, '9:16');
  assert.equal(normalizeSettings({ camAspect: 'Horizontal' }).camAspect, '16:9');
  assert.equal(normalizeSettings({ camAspect: '4:3' }).camAspect, '16:9');
  assert.equal(normalizeSettings({ camAspect: 916 }).camAspect, '16:9');
  // Zoom por debajo de 1 y valores no numéricos → recorte / default.
  assert.equal(normalizeSettings({ camZoom: 0.5 }).camZoom, 1);
  assert.equal(normalizeSettings({ camZoom: 'abc' }).camZoom, 1);
  assert.equal(normalizeSettings({ camBrightness: true }).camBrightness, 0);
  assert.equal(normalizeSettings({ camMirror: 'quizás' }).camMirror, false);
});

test('imagen de la cámara: save persiste y un parche parcial no toca el resto', async () => {
  const fs = memoryFs();
  const store = createSettingsStore({ dir: 'X', fs, crypto: fakeCrypto() });
  await store.save({ camMirror: true, camAspect: '9:16', camBrightness: 0.4 });
  const saved = await store.save({ camZoom: 1.5 });
  assert.equal(saved.camMirror, true);
  assert.equal(saved.camAspect, '9:16');
  assert.equal(saved.camBrightness, 0.4);
  assert.equal(saved.camZoom, 1.5);
  const onDisk = JSON.parse(fs.files.get(path.join('X', 'settings.json')).toString('utf8'));
  assert.equal(onDisk.camAspect, '9:16');
  assert.equal(onDisk.camZoom, 1.5);
});

test('protocolo v3: settings.save persiste los ajustes nuevos normalizados', async () => {
  const fs = memoryFs();
  const store = createSettingsStore({ dir: 'X', fs, crypto: fakeCrypto() });
  const saved = await store.save({ ttsModel: 'eleven_flash_v2_5', ttsSpeed: 1.5, translateReasoningEffort: 'medium' });
  assert.equal(saved.ttsModel, 'eleven_flash_v2_5');
  assert.equal(saved.ttsSpeed, 1.2);
  const onDisk = JSON.parse(fs.files.get(path.join('X', 'settings.json')).toString('utf8'));
  assert.equal(onDisk.translateReasoningEffort, 'medium');
  assert.equal(onDisk.ttsSpeakerBoost, true);
});
