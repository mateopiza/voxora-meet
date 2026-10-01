# @voxora-meet/sync-buffer

Motor de sincronización temporal y cola de retraso audio-video para **VOXORA Meet** (Milestone M5).

Retiene el audio original y los frames de cámara un tiempo configurable (`delayMs`, de 2000 ms a 6000 ms) para que el pipeline de IA pueda procesar la traducción sin producir desincronización de labios (*lipsync*).

Implementa el contrato `sync-buffer → entrega` definido en [`docs/CONTRACTS.md`](../docs/CONTRACTS.md).

---

## Características

- **Cero dependencias externas**: Implementado puramente en Node.js moderno (ESM, `node:events`, buffers tipados).
- **Modelo de Doble Línea Temporal**:
  - *Línea temporal fuente ($T_{src}$)*: Marcas de tiempo de captura de los frames de cámara y del micrófono.
  - *Línea temporal de reloj real ($T_{wall}$)*: Reloj monotónico del sistema (`performance.now()`).
  - *Objetivo de reproducción*: $\text{target} = T_{wall} - \text{delayMs}$.
- **Contabilidad Continua de Muestras (Anti-Drift)**:
  - No depende de la precisión de `setInterval`. Calcula acumulativamente las muestras exactas que deben emitirse:
    $$\text{totalSamples} = \text{round}\left(\frac{(T_{wall} - T_{origin}) \times 48000}{1000}\right)$$
  - Garantiza un flujo PCM a 48 kHz ininterrumpido sin micro-cortes, clics ni desincronización acumulativa hacia el driver WaveRT.
- **Sustitución de Audio y Prevención de Fugas**:
  - Al colocar un segmento doblado, silencia completamente el audio original en el rango de voz para evitar que la voz original del usuario se filtre o choque con la voz doblada.
- **Modos de Contingencia (`fallbackMode`)**:
  - `'silence'`: Emite silencio si el doblaje no llega a tiempo (recomendado para reuniones).
  - `'original'`: Emite la voz original si el doblaje no está listo.
  - `'duck'`: Emite la voz original atenuada en -18 dB (`DUCK_DB = -18`).
- **Control de Deriva (Drift) sin Alteración Tonal**:
  - Si la traducción es más larga que la frase original, extiende el segmento doblado y encadena las frases siguientes sin aplicar estiramiento temporal (*time-stretching*) artificial.
  - Notifica si el drift supera el umbral configurable `maxDriftMs` (1500 ms) mediante el evento `'drift-exceeded'`.
- **Ajuste de Delay en Caliente**:
  - *Al aumentar delay*: Congela la salida emitiendo silencio para que el nuevo umbral se alcance de forma natural sin saltos.
  - *Al reducir delay*: Descarta limpiamente el audio acumulado anterior al nuevo target preservando el frame de video más reciente.

---

## Estructura

```
sync-buffer/
├── package.json
├── README.md
├── src/
│   ├── sync-buffer.mjs   # Clase SyncBuffer (EventEmitter, planificador de ticks)
│   └── resampler.mjs     # Remuestreo lineal PCM s16le, cálculo de ganancia y ducking
└── test/
    └── sync-buffer.test.mjs # 11 pruebas unitarias completas
```

---

## Tests

```bash
npm test -- "sync-buffer/**/*.test.mjs"
```

---

## Licencia

VOXORA Community & Fair Source License v1.0 (gratuita para uso personal/académico; requiere licencia comercial para startups y empresas). Consulta [`LICENSE`](../LICENSE).
