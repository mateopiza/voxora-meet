# M8 — Prueba E2E en una reunión Google Meet real

La revisión del 2026-09-30 pasó pruebas locales y recorrido sintético por VB-Cable.
Eso no completa este checklist. Véase [evidencia y límites](AUDIO-QUALITY-PLAN-2026-09-29.md).
Añadir a la grabación: monitor apagado/encendido, auriculares/altavoces, los tres modos de fallback,
traducción tardía y desconexión de dispositivo. Verificar cero repeticiones por turno y registrar
`rejectedDubs`, colas, underruns y `presentationErrorMs`/`presentationMisses`.

Prerrequisitos (una sola vez, con elevación):
1. Driver de audio instalado y firmado (`windows-driver/installer/install.ps1`): en Configuración →
   Sonido deben aparecer "VOXORA Meet Speaker" (salida) y "VOXORA Meet Microphone" (entrada).
2. Cámara virtual registrada (`windows-camera`: `VoxoraMeetVCamHost.exe --register-dll`).
3. `npm run check:providers` en verde y voz clonada creada desde la app (≥60 s de muestras).
4. Binarios nativos compilados (`npm run build:native`).
5. `npm run test:camera-e2e` en verde (cámara virtual real: patrón por FrameServer en ambos órdenes;
   con VOXORA Meet cerrado, que si no su host ya tiene la cámara).

Procedimiento:
1. Abrir VOXORA Meet, elegir mic físico y webcam física, idioma destino, tono, delay 3 s. Start.
2. En Chrome, abrir `meet.google.com` → Configuración → Audio: micrófono = "VOXORA Meet Microphone";
   Video: cámara = "VOXORA Meet Camera". Desactivar cancelación de ruido de Meet (procesa la voz doblada).
3. Con un segundo participante (otra cuenta/dispositivo) grabar la reunión.

Criterios de aceptación:
| Criterio | Cómo medir | Umbral |
|---|---|---|
| Sincronía labios-audio | En la grabación, comparar el inicio de la frase doblada con el movimiento de labios del frame retrasado | desfase ≤ 300 ms |
| Integridad de turnos | Contar frases dichas vs. dobladas (panel "transcripción" de la app) | ≥ 95 % dobladas |
| Naturalidad de voz | Escucha ciega de 5 frases por 3 personas: ¿es la voz del usuario? | ≥ 4/5 en promedio |
| Latencia percibida | Delay configurado vs. `stats.driftMs` en la app durante 10 min | drift ≤ 500 ms, sin `lateDubs` > 5 % |
| Costo | `cost` acumulado en 10 min de conversación 50 % hablada vs. `estimateMeetingCost` | desviación ≤ 20 % |
| Estabilidad | 45 min de reunión sin reinicio del engine ni caída de dispositivos virtuales | 0 incidentes |

Registrar resultados en `docs/e2e-runs/<fecha>.md` (plantilla: contexto, tabla anterior con valores, incidencias).
