# Firma del driver `voxorameet.sys`

Windows 10/11 x64 solo carga drivers de kernel firmados por Microsoft. Para un
driver de audio virtual sin certificación HLK el camino es la **firma por
atestación** (attestation signing) en **Microsoft Partner Center → Hardware**
(el antiguo "Hardware Dev Center" / "sysdev"). Esta guía es el proceso real,
de punta a punta, tal como está vigente en 2026; los detalles de UI cambian
con frecuencia, así que se indica dónde comprobar cada paso.

> Resumen: `build-driver.cmd` → `out\cab\voxorameet.cab` → firma del `.cab`
> con el token EV → submission de atestación en Partner Center → Microsoft
> devuelve `.sys` + `.cat` firmados por *Microsoft Windows Hardware
> Compatibility Publisher* → `installer\install.ps1` en cualquier Windows
> 10 (2004+) / 11 x64 sin modo de prueba.

**Estado (2026-09-28):** paquete compilado y validado (infverif `/h` VALID,
Inf2Cat sin errores, ApiValidator OK); `out\cab\voxorameet.cab` generado **sin
firmar**. El certificado EV ya está disponible (token del usuario): quedan los
pasos 3 → 5.

---

## 0. Qué se necesita (checklist)

| # | Requisito | Notas |
|---|-----------|-------|
| 1 | **Entidad legal** (empresa registrada) | Los certificados EV **no** se emiten a personas físicas. |
| 2 | **Tenant de Microsoft Entra ID** (Azure AD) con un usuario Global Admin | El registro en Partner Center se hace con una cuenta de trabajo de ese tenant, no con una cuenta personal de Microsoft. |
| 3 | **Certificado EV de firma de código** en token/HSM | ✅ disponible. Middleware del token instalado (SafeNet Authentication Client, YubiKey minidriver…) para que el certificado aparezca en `certmgr.msc → Personal` y `signtool` lo use vía CSP/KSP. |
| 4 | **Paquete Release** | `build-driver.cmd` (WDK de NuGet en `.wdk\`, sin instalar nada): `out\package\{sys,inf,cat}`, `out\symbols\voxorameet.pdb`, `out\cab\voxorameet.cab`. |
| 5 | `signtool.exe` | En `.wdk\Microsoft.Windows.SDK.CPP\c\bin\10.0.26100.0\x64\` (o el Windows SDK instalado). `makecab.exe` es inbox. |
| 6 | `infverif.exe`, `Inf2Cat`, `ApiValidator` | En el WDK de NuGet; `build-driver.cmd` ya los ejecuta. |

## 1. Certificado EV — compra y activación

(Ya resuelto; se deja como referencia para renovaciones.)

1. Producto "**EV Code Signing**" (no OV) de una CA del programa de raíces de
   Microsoft (DigiCert, GlobalSign, Sectigo, SSL.com, Entrust, Certum…).
   Precios orientativos 2026: 350–700 USD/año + token (50–100 USD) o servicio
   de firma en la nube (DigiCert KeyLocker, SSL.com eSigner, Azure Key Vault…).
2. Vetting de la empresa (registro mercantil, dirección, llamada de
   verificación, identidad del solicitante): 1–7 días laborables.
3. Verificar que `signtool` ve el certificado y anotar la **huella SHA-1**:
   ```powershell
   Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Format-List Subject, Thumbprint, NotAfter, Issuer
   ```

## 2. Registro en Partner Center (Hardware Program)

1. Con la cuenta Global Admin del tenant: https://partner.microsoft.com/dashboard/registration/hardware
2. Datos de la empresa. Partner Center pide **demostrar la posesión del
   certificado EV**: descarga un ejecutable (`winqual.exe`), fírmalo con el EV
   y súbelo:
   ```powershell
   $signtool = ".\.wdk\Microsoft.Windows.SDK.CPP\c\bin\10.0.26100.0\x64\signtool.exe"
   & $signtool sign /v /fd sha256 /tr http://timestamp.digicert.com /td sha256 /sha1 <HUELLA_EV> .\winqual.exe
   ```
3. Aceptar el *Windows Hardware Compatibility Program agreement* (Ajustes →
   Acuerdos). Sin el acuerdo firmado no se pueden crear submissions.
4. Estado "Activo" en **1–3 días laborables** (revisión manual). Gratuito.
5. Roles: dar "Hardware → Submit" a quien vaya a enviar (Ajustes → Usuarios).

## 3. Preparar y firmar el paquete (flujo verificado)

Desde `windows-driver\`, en PowerShell, **sin administrador**:

```powershell
# 3.1 Build Release + validaciones + CAB (la versión debe SUBIR en cada envío:
#     pnputil no reemplaza un paquete instalado con DriverVer igual o menor)
.\build-driver.ps1 -Version 1.0.0.0
#   -> infverif /h: INF is VALID · Inf2Cat: Errors None · ApiValidator: Universal
#   -> out\cab\voxorameet.cab  = voxorameet\voxorameet.inf, .sys, .pdb

# 3.2 Firmar el CAB con el token EV (conectado; el middleware pedirá el PIN)
$signtool = ".\.wdk\Microsoft.Windows.SDK.CPP\c\bin\10.0.26100.0\x64\signtool.exe"
& $signtool sign /v /fd sha256 /tr http://timestamp.digicert.com /td sha256 /sha1 <HUELLA_EV> out\cab\voxorameet.cab
#   Alternativa: /a en lugar de /sha1 <HUELLA_EV> (signtool elige solo el
#   certificado de firma de código; comprobar en la salida que el firmante es el EV).

# 3.3 Verificar (debe decir "Successfully verified" y mostrar el sello de tiempo)
& $signtool verify /v /pa out\cab\voxorameet.cab
```

Equivalente automatizado de 3.2–3.3 (regenera el CAB desde `out\package` con
`make-cab.ddf`, pasa `infverif /h`, firma y verifica):

```powershell
.\signing\sign-and-submit.ps1 -CertThumbprint <HUELLA_EV>        # o -CertSubject "Mi Empresa S.L."; sin ninguno usa /a
```

Notas:

- Se firma **el .cab**, no el .sys: Microsoft firma el .sys y genera su propio
  `.cat`. El `.cat` de `out\package` (Inf2Cat local) solo sirve para
  testsigning y por eso no va en el CAB.
- Firma **SHA-256 con sello de tiempo RFC 3161** (`/tr … /td sha256`)
  obligatoria. Otros TSA: `http://timestamp.sectigo.com`, `http://ts.ssl.com`,
  `http://timestamp.globalsign.com/tsa/r6advanced1`.
- No toques `out\package` entre el build y la firma: `test-signing.ps1` firma
  en sitio; si lo has usado, vuelve a ejecutar `build-driver.ps1`.
- `infverif /w` (DCH) da 4 × ERROR 1321 por `HKLM\…\MediaCategories`: es
  esperado (driver *Desktop*); Partner Center aplica las reglas de `/h`.

## 4. Submission de atestación

1. https://partner.microsoft.com/dashboard/hardware → **Drivers** →
   **Submit new hardware**.
2. **Product name**: `VOXORA Meet Virtual Audio 1.0.0.0` (la versión del INF).
3. **Submission**: arrastra `out\cab\voxorameet.cab` (el firmado). Partner
   Center detecta que no hay HLKX → firma por **atestación**.
4. **Requested signatures**: marca solo **Client x64**: Windows 10 (2004 /
   20H2 / 21H2 / 22H2) y Windows 11 (21H2 … 25H2) — el INF solo instala en
   build 19041+. La atestación **no** cubre Windows Server ni ARM64.
5. Acepta la declaración de atestación y **Submit**. Fases: *Preparation →
   Validation (InfVerif/ApiValidator/antimalware) → Signing → Finalize*;
   normalmente 10–60 min (picos de hasta 24 h). Si falla la validación, el
   informe descargable indica el ID de error de InfVerif/ApiValidator.
6. Al llegar a *Signed*: **Download signed files** → zip con la misma
   estructura del CAB (`voxorameet\`) + `voxorameet.cat` firmado por
   *Microsoft Windows Hardware Compatibility Publisher* y el `.sys` con firma
   de Microsoft.
7. Verificar en local (sin admin):
   ```powershell
   .\signing\sign-and-submit.ps1 -Mode VerifySigned -SignedPackage C:\Users\<tú>\Downloads\Signed_XXXX.zip
   ```
   (`signtool verify /kp` = política de firma de kernel; debe pasar sin modo de prueba.)
8. Instalar / integrar en el instalador de la app (admin):
   ```powershell
   Expand-Archive C:\Users\<tú>\Downloads\Signed_XXXX.zip C:\drivers\voxorameet-1.0.0.0
   .\installer\install.ps1 -InfPath (Get-ChildItem C:\drivers\voxorameet-1.0.0.0 -Recurse -Filter voxorameet.inf).FullName
   ```
   **No editar el INF firmado**: cualquier byte cambiado invalida el `.cat`.

Cada nueva versión del driver = nuevo build con `-Version` mayor + nueva
submission (~1 h).

## 5. Distribución

- **Instalador propio** (recomendado para VOXORA Meet): el paquete firmado por
  atestación se instala con `pnputil` + creación del nodo root
  (`installer\install.ps1`) en cualquier Windows 10 2004+/11 x64, con Secure
  Boot y HVCI/Core Isolation activos (el binario es NX, CFG y sin secciones RWX).
- **Windows Update**: los paquetes firmados por atestación **no** se publican
  en Windows Update; para eso Microsoft exige HLK. No lo necesitamos.
- **Elevación**: la instalación siempre pide UAC (admin). Planificar el
  instalador de la app en consecuencia (MSI/Inno con `requireAdministrator`).

## 6. Desarrollo sin firma: VM en modo de prueba

Para iterar antes (o en paralelo) de Partner Center. **Solo en una VM**:

1. VM Hyper-V **Gen 2 con Secure Boot desactivado** (Configuración →
   Seguridad) o Gen 1, Windows 11 / Windows 10 2004+ x64. Checkpoint.
2. Host: `.\build-driver.ps1` (o `-Configuration Debug` para trazas
   `DbgPrintEx`). Copiar la carpeta `windows-driver` completa a la VM (con
   `out\` y `.wdk\`, de donde se toman `signtool` e `Inf2Cat`).
3. VM, PowerShell como administrador:
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\signing\test-signing.ps1        # cert "VOXORA Meet Test" -> LocalMachine\Root y TrustedPublisher,
                                     # bcdedit /set testsigning on, Inf2Cat + signtool sobre out\package
   Restart-Computer
   .\installer\install.ps1           # Debug: test-signing.ps1 -PackageDir .\out\package-debug y luego
                                     #        install.ps1 -InfPath .\out\package-debug\voxorameet.inf
   Get-PnpDevice -Class AudioEndpoint | ? FriendlyName -like '*VOXORA*'
   verifier /standard /driver voxorameet.sys ; Restart-Computer
   ```
4. Depuración de kernel opcional: `bcdedit /debug on` +
   `bcdedit /dbgsettings net hostip:<host> port:50000` y WinDbg en el host.

Windows mostrará "Modo de prueba" en la esquina del escritorio. **Nunca**
distribuir así, ni activar testsigning en la máquina de desarrollo.

## 7. Estimación de lead time y costes (M0)

| Partida | Tiempo | Coste |
|---------|--------|-------|
| Tenant Entra ID + cuenta | 1 h | 0 |
| Certificado EV (vetting + token) | ✅ hecho | 350–700 USD/año (+50–100 USD token) |
| Registro Partner Center Hardware | 1–3 días laborables | 0 |
| Primera submission (build ya validado) | 1–2 h (+ correcciones si Partner Center añade reglas) | 0 |
| Cada resubmission | ~1 h | 0 |

## 8. Roadmap a certificación completa (opcional, post-MVP)

Solo si en el futuro se quisiera Windows Update o el sello "Compatible con
Windows": convertir el INF a DCH (ver "Riesgos" en `../README.md`), HLK
Studio + controlador HLK en una máquina de pruebas, pruebas de la clase
*Audio*, generar el `.hlkx`, firmarlo con el EV y enviarlo en lugar de la
atestación.

## Referencias (comprobar la versión vigente)

- Partner Center hardware dashboard: https://partner.microsoft.com/dashboard/hardware
- "Attestation signing a kernel driver for public release" (learn.microsoft.com → windows-hardware/drivers/dashboard)
- "Register for the Hardware Program" y "Code signing certificates" (mismo árbol de docs)
- `signtool`, `makecab`, `inf2cat`, `infverif`, `ApiValidator` en la documentación del WDK
- WDK en NuGet: https://www.nuget.org/packages/Microsoft.Windows.WDK.x64
