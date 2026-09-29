<#
.SYNOPSIS
  Desinstala el driver de audio virtual VOXORA Meet: elimina el nodo
  ROOT\VOXORAMEET y quita el paquete voxorameet.inf del Driver Store.

.EXAMPLE
  PS> .\uninstall.ps1
  PS> .\uninstall.ps1 -KeepDriverStore   # solo quita el dispositivo
#>
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$HardwareId = 'ROOT\VOXORAMEET',
    [switch]$KeepDriverStore
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# --- 1. Eliminar el/los nodos de dispositivo ----------------------------------
$devices = Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like "$HardwareId*" }
if (-not $devices) {
    Write-Host "No hay dispositivos $HardwareId presentes."
} else {
    foreach ($dev in $devices) {
        Write-Step "pnputil /remove-device $($dev.InstanceId)"
        & pnputil.exe /remove-device "$($dev.InstanceId)" | ForEach-Object { Write-Host "    $_" }
        if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3010) {
            # Alternativa si pnputil no soporta /remove-device (Windows 10 < 2004)
            $devcon = Get-Command devcon.exe -ErrorAction SilentlyContinue
            if ($devcon) {
                & $devcon.Source remove "@$($dev.InstanceId)" | ForEach-Object { Write-Host "    $_" }
            } else {
                Write-Warning "No se pudo eliminar $($dev.InstanceId) (código $LASTEXITCODE)."
            }
        }
    }
}

# --- 2. Quitar el paquete del Driver Store -------------------------------------
if (-not $KeepDriverStore) {
    Write-Step "Buscando voxorameet.inf en el Driver Store"
    $enum = & pnputil.exe /enum-drivers 2>&1
    $published = @()
    $current = $null
    foreach ($line in $enum) {
        # Formato: "Published Name:     oem42.inf" / "Original Name:      voxorameet.inf"
        if ($line -match '^\s*(Published Name|Nombre publicado)\s*:\s*(\S+)') { $current = $Matches[2] }
        elseif ($line -match '^\s*(Original Name|Nombre original)\s*:\s*(\S+)' -and $Matches[2] -ieq 'voxorameet.inf') {
            if ($current) { $published += $current }
        }
    }
    if (-not $published) {
        Write-Host "voxorameet.inf no está en el Driver Store."
    }
    foreach ($oem in ($published | Select-Object -Unique)) {
        Write-Step "pnputil /delete-driver $oem /uninstall /force"
        & pnputil.exe /delete-driver $oem /uninstall /force | ForEach-Object { Write-Host "    $_" }
    }
}

# --- 3. Verificación ---------------------------------------------------------------
$left = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like "$HardwareId*" }
if ($left) {
    Write-Warning "Quedan dispositivos presentes; puede hacer falta reiniciar."
} else {
    Write-Host "Desinstalación completada." -ForegroundColor Green
}
