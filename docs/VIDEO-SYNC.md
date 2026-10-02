# Sincronía de video en el shell nativo

El `SyncBuffer` (JS, `sync-buffer/`) gestiona **solo la línea de tiempo de audio**: retiene el
original `delayMs`, mezcla doblaje/fallback y emite PCM 48 kHz continuo hacia `VirtualMic`.
`pushFrame()` existe y funciona (tests), pero el shell nativo **no lo usa**: pasar 1280×720 RGBA a
30 fps por el pipe JSON-lines sería inviable.

## Regla de presentación

Durante el doblaje, el motor informa el progreso del audio aceptado por la salida mediante eventos `presentation`. El shell usa ese progreso de fuente para seleccionar el frame correspondiente. El mensaje incluye una estimación de la cola y del padding nativos; no constituye una confirmación de reproducción física.

1. `CameraCapture` sella cada frame con su instante de captura (timestamp de Media Foundation, mismo reloj QPC; ~40 ms antes de que llegue) y conserva un historial acotado en NV12.
2. El reloj `AudioPresentation` transforma la edad y velocidad de la fuente en un instante objetivo de video, teniendo en cuenta el tránsito del mensaje en el shell. Rechaza valores inválidos y caduca las actualizaciones.
3. El publicador selecciona el frame disponible más cercano al objetivo. Conserva frames recientes para permitir que una traducción de duración diferente avance por el intervalo de fuente correspondiente.
4. Sin una actualización válida, el retraso nominal `delayMs` sirve como referencia. Fuera de la sesión, `cameraAlwaysOn` publica en vivo.
5. Los timestamps publicados siguen siendo monotónicos aunque el contenido seleccionado provenga de un frame anterior. Las métricas de desajuste y de frames ausentes permiten detectar límites del historial.

El historial llega hasta 7,5 s y tiene un presupuesto de 384 MiB: en NV12 (1,32 MiB por frame 720p) caben ~9,7 s a 30 fps, así que no se diezma la cadencia. Antes se guardaba RGBA (3,5 MiB) en 640 MiB y con `delayMs` ≥ ~4,6 s se retenía un frame de cada dos: Meet recibía 15 fps durante todo el doblaje (medido con la BRIO del equipo de desarrollo: 15,0 frames distintos/s con 5,9 s de retraso; ahora ~29). Se reutilizan buffers de píxeles para reducir asignaciones.

El publicador espera con un waitable timer de alta resolución hasta el instante exacto en que el siguiente frame pasa a ser elegible (captura + retraso, o lo que marque el reloj de audio) y, con retraso 0, se despierta al llegar cada frame. Antes sondeaba con `Sleep(16)`, que en Windows 11 dura ~31 ms: fase arbitraria respecto a la webcam y frames saltados o repetidos.

La estimación periódica de la cola introduce incertidumbre. Las pruebas del reloj y la compilación nativa pasaron; queda pendiente medir la sincronía labial en una reunión real. Este mecanismo no garantiza un desfase <=300 ms ni correspondencia fonética entre idiomas. Véase [el informe de audio](AUDIO-QUALITY-PLAN-2026-09-29.md).

## Memoria compartida hacia la cámara virtual

Layout y nombres según `windows-camera/native/common/vcam_shared.h` (`Global\VoxoraMeetVCamFrames`,
`Global\VoxoraMeetVCamFrameReady`, cabecera `SharedHeader` de 64 bytes + 3 slots con seqlock).
El shell escribe el frame liberado del ring en el slot siguiente con el productor común
`windows-camera/native/common/frame_producer.h` (el mismo que `VoxoraMeetFrameWriter.exe`) y lanza
`VoxoraMeetVCamHost.exe` al abrirse la app (`cameraAlwaysOn`) o al iniciar la sesión (sin él).

Formato del slot: **NV12** (BT.601 limitado, `common/nv12.h`) si la DLL anuncia `kConsumerCapNV12`
en `SharedHeader::consumerCaps` — lo que pide Chrome/Meet, así que la DLL lo copia sin convertir —
o **RGBA8** con una DLL anterior (campo a 0; el shell convierte). `camera.stats.outputFormat` dice cuál
se usa. La DLL entrega cada muestra al recibir el evento «frame listo» (la cadencia la marca la webcam,
no un timer propio con fase arbitraria) y solo anuncia 1280×720 (NV12 y RGB32): ampliar el lienzo a
1080p solo ablandaba la imagen y daba más píxeles que codificar.

El mapping lo crea la DLL (FrameServer, LocalService) ≈0,6 s después de que el host haga Start; el
shell no tiene `SeCreateGlobalPrivilege` y solo puede abrirlo, así que lo reintenta cada 500 ms
**siempre** que no lo tenga, lleguen o no frames. (El bug «Meet solo ve la imagen de espera»: el shell
lo intentaba una vez antes de lanzar el host y después solo en la rama sin frames, así que con la
webcam activa nunca se conectaba.) El latido (`producerHeartbeat100ns`) es QPC en 100 ns en ambos
lados: la DLL lo compara con `MFGetSystemTime()`, que es el mismo reloj (diferencia medida < 10 µs).
Lo cubre `npm run test:camera-e2e` (ver `windows-camera/README.md`).
