# @voxora-meet/capture

Captura de micrófono para VOXORA Meet (Milestone M1): audio WASAPI → **turnos de habla completos**
cerrados por silencio (endpointing), no ventanas fijas. Cumple el contrato `capture → pipeline` de
`../docs/CONTRACTS.md`.

ESM, Node ≥ 22, sin dependencias externas. Tests: `npm test` (`node --test`).

## Uso

```js
import { MicCapture } from "@voxora-meet/capture";

const devices = await MicCapture.listDevices(); // [{ id, name, default }]
const mic = new MicCapture({ deviceId: devices.find((d) => d.default)?.id });
mic.on("turn", ({ pcm, sampleRate, startedAt, endedAt, voicedMs, rmsDb }) => { /* → STT */ });
mic.on("level", ({ rmsDb, speaking }) => { /* UI, ~20 Hz */ });
mic.on("error", console.error);
mic.start();
// ...
mic.stop(); // cierra el turno en curso (flush) y mata el helper
```

Fuente inyectable para tests u otras capturas: `new MicCapture({ source })`, donde `source` es un
`Readable` de PCM s16le mono 16 kHz.

## Módulos

- `src/phrase-segmenter.mjs` — `PhraseSegmenter`, clase pura sin I/O. `push(buffer, nowMs)` con PCM
  s16le 16 kHz; frames de 20 ms → RMS dB → compuerta adaptativa (piso de ruido por percentil 30 % de
  los últimos 5 s, margen de apertura 12 dB, histéresis 4 dB, attack 120 ms, hangover 300 ms) →
  endpointing: cierra tras `endSilenceMs` (700) de silencio, descarta turnos con menos de
  `minTurnMs` (250) de voz, fuerza corte en `maxTurnMs` (15000) prefiriendo una pausa débil en los
  últimos `softCutWindowMs` (3000), conserva `preRollMs` (200) antes de la voz y `tailSilenceMs`
  (200) después. `flush()` cierra el turno en curso. Emite `turn` y `level`.
- `src/mic-capture.mjs` — `MicCapture extends EventEmitter`. Sin `source`, lanza
  `native/bin/wasapi-capture.exe --rate 16000 [--device <id>]` y lee PCM de su stdout; si el
  helper muere lo relanza con backoff exponencial (500 ms → 8 s, se reinicia tras 10 s estable).
  `MicCapture.listDevices()` ejecuta `--list`.
- `src/resample.mjs` — `Resampler` (con estado, por chunks) y `resamplePcm16(buf, from, to)`:
  interpolación lineal con FIR antialias (sinc-Hamming, 47 taps) al bajar la tasa. Para
  48 k → 16 k y 16 k → 24/48 k (TTS).
- `native/wasapi-capture.cpp` — helper C++17 WASAPI modo compartido, event-driven, MMCSS. Pide al
  motor `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | SRC_DEFAULT_QUALITY` (mono s16le a la tasa pedida);
  si el driver lo rechaza captura en el formato de mezcla y convierte él mismo. stdout = PCM crudo,
  stderr = líneas JSON de diagnóstico (`ready`, `error`, `stopped`). Códigos de salida: 1 args,
  2 inicialización, 3 dispositivo invalidado, 4 E/S.

## Compilar el helper

Desde un "Developer Command Prompt" (o tras `vcvars64.bat`), MSVC 14.5x + Windows SDK 10.0.26100:

```
cd native && build.cmd        # → native\bin\wasapi-capture.exe
```

Enlaza `ole32.lib avrt.lib ksuser.lib`. `wasapi-capture.exe --list` imprime los endpoints de
captura activos en JSON.
