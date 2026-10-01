# Correcciones de audio: implementación y validación

Revisión inicial: 2026-09-29. Cierre local: 2026-09-30.
Alcance: exclusivamente `05 VOXORA Meet`. Cambios en código y binarios locales; no se publicó un instalador ni se cambió el driver instalado.

## Problema reproducido y corregido

Con `fallbackMode=original` o `duck` y `lateDubPolicy=play`, el búfer podía emitir primero el original y después la traducción tardía del mismo turno. La reproducción sintética inicial confirmó ambos contenidos. Con `silence`, que sigue siendo el valor predeterminado, no salía el original.

Ahora reserva cada turno desde el inicio de voz y mantiene silencio durante su procesamiento. Si ya emitió original, rechaza el doblaje posterior. También rechaza resultados repetidos, vencidos o que excedan la cola. Esto corrige el defecto reproducido en código; no identifica por sí solo la causa de la reunión reportada ni elimina eco acústico de altavoces.

## Cambios implementados

| Área | Implementación |
|---|---|
| Entrega única | Reservas desde VAD, identificación por sesión/inicio de turno, historial del original emitido y deduplicación. Cambiar el fallback no borra la decisión. |
| Rutas | Fija el ID de la entrada física; rechaza entradas virtuales conocidas y monitor igual a salida. Revalida dispositivos al refrescarlos. |
| Escrituras | Un consumidor asíncrono por destino; cola de 500 ms; espera de callback y drain; manejo de rechazo/cierre y timeout de 2 s. Monitor independiente. |
| Sobrecarga | Cuatro turnos/15 s de fuente pendientes; cola de doblajes de 15 s; reservas de 30 s. Pausas del scheduler mayores de 500 ms detienen la sesión con aviso. |
| Ciclo de vida | Cancela trabajos y audio pendiente al cerrar; descarta respuestas de sesiones cerradas; permite cancelar el inicio sin dejar captura abierta. |
| Captura | Original a 48 kHz; STT a 16 kHz con remuestreo con estado y filtro antialias. Maneja bytes impares entre bloques. |
| Calidad de salida | Remuestreo sinc para turnos TTS completos; envolvente de 3 ms en extremos, sin reiniciarla por bloque; saturación PCM. |
| Frases | Presupuesto basado en p95 de hasta 64 muestras; aviso si el delay es insuficiente; margen de 500 ms para encontrar una pausa antes del corte duro. |
| Rendimiento | No conserva/remuestrea original con fallback silencio; atenúa solo el rango copiado. |
| Helper nativo | Lee bytes disponibles con _read; cola de 500 ms; alineación de frames; cancelación del hilo al cerrar; telemetría de cola y underruns. |
| Video | Presentación ligada al progreso de fuente tras aceptar la escritura; historial acotado; timestamps de presentación monotónicos; métricas de desajuste. |

No se añadió AEC ni reducción de ruido agresiva sin evaluación de voz real. El monitor recomienda auriculares. La validación reconoce VOXORA Meet y VB-Cable, pero no puede inferir todas las conexiones de mezcladores externos ni «Escuchar este dispositivo» de Windows. El margen de frase tampoco garantiza evitar todos los cortes al hablar continuamente sin pausas.

## Verificación local

- Suite completa de Node: **255 pruebas aprobadas, cero fallos**; resultado final en `.cache/audio-test-results.txt`. Concurrencia 1 para evitar los timeouts de PowerShell/DPAPI observados con muchas pruebas simultáneas.
- Regresiones: original seguido de traducción, cambio de fallback, reserva desde inicio de voz, resultado repetido, vencimiento, rutas, consumidor lento, sobrecarga, rechazo asíncrono, monitor independiente y cancelación durante inicio.
- Calidad numérica: rechazo de alias fuera de banda, amplitud en banda de voz, continuidad con bloques impares y transiciones de extremos.
- Compilación MSVC de `wasapi-render.exe` y `VoxoraMeet.exe`: aprobada. No se modificó el driver de kernel.
- `audio_clock_selftest.exe`: ocho comprobaciones aprobadas.
- `smoke-audio-route.mjs`: aprobado con helper real y VB-Cable. Tres tonos enviados y tres recibidos, en orden y sin repetición: 440, 660 y 880 Hz. Ráfagas de 200 ms detectadas en ventanas de 220 ms (análisis en bloques de 20 ms). Nunca abre micrófono físico.

El aislamiento rechazó la apertura de captura con 0x80070057. Fuera del aislamiento funcionó. El análisis inicial por cruces de cero era sensible al ruido/dithering; se sustituyó por frecuencia dominante dentro de cada ráfaga, manteniendo criterios de duración y número de segmentos.

La última prueba reportó 3840 frames de underrun acumulados, incluyendo arranque y cola final. Este smoke acredita recorrido, orden y frecuencias, no continuidad sin underruns ni estabilidad de una reunión larga.

## Rendimiento medido

`node --expose-gc scripts/bench-audio.mjs --compare-head`, Node v24.19.0.
Simulación de 45 minutos de scheduler, sin proveedores ni espera de tiempo real:

| Métrica | HEAD anterior | Implementación |
|---|---:|---:|
| Tiempo de ejecución | 1945 ms | 1021 ms |
| CPU de Node | 2188 ms | 1171 ms |
| Original retenido con fallback silencio | 3000 ms | 0 ms |
| Máximo de doblajes pendientes | 2 | 2 |
| Muestras emitidas | 129600000 | 129600000 |

En esa ejecución el trabajo de CPU bajó aproximadamente 46%. Es una medición del búfer sintético, no de toda la aplicación ni de Meet. El incremento de heap retenido tras GC fue 178336 bytes en la referencia y 205952 en la implementación: no se acredita una reducción global de memoria.

## Comandos

```powershell
node --test --test-concurrency=1 "capture/**/*.test.mjs" "pipeline/**/*.test.mjs" "sync-buffer/**/*.test.mjs" "billing/**/*.test.mjs" "windows-camera/**/*.test.mjs" "app/**/*.test.mjs" "windows-driver/**/*.test.mjs" "scripts/**/*.test.mjs"
node --expose-gc scripts/bench-audio.mjs --compare-head
node scripts/smoke-audio-route.mjs
app/native-shell/build/tools/audio_clock_selftest.exe
```

## Límites y aceptación de producto pendiente

No se realizó una reunión de 45 minutos con otro participante ni escucha A/B de fidelidad, ruido o altavoces. Tampoco se acreditó el driver propio instalado/firmado, un nuevo instalador o el pipeline contra proveedores reales en este cierre. El smoke usa VB-Cable, ya instalado.

El video usa una estimación periódica de la cola nativa. Historial máximo: 7,5 s; presupuesto del ring: 640 MiB, con reducción de cadencia cuando hace falta conservar el intervalo. Si el frame solicitado ya no existe, las métricas lo señalan. No demuestra sincronía labial <=300 ms en Meet ni correspondencia fonética entre idiomas.

Para aceptación de producto, ejecutar [E2E-MEET-CHECKLIST.md](E2E-MEET-CHECKLIST.md): comparar monitor apagado/encendido y auriculares/altavoces; verificar cero repeticiones por turno, >=95% de turnos doblados, naturalidad >=4/5, desfase <=300 ms, deriva <=500 ms y 45 minutos estables. Son objetivos pendientes de medición.

Referencias: [contrapresión de Node.js](https://nodejs.org/api/stream.html#event-drain) e [inicialización WASAPI de Microsoft](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclient-initialize).
