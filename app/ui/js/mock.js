// Backend simulado para abrir la UI en un navegador normal (diseño y pruebas
// visuales sin el shell). Misma forma de mensajes que el puente real.
// No se carga dentro de VoxoraMeet.exe (allí existe window.chrome.webview).
//
// Escenarios (?mock=…): ready (por defecto) · fresh (sin keys ni voz) · down (motor caído) ·
// offline (sin red: catálogo de referencia) · gone (modelo TTS guardado que ya no existe) ·
// v2 (motor sin protocolo v3). Con ?tab=models, ?autostart=1, etc. se abren pestañas y estados.
// Cámara virtual (?cam=…): live (por defecto: cámara permanente; el shell abre la webcam al arrancar,
// starting → live, en vivo sin retraso) · lost · error · off (cameraAlwaysOn=false) · down
// (permanente pero el host no arrancó) · flap (live → lost → live). Al doblar pasa a mode 'dubbing'
// con delayMs; al detener vuelve a 0 sin cortar (u off si la cámara no es permanente).

// ── Protocolo v3: catálogo como el de app/engine/models.mjs y precios de billing/src ──
const MOCK_STT = [
  { id: 'whisper-large-v3', label: 'Whisper Large v3', description: 'La transcripción más precisa: acierta más con nombres propios, cifras y acentos. Recomendado para reuniones.', recommended: true, supportsReasoningEffort: false, reasoningEfforts: [], price: { unit: 'hora de audio', usd: 0.111 }, available: true },
  { id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo', description: 'Más rápido y ~64 % más barato; algo menos preciso con términos poco comunes.', recommended: false, supportsReasoningEffort: false, reasoningEfforts: [], price: { unit: 'hora de audio', usd: 0.04 }, available: true },
];
const chat = (id, label, description, input, output, extra = {}) => ({
  id, label, description, recommended: false, supportsReasoningEffort: false, reasoningEfforts: [],
  price: { unit: '1M tokens de entrada', usd: input, usdOutput: output, outputUnit: '1M tokens de salida', source: 'live' },
  available: true, contextWindow: 131072, ...extra,
});
const MOCK_TRANSLATE = [
  chat('openai/gpt-oss-120b', 'GPT-OSS 120B', 'La mejor calidad de traducción y la terminología más consistente. Recomendado.', 0.15, 0.6, { recommended: true, supportsReasoningEffort: true, reasoningEfforts: ['low', 'medium', 'high'] }),
  chat('openai/gpt-oss-20b', 'GPT-OSS 20B', 'Más rápido y barato; buena calidad en frases directas, flojea con matices.', 0.075, 0.3, { supportsReasoningEffort: true, reasoningEfforts: ['low', 'medium', 'high'] }),
  chat('qwen/qwen3.8-27b', 'Qwen3.8 27B', 'Qwen de última generación, multilingüe; más caro. El razonamiento se oculta para que no llegue a la voz.', 0.8, 4, { supportsReasoningEffort: true, reasoningEfforts: ['none', 'default'] }),
  chat('llama-3.3-70b-versatile', 'Llama 3.3 70B', 'Traducción fluida sin razonamiento y latencia estable.', 0.59, 0.79),
];
// Proveedores alternativos por etapa: ElevenLabs Scribe / OpenAI para transcribir, OpenAI para traducir.
const sttModel = (id, label, description, usd, recommended = false) => ({ id, label, description, recommended, supportsReasoningEffort: false, reasoningEfforts: [], price: { unit: 'hora de audio', usd }, available: true });
const MOCK_STT_BY_PROVIDER = {
  groq: MOCK_STT,
  elevenlabs: [
    sttModel('scribe_v2', 'Scribe v2', 'El transcriptor más preciso de ElevenLabs (90+ idiomas); usa tu vocabulario como términos clave. Recomendado.', 0.4, true),
    sttModel('scribe_v1', 'Scribe v1', 'Generación anterior de Scribe; no admite términos clave del vocabulario.', 0.4),
  ],
  openai: [
    sttModel('gpt-4o-transcribe', 'GPT-4o Transcribe', 'La transcripción más precisa de OpenAI. Recomendado.', 0.36, true),
    sttModel('gpt-4o-mini-transcribe', 'GPT-4o mini Transcribe', 'Más rápido y a mitad de precio; algo menos preciso.', 0.18),
  ],
};
const MOCK_TRANSLATE_BY_PROVIDER = {
  groq: MOCK_TRANSLATE,
  openai: [
    chat('gpt-4.1', 'GPT-4.1', 'Traducción de alta calidad con latencia baja y sin razonamiento. Recomendado.', 2, 8, { recommended: true, contextWindow: undefined }),
    chat('gpt-4.1-mini', 'GPT-4.1 mini', 'Rápido y económico; buena calidad en frases directas.', 0.4, 1.6, { contextWindow: undefined }),
    chat('gpt-4o', 'GPT-4o', 'Muy buena calidad multilingüe; algo más caro que GPT-4.1.', 2.5, 10, { contextWindow: undefined }),
    chat('gpt-5', 'GPT-5', 'Máxima calidad, pero razona antes de traducir: bastante más latencia.', 1.25, 10, { contextWindow: undefined, supportsReasoningEffort: true, reasoningEfforts: ['low', 'medium', 'high'] }),
  ],
};
const MOCK_PROVIDERS = {
  stt: ['groq', 'elevenlabs', 'openai'], translate: ['groq', 'openai'],
  labels: { groq: 'Groq', elevenlabs: 'ElevenLabs', openai: 'OpenAI' },
  defaults: { stt: { groq: 'whisper-large-v3', elevenlabs: 'scribe_v2', openai: 'gpt-4o-transcribe' }, translate: { groq: 'openai/gpt-oss-120b', openai: 'gpt-4.1' } },
};
const tts = (id, label, description, languages, costMultiplier, caps = {}) => ({
  id, label, description, recommended: false, supportsReasoningEffort: false, reasoningEfforts: [],
  price: { unit: '1k caracteres', usd: Math.round(0.18 * costMultiplier * 1e4) / 1e4 }, languages, costMultiplier,
  supportsStyle: false, supportsSpeakerBoost: false, supportsLanguageCode: false, supportsSpeed: true, supportsNormalizationOn: true,
  stabilityPresets: null, maxChars: 10000, available: true, ...caps,
});
const MOCK_TTS = [
  tts('eleven_multilingual_v2', 'Multilingual v2', 'La voz clonada más fiel y natural, en 29 idiomas. Recomendado para reuniones.', 29, 1, { recommended: true, supportsStyle: true, supportsSpeakerBoost: true }),
  tts('eleven_v3', 'Eleven v3', 'El más expresivo (70+ idiomas). Estabilidad por presets (Creativo, Natural, Robusto) y más latencia.', 74, 1, { supportsLanguageCode: true, supportsSpeed: false, stabilityPresets: [0, 0.5, 1], maxChars: 5000 }),
  tts('eleven_v4_turbo', 'Eleven v4 Turbo', 'v4 optimizado para baja latencia; mitad de costo por carácter.', 85, 0.5),
  tts('eleven_turbo_v2_5', 'Turbo v2.5', 'Buen equilibrio entre calidad y latencia en 32 idiomas; mitad de costo, algo menos fiel al timbre clonado.', 32, 0.5, { supportsLanguageCode: true, supportsNormalizationOn: false, maxChars: 40000 }),
  tts('eleven_flash_v2_5', 'Flash v2.5', 'Latencia mínima y mitad de costo en 32 idiomas; la menos fiel al timbre clonado.', 32, 0.5, { supportsLanguageCode: true, supportsNormalizationOn: false, maxChars: 40000 }),
];
const MODEL_DEFAULTS = {
  sttProvider: 'groq', translateProvider: 'groq',
  sttModel: 'whisper-large-v3', sttTemperature: 0, translateModel: 'openai/gpt-oss-120b', translateTemperature: 0.2,
  translateReasoningEffort: 'low', memoryTurns: 8, ttsModel: 'eleven_multilingual_v2', ttsStability: 0.5,
  ttsSimilarityBoost: 0.75, ttsStyle: 0, ttsSpeed: 1, ttsSpeakerBoost: true, ttsTextNormalization: 'auto',
};

/** Igual que estimateCostRates de billing/src (supuestos de reunión, margen 1,5, 100 VOX/USD). */
function estimateRates(s, minutes = 60, speakingRatio = 0.5) {
  const STT = Object.fromEntries(Object.values(MOCK_STT_BY_PROVIDER).flat().map((m) => [m.id, m.price.usd]));
  const CHAT = Object.fromEntries(Object.values(MOCK_TRANSLATE_BY_PROVIDER).flat().map((m) => [m.id, [m.price.usd, m.price.usdOutput]]));
  const MULT = Object.fromEntries(MOCK_TTS.map((m) => [m.id, m.costMultiplier]));
  const speakingMin = minutes * speakingRatio;
  const words = speakingMin * 140;
  const turns = Math.ceil((speakingMin * 60000) / 8000);
  const tokensPerTurn = (8000 / 60000) * 140 * 1.4;
  const effort = s.translateReasoningEffort;
  const reasoning = /gpt-oss|^gpt-5/.test(s.translateModel) ? ({ low: 80, medium: 300, high: 1000 }[effort] ?? 80)
    : /qwen/.test(s.translateModel) && effort === 'default' ? 300 : 0;
  const inTok = words * 1.4 + turns * (300 + Number(s.memoryTurns) * 2 * tokensPerTurn);
  const outTok = words * 1.4 + turns * reasoning;
  const [pin, pout] = CHAT[s.translateModel] ?? [1, 4];
  const usd = {
    stt: (speakingMin / 60) * (STT[s.sttModel] ?? 0.111),
    translate: (inTok / 1e6) * pin + (outTok / 1e6) * pout,
    tts: ((words * 5.5) / 1000) * 0.18 * (MULT[s.ttsModel] ?? 1),
  };
  const vox = (v) => (v > 0 ? Math.max(1, Math.ceil(v * 1.5 * 100)) : 0);
  const perHour = 60 / minutes;
  const r4 = (n) => Math.round(n * 1e4) / 1e4;
  const totalVox = vox(usd.stt) + vox(usd.translate) + vox(usd.tts);
  return {
    minutes, speakingRatio,
    voxPerMinute: Math.round((totalVox / minutes) * 100) / 100,
    voxPerHour: Math.round((totalVox / minutes) * 60),
    usdPerHour: r4((usd.stt + usd.translate + usd.tts) * perHour),
    breakdown: { stt: r4(usd.stt * perHour), translate: r4(usd.translate * perHour), tts: r4(usd.tts * perHour) },
    breakdownVox: { stt: Math.round(vox(usd.stt) * perHour), translate: Math.round(vox(usd.translate) * perHour), tts: Math.round(vox(usd.tts) * perHour) },
    models: { stt: s.sttModel, translate: s.translateModel, tts: s.ttsModel },
  };
}

/** WAV corto (tres notas) como data URL, para simular tts.preview. */
function previewWav() {
  const rate = 24000;
  const notes = [523.25, 659.25, 783.99];
  const n = Math.round(rate * 0.9);
  const bytes = new Uint8Array(44 + n * 2);
  const view = new DataView(bytes.buffer);
  const str = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f = notes[Math.min(notes.length - 1, Math.floor(t / 0.3))];
    const env = Math.min(1, (t % 0.3) * 40) * Math.max(0, 1 - (t % 0.3) / 0.3);
    view.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * f * t) * env * 9000), true);
  }
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:audio/wav;base64,${btoa(bin)}`;
}

export function createMock(dispatch) {
  const params = new URLSearchParams(location.search);
  const scenario = params.get('mock') || 'ready';
  const emit = (msg) => setTimeout(() => dispatch(msg), 0);
  const settings = {
    delayMs: 3000, sourceLanguage: 'es', targetLanguage: 'en', tone: 'professional', styleInstruction: '',
    fallbackMode: 'silence', micDeviceId: '', cameraDeviceId: '', voiceId: scenario === 'fresh' ? '' : 'Xb7hH8MSUJpSbSDYk0k2',
    voiceName: scenario === 'fresh' ? '' : 'Mateo - Sagitario', virtualMicDevice: 'VOXORA Meet Speaker', monitorDevice: '',
    maxVoxPerSession: 0, warnAtVox: 0, cameraAlwaysOn: params.get('cam') !== 'off',
    uiMode: params.get('mode') === 'advanced' ? 'advanced' : 'simple',
    camMirror: false, camFlip: false, camRotation: 0, camAspect: '16:9', camZoom: 1, camPanX: 0, camPanY: 0,
    camBrightness: 0, camContrast: 0, camSaturation: 0, camTemperature: 0,
    ...(scenario === 'v2' ? {} : MODEL_DEFAULTS),
    ...(scenario === 'gone' ? { ttsModel: 'eleven_monolingual_v1' } : {}),
  };
  let glossary = [
    { term: 'VOXORA', translation: null },
    { term: 'tablero', translation: 'dashboard' },
    { term: 'OKR', translation: null },
  ];
  let vocabulary = ['VOXORA', 'Mateo', 'Bogotá', 'Kubernetes', 'Grafana'];
  const keys = { groq: scenario !== 'fresh', elevenlabs: scenario !== 'fresh', openai: false };
  const voices = [
    { voiceId: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Mateo - Sagitario', category: 'professional', previewUrl: '' },
    { voiceId: 'pNInz6obpgDQGcFmaJgB', name: 'Mateo reuniones (IVC)', category: 'cloned', previewUrl: '' },
    { voiceId: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', category: 'premade', previewUrl: '' },
    { voiceId: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi', category: 'premade', previewUrl: '' },
    { voiceId: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella', category: 'premade', previewUrl: '' },
    { voiceId: 'ErXwobaYiN019PkySvjV', name: 'Antoni', category: 'premade', previewUrl: '' },
  ];
  const devices = () => ({
    type: 'devices', reason: 'hello',
    cameras: [{ id: 'cam-1', name: 'Logitech BRIO' }, { id: 'cam-2', name: 'Integrated Camera' }],
    mics: [{ id: 'mic-1', name: 'Micrófono (Logitech BRIO)', default: true }, { id: 'mic-2', name: 'Micrófono (Realtek(R) Audio)', default: false }],
    renderEndpoints: [
      { id: 'r1', name: 'Altavoces (Realtek(R) Audio)', isDefault: true },
      { id: 'r2', name: 'CABLE Input (VB-Audio Virtual Cable)', isDefault: false },
      { id: 'r3', name: 'Auriculares (WH-1000XM4)', isDefault: false },
    ],
    virtualMic: { installed: true, device: settings.virtualMicDevice, resolvedDevice: 'CABLE Input (VB-Audio Virtual Cable)', captureName: 'CABLE Output', fallback: true, candidates: ['VOXORA Meet Speaker', 'CABLE Input'] },
    virtualCamera: { installed: true },
  });

  // ── Cámara virtual (eventos nativos `camera` / `camera.stats`, como el shell) ──
  const CAM_NAME = 'Logitech BRIO';
  const CAM_MESSAGES = {
    lost: `Se desconectó «${CAM_NAME}». Meet ve la imagen de espera de VOXORA hasta que vuelva; se reintenta sola.`,
    error: `No se pudo abrir «${CAM_NAME}»: otra aplicación la está usando. Meet ve la imagen de espera; se reintenta sola.`,
    down: 'La cámara virtual no arrancó (VoxoraMeetVCamHost.exe se cerró). VOXORA Meet la reintenta.',
  };
  const camScenario = params.get('cam') || 'live';
  const cam = { state: 'starting', name: CAM_NAME, message: '', mode: 'live', delayMs: 0, alwaysOn: settings.cameraAlwaysOn, hostRunning: true };
  if (camScenario === 'off' || camScenario === 'down') Object.assign(cam, { state: 'off', mode: 'off', hostRunning: false, message: CAM_MESSAGES[camScenario] || '' });
  else if (['lost', 'error'].includes(camScenario)) Object.assign(cam, { state: camScenario, message: CAM_MESSAGES[camScenario] || '' });
  else if (camScenario === 'flap') cam.state = 'live';
  const emitCamera = () => emit({ type: 'native-event', event: 'camera', data: { ...cam } });
  /** Como el shell con la cámara permanente: abre la webcam en cuanto hay cámara virtual. */
  const openWebcamSoon = () => setTimeout(() => {
    if (cam.state === 'starting' && cam.hostRunning) { cam.state = 'live'; emitCamera(); }
  }, 900);
  if (cam.state === 'starting') openWebcamSoon();
  if (camScenario === 'flap') {
    // ?cam=flap: la webcam se desconecta a los 2,5 s y vuelve a los 5 s (toasts de transición).
    setTimeout(() => { Object.assign(cam, { state: 'lost', message: CAM_MESSAGES.lost }); emitCamera(); }, 2500);
    setTimeout(() => { Object.assign(cam, { state: 'live', message: `«${CAM_NAME}» volvió: Meet recibe de nuevo tu cámara.` }); emitCamera(); }, 5000);
  }
  let published = 0;
  setInterval(() => {
    if (!cam.hostRunning) return;
    const flowing = cam.state === 'live';
    if (flowing) published += 30;
    emit({
      type: 'native-event', event: 'camera.stats', data: {
        width: flowing ? 1280 : 0, height: flowing ? 720 : 0, fps: flowing ? 30 : 0,
        queuedFrames: flowing ? Math.round((cam.delayMs / 1000) * 30) : 0, delayMs: cam.delayMs, published,
        sourceLost: cam.state === 'lost', vcamHostRunning: cam.hostRunning, sharedMemoryOk: true,
        state: cam.state, mode: cam.mode, outputWidth: 1280, outputHeight: 720,
        effectsMs: flowing ? 1.4 + Math.random() * 0.6 : 0, effectsPeakMs: flowing ? 2.6 + Math.random() : 0,
      },
    });
  }, 1000);
  /** Fuera de la sesión: la cámara permanente enciende/apaga el host y la webcam (en sesión siguen hasta detener). */
  const applyAlwaysOn = () => {
    cam.alwaysOn = settings.cameraAlwaysOn;
    if (!session) {
      if (settings.cameraAlwaysOn && !cam.hostRunning) {
        Object.assign(cam, { state: 'starting', mode: 'live', delayMs: 0, hostRunning: true, message: '' });
        openWebcamSoon();
      }
      if (!settings.cameraAlwaysOn) Object.assign(cam, { state: 'off', mode: 'off', delayMs: 0, hostRunning: false, message: '' });
    }
    emitCamera();
  };

  let session = null;
  const startSession = () => {
    let turn = 0;
    let vox = 0;
    const t0 = performance.now();
    const lines = [
      ['Buenos días a todos, gracias por conectarse.', 'Good morning everyone, thanks for joining.'],
      ['Hoy vamos a revisar los resultados del trimestre y las prioridades.', 'Today we will review the quarterly results and our priorities.'],
      ['¿Les parece si empezamos por las ventas de marzo?', 'Shall we start with the March sales?'],
    ];
    session = {
      level: setInterval(() => {
        const speaking = Math.sin(performance.now() / 700) > -0.2;
        emit({ type: 'engine-event', event: 'level', data: { rmsDb: speaking ? -22 + Math.random() * 10 : -58, speaking } });
      }, 60),
      turns: setInterval(() => {
        turn += 1;
        const [src, dst] = lines[(turn - 1) % lines.length];
        const endedAt = performance.now() - t0;
        vox += 3;
        emit({ type: 'engine-event', event: 'transcript', data: { turnId: turn, text: src, startedAt: endedAt - 2500, endedAt } });
        emit({ type: 'engine-event', event: 'translation', data: { turnId: turn, text: dst } });
        emit({ type: 'engine-event', event: 'dub', data: { turnId: turn, durationMs: 2200, late: turn === 3 }, engineNowMs: endedAt + 1600 + Math.random() * 900 });
        emit({ type: 'engine-event', event: 'cost', data: { turnId: turn, cost: { totalVox: 3 }, totalVox: vox } });
      }, 3500),
      stats: setInterval(() => {
        emit({ type: 'engine-event', event: 'stats', data: { delayMs: settings.delayMs, driftMs: 40, lateDubs: turn >= 3 ? 1 : 0, totalVox: vox, remainingVox: null, turns: turn, pendingTurns: 1, state: 'running' } });
      }, 500),
    };
    // En sesión la webcam se captura siempre y el video pasa a ir retrasado delayMs.
    const keep = cam.state === 'lost' || cam.state === 'error';
    Object.assign(cam, { mode: 'dubbing', delayMs: settings.delayMs, hostRunning: true, state: keep ? cam.state : cam.state === 'live' ? 'live' : 'starting' });
    if (!keep) cam.message = '';
    emitCamera();
    if (cam.state === 'starting') setTimeout(() => { if (session && cam.state === 'starting') { cam.state = 'live'; emitCamera(); } }, 700);
  };
  const stopSession = () => {
    if (!session) return;
    Object.values(session).forEach(clearInterval);
    session = null;
    // Con la cámara permanente vuelve a retraso 0 sin cortar; si no, la cámara virtual desaparece.
    if (settings.cameraAlwaysOn) Object.assign(cam, { mode: 'live', delayMs: 0, state: cam.state === 'starting' ? 'live' : cam.state });
    else Object.assign(cam, { state: 'off', mode: 'off', delayMs: 0, hostRunning: false, message: '' });
    emitCamera();
  };

  let recTimer = null;
  let recSeconds = 0;
  // «Grabar prueba» simulada: progreso cada 250 ms y recording.done sin archivo real (url vacía).
  let testRec = null;
  const recordings = [];
  const RECORDINGS_DIR = 'C:\\Users\\demo\\AppData\\Local\\VOXORA Meet\\recordings';
  const finishTestRec = (reason) => {
    if (!testRec) return;
    clearInterval(testRec.timer);
    const elapsed = Math.min(testRec.seconds, (performance.now() - testRec.t0) / 1000);
    const item = { ok: true, reason, path: testRec.path, name: testRec.name, url: '', durationMs: Math.round(elapsed * 1000), sizeBytes: Math.round(elapsed * 650_000),
      hasVideo: true, hasAudio: true, audioDevice: 'CABLE Output (VB-Audio Virtual Cable)', videoFrames: Math.round(elapsed * 30), cameraFrames: Math.round(elapsed * 30), message: '' };
    recordings.unshift(item);
    testRec = null;
    setTimeout(() => emit({ type: 'native-event', event: 'recording.done', data: item }), 600);
  };

  const handlers = {
    'native.hello': () => {
      setTimeout(() => emit(devices()), 200);
      return { app: { version: '0.2.0 (simulado)', dataDir: 'C:\\Users\\demo\\AppData\\Roaming\\VOXORA Meet', webviewVersion: '—' }, engine: { state: scenario === 'down' ? 'exited' : 'ready', message: scenario === 'down' ? 'El motor de doblaje se detuvo inesperadamente (código 1). Pulsa «Reiniciar motor» para volver a intentarlo.' : '' }, session: { running: false, camera: 'off', cameraName: '' }, camera: { ...cam } };
    },
    'native.devices.refresh': () => { setTimeout(() => emit({ ...devices(), reason: 'manual' }), 300); return {}; },
    'native.engine.restart': () => { emit({ type: 'engine-state', state: 'ready', message: '' }); return {}; },
    'native.voice.record.start': () => {
      recSeconds = 0;
      recTimer = setInterval(() => { recSeconds += 0.1; emit({ type: 'native-event', event: 'record.level', data: { seconds: recSeconds, levelDb: -25 + Math.random() * 12, maxSeconds: 100 } }); }, 100);
      return { path: 'C:\\take.wav', maxSeconds: 100 };
    },
    'native.voice.record.stop': () => {
      clearInterval(recTimer);
      return { ok: true, path: `C:\\take-${Date.now()}.wav`, url: '', durationMs: Math.round(recSeconds * 1000), seconds: recSeconds, reason: 'user' };
    },
    'native.voice.record.discard': () => ({}),
    'native.pickAudioFiles': () => ({ files: [{ path: 'C:\\Users\\demo\\Music\\podcast.mp3', name: 'podcast.mp3', sizeBytes: 3_400_000, durationMs: 94_000 }] }),
    'native.openExternal': () => ({}),
    'native.camera.effects': (p) => {
      for (const [k, v] of Object.entries(p || {})) if (k.startsWith('cam')) settings[k] = v;
      return Object.fromEntries(Object.entries(settings).filter(([k]) => k.startsWith('cam') && k !== 'cameraDeviceId' && k !== 'cameraAlwaysOn'));
    },
    'native.recording.start': (p) => {
      if (testRec) throw { code: 'busy', message: 'Ya hay una grabación de prueba en curso.' };
      const seconds = Math.min(30, Math.max(10, Number(p.seconds) || 10));
      const name = `prueba-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.mp4`;
      testRec = { seconds, name, path: `${RECORDINGS_DIR}\\${name}`, t0: performance.now() };
      testRec.timer = setInterval(() => {
        const elapsed = (performance.now() - testRec.t0) / 1000;
        emit({ type: 'native-event', event: 'recording.progress', data: { elapsedMs: Math.round(elapsed * 1000), seconds, levelDb: session ? -24 + Math.random() * 8 : -100, cameraFrames: Math.round(elapsed * 30) } });
        if (elapsed >= seconds) finishTestRec('complete');
      }, 250);
      return { path: testRec.path, name, url: '', seconds, videoActive: cam.state === 'live', audioDevice: 'CABLE Output (VB-Audio Virtual Cable)' };
    },
    'native.recording.stop': () => { finishTestRec('user'); return {}; },
    'native.recording.status': () => ({ recording: Boolean(testRec), seconds: testRec?.seconds || 0 }),
    'native.recording.list': () => ({ items: recordings.slice(0, 12), dir: RECORDINGS_DIR }),
    'native.recording.delete': (p) => { const i = recordings.findIndex((r) => r.path === p.path); if (i >= 0) recordings.splice(i, 1); return {}; },
    'native.recording.reveal': () => ({}),
    'native.window.hide': () => ({}),
    'native.window.quit': () => ({}),
    'settings.get': () => ({ settings: { ...settings }, providerKeys: { ...keys }, dataDir: 'C:\\Users\\demo\\AppData\\Roaming\\VOXORA Meet' }),
    'settings.set': (p) => {
      const wasAlwaysOn = settings.cameraAlwaysOn;
      Object.assign(settings, p.settings || {});
      if ('cameraAlwaysOn' in (p.settings || {})) settings.cameraAlwaysOn = p.settings.cameraAlwaysOn !== false && p.settings.cameraAlwaysOn !== 'false';
      for (const [k, v] of Object.entries(p.providerKeys || {})) keys[k] = Boolean(v);
      // Como el shell: lee cameraAlwaysOn de la respuesta y enciende/apaga la cámara virtual.
      if (settings.cameraAlwaysOn !== wasAlwaysOn) applyAlwaysOn();
      return { settings: { ...settings }, providerKeys: { ...keys } };
    },
    'delay.set': (p) => {
      settings.delayMs = Math.min(6000, Math.max(2000, p.delayMs));
      if (session) cam.delayMs = settings.delayMs;  // el ring de video adopta el delay (llega en camera.stats)
      return { delayMs: settings.delayMs };
    },
    'voices.list': () => ({ voices: voices.map((v) => ({ ...v, isCurrent: v.voiceId === settings.voiceId })), currentVoiceId: settings.voiceId }),
    'voice.set': (p) => {
      const v = voices.find((x) => x.voiceId === p.voiceId);
      if (!v) throw { code: 'voice_missing', message: 'Ese Voice ID no existe en tu cuenta de ElevenLabs.' };
      Object.assign(settings, { voiceId: v.voiceId, voiceName: v.name });
      return { voiceId: v.voiceId, name: v.name };
    },
    'voice.clone': (p) => ({ voiceId: 'NewVoice1234567890ab', name: p.name, totalMs: 120000 }),
    ...(scenario === 'v2' ? {} : {
      'models.list': () => {
        const offline = scenario === 'offline' || scenario === 'fresh';
        const errors = scenario === 'fresh'
          ? { groq: { code: 'missing_key', message: 'Falta la API key de Groq: se muestra el catálogo de referencia.' }, elevenlabs: { code: 'missing_key', message: 'Falta la API key de ElevenLabs: se muestra el catálogo de referencia.' } }
          : offline ? { groq: { code: 'network', message: 'Sin conexión con Groq.' } } : {};
        // Como ensureSelected del motor: el modelo guardado que ya no existe llega con available:false.
        const withSelected = (list, id, make) => (list.some((m) => m.id === id) ? list : [...list, { ...make(id), available: false }]);
        const sttProvider = settings.sttProvider || 'groq';
        const trProvider = settings.translateProvider || 'groq';
        const sttByProvider = { ...MOCK_STT_BY_PROVIDER };
        const translateByProvider = { ...MOCK_TRANSLATE_BY_PROVIDER };
        sttByProvider[sttProvider] = withSelected(sttByProvider[sttProvider], settings.sttModel, (id) => ({ ...MOCK_STT[0], id, label: id, recommended: false }));
        translateByProvider[trProvider] = withSelected(translateByProvider[trProvider], settings.translateModel, (id) => chat(id, id, 'Modelo de chat sin ficha propia.', 1, 4));
        return {
          stt: sttByProvider[sttProvider],
          translate: translateByProvider[trProvider],
          sttByProvider, translateByProvider, providers: MOCK_PROVIDERS,
          tts: withSelected(MOCK_TTS, settings.ttsModel, (id) => tts(id, id, 'Modelo de ElevenLabs sin ficha propia.', null, 1)),
          defaults: { ...MODEL_DEFAULTS }, offline,
          fetchedAt: new Date().toISOString(), sources: { groq: offline ? 'static' : 'live', elevenlabs: scenario === 'fresh' ? 'static' : 'live', openai: keys.openai ? 'live' : 'static' }, errors,
        };
      },
      'cost.estimate': (p) => {
        const overrides = Object.fromEntries(Object.entries(p.overrides || {}).filter(([k]) => k in MODEL_DEFAULTS));
        return estimateRates({ ...settings, ...overrides }, p.minutes ?? 60, p.speakingRatio ?? 0.5);
      },
      'tts.preview': (p) => {
        if (!keys.elevenlabs) throw { code: 'missing_key', message: 'Falta la API key de ElevenLabs (Ajustes).' };
        const text = (p.text || 'Hola, así sonará tu voz en la reunión con estos ajustes.').trim();
        return { audioDataUrl: previewWav(), chars: text.length, sampleRate: 24000, model: settings.ttsModel, voiceId: p.voiceId || settings.voiceId, text, format: 'wav' };
      },
      'glossary.get': () => ({ entries: glossary.map((e) => ({ ...e })) }),
      'glossary.set': (p) => {
        glossary = (p.entries || []).filter((e) => String(e?.term || '').trim()).map((e) => ({ term: String(e.term).trim(), translation: e.translation ? String(e.translation).trim() : null }));
        return { entries: glossary };
      },
      'vocabulary.get': () => ({ terms: [...vocabulary] }),
      'vocabulary.set': (p) => {
        vocabulary = [...new Set((p.terms || []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 200);
        return { terms: [...vocabulary] };
      },
    }),
    'session.start': () => { startSession(); emit({ type: 'engine-event', event: 'status', data: { state: 'running' } }); return {}; },
    'session.stop': () => { stopSession(); emit({ type: 'engine-event', event: 'status', data: { state: 'idle', reason: 'stopped' } }); return {}; },
    'stats.get': () => ({ state: 'idle' }),
  };

  return (msg) => {
    const handler = handlers[msg.cmd];
    const replyType = msg.type === 'engine' ? 'engine-reply' : 'native-reply';
    setTimeout(() => {
      try {
        if (!handler) throw { code: 'unknown_command', message: `Comando simulado desconocido: ${msg.cmd}` };
        dispatch({ type: replyType, id: msg.id, ok: true, result: handler(msg.params || {}) });
      } catch (error) {
        dispatch({ type: replyType, id: msg.id, ok: false, error: { code: error.code || 'internal', message: error.message || String(error) } });
      }
    }, msg.cmd === 'session.start' ? 900 : msg.cmd === 'models.list' || msg.cmd === 'tts.preview' ? 700 : 120);
  };
}
