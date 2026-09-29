# windows-driver — Micrófono virtual de VOXORA Meet (`voxorameet.sys`)

Milestone **M0** (bloqueante). Cable de audio virtual para Windows 10/11 x64
con el mismo enfoque que VB-Cable: un driver de kernel **PortCls + WaveRT** que
expone dos endpoints de audio:

- **"VOXORA Meet Speaker"** (render): la app escribe aquí el doblaje (PCM).
- **"VOXORA Meet Microphone"** (captura): lo que Google Meet / Zoom / Discord
  seleccionan como micrófono. Recibe, con ~10–100 ms de latencia, todo lo que
  entra por el Speaker; silencio si nadie está rindiendo.

```
app (Node)  --PCM s16le 48k--> wasapi-render.exe --WASAPI--> [VOXORA Meet Speaker]
                                                                    |  voxorameet.sys
                                                                    |  buffer circular (kernel)
                                                                    v
Google Meet <------------------------- WASAPI -------------- [VOXORA Meet Microphone]
```

**Estado (2026-09-28):** el driver **compila** (Release y Debug, `/W4 /WX`,
Code Analysis del WDK limpio) con el WDK **10.0.26100.6584 descargado de NuGet**,
sin instalar nada en el sistema ni pedir administrador. El paquete de
Partner Center (`out\cab\voxorameet.cab`) está listo para **firmar con el token
EV**. Falta: firma EV + atestación, y probarlo en VM (nunca se ha cargado).

## Por qué WaveRT en kernel y no un APO

Un **APO** (Audio Processing Object, modo usuario) solo procesa el audio de un
endpoint **que ya existe**: no puede crear un dispositivo de micrófono nuevo, y
Meet necesita ver un micrófono seleccionable. Las únicas vías para crear un
endpoint de audio en Windows son un driver de kernel (PortCls/WaveRT, o AVStream
KS) o un driver Bluetooth/USB emulado; WaveRT es la vía estándar, sin DMA real
(el "hardware" es un buffer cíclico compartido con el motor de audio y una
posición virtual que avanza con el reloj del sistema), es lo que usan VB-Cable
y Voicemeeter y es compatible con pull-mode/event-driven de WASAPI. El coste es
la **firma** (certificado EV + atestación en Partner Center): ver `signing/`.

## Arquitectura del driver (`src/`)

| Archivo | Contenido |
|---|---|
| `adapter.cpp` | `DriverEntry` → `PcInitializeAdapterDriver` (encadena el `DriverUnload` que instala PortCls); `AddDevice` → `PcAddAdapterDevice`; `StartDevice` crea el objeto común (`CVoxoraAdapter`: buffer de loopback + volumen/mute), instala los 4 subdispositivos (`WaveSpeaker`, `TopologySpeaker`, `WaveMicrophone`, `TopologyMicrophone`) y registra las conexiones físicas wave↔topología. `PnpHandler` libera el objeto común en `IRP_MN_REMOVE_DEVICE`. `operator new/delete` de kernel sobre `ExAllocatePool2`. |
| `minwavert.cpp/.h` | `CMiniportWaveRT` (render o capture según flag): descriptor de filtro (pin host + pin puente, nodo DAC/ADC, categorías AUDIO+RENDER/CAPTURE+REALTIME), `DataRangeIntersection`, `KSPROPERTY_PIN_PROPOSEDATAFORMAT`. `CMiniportWaveRTStream`: `AllocateAudioBuffer`/`AllocateBufferWithNotification` (páginas propias vía `IPortWaveRTStream::AllocatePagesForMdl` + `MapAllocatedPages`), `GetPosition` (posición virtual por `KeQueryPerformanceCounter`), `SetState`, `GetClockRegister`/`GetPositionRegister` → `STATUS_NOT_IMPLEMENTED`, `RegisterNotificationEvent` (pull mode). Timer `KeSetTimerEx` 10 ms + DPC que mueve audio entre el buffer cíclico y el loopback y dispara los eventos. |
| `mintopo.cpp/.h` | `CMiniportTopology`: pin `KSNODETYPE_SPEAKER` / `KSNODETYPE_MICROPHONE` con nombre propio, nodos `KSNODETYPE_VOLUME` (-60..0 dB, 0.5 dB, por canal) y `KSNODETYPE_MUTE`, `KSPROPERTY_JACK_DESCRIPTION(2)` "siempre conectado". Así el panel de sonido lo clasifica como micrófono y muestra el slider de volumen. |
| `loopback.cpp/.h` | `CLoopbackBuffer`: anillo float32 estéreo 48 kHz en pool no paginado NX con `KSPIN_LOCK`; conversión s16↔float, mono↔estéreo, remuestreo lineal 16–48 kHz; descarta lo más antiguo si nadie lee y acota la latencia a 100 ms. |
| `common.h` | Constantes (formatos, tags, nombres de subdispositivo, índices de pins), interfaz interna `IVoxoraAdapter` y declaración de los `operator new/delete`. |
| `guids.h` | GUIDs propios: nombres de pin (`KSNAME_VOXORA_*`, registrados en `MediaCategories` por el INF) e `IID_IVoxoraAdapter`. |
| `voxorameet.rc` | Recurso de versión (`ntverp.h` + `common.ver`); la versión llega de `build-driver.cmd`. |

Formatos aceptados en los pins de streaming: PCM s16le y IEEE float32, 1–2
canales, 16 000–48 000 Hz (`KSDATARANGE_AUDIO` con rango). La intersección
propone 48 kHz estéreo. Internamente todo se normaliza a 48 kHz.

Estados: `STOP → ACQUIRE → PAUSE → RUN`. En `RUN` se sube la resolución de
timer (`ExSetTimerResolution` 10 ms) y arranca el timer periódico; `PAUSE`/`STOP`
lo cancelan (`KeCancelTimer` + `KeFlushQueuedDpcs`). `STOP` pone la posición a 0.

## Build sin instalar el WDK (`build-driver.cmd`)

Requisitos: Visual Studio 2026 (o 2022) con *Desarrollo de escritorio con C++*
(MSVC 14.5x; verificado con **14.51.36231**), `curl.exe`/`tar.exe` de Windows
10+ e Internet la primera vez. **No** hace falta el WDK instalado, ni
administrador, ni la extensión WDK de Visual Studio.

```powershell
# PowerShell / cmd
.\build-driver.cmd                         # Release (+ .cab)   -> out\
.\build-driver.cmd Debug                   # Debug (DBG=1, trazas DbgPrintEx) -> out\package-debug
.\build-driver.cmd Release /analyze        # + Code Analysis con el plugin de drivers del WDK
$env:VOXORA_DRIVER_VERSION = '1.0.1.0'; .\build-driver.cmd   # subir versión (cada envío a Partner Center)

# Git Bash (cmd //c "..." rompe las comillas de rutas con espacios): usar el .ps1
powershell -NoProfile -ExecutionPolicy Bypass -File build-driver.ps1 -Version 1.0.0.0 [-Configuration Debug] [-Analyze]
```

Qué hace, paso a paso:

1. **WDK/SDK de NuGet** (solo la primera vez, ~320 MB de descarga, ~1.5 GB
   extraído en `.wdk\`, ignorado por `.gitignore`):
   `Microsoft.Windows.WDK.x64`, `Microsoft.Windows.SDK.CPP` y
   `Microsoft.Windows.SDK.CPP.x64` **10.0.26100.6584** (último 10.0.26100.x en
   `https://api.nuget.org/v3-flatcontainer/microsoft.windows.wdk.x64/index.json`),
   descargados de `https://www.nuget.org/api/v2/package/<id>/<versión>` y
   extraídos con `tar.exe` (los `.nupkg` quedan en caché en `.wdk\dl\`).
2. **vcvars64.bat** (localizado con `vswhere`, o `VCVARS64=`) y sustitución de
   `INCLUDE`/`LIB` por `km\crt; km; shared (SDK); shared (WDK)` y `km\x64`,
   como hace el toolset `WindowsKernelModeDriver10.0`.
3. **cl / rc / link** con los flags copiados de los `.props` del WDK
   (`WindowsDriver.Shared.Props`, `.Common.props`, `.KernelMode.props`,
   `.KernelMode.Wdm.props`, `WindowsDriver.x64.props`):
   - cl: `/kernel -cbstring -d2epilogunwind /d1import_no_registry
     /d2AllowCompatibleILVersions /d2Zi+ /Zi /W4 /WX /wd4603 /wd4627 /wd4986
     /wd4987 /GS /Gz /Zc:wchar_t- /Zp8 /GF /Gy /GR- /Oy- /guard:cf
     /FI warning.h /std:c++17`, Release `/Ox /Os /d1nodatetime`, Debug `/Od /Oi
     /homeparams DBG=1`; defines `_WIN64 _AMD64_ AMD64 _WIN32_WINNT=0x0A00
     WINVER=0x0A00 WINNT=1 NTDDI_VERSION=0x0A000008`.
   - link: `/DRIVER /KERNEL /SUBSYSTEM:NATIVE,10.00 /ENTRY:GsDriverEntry
     /NODEFAULTLIB /DEBUG:FULL /DEBUGTYPE:CV,PDATA /pdbcompress /OSVERSION:10.0
     /VERSION:10.0 /PROFILE /OPT:REF /OPT:ICF /INCREMENTAL:NO /MERGE:_TEXT=.text
     /MERGE:_PAGE=PAGE /RELEASE /SECTION:INIT,d /IGNORE:4198,… /WX /guard:cf`
     (+ `/PDBALTPATH:%_PDB%` para no incrustar la ruta local del PDB) con
     `portcls.lib stdunk.lib ksguid.lib libcntpr.lib BufferOverflowFastFailK.lib
     ntoskrnl.lib hal.lib wmilib.lib`.
4. **stampinf** (`DriverVer` = fecha de hoy + `VOXORA_DRIVER_VERSION`),
   **infverif /h** (bloqueante), **infverif /w** (informativo),
   **Inf2Cat /os:10_X64**, **ApiValidator** (informativo) y **makecab** con
   `signing\make-cab.ddf`.

Salida:

| Ruta | Contenido |
|---|---|
| `out\package\` | `voxorameet.sys` (≈ 28 KB), `voxorameet.inf` (sellado), `voxorameet.cat` (Inf2Cat, sin firmar) — el paquete instalable (Release) |
| `out\symbols\voxorameet.pdb` | símbolos (aparte: no se instalan) |
| `out\cab\voxorameet.cab` | `voxorameet\{inf,sys,pdb}` para Partner Center, **sin firmar** |
| `out\package-debug\` | idem Debug (sin .cab) |
| `out\bin\`, `out\obj\` | intermedios (`.map` incluido) |

`voxorameet.sln`/`.vcxproj` siguen valiendo para quien tenga VS + WDK
instalados (`msbuild voxorameet.sln /p:Configuration=Release /p:Platform=x64`,
salida en `build\x64\Release\voxorameet\`); fijan el mismo `NTDDI_VERSION`.

### Resultado de las validaciones (build del 2026-09-28)

| Herramienta | Resultado |
|---|---|
| cl `/W4 /WX` (Release y Debug) | 0 avisos |
| Code Analysis (`/analyze`, plugin `drivers.dll`, `DriverRecommendedRules`) | 0 avisos en el código del driver (los de `wdm.h` se excluyen, como hace VS) |
| `infverif /v /h` (requisitos de firma de Microsoft = lo que aplica Partner Center) | **INF is VALID** (también con `/rulever vnext`, `/k` y `/u`) |
| `infverif /w` (Windows Driver / DCH) | 4 × ERROR 1321: `HKLM\…\MediaCategories` no aislado a `HKR`. **Esperado**: el driver es *Desktop* (no DCH) para poder dar nombre propio a los pins; ver "Riesgos" |
| `Inf2Cat /os:10_X64` | Errors: None · Warnings: None |
| `ApiValidator` (UniversalDDIs x64) | "All binaries are Universal" |
| `dumpbin` | Native, `NX compatible`, `Dynamic base`, `Control Flow Guard`; `INIT` descartable; sin secciones RWX; importa solo `portcls.sys`, `ntoskrnl.exe`, `HAL.dll` |

### Correcciones hechas al compilar por primera vez

Errores de compilación:

- `IMP_IMiniportWaveRTStreamNotification` no incluye los métodos de
  `IMiniportWaveRTStream`: se añadió `IMP_IMiniportWaveRTStream;` en
  `CMiniportWaveRTStream` (la clase era abstracta).
- `PcUnload` no existe en `portcls.h`: `DriverEntry` guarda el `DriverUnload`
  que instala `PcInitializeAdapterDriver` y `DriverUnload` lo encadena (patrón
  sysvad).
- `VARTYPE` no existe en modo kernel: `BasicSupport` recibe `ULONG` (VARENUM).
- `stdunk.h` define `operator new` *inline* sobre `ExAllocatePoolWithTag`
  (obsoleta desde Windows 10 2004, "will be removed soon"): se define
  `_NEW_DELETE_OPERATORS_` y `adapter.cpp` implementa `operator new(size_t,
  POOL_FLAGS, ULONG)` sobre **`ExAllocatePool2`** (+ `delete` con tamaño,
  `delete[]`); el `delete(void*)` plano ya lo aporta `stdunk.lib`. Las fábricas
  reciben `POOL_FLAGS` (`POOL_FLAG_NON_PAGED`) en vez de `POOL_TYPE`.

Correcciones de diseño/robustez (no las detecta el compilador):

- **IRQL / secciones:** varias funciones en `#pragma code_seg("PAGE")` tomaban
  un spinlock (quedaban ejecutando código paginable a `DISPATCH_LEVEL` →
  posible `IRQL_NOT_LESS_OR_EQUAL`). `AllocateBufferInternal`,
  `FreeBufferInternal`, `Register/UnregisterNotificationEvent` y `SetState`
  pasan a la sección no paginada (con `ASSERT(PASSIVE_LEVEL)`); el slot de
  stream único de `CMiniportWaveRT` deja de usar spinlock y se reserva con
  `InterlockedCompareExchangePointer`.
- **Volumen multicanal:** el `BASICSUPPORT` de `KSPROPERTY_AUDIO_VOLUMELEVEL`
  devolvía un solo rango sin flags (el motor lo trataría como mono y solo
  ajustaría el canal 0, dejando el otro a 0 dB → la ganancia media quedaba a
  la mitad). Ahora devuelve un rango por canal con
  `KSPROPERTY_MEMBER_FLAG_BASICSUPPORT_MULTICHANNEL`, como sysvad.
- `CLoopbackBuffer::Write` con `SampleRate == 0` entraba en bucle infinito con
  el spinlock tomado: misma guarda que `Read`.
- `PAUSE` desde `RUN` consolida la posición (`AdvancePosition`) antes de
  congelarla.
- SAL: anotaciones de IRQL coherentes entre declaración y definición,
  `_Dispatch_type_(IRP_MJ_PNP)`, tamaños `_In_reads_bytes_/_Out_writes_bytes_`
  en los conversores de frame; `C28110` (float) suprimido con justificación y
  `#error` si alguien compila para algo que no sea x64.
- **INF:** `[Manufacturer]` decorado `NTamd64.10.0...19041` (Windows 10 2004+):
  InfVerif 1199 exige ≥ 16299 para `DIRID 13`, y el driver importa
  `ExAllocatePool2` (no existe antes de 2004). `NTDDI_VERSION` fijado a
  `NTDDI_WIN10_VB` (0x0A000008) por coherencia (el WDK 26100 usaría por
  defecto 0x0A000010 = Windows 11 24H2).

## Firma y publicación (con el token EV)

Resumen del flujo verificado (detalle, requisitos y costes en
**`signing/README.md`**):

```powershell
# 1) Build (sin admin). Subir la versión en cada envío.
.\build-driver.ps1 -Version 1.0.0.0

# 2) Firmar el CAB con el EV (token USB conectado; pedirá el PIN)
$signtool = ".\.wdk\Microsoft.Windows.SDK.CPP\c\bin\10.0.26100.0\x64\signtool.exe"
& $signtool sign /v /fd sha256 /tr http://timestamp.digicert.com /td sha256 /sha1 <HUELLA_EV> out\cab\voxorameet.cab
#    (o /a en lugar de /sha1 <HUELLA_EV> si el EV es el único certificado de firma de código)
& $signtool verify /v /pa out\cab\voxorameet.cab
#    Equivalente automatizado: .\signing\sign-and-submit.ps1 -CertThumbprint <HUELLA_EV>

# 3) Partner Center -> Hardware -> Submit new hardware -> subir out\cab\voxorameet.cab,
#    Requested signatures: Windows 10 (2004+) y Windows 11 Client x64 -> atestación -> Submit.
# 4) Descargar "Signed files" y verificar:
.\signing\sign-and-submit.ps1 -Mode VerifySigned -SignedPackage C:\Users\<tú>\Downloads\Signed_XXXX.zip
# 5) Instalar (admin) desde la carpeta extraída del zip firmado por Microsoft:
.\installer\install.ps1 -InfPath C:\ruta\extraida\voxorameet\voxorameet.inf
```

## Prueba local en VM (testsigning, sin Partner Center)

Solo para desarrollo; **nunca** en la máquina de trabajo ni para distribuir.

1. VM Hyper-V **Gen 2 con Secure Boot desactivado** (Configuración → Seguridad)
   o Gen 1, Windows 11 x64 (o Windows 10 2004+). Checkpoint antes de empezar.
2. En el host: `.\build-driver.ps1` (o `-Configuration Debug` para trazas).
3. Copiar a la VM la carpeta `windows-driver` completa (con `out\` y `.wdk\`:
   `test-signing.ps1` toma `signtool`/`Inf2Cat` de `.wdk\`).
4. En la VM, PowerShell **como administrador**:
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\signing\test-signing.ps1                 # cert autofirmado -> Root/TrustedPublisher, testsigning on, firma .sys/.cat
   Restart-Computer                           # "Modo de prueba" en el escritorio
   .\installer\install.ps1                    # usa out\package (o -InfPath ...\out\package-debug\voxorameet.inf)
   Get-PnpDevice -Class AudioEndpoint | ? FriendlyName -like '*VOXORA*'
   verifier /standard /driver voxorameet.sys  # Driver Verifier + reinicio; repetir las pruebas
   ```
5. E2E con Meet: `docs/E2E-MEET-CHECKLIST.md`. Trazas Debug con DebugView
   (Capture Kernel) o WinDbg (`ed nt!Kd_IHVAUDIO_Mask 0xF`).
6. Desinstalar: `.\installer\uninstall.ps1`; volver al checkpoint o
   `bcdedit /set testsigning off`.

`test-signing.ps1` firma **en sitio** los archivos del paquete: no generes el
`.cab` de Partner Center a partir de un `out\package` firmado en pruebas
(vuelve a ejecutar `build-driver.cmd`, que lo regenera desde cero).

## Instalación

Dispositivo **root-enumerado** `ROOT\VOXORAMEET` (clase MEDIA, `Include=ks.inf,
wdmaudio.inf`, `Needs=KS.Registration,WDMAUDIO.Registration`), Windows 10 2004+
/ Windows 11, solo x64.

```powershell
# como administrador
.\installer\install.ps1                 # busca out\package, out\package-debug y build\x64\*\voxorameet
.\installer\install.ps1 -InfPath C:\ruta\voxorameet.inf
.\installer\uninstall.ps1
```

`install.ps1` hace `pnputil /add-driver … /install` y crea el nodo root con
`devcon install` si encuentra `devcon.exe` (WDK instalado o `.wdk\` local) o,
si no, con SetupAPI (`SetupDiCreateDeviceInfo` + `DIF_REGISTERDEVICE` +
`UpdateDriverForPlugAndPlayDevices`), que es lo que devcon hace por dentro.
Más detalles y diagnóstico en `installer/devcon-notes.md`.

Tras instalar, `Get-PnpDevice -Class AudioEndpoint | ? FriendlyName -like '*VOXORA*'`
debe listar *VOXORA Meet Speaker* y *VOXORA Meet Microphone*.

## Cliente Node: `VirtualMic` (`src/virtual-mic.mjs`)

Node no tiene WASAPI, así que el audio lo entrega el helper nativo user-mode
`native/wasapi-render.exe` (`native/wasapi-render.cpp`, compilado aquí con
MSVC, sin dependencias): lee PCM s16le de stdin y lo rinde en el endpoint cuyo
nombre contenga `VOXORA Meet Speaker` (o `--device <id>`); `--list` imprime un
JSON de endpoints de render. Usa `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM`, modo
compartido event-driven, contrapresión sobre stdin (cola máx. 2 s) y emite
eventos JSON por línea (`ready`, `eof`, `error`).

```powershell
npm run build:native      # o scripts/build-native.mjs desde la raíz (ya incluye este módulo)
npm run build:driver      # = build-driver.ps1 (driver de kernel, ver arriba)
npm test                  # node --test "src/**/*.test.mjs": spawn inyectado, no requieren driver ni helper
```

```js
import { VirtualMic } from '@voxora-meet/windows-driver';

if (!(await VirtualMic.isInstalled())) throw new Error('Instala el driver VOXORA Meet');

const mic = new VirtualMic({ sampleRate: 48000, channels: 1 }); // contrato: PCM s16le 48 kHz mono
await mic.open();                 // resuelve cuando WASAPI está rindiendo
await mic.write(pcmS16le48k);     // respeta la contrapresión (Promise)
await mic.close();                // EOF → el helper vacía su cola y sale
```

API: `VirtualMic.isInstalled(opts)`, `VirtualMic.findEndpoint(opts)`,
`listRenderEndpoints(opts)`, `open()`, `write(pcm)`, `close({timeoutMs})`,
propiedades `isOpen`, `device`, `bytesWritten`; eventos `close`, `error`, `stderr`.
Opciones inyectables: `helperPath`, `spawn`, `deviceId`, `deviceName`, `bufferMs`,
`readyTimeoutMs`.

## Estado y riesgos

- **Compilado y validado estáticamente, nunca cargado.** Pendiente de probar
  en VM con Driver Verifier y depurador de kernel (sección anterior).
- Posición virtual por QPC + timer de 10 ms: jitter de posición de hasta un
  periodo; el motor de audio lo tolera (VB-Cable hace lo mismo) pero puede
  requerir ajustar `VOXORA_TIMER_PERIOD_MS` o pasar a `ExAllocateTimer` con
  `EX_TIMER_HIGH_RESOLUTION` si aparecen glitches.
- `GetPosition` mueve audio bajo spinlock (llamado a ≤ DISPATCH_LEVEL): coste
  acotado (≤ 1 buffer), pero conviene medir con `xperf`/WPA.
- Volumen/mute se aplican en el driver (nodos "hardware"); si Windows además
  aplica volumen por software se verá doble atenuación → en ese caso quitar
  la ganancia en `TransferChunk` y dejar solo el estado.
- INF *Desktop*, no DCH: los nombres de pin propios se registran en
  `HKLM\…\MediaCategories`, lo que `infverif /w` marca (ERROR 1321) pero
  `infverif /h` (firma de Microsoft / atestación) acepta. Si algún día se
  quiere DCH/Windows Update: quitar `KSNAME_VOXORA_*` (el endpoint se llamaría
  "Altavoces (VOXORA Meet Speaker)" / "Micrófono (VOXORA Meet Microphone)",
  tomando el nombre entre paréntesis del `FriendlyName` de la interfaz) y
  borrar esas líneas `HKLM` del INF.
- Solo x64 (float por SSE sin `KeSaveFloatingPointState`; `common.h` da
  `#error` en otra arquitectura). `ExAllocatePool2` exige Windows 10 2004+
  (el INF ya lo impone). Sin C++ exceptions/RTTI.

## Roadmap M0 → certificación

1. ~~Compilar con WDK, corregir avisos, `infverif`/`ApiValidator` limpios.~~ Hecho
   (`build-driver.cmd`, WDK de NuGet).
2. VM Windows 11 en testsigning: instalar, verificar endpoints, Driver Verifier,
   E2E con Meet (`docs/E2E-MEET-CHECKLIST.md`).
3. Firmar `out\cab\voxorameet.cab` con el EV y registrar Partner Center.
4. Primera submission por atestación; integrar el paquete firmado en el
   instalador de la app.
5. (Opcional) HLK Audio para Windows Update / logo "Compatible con Windows".
