# Contratos entre módulos (fuente de verdad)

Convenciones: ESM (`.mjs`/`.js` con `"type":"module"`), Node ≥ 22 (fetch y WebSocket globales, sin deps),
tests con `node --test` en `*.test.mjs`, comentarios en español, sin TypeScript en runtime.
Tiempos en ms monotónicos (`performance.now()`), audio PCM s16le mono salvo indicación.

## capture → pipeline
`MicCapture` (capture/src/mic-capture.mjs) emite eventos:
- `turn` → `{ pcm: Buffer (s16le mono 16 kHz), sampleRate: 16000, startedAt, endedAt, voicedMs, rmsDb }`
  Un turno = frase completa cerrada por silencio (endpointing), NO ventana fija.
- `level` → `{ rmsDb, speaking: boolean }` (para la UI, ~20 Hz).
- `error`.
Fuente PCM inyectable: `new MicCapture({ source })` con `Readable` PCM s16le mono.
Sin `source.sampleRate` se asumen 16 kHz; la fuente real declara 48000.
MicCapture convierte con estado a 16 kHz para STT; el original conserva 48 kHz.
También emite `turn-start` y `turn-discarded` con `{ startedAt }` para reservar/liberar el turno.

## pipeline → sync-buffer
`DubbingPipeline.processTurn(turn)` → `Promise<DubResult>`:
```
{ audioDub: Buffer (s16le mono, sampleRate), sampleRate: 24000|44100|48000,
  sourceTimestamp: turn.startedAt, sourceEndedAt: turn.endedAt, readyAt,
  transcript, translation, cost: { stt, translate, tts, totalVox } }
```
Turnos descartados (sin voz/alucinación) resuelven `null`.
`processTurn(turn, { signal, shouldSynthesize })` permite cancelar o impedir TTS cuando ya no se
puede entregar el turno. Admite hasta cuatro turnos y 15 s de audio fuente pendientes.

## sync-buffer → entrega
`SyncBuffer` recibe `pushFrame({ frame, timestamp })` y `pushAudio({ pcm, sampleRate, timestamp })` del original,
y `pushDub(dubResult)`. Retiene `delayMs` (2000–6000, configurable en caliente) y libera con `onRelease({ frame, audio })`
en el mismo tick: `audio` es el doblaje si llegó a tiempo para ese rango, o el original/silencio según `fallbackMode`.
`reserveTurn({ turnId, sourceTimestamp, sourceEndedAt? })` reserva desde el inicio de voz.
Mientras está pendiente se emite silencio. `finishTurn(turnId)` finaliza sin doblaje.
`pushDub({ ...dubResult, turnId })` devuelve `scheduled:false` con `reason` si se repite, vence,
excede la cola o ya salió original. La decisión es definitiva para ese turno.
`release` incluye `presentation` cuando hay doblaje: progreso de fuente, tasa y duración restante.

## entrega → Windows
- Video: lo maneja el shell nativo: webcam (MF SourceReader) → ring de `delayMs` → shared memory `Local\VoxoraMeetVCamFrames` → DLL MF Virtual Camera. `VirtualCamera.writeFrame` (Node) queda para pruebas/herramientas.
- Audio: `VirtualMic.write(pcm)` → dispositivo render "VOXORA Meet Speaker" del driver WaveRT, que lo
  refleja en la captura "VOXORA Meet Microphone". Formato del driver: PCM s16le, 48 kHz, mono/estéreo (M0).

## billing
`estimateTurnCost({ audioMs, inputTokens, outputTokens, ttsChars }, { sttModel?, translateModel?, ttsModel?, ttsCostMultiplier? })` → créditos VOX enteros
(precios por modelo documentados en `billing/src/index.mjs`; modelo de chat desconocido → precio conservador).
`estimateMeetingCost({ minutes, speakingRatio, …modelos, translateReasoningEffort?, memoryTurns? })` y
`estimateCostRates(…)` (forma de `cost.estimate`). `SessionMeter` acumula y aplica límites (`maxVoxPerSession`, `warnAtVox`).

## shell nativo ↔ engine (JSON-lines por stdio)
Petición: `{ id, cmd, params }`, respuesta `{ id, ok, result | error: { code, message } }`.
Comandos: `ping`, `session.start`, `session.stop`, `settings.get`, `settings.set`, `devices.list`, `voice.clone`, `delay.set`, `stats.get`.
Eventos: `{ event: 'level'|'transcript'|'translation'|'dub'|'stats'|'cost'|'warn'|'limit'|'status', data }`.
El shell aplica el delay nominal y sigue el progreso de fuente mediante `presentation`:
`{ sessionId, turnId, sourceAgeMs, sourceRate, validForMs }`, emitido tras aceptar la escritura PCM.
`stats` añade rutas efectivas, latencias p50/p95, colas, rechazos y telemetría nativa.
El seguimiento es estimado; véase [VIDEO-SYNC.md](VIDEO-SYNC.md).

Ajustes que consume el shell (los lee de las respuestas de `settings.get`/`settings.set` que atraviesan el puente;
el engine solo los normaliza y persiste):

| Clave | Default | Valores |
|---|---|---|
| `cameraDeviceId` | `''` | symbolic link MF de la webcam (`''` = la primera) |
| `cameraAlwaysOn` | `true` | bool (`'true'`/`'false'`/`1`/`0` se aceptan; otro valor → default). `true`: la cámara virtual existe mientras la app esté abierta, con la webcam abierta y en vivo (retraso 0); al doblar pasa a `delayMs` y al detener vuelve a 0 sin cortar. `false`: webcam y cámara virtual solo durante la sesión. Se aplica en caliente |

## Protocolo shell ↔ engine v2 (2026-09-28)
Adiciones compatibles hacia atrás a los comandos JSON-lines:

- `devices.list` → además de lo anterior:
  - `renderEndpoints: [{ id, name, isDefault }]` (salidas de audio del sistema).
  - `capture.mics: [{ id, name, default }]`.
  - `virtualMic: { installed, device, resolvedDevice, candidates: [name] }`
    `device` = ajuste `virtualMicDevice`; `resolvedDevice` = endpoint real que se usará
    (el driver propio si existe; si no, VB-Cable "CABLE Input" si existe; si no, `null`).
- `voices.list` → `{ voices: [{ voiceId, name, category, previewUrl, isCurrent }], currentVoiceId }`
  (`category`: `cloned` | `professional` | `premade` | `generated`; clonadas primero).
- `voice.set` `{ voiceId, name? }` → `{ voiceId, name }` (valida que la voz exista en la cuenta).
- `voice.clone` `{ name, description?, wavPaths?: [], filePaths?: [] }` → `{ voiceId, name, totalMs }`.
  `filePaths` admite .wav/.mp3/.m4a/.ogg/.flac (mín. 60 s sumando solo lo medible en WAV; el resto lo valida ElevenLabs).
  Al terminar deja la voz como actual.
- `settings.set` acepta además `virtualMicDevice` (nombre o subcadena del endpoint de render) y
  `monitorDevice` (`''` = apagado; si no, endpoint donde también se escucha el doblaje localmente).
- Errores con `code` estable y `message` en español listo para mostrar:
  `missing_key`, `provider_auth` (key inválida), `provider_payment` (cuenta con pago pendiente),
  `provider_quota`, `model_unavailable` (v3: el modelo elegido no existe, fue retirado o la cuenta no
  tiene acceso; el mensaje nombra la etapa y el id, p. ej. «El modelo de traducción «x» no está disponible
  en tu cuenta de Groq…»), `network`, `virtual_mic_missing`, `voice_missing`, `samples_too_short`,
  `bad_request`, `internal`.
  El evento `error` usa la misma forma: `{ scope, code, message }`.

El shell es dueño de: enumeración de cámaras (Media Foundation), detección de conexión/desconexión de
dispositivos (WM_DEVICECHANGE + IMMNotificationClient) y reenvío de `devices.list` al detectar cambios.

## Protocolo v3 — selección y configuración de modelos (2026-09-28)
Ajustes planos nuevos (en `settings.json`, normalizados por el engine; valores fuera de rango se recortan):

| Clave | Default | Rango / valores |
|---|---|---|
| `sttModel` | `whisper-large-v3` | id de Groq con "whisper" |
| `sttTemperature` | `0` | 0–1 |
| `translateModel` | `openai/gpt-oss-120b` | id de chat de Groq |
| `translateTemperature` | `0.2` | 0–1 |
| `translateReasoningEffort` | `low` | `low`\|`medium`\|`high` (gpt-oss); también `none`\|`default` (Qwen3). Solo en modelos que lo admiten (ver `reasoningEfforts` del modelo); se ignora en el resto y se traduce entre escalas (Qwen3: low→none, medium/high→default) |
| `memoryTurns` | `8` | 0–64 (ya existía) |
| `ttsModel` | `eleven_multilingual_v2` | id de ElevenLabs con TTS |
| `ttsStability` | `0.5` | 0–1 (en `eleven_v3` se ajusta al preset más cercano: 0 Creativo, 0.5 Natural, 1 Robusto) |
| `ttsSimilarityBoost` | `0.75` | 0–1 |
| `ttsStyle` | `0` | 0–1 (solo si el modelo lo admite) |
| `ttsSpeed` | `1` | 0.7–1.2 |
| `ttsSpeakerBoost` | `true` | bool (solo si el modelo lo admite) |
| `ttsTextNormalization` | `auto` | `auto`\|`on`\|`off` |

Comandos nuevos:
- `models.list` `{ refresh?: bool }` → `{ stt: [Model], translate: [Model], tts: [TtsModel], defaults, offline: bool, fetchedAt }`.
  `Model = { id, label, description, recommended: bool, contextWindow?, supportsReasoningEffort: bool, reasoningEfforts: [], price: { unit, usd } }`.
  `TtsModel = Model & { languages: number, costMultiplier, supportsStyle, supportsSpeakerBoost, stabilityPresets: number[]|null, supportsLanguageCode, maxChars }`.
  Se consulta en vivo (`GET groq /openai/v1/models`, `GET elevenlabs /v1/models`), caché 10 min; sin red devuelve un catálogo estático con `offline: true`.
  Detalle de la implementación (campos extra, compatibles):
  - Respuesta: además `sources: { groq, elevenlabs }` (`live`|`static`) y `errors: { groq?, elevenlabs? }` con `{ code, message }`
    (p. ej. `missing_key`, `provider_auth`, `network`) cuando esa sección cayó al respaldo. `offline` es `true` si alguna lo hizo.
  - `Model.available` (`false` si el modelo guardado en ajustes ya no aparece en el catálogo en vivo: se añade igual para que la UI lo muestre) y `Model.source`.
  - `price`: STT `{ unit: 'hora de audio', usd }`; traducción `{ unit: '1M tokens de entrada', usd, usdOutput, outputUnit: '1M tokens de salida', source: 'live'|'table'|'estimate' }`;
    TTS `{ unit: '1k caracteres', usd }` (= 0.18 × `costMultiplier`).
  - `reasoningEfforts`: gpt-oss `['low','medium','high']`, Qwen3 `['none','default']`, resto `[]`.
  - `TtsModel` también trae `supportsSpeed` y `supportsNormalizationOn` (Flash/Turbo no admiten `ttsTextNormalization: 'on'`; se envía `auto`).
    `stabilityPresets` = `[0, 0.5, 1]` en la familia `eleven_v3`. Se omiten los modelos con `requires_alpha_access`.
- `tts.preview` `{ text?, voiceId? }` → `{ audioDataUrl: 'data:audio/wav;base64,…', chars, sampleRate, model }` — usa los ajustes TTS actuales (gasta caracteres).
  Sin `text` sintetiza una frase fija corta en el idioma destino (tabla es/en/pt/fr/de/it/nl/pl; inglés si no está). `text` ≤ 300 caracteres.
  Extra: `voiceId`, `text`, `format` (`wav`; `mp3` con `data:audio/mpeg` solo si la cuenta no tiene ningún PCM).
- `cost.estimate` `{ minutes?: 60, speakingRatio?: 0.5, overrides?: {…ajustes de modelo} }` → `{ voxPerMinute, voxPerHour, usdPerHour, breakdown: { stt, translate, tts } }`.
  `breakdown` son números en **USD por hora** de reunión (costo de proveedor, sin margen; suman `usdPerHour`). Extra: `breakdownVox` (VOX/h por etapa),
  `models: { stt, translate, tts }`, `prices`, `total: { vox, usd }` (para `minutes`), `usage`. `overrides` acepta las claves de la tabla de arriba y no se guarda;
  `minutes` se recorta a 1–1440 y `speakingRatio` a 0–1. `translateReasoningEffort` y `memoryTurns` cambian los tokens estimados.
- `glossary.get` → `{ entries: [{ term, translation?, note? }] }`; `glossary.set` `{ entries }`.
  `set` reemplaza todo y devuelve `{ entries }` normalizado: filas sin `term` se ignoran, términos duplicados (sin distinguir mayúsculas) → gana el último,
  `translation` vacía/ausente = "no traducir" (se omite en la respuesta). Máx. 500 entradas (term ≤120, translation/note ≤200 caracteres).
- `vocabulary.get` → `{ terms: [] }`; `vocabulary.set` `{ terms }` (nombres propios/jerga para el STT).
  `set` devuelve `{ terms }` deduplicado (sin distinguir mayúsculas), máx. 200 términos de ≤80 caracteres.
  Glosario y vocabulario se leen en cada turno: los cambios aplican desde el siguiente turno sin reiniciar la sesión.

Aplicación en caliente: traducción (modelo, temperatura, esfuerzo, memoria) y TTS (modelo y voice settings) se aplican desde el siguiente turno; el modelo de STT también. No hace falta reiniciar la sesión.

Aplicación en el pipeline: el TTS usa siempre `POST /v1/text-to-speech/{voice_id}` (no-stream, válido para todos los modelos incluido `eleven_v3`)
y manda solo lo que el modelo admite: `style`/`use_speaker_boost` según `supportsStyle`/`supportsSpeakerBoost`, `speed` salvo en v3,
`stability` redondeada al preset en v3, `language_code` (= idioma destino) solo si `supportsLanguageCode`, `apply_text_normalization`
solo si no es `auto`. Si el proveedor rechaza `language_code` o `reasoning_effort`, se repite una vez sin ese parámetro y no se vuelve
a mandar para ese modelo. El costo de cada turno se calcula con los modelos que lo atendieron.

## Ajustes de interfaz e imagen de la cámara (2026-09-28)
Claves planas de `settings.json` (normalizadas por `app/engine/settings-store.mjs`, tests en `app/test/settings-store.test.mjs`;
basura → default, números fuera de rango se recortan y se redondean a 3 decimales). El motor solo las guarda; las aplica la UI
(`uiMode`) y el shell (`cam*`, lista en `CAMERA_EFFECT_KEYS`), que las lee de la respuesta de `settings.get/set` y en caliente de
`native.camera.effects` (ver `docs/APP-SHELL.md`).

| Clave | Default | Rango / valores |
|---|---|---|
| `uiMode` | `simple` | `simple`\|`advanced` (sin distinguir mayúsculas ni espacios) |
| `camMirror` | `false` | bool (acepta `1`/`0`/`'true'`/`'false'`); espejo horizontal de lo que ve Meet |
| `camFlip` | `false` | bool; volteo vertical |
| `camRotation` | `0` | múltiplo de 90 → `0`\|`90`\|`180`\|`270` (horario; `-90` → `270`, `450` → `90`) |
| `camAspect` | `16:9` | `16:9`\|`9:16` (también `16/9`, `horizontal`/`landscape`, `vertical`/`portrait`); 9:16 = recorte vertical centrado dentro del lienzo 1280×720 con laterales difuminados y oscurecidos |
| `camZoom` | `1` | 1–2 |
| `camPanX` · `camPanY` | `0` | −1…1 (izquierda/arriba … derecha/abajo, dentro del margen que deja el zoom) |
| `camBrightness` · `camContrast` · `camSaturation` · `camTemperature` | `0` | −1…1 (0 = sin cambio; saturación −1 = blanco y negro; temperatura −1 fría … 1 cálida) |
