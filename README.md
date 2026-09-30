# VOXORA Meet

**Doblaje profesional con voz clonada para videollamadas** — Google Meet, Zoom, Teams, Discord y
cualquier app de videoconferencia.

El usuario habla en su idioma; la reunión escucha su propia voz clonada en el idioma destino, con
video y audio sincronizados por un delay controlado (2–6 s). A diferencia de un traductor en
tiempo real, VOXORA Meet prioriza **calidad y fidelidad de voz por encima de latencia**: turnos
de habla completos, traducción con contexto de la conversación, y una voz sintética
indistinguible de la del hablante.

**Versión actual: `0.2.0`** · Windows 10 2004+ (build 19041) · Node ≥ 22 · Sin dependencias npm
externas en runtime.

---

## Índice

- [Visión general](#visión-general)
- [Arquitectura](#arquitectura)
- [Módulos](#módulos)
  - [capture/ — Captura de micrófono y VAD](#capture--captura-de-micrófono-y-vad)
  - [pipeline/ — STT, traducción y TTS](#pipeline--stt-traducción-y-tts)
  - [sync-buffer/ — Cola de sincronía audio-video](#sync-buffer--cola-de-sincronía-audio-video)
  - [windows-camera/ — Cámara virtual (Media Foundation)](#windows-camera--cámara-virtual-media-foundation)
  - [windows-driver/ — Micrófono virtual (driver WaveRT de kernel)](#windows-driver--micrófono-virtual-driver-waveart-de-kernel)
  - [billing/ — Créditos VOX y medición de sesión](#billing--créditos-vox-y-medición-de-sesión)
  - [app/ — Motor Node + Shell nativo + UI](#app--motor-node--shell-nativo--ui)
- [Requisitos](#requisitos)
- [Desarrollo](#desarrollo)
- [Contratos entre módulos](#contratos-entre-módulos)
- [Configuración y ajustes](#configuración-y-ajustes)
- [Firma de código](#firma-de-código)
- [Release, instalador y publicación](#release-instalador-y-publicación)
- [Auto-actualización](#auto-actualización)
- [Prueba E2E en Google Meet](#prueba-e2e-en-google-meet)
- [Decisiones cerradas](#decisiones-cerradas)
- [Decisiones abiertas](#decisiones-abiertas)
- [Estructura de archivos](#estructura-de-archivos)

---

## Visión general

VOXORA Meet es un proyecto **independiente** de `03 Plugin OBS`. El plugin de streaming está
optimizado para **latencia mínima en streaming en vivo** (Chaturbate/Stripchat): ventanas cortas,
un solo paso de traducción, voces genéricas rápidas. Meet necesita lo contrario:

| Aspecto | Plugin OBS (streaming) | VOXORA Meet (reuniones) |
|---|---|---|
| Prioridad | Latencia mínima | Calidad y fidelidad de voz |
| Segmentación | Chunks de tiempo fijo | Turnos de habla completos (endpointing por silencio) |
| Traducción | Un paso, sin contexto previo | Con memoria de N turnos + glosario + tono |
| Voz | Genérica, rápida | Clonada del usuario (IVC/PVC de ElevenLabs) |
| Entrega | v4l2loopback / PulseAudio (Linux) | Cámara y mic virtual de Windows |
| Costos | Por stream | Créditos VOX por minuto de reunión |
| Sincronía | Invisible en streaming | Labios-audio con delay controlado |

---

## Arquitectura

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        VOXORA Meet — Flujo de datos                         │
│                                                                             │
│  Micrófono ─── WASAPI ──► MicCapture ──► PhraseSegmenter ───── turn ─────┐ │
│  (hardware)   (helper      (ESM)        (VAD adaptativo,      (PCM s16le │ │
│                nativo)                   endpointing por         16 kHz,  │ │
│                                          silencio)             frase      │ │
│                                                              completa)   │ │
│                                                                   │      │ │
│                                                                   ▼      │ │
│                                                          DubbingPipeline │ │
│                                                         ┌───────────────┐│ │
│                                                         │ 1. STT        ││ │
│                                                         │    Groq       ││ │
│                                                         │    Whisper    ││ │
│                                                         │    large-v3  ││ │
│                                                         │    + vocab   ││ │
│                                                         │    custom    ││ │
│                                                         ├───────────────┤│ │
│                                                         │ 2. Traducción ││ │
│                                                         │    Groq Chat  ││ │
│                                                         │    gpt-oss-  ││ │
│                                                         │    120b +    ││ │
│                                                         │    memoria + ││ │
│                                                         │    glosario  ││ │
│                                                         ├───────────────┤│ │
│                                                         │ 3. TTS        ││ │
│                                                         │    ElevenLabs ││ │
│                                                         │    v2 + voz  ││ │
│                                                         │    clonada   ││ │
│                                                         └──────┬────────┘│ │
│                                                                │         │ │
│                                                                ▼         │ │
│                                                          SyncBuffer      │ │
│  Webcam ──── MF SourceReader ──► Ring de delay ─────────►(audio delay    │ │
│  (hardware)  (shell nativo)      (delayMs)                2–6 s)         │ │
│                    │                  │                       │           │ │
│                    │                  ▼                       ▼           │ │
│                    │          Shared Memory           VirtualMic.write   │ │
│                    │    Global\VoxoraMeetVCamFrames   (driver WaveRT)    │ │
│                    │                  │                       │           │ │
│                    │                  ▼                       ▼           │ │
│                    │         VoxoraMeetVCam.dll      "VOXORA Meet        │ │
│                    │        (MF Virtual Camera)      Microphone"         │ │
│                    │                  │                       │           │ │
│                    │                  ▼                       ▼           │ │
│                    │         Google Meet / Zoom / Teams / Discord         │ │
│                    │         (seleccionar cámara y mic virtuales)         │ │
└─────────────────────────────────────────────────────────────────────────────┘
```

El shell nativo (C++ Win32 con WebView2) orquesta todo: lanza el motor Node (JSON-lines por
stdio), captura la webcam con Media Foundation, aplica el mismo `delayMs` al video con un ring de
frames, y escribe en la memoria compartida de la cámara virtual. El motor Node gestiona el audio
(VAD → STT → traducción → TTS → buffer de sincronía → mic virtual).

---

## Módulos

### `capture/` — Captura de micrófono y VAD

**Paquete:** `@voxora-meet/capture` · **Milestone:** M1 (DONE) · **Tests:** 32

Motor de adquisición de audio en tiempo real y segmentación por voz adaptativa.

#### Componentes

| Componente | Archivo | Descripción |
|---|---|---|
| `MicCapture` | `src/mic-capture.mjs` | Orquestador: lanza helper WASAPI o fuente inyectable, alimenta el segmentador, emite turnos y niveles |
| `PhraseSegmenter` | `src/phrase-segmenter.mjs` | Máquina de estados VAD pura: frames de 20 ms, piso de ruido adaptativo (percentil 30), Schmitt trigger con histéresis, attack/hangover, pre-roll, cortes suaves/duros |
| `Resampler` | `src/resample.mjs` | Resampleador con estado y filtro FIR sinc-Hamming de 47 taps para anti-aliasing |
| Helper WASAPI | `native/wasapi-capture.cpp` | Binario C++17: captura WASAPI en modo compartido con callback de evento, MMCSS, escritura zero-copy por stdout. Salida: PCM s16le mono 16 kHz |

#### API principal

```javascript
import { MicCapture } from '@voxora-meet/capture';

const mic = new MicCapture({ deviceId: null, sampleRate: 16000 });
mic.on('turn', ({ pcm, sampleRate, startedAt, endedAt, voicedMs, rmsDb, reason }) => { /* ... */ });
mic.on('level', ({ rmsDb, speaking, noiseFloorDb }) => { /* UI: ~20 Hz */ });
mic.start();
```

#### Algoritmo VAD

1. **Frames de 20 ms** (320 muestras a 16 kHz) → RMS → dBFS.
2. **Piso de ruido adaptativo**: ventana deslizante de 5 s, percentil 30, slew-rate limitado
   (sube ≤ 1 dB/s, baja ≤ 6 dB/s).
3. **Umbral dual (Schmitt)**: apertura = `clamp(noiseFloor + 12 dB, -45, -24)`;
   cierre = apertura − 4 dB.
4. **Attack** (120 ms de voz sostenida para abrir) y **hangover** (300 ms de silencio para cerrar).
5. **Pre-roll** (200 ms): ring buffer que preserva consonantes iniciales.
6. **Endpointing**: silencio de 700 ms cierra el turno; corte suave en pausas ≥ 250 ms cerca de
   `maxTurnMs` (15 s); corte duro al llegar a 15 s.
7. **Rechazo de ruido**: turnos con menos de 250 ms de voz se descartan.

#### Supervisión del helper

Reinicio automático con backoff exponencial (500 ms → 8 s, factor 2). Si el helper corre más de
10 s se resetea el backoff. Máximo de intentos configurable (por defecto infinito).

---

### `pipeline/` — STT, traducción y TTS

**Paquete:** `@voxora-meet/pipeline` · **Milestone:** M2–M4 (DONE) · **Tests:** 81

Pipeline de doblaje que transforma turnos de habla en audio doblado con voz clonada. Ejecuta
tres etapas secuenciales con concurrencia pipelineada entre turnos (el STT del turno N+1 corre
mientras el TTS del turno N se ejecuta).

#### Etapa 1: STT — Groq Whisper

**Clase:** `GroqWhisperStt` · **Endpoint:** `POST /openai/v1/audio/transcriptions`

- Modelo por defecto: `whisper-large-v3` (turno completo, no chunks).
- Envía WAV in-memory con `verbose_json` para obtener segmentos con `no_speech_prob`.
- **Vocabulario custom** (`VocabularyStore`): nombres propios/jerga inyectados vía campo `prompt`
  de Whisper (≤ 224 tokens).
- **Detección de alucinaciones**: normaliza texto, compara contra patrones conocidos de Whisper
  (subtítulos de Amara, YouTube, frases cortas sospechosas), evalúa `no_speech_prob` (≥ 0.5),
  `avg_logprob` (< −1.0), y duración de voz confiable (< 160 ms). Descarta turnos sin voz.

#### Etapa 2: Traducción — Groq Chat Completions

**Clase:** `ContextTranslator` · **Endpoint:** `POST /openai/v1/chat/completions`

- Modelo por defecto: `openai/gpt-oss-120b` (configurable vía `VOXORA_MEET_GROQ_MODEL`).
- **Memoria conversacional**: últimos N turnos (8 por defecto, configurable 0–64) como mensajes
  alternos `user`/`assistant`.
- **Glosario persistente** (`GlossaryStore`): término → traducción fija o "no traducir".
- **Tono**: `formal`, `professional`, `neutral`.
- **Instrucciones de estilo** personalizadas.
- **Reasoning effort**: `low`/`medium`/`high` para gpt-oss, `none`/`default` para Qwen3.
  Asigna `max_completion_tokens` dinámicamente para dar presupuesto de razonamiento sin
  recortar la traducción.
- Limpieza automática de tags `<think>`, comillas envolventes y prefijos "Traducción:".

#### Etapa 3: TTS — ElevenLabs

**Clase:** `ElevenLabsTts` · **Endpoint:** `POST /v1/text-to-speech/{voice_id}`

- Modelo por defecto: `eleven_multilingual_v2` con voz clonada (IVC/PVC).
- Síntesis no-streaming (turno completo antes de sincronizar).
- **Cascada de formatos PCM**: `pcm_48000` → `pcm_44100` → `pcm_24000` según el tier de la
  cuenta ElevenLabs. Fallback a `mp3_44100_128` solo si se permite explícitamente.
- **Filtrado por capacidad del modelo**: `supportsStyle`, `supportsSpeakerBoost`,
  `supportsLanguageCode`, `supportsSpeed`, `stabilityPresets` (snapping a `[0, 0.5, 1]` en v3).
- Si ElevenLabs rechaza `language_code`, se reintenta sin él y se cachea la excepción.

#### Voice settings por defecto

| Parámetro | Valor | Rango |
|---|---|---|
| `stability` | 0.5 | 0–1 |
| `similarity_boost` | 0.75 | 0–1 |
| `style` | 0 | 0–1 |
| `speed` | 1 | 0.7–1.2 |
| `use_speaker_boost` | true | bool |

#### Clonación de voz (`VoiceOnboarding`)

- **IVC (Instant)**: ≥ 60 s de audio, ≥ 2 s por muestra, ≥ 16 kHz, ≤ 25 archivos, ≤ 10 MB.
  Resultado inmediato.
- **PVC (Professional)**: ≥ 30 min (recomendado 3 h), ≤ 1 GB por archivo. Entrenamiento
  asíncrono; `activatePending` verifica el estado y activa la voz al completar.

#### Stores persistentes

| Store | Uso | Backend |
|---|---|---|
| `GlossaryStore` | Glosario por usuario (término → traducción) | `JsonStore` (atómico, quarantine de JSON corrupto) |
| `VocabularyStore` | Keyterms para Whisper (≤ 200 términos, ≤ 80 chars) | `JsonStore` |
| `ProfileStore` | Voz, idiomas, tono, estilo por usuario | `JsonStore` |

---

### `sync-buffer/` — Cola de sincronía audio-video

**Paquete:** `@voxora-meet/sync-buffer` · **Milestone:** M5 (DONE) · **Tests:** 11 ·
**Dependencias externas:** 0

Motor de delay queue que sincroniza audio doblado con video retrasado para evitar desfase de
labios.

#### Funcionamiento

1. Retiene frames de cámara y audio original por `delayMs` (2000–6000 ms, configurable en
   caliente).
2. Espera el audio doblado (`DubResult`) del pipeline.
3. Al vencer el delay, libera un **stream PCM 48 kHz continuo** hacia el driver virtual y los
   frames correspondientes hacia la cámara virtual.
4. Si el doblaje no llegó a tiempo: silencio, audio original, o audio original atenuado −18 dB
   según `fallbackMode`.

#### Contabilidad exacta de muestras

No depende de la precisión de `setInterval`. Calcula muestras acumuladas exactas desde el
reloj monotónico:

$$\text{totalSamples} = \text{round}\left(\frac{(T_{wall} - T_{origin}) \times 48000}{1000}\right)$$

Esto garantiza 0 drift acumulado de muestras y un stream sin cortes hacia el driver WaveRT.

#### Manejo de drift

Si la traducción es más larga que el original (ej. español → alemán), el dub se extiende sin
time-stretching ni cambio de pitch. Los dubs siguientes se encadenan sin solapamiento.
Si el drift supera `maxDriftMs` (1500 ms), emite `drift-exceeded`. Cuando el hablante hace
pausa y los dubs se ponen al día, el drift vuelve a 0.

#### Cambios de delay en caliente

- **Sube**: la reproducción se congela (silencio, sin video) hasta que el reloj alcanza el
  nuevo target. Sin repetir frames ni saltos temporales.
- **Baja**: se saltan los frames/audio que quedaron por debajo del nuevo target. Se preserva el
  frame más reciente descartado si no hay ninguno en la ventana actual.

---

### `windows-camera/` — Cámara virtual (Media Foundation)

**Paquete:** `@voxora-meet/windows-camera` · **Milestone:** M6 (DONE) · **Tests:** 16 unitarios + E2E

Cámara virtual basada en la **Media Foundation Virtual Camera API** (`MFCreateVirtualCamera`).
Corre en modo usuario — **no requiere driver de kernel firmado**.

#### Binarios nativos

| Binario | Función |
|---|---|
| `VoxoraMeetVCam.dll` | COM In-Proc Server (IMFMediaSource). Se ejecuta dentro del Frame Server de Windows (`svchost.exe`, LocalService, Session 0). Formatos: NV12 y RGB32 a 1280×720 y 1920×1080 @ 30 fps. Compilado `/MT` (sin VC Redist) |
| `VoxoraMeetVCamHost.exe` | Registra la cámara con `MFCreateVirtualCamera` (lifetime = sesión, acceso = usuario actual). Escucha `stdin` para control (`ping`, `status`, `stop`). `--register-dll` para registro COM con elevación |
| `VoxoraMeetFrameWriter.exe` | Puente: lee frames RGBA por `stdin` (16 bytes header + payload) y los escribe en la memoria compartida via `FrameProducer` |
| `VoxoraMeetCameraTest.exe` | Test consumer con `IMFSourceReader`. `--list` (JSON de cámaras), `--probe` (inspección de shared memory), modo stream (clasifica frames: `pattern`/`fallback`/`other`) |

#### IPC: Shared Memory con seqlock

```
Producer (shell/writer) ──► Global\VoxoraMeetVCamFrames ──► DLL (Frame Server, Session 0)
                             Global\VoxoraMeetVCamFrameReady (evento)
```

- **Layout**: `SharedHeader` (64 bytes) + 3 slots de ~8.3 MB cada uno (1920×1080 RGBA).
  Total: ~25 MB.
- **Seqlock**: el productor marca `seqBegin` impar, escribe, marca `seqEnd = seqBegin`. El
  consumidor verifica antes y después de leer. Si hay colisión, usa el slot anterior.
- **DACL permisivo** para cruzar de Session 1+ (usuario) a Session 0 (LocalService):
  `D:(A;;GA;;;WD)(A;;GA;;;LS)(A;;GA;;;AC)S:(ML;;NW;;;LW)`.
- **Heartbeat**: `producerHeartbeat100ns` (QPC). Si no se actualiza en 2 s, la DLL muestra una
  **imagen de espera** animada ("VOXORA MEET — ESPERANDO VIDEO" con barra pulsante) en vez de
  congelarse.

#### E2E tests

`npm run test:camera-e2e` prueba tres escenarios reales:
1. Consumer primero → fallback → producer → patrón → producer para → fallback.
2. Producer primero (host detenido) → writer espera → host arranca → patrón (NV12 y RGB32).
3. Host muere → mapping sobrevive en kernel → host reinicia → DLL se reconecta al mapping
   existente sin que el producer necesite reiniciar.

---

### `windows-driver/` — Micrófono virtual (driver WaveRT de kernel)

**Milestone:** M0 (IN PROGRESS) — driver compilado, pendiente firma EV y atestación.

Driver de audio virtual de clase **WaveRT** en modo kernel. Crea dos dispositivos:
- **"VOXORA Meet Speaker"** (salida/render) — donde la app escribe el audio doblado.
- **"VOXORA Meet Microphone"** (entrada/captura) — lo que selecciona el usuario en Meet.

El audio escrito en Speaker se refleja internamente hacia Microphone (loopback).

#### ¿Por qué un driver de kernel?

Un APO (Audio Processing Object, modo usuario) solo puede modificar audio de un endpoint
**existente**. No puede crear un dispositivo de micrófono nuevo. WaveRT es la única vía para
que aparezca "VOXORA Meet Microphone" en cualquier app (Meet, Zoom, Discord, etc.), y es lo
que usan VB-Cable y Voicemeeter.

#### Build sin instalar el WDK

```
cd windows-driver
build-driver.cmd
```

Usa WDK 10.0.26100.6584 de NuGet (descarga automática a `.wdk/`). Compila con `/W4 /WX` y
Code Analysis limpios, `infverif /h` VALID, `Inf2Cat` OK. Produce `out/cab/voxorameet.cab`
listo para firmar.

#### Firma del driver

La firma la hace **Microsoft** (firma por atestación en Partner Center), no nuestro certificado.
Requisitos:
1. Certificado **EV** Code Signing (el actual es OV → no alcanza para registrarse).
2. Registrarse en el Hardware Developer Program.
3. Firmar el `.cab` con el EV y enviarlo a Partner Center.

**Mientras tanto**: la app detecta y usa VB-Cable automáticamente como fallback. Para probar el
driver propio: VM con `testsigning` + Driver Verifier.

---

### `billing/` — Créditos VOX y medición de sesión

**Paquete:** `@voxora-meet/billing` · **Milestone:** M7 (DONE) · **Tests:** 13

Perfil de costos para reuniones: convierte consumo de proveedores (audio Whisper, tokens LLM,
caracteres TTS) en créditos VOX enteros.

#### Conversión

- **1 USD = 100 VOX** con margen del 50% (factor 1.5).
- Cualquier consumo > 0 cuesta **al menos 1 VOX** (anti-zero).

#### Precios de proveedores

| Proveedor | Modelo | Precio |
|---|---|---|
| Groq STT | `whisper-large-v3` | $0.111/h de audio |
| Groq STT | `whisper-large-v3-turbo` | $0.040/h de audio |
| Groq LLM | `openai/gpt-oss-120b` | $0.15/$0.60 por 1M tokens (in/out) |
| Groq LLM | `llama-3.3-70b-versatile` | $0.59/$0.79 por 1M tokens |
| ElevenLabs | `eleven_multilingual_v2` | $0.18/1k chars (×1.0) |
| ElevenLabs | `eleven_flash_v2_5` | $0.09/1k chars (×0.5) |

#### `SessionMeter`

`EventEmitter` que acumula costos por turno en tiempo real:
- Emite `cost` en cada turno, `warn` una vez al llegar al umbral (80% por defecto), `limit` una
  vez al llegar al tope.
- `voxPerMinute()`: burn rate observado para proyectar minutos restantes.
- `canAfford(vox)`: verifica si queda presupuesto antes de procesar un turno.

---

### `app/` — Motor Node + Shell nativo + UI

**Paquete:** `@voxora-meet/app` · El módulo que integra todo.

#### `app/engine/` — Motor headless (Node ≥ 22, ESM, sin deps)

Proceso Node que recibe y responde comandos por JSON-lines sobre stdio:

```
Petición:  { id, cmd, params }
Respuesta: { id, ok, result | error: { code, message } }
Evento:    { event, data }
```

**Comandos principales** (v1–v3):

| Comando | Descripción |
|---|---|
| `session.start` / `session.stop` | Iniciar/detener doblaje |
| `settings.get` / `settings.set` | Lectura/escritura de ajustes |
| `devices.list` | Cámaras, mics, endpoints de audio, mic virtual |
| `delay.set` | Cambiar delay en caliente (2000–6000 ms) |
| `voices.list` / `voice.set` / `voice.clone` | Gestión de voces |
| `models.list` | Catálogo en vivo de modelos STT/traducción/TTS (caché 10 min) |
| `cost.estimate` | Estimación de costo por hora según modelos actuales |
| `tts.preview` | Preview de la voz (gasta caracteres) |
| `glossary.get` / `glossary.set` | Glosario persistente (≤ 500 entradas) |
| `vocabulary.get` / `vocabulary.set` | Vocabulario STT (≤ 200 términos) |
| `stats.get` | Métricas de la sesión en curso |

**Eventos**: `level`, `transcript`, `translation`, `dub`, `stats`, `cost`, `warn`, `limit`,
`status`, `error`.

#### `app/native-shell/` — VoxoraMeet.exe (C++17, Win32 + WebView2)

App nativa de Windows que:
- Muestra la UI en WebView2 (HTML/CSS/JS vanilla sobre host virtual `https://app.voxora-meet/`).
- Lanza y supervisa el motor Node (JSON-lines por stdio; si muere, lo relanza con backoff
  1→3→10→30→60 s, hasta 5 caídas; botón "Reiniciar motor" después).
- Captura la webcam con MF SourceReader (RGB32, 1280×720@30).
- Aplica **efectos de imagen en caliente** (espejo, volteo, rotación 0/90/180/270, aspecto 16:9
  o 9:16, zoom 1–2×, pan, brillo, contraste, saturación, temperatura) en una sola pasada por
  pixel con tablas y LUT precalculadas (1.1–3.8 ms/frame en Ryzen 5 3400G).
- Mantiene un ring de frames con delay (0 en vivo, `delayMs` en sesión).
- Publica en la memoria compartida de la cámara virtual.
- Detecta dispositivos en caliente (WM_DEVICECHANGE + IMMNotificationClient, debounce 600 ms).
- Graba pruebas MP4 ("Grabar prueba") capturando exactamente lo que recibe Meet (video de la
  cámara virtual + audio del mic virtual con WASAPI + MF SinkWriter H.264/AAC).
- Gestiona la grabación de muestras de voz para clonación (WAV PCM, corte a 100 s/~10 MiB).
- Actualización automática con verificación de firma Authenticode.
- Instancia única (mutex); cerrar oculta en bandeja.

**Ventana**: 1200×780, mínimo 960×640, per-monitor DPI v2, tema claro lavanda `#F7F5FF`,
Mica en Windows 11.

#### `app/ui/` — Interfaz (HTML/CSS/JS vanilla)

Sigue el design system **VØXORA Live «Vocal Glass»**: lienzo lavanda con orbes pastel, tarjetas
de vidrio blanco con blur, tokens del design system importados literalmente. Fuentes locales
(Inter, Space Grotesk, JetBrains Mono). Sin frameworks ni CDN. CSP estricto.

**Dos modos:**

| Modo | Descripción |
|---|---|
| **Simple** | Una sola pantalla en tres pasos: (1) Vista previa + cámara/mic/voz, (2) Idiomas + Iniciar, (3) Subtítulos en vivo |
| **Avanzado** | 7 pestañas: Reunión, En vivo, Cámara, Modelos, Traducción, Voz, Ajustes |

**Sin scroll de página** en ningún modo ni pestaña (verificado de 960×640 a 1200×780). Solo
scroll interno en tarjetas con contenido largo.

**Mock para diseño**: `ui/index.html` en cualquier navegador usa `js/mock.js` con URL params
(`?mock=ready|fresh|down|offline|gone|v2&mode=simple|advanced&tab=...`).

---

## Requisitos

| Requisito | Versión |
|---|---|
| **Windows** | 10 2004+ (build 19041) o Windows 11 |
| **Node.js** | ≥ 22 (fetch y WebSocket globales, ESM, test runner nativo) |
| **MSVC** | Visual Studio 2022 con C++17 (para compilar nativos) |
| **WebView2 Runtime** | Evergreen (preinstalado en Windows 11) |
| **Groq API Key** | Para STT y traducción |
| **ElevenLabs API Key** | Para TTS y clonación de voz |
| **VB-Cable** (temporal) | Mic virtual mientras el driver WaveRT no esté firmado |

---

## Desarrollo

```bash
# Tests de todos los módulos JS (node --test, sin deps)
npm test

# Compilar helpers nativos, cámara virtual y shell (MSVC + Windows SDK)
npm run build:native

# E2E real de la cámara virtual (DLL registrada; fuera de npm test)
npm run test:camera-e2e

# Validar API keys de Groq y ElevenLabs
npm run check:providers

# Smoke test del pipeline con proveedores reales
# (~60 chars de ElevenLabs; --no-tts para evitarlo)
npm run smoke:pipeline

# Iniciar la app
npm start

# Release completo (build → firma → layout ofuscado → instalador → firma → verify)
npm run release

# Probar el actualizador contra un canal HTTP local
npm run test:update-flow

# Publicar al canal S3 (sin --dry-run sube de verdad)
npm run publish:release -- --dry-run
```

### Tests por módulo

| Módulo | Tests | Tiempo |
|---|---|---|
| `capture/` | 32 (segmenter: 14, mic-capture: 8, resample: 10) | ~460 ms |
| `pipeline/` | 81 (wav: 5, http: 8, stt: 9, translate: 9, tts: 10, stores: 7, onboarding: 9, pipeline: 10, model-settings: 14) | ~1.7 s |
| `sync-buffer/` | 11 | ~260 ms |
| `windows-camera/` | 16 | (mock, cualquier OS) |
| `billing/` | 13 | (rápido) |
| **Total** | **153+** | **< 5 s** |

### Compilar solo el shell nativo

```bash
cd app\native-shell
build.cmd    # llama vcvars64.bat si hace falta; NMake + CMake ≥ 3.20
```

Sale `app\native-shell\bin\VoxoraMeet.exe`. Compila sin warnings con `/W4`. Runtime estático
de MSVC (`/MT`).

> **Tip**: con la app abierta, renombrar `VoxoraMeet.exe` a `VoxoraMeet.run.exe` antes de
> compilar. Windows permite renombrar un exe en ejecución; el nuevo se usa al reabrir.

---

## Contratos entre módulos

Fuente de verdad completa: [`docs/CONTRACTS.md`](docs/CONTRACTS.md).

### capture → pipeline

```javascript
// MicCapture emite 'turn':
{ pcm: Buffer,       // s16le mono 16 kHz
  sampleRate: 16000,
  startedAt: number,  // performance.now()
  endedAt: number,
  voicedMs: number,
  rmsDb: number }
```

### pipeline → sync-buffer

```javascript
// DubbingPipeline.processTurn(turn) → Promise<DubResult | null>
{ audioDub: Buffer,          // s16le mono
  sampleRate: 24000|44100|48000,
  sourceTimestamp: turn.startedAt,
  sourceEndedAt: turn.endedAt,
  readyAt: number,
  transcript: string,
  translation: string,
  cost: { stt, translate, tts, totalVox } }
```

### sync-buffer → entrega Windows

- **Video**: el shell nativo escribe frames en `Global\VoxoraMeetVCamFrames` → DLL MF Virtual
  Camera → Google Meet.
- **Audio**: `VirtualMic.write(pcm)` → "VOXORA Meet Speaker" (render) → driver WaveRT refleja
  hacia "VOXORA Meet Microphone" (captura) → Google Meet.

### shell ↔ motor (JSON-lines)

Petición `{ id, cmd, params }`, respuesta `{ id, ok, result | error: { code, message } }`,
eventos `{ event, data }`. Cerrar stdin del motor = apagado limpio.

Protocolo completo (v1–v3) con todos los comandos, eventos, ajustes de modelos, imagen de
cámara y errores codificados en [`docs/CONTRACTS.md`](docs/CONTRACTS.md).

---

## Configuración y ajustes

Los ajustes se guardan en `%APPDATA%\VOXORA Meet\settings.json`. Las API keys en
`provider-keys.dpapi` (DPAPI CurrentUser).

### Ajustes principales

| Clave | Default | Descripción |
|---|---|---|
| `delayMs` | 3000 | Delay audio+video (2000–6000 ms) |
| `sourceLanguage` / `targetLanguage` | `es` / `en` | Idiomas |
| `tone` | `professional` | Tono de traducción |
| `fallbackMode` | `silence` | Qué emitir si el dub no llega (`silence`/`original`/`duck`) |
| `voiceId` / `voiceName` | — | Voz de ElevenLabs |
| `virtualMicDevice` | — | Endpoint de render para el mic virtual |
| `monitorDevice` | `''` | Escucha local del doblaje |
| `cameraAlwaysOn` | `true` | Cámara virtual activa mientras la app esté abierta |
| `uiMode` | `simple` | Modo de interfaz (`simple`/`advanced`) |

### Ajustes de modelos (protocolo v3)

| Clave | Default | Rango |
|---|---|---|
| `sttModel` | `whisper-large-v3` | id Groq con "whisper" |
| `sttTemperature` | 0 | 0–1 |
| `translateModel` | `openai/gpt-oss-120b` | id chat de Groq |
| `translateTemperature` | 0.2 | 0–1 |
| `translateReasoningEffort` | `low` | `low`\|`medium`\|`high`\|`none`\|`default` |
| `memoryTurns` | 8 | 0–64 |
| `ttsModel` | `eleven_multilingual_v2` | id ElevenLabs |
| `ttsStability` | 0.5 | 0–1 |
| `ttsSimilarityBoost` | 0.75 | 0–1 |
| `ttsStyle` | 0 | 0–1 |
| `ttsSpeed` | 1 | 0.7–1.2 |

### Ajustes de imagen de la cámara

| Clave | Default | Rango |
|---|---|---|
| `camMirror` / `camFlip` | `false` | bool |
| `camRotation` | 0 | 0\|90\|180\|270 |
| `camAspect` | `16:9` | `16:9`\|`9:16` |
| `camZoom` | 1 | 1–2 |
| `camPanX` / `camPanY` | 0 | −1…1 |
| `camBrightness` / `camContrast` | 0 | −1…1 |
| `camSaturation` / `camTemperature` | 0 | −1…1 |

---

## Firma de código

Detalle completo: [`docs/SIGNING.md`](docs/SIGNING.md).

### Binarios de la app (Authenticode)

Certificado SSL.com eSigner, `CN=Mateo Piza Ruiz`, thumbprint
`F105226E95107920D137D7E761C605F0EF30933B`. Clave en HSM de SSL.com (eSigner CKA). No hay
`.pfx`.

```bash
npm run build:native    # compilar primero
npm run sign            # firma lo que no esté firmado por nosotros
npm run sign -- --force # re-firma todo
```

**OTP manual**: eSigner abre una ventana por cada firma para el OTP de la app autenticadora.
8 firmas en total (7 binarios internos + instalador), 36 s entre firmas. Hay que estar frente
al PC con la app VOXORA Meet cerrada.

### Driver de kernel

Lo firma **Microsoft** (atestación en Partner Center). Requiere certificado **EV** Code Signing
(el actual es OV → pendiente comprar EV Sole Proprietor en SSL.com).

---

## Release, instalador y publicación

Detalle completo: [`docs/RELEASE.md`](docs/RELEASE.md).

### Generar una versión

1. Subir `"version"` en `package.json` (única fuente).
2. Cerrar VOXORA Meet.
3. `npm test` en verde.
4. `npm run release` (acepta `--no-build`, `--no-sign`, `--no-verify`).

### Pipeline de release

| Paso | Qué hace |
|---|---|
| **build** | `build-native.mjs`: helpers, cámara virtual, shell, desinstalador, `vxpack` |
| **layout** | `dist/VOXORA-Meet-<v>/`: binarios + engine.mjs (esbuild + javascript-obfuscator) + UI ofuscada + Node LTS portable (verificado con SHASUMS256) |
| **sign interno** | `sign.mjs` firma los binarios del layout (antes de empaquetar) |
| **package** | `vxpack` comprime con LZMS + SHA256, embebido en `VoxoraMeetSetup.exe` |
| **sign instalador** | Firma el `.exe` final |
| **verify** | `verify-release.mjs`: layout limpio, JS ofuscado, sin credenciales, VERSIONINFO, motor arranca, UI carga, firmas correctas |

### El instalador

`VoxoraMeetSetup.exe` (C++ + WebView2, identidad VØXORA):

| Modo | Uso |
|---|---|
| (sin args) | Asistente: Bienvenida → Licencia → Ubicación → Progreso → Listo |
| `/S [/D=<dir>] [/relaunch]` | Silencioso (actualizaciones) |
| `/uninstall [/S] [/purge]` | Desinstalar |
| `/extract <dir>` | Solo extraer y verificar |
| `/preview` | Recorrer la UI sin instalar |

### Publicar (canal S3)

```bash
npm run publish:release -- --dry-run           # todo menos subir
npm run publish:release -- --notes-file n.md   # sube de verdad
```

Sube: instalador (inmutable) → historial JSON → `latest.json` (sin caché). Se niega a publicar
sin firma, versión menor que la publicada, o misma versión con otro archivo.

---

## Auto-actualización

En la app (`app/native-shell/src/updater.cpp`):

1. A los 30 s de abrir y luego cada 6 h, lee `latest.json` del canal.
2. Si hay versión mayor: descarga en `%LOCALAPPDATA%\VOXORA Meet\updates\`.
3. Verifica tamaño + SHA256 + Authenticode (WinVerifyTrust + thumbprint nuestro).
4. Avisa en la UI. Nunca durante una sesión de doblaje.
5. Al aceptar: re-verifica, lanza instalador elevado con `/S /relaunch`, se cierra.

Variables de prueba: `VOXORA_UPDATE_FEED`, `VOXORA_UPDATE_ALLOW_UNSIGNED=1`,
`VOXORA_UPDATE_DISABLE=1`, `VOXORA_UPDATE_DELAY_MS`, `VOXORA_UPDATE_INTERVAL_MS`.

`npm run test:update-flow` prueba el actualizador contra un servidor HTTP local con escenarios:
al día, sin firma, firma de otro emisor, SHA256 alterado, 404, obligatoria, URL relativa, y
descarga del instalador real.

---

## Prueba E2E en Google Meet

Detalle completo: [`docs/E2E-MEET-CHECKLIST.md`](docs/E2E-MEET-CHECKLIST.md).

### Prerrequisitos (una sola vez)

1. Driver de audio instalado y firmado (o VB-Cable).
2. Cámara virtual registrada (`VoxoraMeetVCamHost.exe --register-dll`).
3. API keys válidas + voz clonada (≥ 60 s de muestras).
4. Binarios compilados (`npm run build:native`).
5. `npm run test:camera-e2e` en verde.

### Procedimiento

1. VOXORA Meet → elegir mic, webcam, idioma, tono, delay 3 s → Start.
2. Chrome → `meet.google.com` → Audio: "VOXORA Meet Microphone"; Video: "VOXORA Meet Camera".
   Desactivar cancelación de ruido de Meet.
3. Segundo participante graba la reunión.

### Criterios de aceptación

| Criterio | Umbral |
|---|---|
| Sincronía labios-audio | ≤ 300 ms |
| Integridad de turnos | ≥ 95% dobladas |
| Naturalidad de voz | ≥ 4/5 en escucha ciega |
| Drift | ≤ 500 ms, `lateDubs` ≤ 5% |
| Costo vs. estimación | ≤ 20% desviación |
| Estabilidad | 45 min sin incidentes |

---

## Decisiones cerradas

| Área | Decisión | Alternativa descartada | Motivo |
|---|---|---|---|
| STT | **Groq** (`whisper-large-v3`, turno completo, vocab custom) | — | Mismo proveedor que Plugin OBS, mayor contexto por turno |
| Traducción | **Groq** (`openai/gpt-oss-120b`, memoria + glosario + tono) | — | Razonamiento, consistencia terminológica |
| TTS | **ElevenLabs** (`eleven_multilingual_v2`, voz clonada IVC/PVC) | `eleven_v3` | Mayor costo/latencia sin necesidad comprobada |
| Mic virtual | **WaveRT kernel driver** | APO (modo usuario) | APO no puede crear dispositivo nuevo |
| Cámara virtual | **MF Virtual Camera API** (modo usuario) | DirectShow filter (kernel) | Sin driver firmado, SDK moderno |
| Shell | **C++ Win32 nativo + WebView2** | Electron | Sin Chromium bundled, menor footprint |
| UI | **HTML/CSS/JS vanilla** | React/Vue | Sin deps de build para la UI, CSP estricto |

---

## Decisiones abiertas

- Empaquetado del runtime Node del motor (node portable dentro del instalador vs. requisito
  externo).
- Certificación HLK completa del driver (hoy: solo firma por atestación).

---

## Estructura de archivos

```
05 VOXORA Meet/
├── capture/                    Mic WASAPI + VAD por frase (M1)
│   ├── src/                    mic-capture.mjs, phrase-segmenter.mjs, resample.mjs
│   └── native/                 wasapi-capture.cpp → bin/wasapi-capture.exe
├── pipeline/                   STT → Traducción → TTS (M2–M4)
│   └── src/
│       ├── stt/                groq-whisper.mjs
│       ├── translate/          groq-translate.mjs
│       ├── tts/                elevenlabs.mjs
│       ├── stores.mjs          GlossaryStore, VocabularyStore, ProfileStore
│       ├── voice-onboarding.mjs
│       ├── dubbing-pipeline.mjs
│       └── util/               wav.mjs, http.mjs, languages.mjs
├── sync-buffer/                Cola de delay audio+video (M5)
│   └── src/                    sync-buffer.mjs, resampler.mjs
├── windows-camera/             Cámara virtual MF (M6)
│   ├── src/                    virtual-camera.mjs (Node API)
│   ├── scripts/                e2e-camera.mjs
│   └── native/
│       ├── common/             vcam_shared.h, frame_producer.h
│       ├── vcam-source/        VoxoraMeetVCam.dll (IMFMediaSource)
│       ├── vcam-host/          VoxoraMeetVCamHost.exe
│       ├── frame-writer/       VoxoraMeetFrameWriter.exe
│       └── test-consumer/      VoxoraMeetCameraTest.exe
├── windows-driver/             Driver WaveRT de kernel (M0)
│   ├── src/                    driver C (miniport, topology, loopback)
│   ├── build-driver.cmd        Build con WDK de NuGet (sin instalar)
│   └── out/                    cab/, package/, symbols/
├── billing/                    Créditos VOX (M7)
│   └── src/                    index.mjs (precios, estimaciones, SessionMeter)
├── app/
│   ├── engine/                 Motor Node headless (JSON-lines)
│   │   ├── engine.mjs          Proceso principal
│   │   ├── protocol.mjs        Servidor JSON-lines
│   │   ├── session-controller.mjs
│   │   └── settings-store.mjs  %APPDATA%\VOXORA Meet\settings.json
│   ├── native-shell/           VoxoraMeet.exe (C++17 Win32 + WebView2)
│   │   ├── src/                main.cpp, webview_host, camera_capture,
│   │   │                       device_watcher, vcam_host, audio_capture,
│   │   │                       video_effects, test_recording, updater, ...
│   │   ├── res/                app.rc, voxora-meet.ico
│   │   └── third_party/        WebView2 SDK (vendorizado)
│   └── ui/                     HTML/CSS/JS vanilla (design system VØXORA)
│       ├── index.html, styles.css, app.js
│       ├── js/                 models.js, mode.js, nav.js, live.js, mock.js, ...
│       ├── tokens/             Copia de project/tokens (design system)
│       ├── fonts/              Inter, Space Grotesk, JetBrains Mono (.woff2)
│       └── assets/             logo.svg, isotipo.svg, favicon
├── native-common/              voxora_version.h / .rc (fuente: package.json)
├── installer/                  VoxoraMeetSetup.exe (C++ + WebView2)
├── scripts/                    build, sign, release, publish, verify, smoke, ...
├── docs/
│   ├── APP-SHELL.md            Documentación completa del shell nativo y la UI
│   ├── CONTRACTS.md            Contratos entre módulos (fuente de verdad)
│   ├── E2E-MEET-CHECKLIST.md   Checklist de prueba en reunión real (M8)
│   ├── RELEASE.md              Release, instalador, publicación
│   ├── SIGNING.md              Firma de código (Authenticode y driver)
│   └── VIDEO-SYNC.md           Sincronía de video en el shell nativo
├── dist/                       Builds generados
├── package.json                Raíz del monorepo (workspaces)
├── PROJECT.md                  Alcance, decisiones, milestones
└── README.md                   ← este archivo
```

---

## Documentación detallada

| Documento | Contenido |
|---|---|
| [`PROJECT.md`](PROJECT.md) | Alcance del proyecto, features, milestones y decisiones |
| [`docs/CONTRACTS.md`](docs/CONTRACTS.md) | Contratos entre módulos, protocolo JSON-lines (v1–v3), ajustes de modelos e imagen |
| [`docs/APP-SHELL.md`](docs/APP-SHELL.md) | Shell nativo (WebView2, puente UI↔motor, comandos nativos, dispositivos, imagen de cámara, grabar prueba, ventana, empaquetado) |
| [`docs/VIDEO-SYNC.md`](docs/VIDEO-SYNC.md) | Sincronía de video, ring de frames, memoria compartida |
| [`docs/RELEASE.md`](docs/RELEASE.md) | Pipeline de release, instalador, publicación, auto-actualización |
| [`docs/SIGNING.md`](docs/SIGNING.md) | Firma Authenticode y firma del driver por atestación |
| [`docs/E2E-MEET-CHECKLIST.md`](docs/E2E-MEET-CHECKLIST.md) | Checklist y criterios de aceptación para prueba E2E en Meet real |

---

## Logs y diagnóstico

- `%LOCALAPPDATA%\VOXORA Meet\logs\`:
  - `shell.log` (rota a 2 MiB, 5 archivos; incluye stderr del motor)
  - `engine.log` (rotado)
  - `installer.log` (actualizaciones silenciosas)
  - `crash-shell-*.dmp` (minidump si el shell cae; se conservan 5)
- **Acerca de → Abrir carpeta de registros** en la app.
- Si el motor muere, el shell lo relanza con backoff (1, 3, 10, 30, 60 s) y lo avisa en la UI.
  Tras 5 caídas: botón "Reiniciar motor".

---

## Milestones

| # | Nombre | Status |
|---|--------|--------|
| **M0** | Driver de audio virtual Windows | 🟡 IN PROGRESS — compilado, pendiente firma EV + atestación |
| **M1** | Captura + VAD por frase | ✅ DONE — 32 tests |
| **M2** | STT de alta exactitud | ✅ DONE — verificado con audio real |
| **M3** | Traducción con contexto | ✅ DONE — verificado con proveedor real |
| **M4** | Voz clonada | ✅ DONE — TTS real verificado |
| **M5** | Buffer de sincronía | ✅ DONE — 11 tests |
| **M6** | Cámara virtual Windows | ✅ DONE — DLL + host + writer + E2E |
| **M7** | Perfil de costos | ✅ DONE — 13 tests |
| **M8** | Integración E2E en Meet real | ⬜ TODO — requiere driver firmado |
