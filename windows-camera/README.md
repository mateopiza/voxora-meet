# windows-camera — Cámara virtual "VOXORA Meet Camera"

Milestone **M6** de VOXORA Meet. Cámara virtual de Windows construida sobre la **Media Foundation
Virtual Camera API** (`MFCreateVirtualCamera`): corre en modo usuario, no necesita driver de kernel ni
firma, y aparece como cámara normal en Google Meet (Chrome), Zoom, Teams y Discord.

```
Node (sync-buffer) ──writeFrame(rgba)──▶ VoxoraMeetFrameWriter.exe ──▶ memoria compartida
                                                                            │  Global\VoxoraMeetVCamFrames
VoxoraMeetVCamHost.exe ──MFCreateVirtualCamera──▶ FrameServer (svchost) ◀───┘  + evento FrameReady
                                                   └─ carga VoxoraMeetVCam.dll (IMFMediaSource)
                                                              └─▶ Chrome / Meet / Zoom / Teams
```

## Componentes

| Binario | Carpeta | Rol |
|---|---|---|
| `VoxoraMeetVCam.dll` | `native/vcam-source/` | DLL COM con el media source (`IMFMediaSource` + `IMFMediaSourceEx` + `IMFGetService` + `IKsControl` + `IMFSampleAllocatorControl`) y un `IMFMediaStream2` que produce NV12 y RGB32 a 1280x720 @ 30 fps. Lee frames NV12 (shell) o RGBA (FrameWriter, shell anterior) del ring compartido y entrega cada muestra al llegar el evento «frame listo»; sin productor emite "VOXORA MEET — ESPERANDO VIDEO". |
| `VoxoraMeetVCamHost.exe` | `native/vcam-host/` | Registra la cámara (`MFCreateVirtualCamera`, tipo `SoftwareCameraSource`, `Lifetime_Session`, `Access_CurrentUser`), hace `Start` y se queda vivo leyendo comandos por stdin (`ping`, `status`, `stop`). También `--register-dll` / `--unregister-dll` (equivalente a regsvr32, requiere elevación) y `--check-registered`. |
| `VoxoraMeetFrameWriter.exe` | `native/frame-writer/` | Productor: lee frames RGBA crudos por stdin (cabecera binaria de 16 bytes `{u32 width, u32 height, u64 timestampMs}` + píxeles) y los publica en la memoria compartida, señalando el evento. Evita un addon nativo en Node. Usa el productor común `native/common/frame_producer.h`, el MISMO que el shell (`VoxoraMeet.exe`). |
| `VoxoraMeetCameraTest.exe` | `native/test-consumer/` | Consumidor de prueba E2E: enumera cámaras MF (`--list`), inspecciona la memoria compartida (`--probe`) o abre «VOXORA Meet Camera» con `IMFSourceReader` en NV12/RGB32 nativo y clasifica cada frame (patrón de prueba / imagen de espera / otro) en JSON por línea. |
| `src/virtual-camera.mjs` | `src/` | `VirtualCamera` (ESM, Node ≥ 22, sin deps): `isSupported()`, `isRegistered()`, `register()`, `start()`, `writeFrame()`, `stop()`, eventos `status` / `log` / `error`. |

Contrato binario compartido: `native/common/vcam_shared.h` (cabecera `{ magic, version, width, height,
format, frameSeq, writeIndex, timestamp100ns, heartbeat, consumerCaps }` + ring de 3 slots de hasta
1920x1080 en RGBA8 o NV12 (`native/common/nv12.h`; NV12 solo si la DLL lo anuncia en `consumerCaps`),
cada slot con seqlock `seqBegin/seqEnd`).

## Requisitos

- **Windows 10 2004 (build 19041) o superior**; Windows 11 recomendado. `VirtualCamera.isSupported()`
  comprueba la versión y el host comprueba además `MFIsVirtualCameraTypeSupported`.
- Para compilar: Visual Studio 2022/2026 con MSVC (probado con 14.51) y **Windows SDK ≥ 10.0.22000**
  (`mfvirtualcamera.h`; probado con 10.0.26100). CMake es opcional (`build.cmd` cae a `cl.exe` directo).
- Runtime: ninguno adicional. Los tres binarios se enlazan con CRT estático (`/MT`) porque la DLL se
  carga en `svchost.exe`, donde no se puede asumir el VC redistributable.

## Compilar

Desde un "x64 Native Tools Command Prompt" (o tras `call vcvars64.bat`):

```bat
cd windows-camera\native
build.cmd            rem Release por defecto; build.cmd Debug / build.cmd --no-cmake
```

Salida en `native/bin/`: `VoxoraMeetVCam.dll`, `VoxoraMeetVCamHost.exe`, `VoxoraMeetFrameWriter.exe`,
`VoxoraMeetCameraTest.exe`.
Desde Node: `npm run build:native --workspace windows-camera`.

## Registro (una sola vez, con elevación)

El FrameServer instancia el media source por CLSID (`{7A1E5C3B-0F4D-4B8A-9C2E-3D6F1B8E5A70}`) desde
`HKLM\Software\Classes\CLSID\{...}\InprocServer32` (`ThreadingModel=Both`). Escribir en HKLM requiere UAC:

```bat
rem consola elevada:
VoxoraMeetVCamHost.exe --register-dll "C:\ruta\VoxoraMeetVCam.dll"
VoxoraMeetVCamHost.exe --check-registered      rem 0 = registrada (no requiere elevación)
VoxoraMeetVCamHost.exe --unregister-dll "C:\ruta\VoxoraMeetVCam.dll"
```

o desde Node, que lanza el host elevado con `Start-Process -Verb RunAs` (aparece el diálogo UAC):

```js
import { VirtualCamera } from '@voxora-meet/windows-camera';
const cam = new VirtualCamera();
if (!(await cam.isRegistered())) await cam.register(); // una vez por máquina
```

**Ubicación de la DLL:** la carga `svchost.exe` bajo la cuenta `NT AUTHORITY\LocalService`, que debe
tener permiso de lectura/ejecución sobre la ruta. Un directorio bajo `C:\Users\<usuario>\...` puede
denegárselo; instale la DLL en `%ProgramFiles%\VOXORA Meet\` o `%ProgramData%\VOXORA Meet\` y registre
esa ruta (`cam.register({ dllPath })`). Si se mueve la DLL hay que volver a registrar.

## Uso desde Node

```js
const cam = new VirtualCamera({ friendlyName: 'VOXORA Meet Camera' });
cam.on('status', ({ state, detail }) => console.log(state, detail ?? ''));
cam.on('log', ({ source, line }) => console.debug(`[${source}] ${line}`));
await cam.start();                       // host + writer; resuelve cuando ambos dicen READY
cam.writeFrame(rgba, 1280, 720, performance.now()); // RGBA top-down; false si se descarta
await cam.stop();
```

`writeFrame` aplica *backpressure*: si el stdin del writer aún no ha drenado, el frame se descarta
(`cam.stats.dropped`) en vez de acumular latencia. Frames válidos: dimensiones pares, ≤ 1920x1080,
`rgba.length === width*height*4`. Si el tamaño no coincide con el negociado por la app (720p), la
DLL lo escala (bilineal) con letterbox. Sin frames durante 2 s la cámara vuelve a la pantalla de espera.

Tests (sin binarios ni Windows, con `spawn`/`execFile` inyectados): `npm test --workspace windows-camera`.

## Verificar en Chrome / Google Meet

1. Con la DLL registrada, ejecute `VoxoraMeetVCamHost.exe` (o `cam.start()`); debe imprimir `READY`.
   La cámara existe mientras el host viva (`Lifetime_Session`).
2. `chrome://media-internals` → pestaña **Video Capture**: debe listarse "VOXORA Meet Camera" con los
   formatos 1280x720 @ 30 fps (NV12 y RGB32).
3. En Meet: Configuración → Vídeo → seleccionar "VOXORA Meet Camera". Sin productor se ve la pantalla
   "VOXORA MEET — ESPERANDO VIDEO" con la barra violeta animada; con `writeFrame` se ven los frames.
4. Alternativas rápidas: la app **Cámara** de Windows, `Get-CimInstance Win32_PnPEntity | ? Name -like '*VOXORA*'`
   en PowerShell, o Zoom/Teams/Discord (cualquier app que enumere cámaras vía FrameServer).

Si `MFCreateVirtualCamera` devuelve error (código de salida 5) casi siempre es CLSID no registrado o
DLL no accesible para LocalService; si `Start` falla (6), revise el Visor de eventos → *Microsoft-Windows-
MediaFoundation* y que el servicio "Windows Camera Frame Server" no esté deshabilitado.

## Prueba E2E real (`npm run test:camera-e2e`)

`windows-camera/scripts/e2e-camera.mjs` (no forma parte de `npm test`: necesita la DLL registrada y
ningún otro `VoxoraMeetVCamHost.exe` en marcha) lanza el host, el consumidor `VoxoraMeetCameraTest.exe`
y `VoxoraMeetFrameWriter.exe` alimentado con un patrón conocido (8 barras de color + contador binario
con su complemento) y comprueba, en frames reales entregados por el FrameServer:

- **A. consumidor primero**: imagen de espera sin productor → patrón con el contador avanzando al
  arrancar el productor → imagen de espera ≤ 2 s después de pararlo (latido QPC).
- **B. productor primero** (el orden del bug): host apagado por EOF en stdin, productor enviando
  frames sin mapping → host → el productor abre el mapping en cuanto la DLL lo crea → patrón en NV12
  y, tras cerrar y reabrir la cámara, en RGB32.
- **C. recarga de la DLL**: con el productor reteniendo el mapping se reinicia el host → la DLL reabre
  el mismo objeto y el consumidor ve el patrón sin que el productor reconecte.

`--verbose` muestra las líneas de cada proceso. Sale con 0 si todo pasa, 1 si falla algo, 2 si faltan
requisitos.

## Limitaciones conocidas

- **La DLL corre dentro del FrameServer (`svchost.exe`, LocalService, sesión 0), no en la app.** Por eso
  no puede depender de VOXORA, del runtime de Node ni del VC redist, ni acceder a la UI. Toda la
  comunicación va por memoria compartida con nombre `Global\` (un objeto `Local\` de la sesión de
  usuario es invisible desde la sesión 0). Crear un file mapping `Global\` requiere
  `SeCreateGlobalPrivilege`, que el proceso de usuario no tiene: por eso lo **crea la DLL** y los
  productores (writer y shell, `common/frame_producer.h`) solo lo **abren**, reintentando cada 500 ms
  mientras no exista — también mientras siguen llegando frames — y descartando frames entretanto.
  Medido: la DLL lo crea ≈0,6 s después de que el host haga `Start` (el FrameServer instancia la fuente
  aunque ninguna app mire) y lo suelta al parar el host; si un productor lo retiene, el objeto
  sobrevive y la DLL recargada reabre el mismo.
  Los objetos llevan DACL permisiva (`D:(A;;GA;;;WD)...`) y etiqueta de integridad baja.
- **`Lifetime_Session` vs `System`:** con `Session` la cámara desaparece al terminar el host (sin
  restos si la app muere) pero no está disponible antes de arrancarlo. `Lifetime_System` la haría
  persistente pero requiere `Access_AllUsers` y elevación al crearla, y deja la cámara registrada aunque
  VOXORA no esté; se descarta para M6.
- Registro en HKLM: **una vez, con UAC**. Sin registro el host termina con código 5.
- La DLL no expone propiedades de cámara (`IKsControl` responde `ERROR_SET_NOT_FOUND`); las apps que
  requieren controles (zoom/exposición) simplemente no los muestran.
- Sin D3D: los frames se producen en memoria de sistema. Con el shell (NV12) la DLL solo copia; con un
  productor RGBA convierte RGBA→NV12 en CPU (sin SIMD), unos pocos ms por frame 720p en un núcleo.
- Chrome cachea la lista de dispositivos: si la cámara se crea con Meet ya abierto puede hacer falta
  recargar la pestaña para que aparezca.
- Procesos con integridad *AppContainer* (apps UWP) ven la cámara pero, si además fueran productores,
  no podrían escribir en el mapping sin añadir su SID a la DACL.
