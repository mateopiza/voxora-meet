# @voxora-meet/capture

Módulo de adquisición de audio de micrófono en tiempo real y segmentación adaptativa por voz (VAD) para **VOXORA Meet** (Milestone M1).

Implementa el contrato `capture → pipeline` definido en [`docs/CONTRACTS.md`](../docs/CONTRACTS.md).

---

## Características

- **Captura nativa de baja latencia**: Helper C++17 (`wasapi-capture.exe`) basado en Windows WASAPI en modo compartido con eventos (`AUDCLNT_STREAMFLAGS_EVENTCALLBACK`) y soporte MMCSS (`Pro Audio`).
- **Segmentación por turnos conversacionales completos**: Corta el flujo continuo de audio en turnos de habla delimitados por silencio (endpointing adaptativo), en lugar de ventanas de tiempo fijo arbitrarias.
- **VAD adaptativo con Schmitt Trigger**:
  - Seguimiento continuo del piso de ruido ambiente (percentil 30 en ventana de 5 s).
  - Slew-rate asimétrico: subida lenta (≤ 1 dB/s) para evitar que la voz contamine la referencia de ruido, y bajada rápida (≤ 6 dB/s) al callarse la sala.
  - Histéresis de 4 dB entre umbral de apertura y de cierre para evitar trepidación.
  - Tiempos de ataque (120 ms de voz sostenida) y hangover (300 ms de silencio).
- **Protección de consonantes iniciales**: Ring buffer de pre-roll de 200 ms que preserva los fonemas iniciales de cada frase.
- **Cortes inteligentes**:
  - Silencio de 700 ms cierra el turno normal.
  - Corte suave (*soft-cut*) en pausas $\ge 250$ ms al aproximarse al límite de turno (últimos 3 s antes de `maxTurnMs`).
  - Corte duro a los 15 s (`maxTurnMs`) con continuidad de fase sin pérdida de muestras entre turnos contiguos.
- **Resampleador FIR anti-aliasing**: Filtro FIR de 47 taps sinc-Hamming para conversiones de tasa de muestreo (ej. 48 kHz $\leftrightarrow$ 16 kHz).
- **Tolerancia a fallos**: Supervisión del proceso nativo con reinicio por retroceso exponencial (500 ms a 8 s) ante desconexión de dispositivos (`AUDCLNT_E_DEVICE_INVALIDATED`).

---

## Estructura

```
capture/
├── package.json
├── README.md
├── native/
│   ├── wasapi-capture.cpp   # Captura WASAPI en C++17 (stdout: PCM s16le 16kHz)
│   ├── build.cmd            # Compilación MSVC (cl.exe /O2 /MT)
│   └── version.rc           # Recursos de versión
└── src/
    ├── index.mjs            # Exportación principal
    ├── mic-capture.mjs      # Clase MicCapture (EventEmitter, ciclo de vida del helper)
    ├── phrase-segmenter.mjs # Máquina de estados VAD pura (sin dependencias nativas)
    ├── resample.mjs         # Resampleador s16le con filtro paso bajo
    └── test-signals.mjs     # Generadores de tonos, ruido y silencios para tests
```

---

## Uso

```javascript
import { MicCapture } from '@voxora-meet/capture';

const mic = new MicCapture({
  deviceId: null,       // null = dispositivo predeterminado del sistema
  sampleRate: 16000,
});

// Emite cada turno completo cerrado por silencio
mic.on('turn', ({ pcm, sampleRate, startedAt, endedAt, voicedMs, rmsDb, reason }) => {
  console.log(`Turno recibido (${voicedMs} ms de voz, cierre por ${reason}):`, pcm.length);
});

// Nivel de audio en tiempo real para VU-meter (~20 Hz)
mic.on('level', ({ rmsDb, speaking, noiseFloorDb }) => {
  // rmsDb: nivel en dBFS [-96, 0]
});

mic.on('error', (err) => console.error('Error de captura:', err));

mic.start();
```

---

## Tests

```bash
npm test -- "capture/**/*.test.mjs"
```

---

## Licencia

VOXORA Community & Fair Source License v1.0 (gratuita para uso personal/académico; requiere licencia comercial para startups y empresas). Consulta [`LICENSE`](../LICENSE).
