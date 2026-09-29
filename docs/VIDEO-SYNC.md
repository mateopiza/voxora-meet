# Sincronía de video en el shell nativo

El `SyncBuffer` (JS, `sync-buffer/`) gestiona **solo la línea de tiempo de audio**: retiene el
original `delayMs`, mezcla doblaje/fallback y emite PCM 48 kHz continuo hacia `VirtualMic`.
`pushFrame()` existe y funciona (tests), pero el shell nativo **no lo usa**: pasar 1280×720 RGBA a
30 fps por el pipe JSON-lines sería inviable.

## Regla

El shell (`app/native-shell`, `VoxoraMeet.exe`) aplica **el mismo `delayMs`** al video con un ring
de frames propio durante la sesión de doblaje. Fuera de ella (con `cameraAlwaysOn`, por defecto) la
cámara virtual sigue activa y el mismo ring publica **con retraso 0** (en vivo); al iniciar la sesión
el retraso pasa a `delayMs` y al detenerla vuelve a 0, sin cortar la cámara:

1. `CameraCapture` lee la webcam con `IMFSourceReader` (RGB32, 1280×720@30) y sella cada frame
   con `QueryPerformanceCounter` en el momento de captura.
2. Los frames entran en un ring (capacidad = `ceil(6 s × fps) + margen`, la cota superior del delay).
3. Un hilo de publicación, cada ~1/fps, publica en la memoria compartida el frame más nuevo cuyo
   `timestamp <= now - delayMs` (el mismo criterio que `SyncBuffer.tick`).
4. Cambios de delay en caliente siguen la misma política que el audio:
   - **sube** → no hay frame elegible durante la diferencia: se mantiene el último publicado
     (congelado), igual que el audio emite silencio;
   - **baja** → los frames más viejos se saltan y se publica el más nuevo elegible.
5. Ambas líneas de tiempo comparten el valor de `delayMs` porque el shell es quien lo fija: al mover
   el trackbar envía `delay.set` al motor **y** actualiza su ring en la misma llamada. El motor
   reporta el `delayMs` efectivo (clamp 2000–6000) en la respuesta y el shell lo adopta.

Reloj: el motor usa `performance.now()` (ms monotónicos, QPC por debajo); el shell usa QPC en
100 ns. No hace falta convertir entre ambos porque nunca se cruzan timestamps: cada lado retiene con
el mismo `delayMs` desde su propio instante de captura, y el audio y el video se capturan del mismo
instante real (mic y webcam del mismo hablante).

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
