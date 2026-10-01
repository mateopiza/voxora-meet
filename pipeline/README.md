# @voxora-meet/pipeline

Motor de doblaje de voz en tiempo real para **VOXORA Meet** (Milestones M2, M3 y M4).

Transforma turnos de habla de entrada en audio doblado de alta calidad con voz clonada:
$$\text{Audio PCM (16 kHz)} \xrightarrow{\text{STT (Groq Whisper)}} \text{Texto} \xrightarrow{\text{Traducción (Groq LLM)}} \text{Traducción} \xrightarrow{\text{TTS (ElevenLabs)}} \text{Audio PCM Doblado}$$

Implementa el contrato `pipeline → sync-buffer` definido en [`docs/CONTRACTS.md`](../docs/CONTRACTS.md).

---

## Características

- **STT de alta fidelidad (Groq Whisper `whisper-large-v3`)**:
  - Procesa turnos completos enviados como WAV en memoria.
  - Inyección de vocabulario personalizado y jerga técnica vía parámetro `prompt` (hasta ~224 tokens).
  - Filtro avanzado de alucinaciones de Whisper: descarta segmentos con `no_speech_prob \ge 0.5`, log-probabilidad degradada (< -1.0) o subtítulos residuales comunes (subtítulos Amara, YouTube, etc.).
- **Traducción con contexto conversacional (Groq Chat)**:
  - Modelo por defecto: `openai/gpt-oss-120b` (configurable por entorno o interfaz).
  - Ventana deslizante de memoria conversacional (8 turnos por defecto) manteniendo roles `user`/`assistant` para coherencia de pronombres y términos elípticos.
  - Inyección de glosarios terminológicos persistentes por usuario (`GlossaryStore`) con reglas de "mantener sin traducir" o "traducción obligatoria".
  - Control de tono (`professional`, `formal`, `neutral`) e instrucciones de estilo personalizadas.
  - Soporte de esfuerzo de razonamiento (`reasoning_effort`: `low`, `medium`, `high` en gpt-oss; `none`, `default` en Qwen3) con ampliación automática de `max_completion_tokens`.
- **Síntesis y clonación de voz (ElevenLabs)**:
  - Modelo por defecto: `eleven_multilingual_v2` con voces clonadas (IVC/PVC).
  - Cascada de formatos PCM: solicita `pcm_48000` $\to$ degrada a `pcm_44100` $\to$ `pcm_24000` según el plan de la cuenta.
  - Adaptación automática de parámetros según el modelo (`supportsStyle`, `supportsSpeakerBoost`, `supportsLanguageCode`, `stabilityPresets` en v3).
- **Onboarding de voz (`VoiceOnboarding`)**:
  - Instant Voice Cloning (IVC): validación de $\ge 60$ s de audio, $\ge 2$ s por muestra, $\ge 16$ kHz. Sustitución atómica de voz previa.
  - Professional Voice Cloning (PVC): validación de $\ge 30$ min, subida por chunks y activación diferida asíncrona (`activatePending`).
- **Concurrencia en pipeline por turnos (`StageQueue`)**:
  - Cada etapa corre con concurrencia 1 en orden FIFO: el STT del turno $N+1$ se ejecuta en paralelo con el TTS del turno $N$.
- **Almacenamiento atómico persistente (`JsonStore`)**:
  - Escrituras atómicas mediante archivo temporal y renombrado en disco.
  - Aislamiento y cuarentena automática de archivos corruptos (`.corrupt-<timestamp>`).

---

## Estructura

```
pipeline/
├── package.json
├── README.md
└── src/
    ├── index.mjs             # Exportación principal
    ├── dubbing-pipeline.mjs  # Orquestador DubbingPipeline y colas de etapa
    ├── stores.mjs            # GlossaryStore, VocabularyStore, ProfileStore, JsonStore
    ├── voice-onboarding.mjs  # Servicio de validación y clonación IVC/PVC
    ├── stt/
    │   └── groq-whisper.mjs  # Cliente Groq Whisper + filtros de alucinación
    ├── translate/
    │   └── groq-translate.mjs# Cliente Groq Chat con memoria y glosario
    ├── tts/
    │   └── elevenlabs.mjs    # Cliente ElevenLabs TTS + VoiceCloning
    └── util/
        ├── http.mjs          # fetchWithRetry (backoff con jitter, Retry-After, timeout)
        ├── languages.mjs     # Normalización y nombres de idiomas ISO 639-1
        └── wav.mjs           # Parser y escritor RIFF/WAVE s16le en memoria
```

---

## Tests

```bash
npm test -- "pipeline/**/*.test.mjs"
```

---

## Licencia

VOXORA Community & Fair Source License v1.0 (gratuita para uso personal/académico; requiere licencia comercial para startups y empresas). Consulta [`LICENSE`](../LICENSE).
