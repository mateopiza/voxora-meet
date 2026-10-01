# Project: VOXORA Meet — Doblaje profesional para videollamadas (Google Meet)

Proyecto **nuevo e independiente** de `03 Plugin OBS`. No es un modo dentro del plugin de streaming:
es una app separada que reutiliza conceptos ya probados ahí (captura de audio, pipeline STT →
traducción → TTS, mic/cámara virtual) pero optimizada para el objetivo opuesto — **calidad y
fidelidad de voz por encima de latencia**, para reuniones profesionales por Google Meet.

## Por qué es un proyecto separado, no un modo del Plugin OBS
El pipeline de `03 Plugin OBS/dubbing-api` (Groq Whisper + Groq gpt-oss-120b + ElevenLabs
Flash/Turbo) está afinado para **latencia mínima en streaming en vivo** (Chaturbate/Stripchat):
ventanas cortas, un solo paso de traducción, voces genéricas rápidas. Meet necesita lo contrario:
ventanas largas, traducción con más razonamiento y memoria de contexto, voz clonada del usuario,
y sincronía labios-audio con delay controlado — un perfil de configuración no alcanza porque
también cambia la capa de entrega (cámara/mic virtual de Windows, no v4l2loopback/PulseAudio) y el
modelo de costos (créditos por minuto de reunión, no por stream).

## Arquitectura
- **Captura**: mic del usuario (Windows WASAPI) con VAD de frase completa (endpointing por
  silencio), no por ventana fija — más contexto por turno mejora STT y traducción.
- **STT (transcripción) — decidido: Groq (Whisper `whisper-large-v3`).** Se transcribe el turno
  completo (cerrado por VAD) vía REST con `verbose_json` para tener `no_speech_prob` por segmento y
  filtrar alucinaciones; el vocabulario custom (nombres propios, jerga) se inyecta por el campo
  `prompt`. Se reutiliza la misma key/proveedor que el Plugin OBS, con un perfil de mayor
  contexto por turno (frases completas, no chunks).
- **Traducción — decidido: Groq** (chat completions, modelo por defecto `openai/gpt-oss-120b`,
  configurable por `VOXORA_MEET_GROQ_MODEL`), con memoria de los últimos N turnos de la reunión para
  consistencia terminológica, glosario custom persistente por usuario y control de tono
  (formal/profesional).
- **TTS + clonación de voz — decidido: ElevenLabs `eleven_multilingual_v2`.** Voice cloning
  (Instant o Professional Voice Cloning) entrenado con muestras del usuario. Se descarta `eleven_v3`
  por ahora (mayor costo/latencia sin necesidad comprobada); si `v2` no alcanza en naturalidad se
  reevalúa más adelante.
- **Buffer de sincronía audio-video**: cola de delay configurable (2–6 s) que retiene tanto el
  frame de cámara como el audio original hasta que el doblaje esté listo, y libera ambos juntos a
  la capa de entrega — evita el desfase de labios que en streaming es invisible pero en una
  reunión profesional no lo es.
- **Entrega a Google Meet — driver propio de Windows** (decisión tomada: no depender de que el
  usuario tenga OBS abierto):
  - **Video**: Media Foundation Virtual Camera API (`MFCreateVirtualCamera` /
    `Windows.Media.Capture.Frames.FrameServer`, inbox desde Windows 10 2004/SDK 19041). Es la vía
    moderna de Windows para cámaras virtuales — corre en modo usuario, **no requiere un driver de
    kernel firmado**, a diferencia del filtro DirectShow clásico. Reduce muchísimo el costo de esta
    pieza frente a la alternativa antigua.
  - **Audio — decidido: driver de kernel clase WaveRT** (el mismo enfoque que usan VB-Cable y
    Voicemeeter). Se descarta la alternativa de Audio Processing Object (modo usuario) porque un
    APO solo puede modificar el audio de un endpoint **que ya existe**, no crear un dispositivo de
    micrófono nuevo — no sirve para el caso de uso (aparecer como "micrófono VOXORA Meet"
    seleccionable en Meet/Discord/Zoom/cualquier app). WaveRT en modo kernel es la única vía que
    logra eso de forma confiable, y es la más compatible/estable en la práctica aunque requiera
    firma: certificado EV + firma por atestación vía Windows Hardware Dev Center (no requiere
    certificación HLK completa para este tipo de driver, pero sí cuenta de partner y el
    certificado). Esto es la pieza de mayor costo/tiempo del proyecto — ver Milestone M0.

## Feature Inventory
| # | Feature | Descripción | Milestone |
|---|---------|-------------|-----------|
| 1 | Captura VAD por frase | Endpointing por silencio, ventanas largas en vez de chunks fijos | M1 |
| 2 | STT de alta exactitud | Integración Groq Whisper large-v3 (turno completo) + vocabulario custom | M2 |
| 3 | Traducción con contexto | Groq chat con memoria de N turnos + glosario persistente + control de tono | M3 |
| 4 | Voz clonada | Onboarding de clonación de voz (ElevenLabs IVC/PVC) + síntesis con `eleven_multilingual_v2` | M4 |
| 5 | Buffer de sincronía | Cola de delay configurable que sincroniza frame de cámara + audio doblado | M5 |
| 6 | Cámara virtual Windows | Integración Media Foundation Virtual Camera (modo usuario, sin driver firmado) | M6 |
| 7 | Micrófono virtual Windows | Driver de audio virtual propio (WaveRT, modo kernel) + firma por atestación | M0 (bloqueante) |
| 8 | Perfil de costos "reunión" | Tabla de créditos VOX propia para el modelo de este producto (STT/traducción/TTS más caros) | M7 |

## Milestones
| # | Nombre | Alcance | Dependencias | Status |
|---|--------|---------|---------------|--------|
| M0 | Driver de audio virtual Windows | Prototipo driver WaveRT (modo kernel), cuenta Hardware Dev Center, certificado EV, firma por atestación | ninguna | IN_PROGRESS — driver compilado sin instalar el WDK (`windows-driver/build-driver.cmd`, WDK 10.0.26100.6584 de NuGet; /W4 /WX y Code Analysis limpios, infverif /h VALID, Inf2Cat OK) y `out/cab/voxorameet.cab` listo para firmar; helper de render user-mode compilado. Pendiente: firma EV del .cab + atestación en Partner Center y validación en VM (testsigning + Driver Verifier) |
| M1 | Captura + VAD por frase | Endpointing por silencio en la app de captura | ninguna | DONE — helper WASAPI compilado y verificado con mic real; 31 tests |
| M2 | STT de alta exactitud | Integrar Groq Whisper large-v3 + vocabulario custom | M1 | DONE — verificado con audio y proveedor reales (`scripts/smoke-pipeline.mjs`) |
| M3 | Traducción con contexto | Integrar traducción Groq + memoria de turnos + glosario | M2 | DONE — verificado con proveedor real |
| M4 | Voz clonada | Flujo de clonación + integración TTS de calidad | ninguna (paralelo a M1-M3) | DONE — TTS real verificado (preview y sesión con VB-Cable); modelo y voice settings seleccionables desde la UI |
| M5 | Buffer de sincronía | Cola de delay video+audio | M3, M4 | DONE — audio en `sync-buffer/`, video en el shell nativo con el mismo delay |
| M6 | Cámara virtual Windows | Integración Media Foundation Virtual Camera | M5 | DONE (DLL + host + writer compilados y probados en proceso). Pendiente: registro con elevación y prueba en Chrome/Meet |
| M7 | Perfil de costos | Tabla de créditos + límites de uso para este producto | M2, M3, M4 | DONE — `billing/` |
| M8 (Final) | Integración E2E en Meet real | Probar en una reunión Google Meet real: audio+video sincronizados, calidad de voz aceptable | M0, M6, M7 | TODO — checklist en `docs/E2E-MEET-CHECKLIST.md`; requiere driver firmado e instalado |

## Interface Contracts
### Capa de captura ↔ Pipeline STT/Traducción/TTS
- Contrato de audio: PCM s16le, 16kHz hacia Groq Whisper (STT, como WAV por turno); el TTS devuelve PCM 24/44.1/48kHz.
- Unidad de trabajo: turno de habla completo (silencio detectado), no chunk de tiempo fijo.

### Pipeline ↔ Buffer de sincronía
- El pipeline emite `{ audioDub: Buffer, sourceTimestamp, readyAt }` por turno; el buffer decide
  cuánto retener el frame de cámara correspondiente a `sourceTimestamp` para liberarlo junto con
  `audioDub`.

### Buffer de sincronía ↔ Capa de entrega Windows
- Video: frames RGB/YUV crudos al Frame Server de Media Foundation.
- Audio: PCM al driver virtual (formato exacto a definir en M0 junto con el diseño del driver).

## Code Layout (a crear)
- `05 VOXORA Meet/capture/`: captura de mic + VAD por frase.
- `05 VOXORA Meet/pipeline/`: STT, traducción con contexto, TTS con voz clonada (puede reusar
  utilidades de `03 Plugin OBS/dubbing-api/src/pipeline.js` como referencia, no como dependencia
  directa — los perfiles de latencia son incompatibles).
- `05 VOXORA Meet/sync-buffer/`: cola de delay audio+video.
- `05 VOXORA Meet/windows-driver/`: driver de audio virtual WaveRT (modo kernel) + su instalador firmado.
- `05 VOXORA Meet/windows-camera/`: integración Media Foundation Virtual Camera.
- `05 VOXORA Meet/app/`: `engine/` (motor Node headless, JSON-lines por stdio) + `native-shell/` (app Win32 nativa C++: UI, bandeja, captura de webcam MF y ring de delay de video).
- `05 VOXORA Meet/billing/`: tabla de créditos VOX del perfil "reunión" y medidor de sesión.

## Decisiones cerradas
- STT: **Groq** (`whisper-large-v3`, turno completo por VAD, vocabulario custom vía `prompt`).
- Traducción: **Groq** (chat completions, `openai/gpt-oss-120b` por defecto, memoria + glosario + tono).
- TTS: **ElevenLabs `eleven_multilingual_v2`** con voz clonada (IVC/PVC).
- Driver de audio virtual: **WaveRT en modo kernel** (se descarta el enfoque APO, que no puede
  crear un dispositivo de micrófono nuevo).
- Cámara virtual: Media Foundation Virtual Camera API (modo usuario, sin driver firmado).
- Shell de la app: **nativo Windows** (C++ Win32, sin Chromium). El pipeline de IA corre en un
  motor Node headless (`app/engine/`) lanzado por el shell y controlado por JSON-lines sobre stdio;
  el shell es dueño del video (captura MF + delay) y el motor del audio (VAD → STT → traducción →
  TTS → buffer de sincronía → mic virtual). Ambos aplican el mismo `delayMs`.
- Licencia: **VOXORA Community & Fair Source License v1.0** (100% gratuita y libre para uso
  personal, individual, académico y proyectos de código abierto; startups, empresas y entidades
  con fines de lucro requieren Licencia Comercial expresa).
- Empaquetado del runtime Node: **Cerrado** (Node.js LTS portable oficial verificado con SHA256,
  alojado en `node/node.exe`, integrado con compresión LZMS propietaria `vxpack` dentro de `VoxoraMeetSetup.exe`).
- Canal de publicación y auto-actualización: **Cerrado** (Canal S3 en MEGA S4, comprobación
  anónima de `latest.json`, y verificación estricta de firma Authenticode con el thumbprint del titular en `updater.cpp`).

## Decisiones abiertas
- Certificación HLK completa del driver (hoy: solo firma por atestación mediante cuenta Partner Center y token EV).
- Activación de Public Read policy en el bucket de MEGA S4 para descargas directas anónimas.
