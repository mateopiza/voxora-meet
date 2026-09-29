# VOXORA Meet

Doblaje profesional con voz clonada para videollamadas (Google Meet, Zoom, Teams). Prioriza
calidad y fidelidad de voz sobre latencia: el usuario habla en su idioma, y la reunión escucha
su propia voz clonada en el idioma destino, con video y audio sincronizados por un delay controlado.

Ver `PROJECT.md` (alcance, decisiones, milestones) y `docs/CONTRACTS.md` (contratos entre módulos).

## Módulos
| Carpeta | Qué hace | Milestone |
|---|---|---|
| `capture/` | Mic WASAPI (helper nativo) + VAD por frase (endpointing por silencio) | M1 |
| `pipeline/` | STT Groq Whisper → traducción Groq con contexto/glosario → TTS ElevenLabs voz clonada | M2–M4 |
| `sync-buffer/` | Línea de tiempo de audio con delay 2–6 s: doblaje, original o silencio | M5 |
| `windows-camera/` | Cámara virtual Media Foundation (DLL + host + memoria compartida) | M6 |
| `windows-driver/` | Driver WaveRT de kernel (mic virtual) + firma por atestación + helper de render | M0 |
| `billing/` | Créditos VOX del perfil "reunión" y límites por sesión | M7 |
| `app/` | `engine/` Node headless (JSON-lines) + `native-shell/` app Win32 C++ | — |

## Desarrollo
```
npm test                 # tests de todos los módulos JS (node --test, sin deps)
npm run build:native     # compila helpers, cámara virtual y shell (MSVC + Windows SDK)
npm run test:camera-e2e  # E2E real de la cámara virtual (DLL registrada; fuera de npm test)
npm run check:providers  # valida GROQ_API_KEY y ELEVENLABS_API_KEY
npm run smoke:pipeline   # STT→traducción→TTS con proveedores reales (gasta ~60 chars de ElevenLabs; --no-tts para evitarlo)
npm run release          # build → firma interna → layout ofuscado → instalador → firma → verify (--no-sign para probar)
npm run test:update-flow # actualizador real contra un canal HTTP local
npm run publish:release -- --dry-run   # canal S3 de MEGA (sin --dry-run sube)
```
Versiones, instalador, firma, publicación y cómo se comparte: `docs/RELEASE.md`.
El driver de kernel se compila con `windows-driver/build-driver.cmd` (WDK de NuGet, sin instalar nada; ver `windows-driver/README.md`). Prueba E2E: `docs/E2E-MEET-CHECKLIST.md`.
