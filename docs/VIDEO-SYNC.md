# Sincronía de video en el shell nativo

El `SyncBuffer` (JS, `sync-buffer/`) gestiona **solo la línea de tiempo de audio**: retiene el
original `delayMs`, mezcla doblaje/fallback y emite PCM 48 kHz continuo hacia `VirtualMic`.
`pushFrame()` existe y funciona (tests), pero el shell nativo **no lo usa**: pasar 1280×720 RGBA a
30 fps por el pipe JSON-lines sería inviable.

## Regla de presentación

Durante el doblaje, el motor informa el progreso del audio aceptado por la salida mediante eventos `presentation`. El shell usa ese progreso de fuente para seleccionar el frame correspondiente. El mensaje incluye una estimación de la cola y del padding nativos; no constituye una confirmación de reproducción física.

1. `CameraCapture` sella los frames de la webcam con `QueryPerformanceCounter` y conserva un historial acotado.
2. El reloj `AudioPresentation` transforma la edad y velocidad de la fuente en un instante objetivo de video, teniendo en cuenta el tránsito del mensaje en el shell. Rechaza valores inválidos y caduca las actualizaciones.
3. El publicador selecciona el frame disponible más cercano al objetivo. Conserva frames recientes para permitir que una traducción de duración diferente avance por el intervalo de fuente correspondiente.
4. Sin una actualización válida, el retraso nominal `delayMs` sirve como referencia. Fuera de la sesión, `cameraAlwaysOn` publica en vivo.
5. Los timestamps publicados siguen siendo monotónicos aunque el contenido seleccionado provenga de un frame anterior. Las métricas de desajuste y de frames ausentes permiten detectar límites del historial.

El historial llega hasta 7,5 s y tiene un presupuesto de 640 MiB. Cuando es necesario, reduce la cadencia retenida para conservar el intervalo sin superar el presupuesto. Se reutilizan buffers de píxeles para reducir asignaciones.

La estimación periódica de la cola introduce incertidumbre. Las pruebas del reloj y la compilación nativa pasaron; queda pendiente medir la sincronía labial en una reunión real. Este mecanismo no garantiza un desfase <=300 ms ni correspondencia fonética entre idiomas. Véase [el informe de audio](AUDIO-QUALITY-PLAN-2026-09-29.md).

## Memoria compartida hacia la cámara virtual

Layout y nombres según `windows-camera/native/common/vcam_shared.h` (`Global\VoxoraMeetVCamFrames`,
`Global\VoxoraMeetVCamFrameReady`, cabecera `SharedHeader` de 64 bytes + 3 slots con seqlock,
RGBA8). El shell escribe el frame liberado del ring en el slot siguiente con el productor común
`windows-camera/native/common/frame_producer.h` (el mismo que `VoxoraMeetFrameWriter.exe`) y lanza
`VoxoraMeetVCamHost.exe` al abrirse la app (`cameraAlwaysOn`) o al iniciar la sesión (sin él).

El mapping lo crea la DLL (FrameServer, LocalService) ≈0,6 s después de que el host haga Start; el
shell no tiene `SeCreateGlobalPrivilege` y solo puede abrirlo, así que lo reintenta cada 500 ms
**siempre** que no lo tenga, lleguen o no frames. (El bug «Meet solo ve la imagen de espera»: el shell
lo intentaba una vez antes de lanzar el host y después solo en la rama sin frames, así que con la
webcam activa nunca se conectaba.) El latido (`producerHeartbeat100ns`) es QPC en 100 ns en ambos
lados: la DLL lo compara con `MFGetSystemTime()`, que es el mismo reloj (diferencia medida < 10 µs).
Lo cubre `npm run test:camera-e2e` (ver `windows-camera/README.md`).
