# Notas sobre devcon / pnputil para VOXORA Meet

El driver es un dispositivo **root-enumerado** (`ROOT\VOXORAMEET`): no hay
hardware que Windows detecte, así que alguien tiene que **crear el nodo de
dispositivo** además de copiar el paquete al Driver Store. `pnputil` hace lo
segundo pero no lo primero; `devcon install` hace ambas cosas.

## Dónde conseguir devcon.exe

- Viene con el **WDK** (no con el SDK): `C:\Program Files (x86)\Windows Kits\10\Tools\<versión>\x64\devcon.exe`.
- Microsoft ya no lo distribuye por separado; el código fuente está en
  `Windows-driver-samples/setup/devcon` (GitHub) y se compila con el WDK.
- `installer/install.ps1` lo usa si lo encuentra; si no, replica
  `devcon install` con SetupAPI (P/Invoke), así que **no es obligatorio**.

## Comandos útiles

```powershell
# Instalar (crea el nodo root + instala el paquete). Requiere admin.
devcon install .\voxorameet.inf ROOT\VOXORAMEET

# Actualizar el driver de un nodo ya existente
devcon update .\voxorameet.inf ROOT\VOXORAMEET

# Estado / ids
devcon status "ROOT\VOXORAMEET*"
devcon hwids  "ROOT\VOXORAMEET*"
devcon stack  "ROOT\VOXORAMEET*"      # pila de drivers (debe verse portcls/ks encima)

# Reiniciar el dispositivo (útil tras cambiar el .sys en testsigning)
devcon restart "ROOT\VOXORAMEET*"

# Quitar el nodo (no borra el paquete del store)
devcon remove "ROOT\VOXORAMEET*"

# Paquetes del Driver Store
devcon dp_enum
devcon dp_delete oem42.inf            # el oemNN.inf que corresponda a voxorameet.inf
```

## Equivalentes con pnputil (inbox, sin WDK)

```powershell
pnputil /add-driver .\voxorameet.inf /install    # solo Driver Store (+ dispositivos que ya existan)
pnputil /enum-devices /class MEDIA               # ver el nodo ROOT\VOXORAMEET
pnputil /enum-drivers                            # localizar el oemNN.inf
pnputil /remove-device "ROOT\VOXORAMEET\0000"    # Windows 10 2004+
pnputil /delete-driver oem42.inf /uninstall /force
pnputil /restart-device "ROOT\VOXORAMEET\0000"
```

`pnputil` **no** puede crear el nodo root; para eso: `devcon install`, el
fallback SetupAPI de `install.ps1`, o el Administrador de dispositivos
(Acción → Agregar hardware heredado → "Controladoras de sonido, vídeo y
juegos" → Usar disco).

## Diagnóstico rápido

| Síntoma | Causa probable |
|---|---|
| Nodo con código 52 | Firma no válida y `testsigning` apagado. Ver `signing/`. |
| Nodo con código 10 / 31 | `StartDevice` devolvió error (KD: `!analyze`, trazas `voxorameet:` en Debug). Revisar `PcRegisterSubdevice` / conexiones físicas. |
| Nodo OK pero sin endpoints | Interfaces del INF no coinciden con `PcRegisterSubdevice` (`WaveSpeaker`, `TopologySpeaker`, `WaveMicrophone`, `TopologyMicrophone`) o el servicio `AudioEndpointBuilder` no ha reconstruido: `Restart-Service AudioEndpointBuilder`. |
| Endpoint aparece como "Altavoces"/"Micrófono" genérico | No se aplicó `MediaCategories\{GUID}` del INF (sección `AddReg`). |
| Meet no lo lista | Endpoint deshabilitado en Panel de sonido → Grabar → "Mostrar dispositivos deshabilitados". |

Herramientas: `Get-PnpDevice -Class MEDIA`, `Get-PnpDevice -Class AudioEndpoint`,
Visor de eventos → `Microsoft-Windows-Audio/Operational`, y `SetupAPI.dev.log`
(`C:\Windows\INF\setupapi.dev.log`) para errores de instalación del INF.
