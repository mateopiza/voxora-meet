<#
.SYNOPSIS
  Instala el driver de audio virtual VOXORA Meet (voxorameet.sys) y crea el
  nodo de dispositivo root-enumerado ROOT\VOXORAMEET.

.DESCRIPTION
  1. Verifica que el paquete (inf + sys + cat) exista y esté firmado (o que el
     equipo esté en modo testsigning para builds de desarrollo).
  2. Añade el paquete al Driver Store:  pnputil /add-driver <inf> /install
  3. Crea el nodo root ROOT\VOXORAMEET si no existe. Para eso usa, en orden:
       a) devcon.exe (WDK) si está disponible:  devcon install <inf> ROOT\VOXORAMEET
       b) SetupAPI vía P/Invoke (SetupDiCreateDeviceInfo + DIF_REGISTERDEVICE +
          UpdateDriverForPlugAndPlayDevices) — exactamente lo que hace devcon,
          sin depender del WDK.
  4. Muestra los endpoints de audio resultantes.

.PARAMETER InfPath
  Ruta a voxorameet.inf. Por defecto busca la salida de build-driver.cmd
  (out\package, luego out\package-debug) y después la de msbuild
  (build\x64\Release|Debug\voxorameet). Para producción, pasa la carpeta del
  paquete FIRMADO por Microsoft (Partner Center).

.EXAMPLE
  PS> .\install.ps1
  PS> .\install.ps1 -InfPath C:\drivers\voxorameet\voxorameet.inf
#>
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$InfPath,
    [string]$HardwareId = 'ROOT\VOXORAMEET',
    [switch]$SkipDeviceNode
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# --- 1. Localizar el paquete -------------------------------------------------
if (-not $InfPath) {
    $root = Split-Path -Parent $PSScriptRoot
    $candidates = @(
        (Join-Path $root 'out\package\voxorameet.inf'),
        (Join-Path $root 'out\package-debug\voxorameet.inf'),
        (Join-Path $root 'build\x64\Release\voxorameet\voxorameet.inf'),
        (Join-Path $root 'build\x64\Debug\voxorameet\voxorameet.inf'),
        (Join-Path $root 'voxorameet.inf')
    )
    $InfPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $InfPath) { throw "No se encontró voxorameet.inf. Compila con build-driver.cmd o pasa -InfPath." }
}
$InfPath = (Resolve-Path $InfPath).Path
$pkgDir = Split-Path -Parent $InfPath
$sysPath = Join-Path $pkgDir 'voxorameet.sys'
$catPath = Join-Path $pkgDir 'voxorameet.cat'

Write-Step "Paquete: $pkgDir"
if (-not (Test-Path $sysPath)) { throw "Falta voxorameet.sys junto al INF ($sysPath)." }
if (-not (Test-Path $catPath)) { Write-Warning "Falta voxorameet.cat: la instalación fallará salvo en modo testsigning con .sys firmado." }

# --- 2. Firma / testsigning --------------------------------------------------
$sig = Get-AuthenticodeSignature -FilePath $sysPath
$testSigning = (bcdedit /enum '{current}' 2>$null | Select-String -Pattern 'testsigning\s+Yes' -Quiet)
if ($sig.Status -ne 'Valid') {
    Write-Warning "voxorameet.sys no tiene una firma válida ($($sig.Status))."
    if (-not $testSigning) {
        throw "El equipo no está en modo testsigning. Firma por atestación (signing/README.md) o ejecuta signing/test-signing.ps1."
    }
    Write-Host "    testsigning=on: se acepta la firma de prueba." -ForegroundColor Yellow
} else {
    Write-Host "    Firma válida: $($sig.SignerCertificate.Subject)"
}

# --- 3. Driver Store -----------------------------------------------------------
Write-Step "pnputil /add-driver `"$InfPath`" /install"
$out = & pnputil.exe /add-driver "$InfPath" /install 2>&1
$out | ForEach-Object { Write-Host "    $_" }
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 259 -and $LASTEXITCODE -ne 3010) {
    # 259 = no matching devices yet (normal antes de crear el nodo root), 3010 = reboot required
    throw "pnputil falló con código $LASTEXITCODE"
}

# --- 4. Nodo root --------------------------------------------------------------
function Get-VoxoraDevice {
    Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
        Where-Object { $_.InstanceId -like "$HardwareId*" }
}

if (-not $SkipDeviceNode) {
    $existing = Get-VoxoraDevice
    if ($existing) {
        Write-Step "El nodo $HardwareId ya existe ($($existing.InstanceId)); se actualiza el driver."
        & pnputil.exe /add-driver "$InfPath" /install | Out-Null
    } else {
        $devcon = Get-Command devcon.exe -ErrorAction SilentlyContinue
        if (-not $devcon) {
            # WDK de NuGet que descarga build-driver.cmd (.wdk\) o WDK instalado.
            $wdkLocal = Join-Path (Split-Path -Parent $PSScriptRoot) '.wdk\Microsoft.Windows.WDK.x64\c\tools'
            foreach ($kits in @($wdkLocal, "${env:ProgramFiles(x86)}\Windows Kits\10\Tools")) {
                if ($devcon -or -not (Test-Path $kits)) { continue }
                $devcon = Get-ChildItem -Path $kits -Recurse -Filter devcon.exe -ErrorAction SilentlyContinue |
                    Where-Object { $_.FullName -match '\\x64\\' } | Select-Object -First 1
            }
        }

        if ($devcon) {
            $devconPath = if ($devcon -is [System.Management.Automation.CommandInfo]) { $devcon.Source } else { $devcon.FullName }
            Write-Step "devcon install `"$InfPath`" $HardwareId  ($devconPath)"
            & $devconPath install "$InfPath" $HardwareId | ForEach-Object { Write-Host "    $_" }
            if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 1) { throw "devcon falló con código $LASTEXITCODE" }
        } else {
            Write-Step "devcon no disponible: creando el nodo root con SetupAPI"
            Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class VoxoraSetupApi
{
    [StructLayout(LayoutKind.Sequential)]
    public struct SP_DEVINFO_DATA
    {
        public uint cbSize;
        public Guid ClassGuid;
        public uint DevInst;
        public IntPtr Reserved;
    }

    const int DICD_GENERATE_ID = 0x1;
    const int SPDRP_HARDWAREID = 0x1;
    const int DIF_REGISTERDEVICE = 0x19;
    const int INSTALLFLAG_FORCE = 0x1;

    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr SetupDiCreateDeviceInfoList(ref Guid ClassGuid, IntPtr hwndParent);

    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool SetupDiCreateDeviceInfo(IntPtr DeviceInfoSet, string DeviceName, ref Guid ClassGuid,
        string DeviceDescription, IntPtr hwndParent, int CreationFlags, ref SP_DEVINFO_DATA DeviceInfoData);

    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool SetupDiSetDeviceRegistryProperty(IntPtr DeviceInfoSet, ref SP_DEVINFO_DATA DeviceInfoData,
        int Property, byte[] PropertyBuffer, int PropertyBufferSize);

    [DllImport("setupapi.dll", SetLastError = true)]
    static extern bool SetupDiCallClassInstaller(int InstallFunction, IntPtr DeviceInfoSet, ref SP_DEVINFO_DATA DeviceInfoData);

    [DllImport("setupapi.dll", SetLastError = true)]
    static extern bool SetupDiDestroyDeviceInfoList(IntPtr DeviceInfoSet);

    [DllImport("newdev.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool UpdateDriverForPlugAndPlayDevices(IntPtr hwndParent, string HardwareId, string FullInfPath,
        int InstallFlags, out bool bRebootRequired);

    // Equivalente a "devcon install <inf> <hwid>" para dispositivos root-enumerados.
    public static bool CreateRootDevice(Guid classGuid, string hardwareId, string infPath, out bool rebootRequired)
    {
        rebootRequired = false;
        IntPtr set = SetupDiCreateDeviceInfoList(ref classGuid, IntPtr.Zero);
        if (set == IntPtr.Zero || set.ToInt64() == -1)
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "SetupDiCreateDeviceInfoList");
        try
        {
            var data = new SP_DEVINFO_DATA();
            data.cbSize = (uint)Marshal.SizeOf(typeof(SP_DEVINFO_DATA));
            // El nombre de dispositivo es el enumerador ("ROOT\VOXORAMEET" -> ROOT\VOXORAMEET\0000).
            if (!SetupDiCreateDeviceInfo(set, hardwareId, ref classGuid, null, IntPtr.Zero, DICD_GENERATE_ID, ref data))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "SetupDiCreateDeviceInfo");

            // REG_MULTI_SZ: "hwid\0\0"
            byte[] multiSz = Encoding.Unicode.GetBytes(hardwareId + "\0\0");
            if (!SetupDiSetDeviceRegistryProperty(set, ref data, SPDRP_HARDWAREID, multiSz, multiSz.Length))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "SetupDiSetDeviceRegistryProperty");

            if (!SetupDiCallClassInstaller(DIF_REGISTERDEVICE, set, ref data))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "SetupDiCallClassInstaller(DIF_REGISTERDEVICE)");
        }
        finally
        {
            SetupDiDestroyDeviceInfoList(set);
        }

        if (!UpdateDriverForPlugAndPlayDevices(IntPtr.Zero, hardwareId, infPath, INSTALLFLAG_FORCE, out rebootRequired))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "UpdateDriverForPlugAndPlayDevices");
        return true;
    }
}
'@
            $mediaClass = [Guid]'{4d36e96c-e325-11ce-bfc1-08002be10318}'
            $reboot = $false
            [VoxoraSetupApi]::CreateRootDevice($mediaClass, $HardwareId, $InfPath, [ref]$reboot) | Out-Null
            if ($reboot) { Write-Warning "Windows pide reiniciar para completar la instalación." }
        }
    }
}

# --- 5. Verificación -----------------------------------------------------------
Start-Sleep -Seconds 2
Write-Step "Dispositivo:"
Get-VoxoraDevice | Format-Table -AutoSize Status, Class, FriendlyName, InstanceId | Out-String | Write-Host

Write-Step "Endpoints de audio VOXORA:"
$endpoints = Get-PnpDevice -Class AudioEndpoint -ErrorAction SilentlyContinue |
    Where-Object { $_.FriendlyName -like '*VOXORA*' }
if ($endpoints) {
    $endpoints | Format-Table -AutoSize Status, FriendlyName | Out-String | Write-Host
    Write-Host "Instalación completada. Selecciona 'VOXORA Meet Microphone' en Meet/Zoom." -ForegroundColor Green
} else {
    Write-Warning "Todavía no aparecen endpoints VOXORA. Revisa el Administrador de dispositivos (clase 'Controladoras de sonido') y el estado del nodo ROOT\VOXORAMEET (código de error)."
}
