# @voxora-meet/billing

Perfil de costos y sistema de medición de consumo en créditos VOX para **VOXORA Meet** (Milestone M7).

Traduce el consumo de proveedores de IA (segundos de audio en Groq Whisper, tokens de Groq Chat y caracteres de ElevenLabs TTS) a créditos **VOX** enteros y controla el presupuesto de cada reunión.

Implementa el contrato de `billing` definido en [`docs/CONTRACTS.md`](../docs/CONTRACTS.md).

---

## Modelo de Créditos

- **Paridad base**: `1 USD = 100 VOX`.
- **Margen de servicio**: Factor de margen por defecto de `1.5` (+50% sobre el costo de proveedor).
- **Crédito mínimo por consumo**: Cualquier uso positivo real ($> 0$) cuesta **al menos 1 VOX** (anti-zero floor).
- **Enteros garantizados**: Todos los cobros se rediseñan y redondean hacia arriba a números enteros (`Math.ceil`) para evitar discrepancias por coma flotante.

$$\text{VOX} = \max\left(1, \left\lceil \text{Costo USD} \times \text{Margen (1.5)} \times 100 \right\rceil\right)$$

---

## Precios de Proveedores Soportados

### 1. Transcripción (Groq Whisper)
- `whisper-large-v3`: **$0.111** por hora de audio ($0.00003083 / s).
- `whisper-large-v3-turbo`: **$0.040** por hora de audio.
- Facturación mínima: **10 segundos** por solicitud según los términos de API de Groq.

### 2. Traducción (Groq Chat)
Precios por millón de tokens (Input / Output):
- `openai/gpt-oss-120b`: $0.15 in / $0.60 out.
- `openai/gpt-oss-20b`: $0.075 in / $0.30 out.
- `qwen/qwen3.6-27b`: $0.60 in / $3.00 out.
- `llama-3.3-70b-versatile`: $0.59 in / $0.79 out.
- *Nota*: Los tokens de razonamiento (*thinking*) se facturan como tokens de salida.

### 3. Síntesis y Voz Clonada (ElevenLabs)
- Base de referencia: **$0.18** por 1.000 caracteres (tier Pro/Scale).
- Multiplicador de modelo:
  - `eleven_multilingual_v2`, `eleven_v3`: **1.0x** ($0.18 / 1k caracteres).
  - `eleven_flash_v2_5`, `eleven_turbo_v2_5`: **0.5x** ($0.09 / 1k caracteres).

---

## Clase `SessionMeter`

Supervisa el consumo acumulado de una llamada en curso:
- **`add(cost)`**: Acumula los costos en VOX por etapa (`stt`, `translate`, `tts`, `totalVox`) y emite el evento `'cost'`.
- **Eventos de umbral**:
  - `'warn'`: Se emite una única vez cuando el consumo alcanza el umbral de advertencia (`warnAtVox`, 80% del límite por defecto).
  - `'limit'`: Se emite una única vez cuando se alcanza el tope máximo de la sesión (`maxVoxPerSession`).
- **`voxPerMinute()`**: Calcula la tasa de gasto (*burn rate*) observada en tiempo real.
- **`estimateRemainingMinutes()`**: Proyecta el tiempo restante de videollamada antes de agotar los créditos.
- **`canAfford(vox)`**: Comprueba si el presupuesto permite despachar un turno antes de procesarlo.

---

## Tests

```bash
npm test -- "billing/**/*.test.mjs"
```

---

## Licencia

VOXORA Community & Fair Source License v1.0 (gratuita para uso personal/académico; requiere licencia comercial para startups y empresas). Consulta [`LICENSE`](../LICENSE).
