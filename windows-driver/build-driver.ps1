<#
.SYNOPSIS
  Envoltorio PowerShell de build-driver.cmd (compila voxorameet.sys sin
  instalar el WDK ni pedir administrador).

.DESCRIPTION
  Toda la lógica vive en build-driver.cmd (necesita cmd.exe para cargar
  vcvars64.bat). Este script solo traduce parámetros y propaga el código de
  salida, para poder lanzarlo desde PowerShell o desde Git Bash:

    powershell -NoProfile -ExecutionPolicy Bypass -File build-driver.ps1 -Configuration Release

  (Desde Git Bash, `cmd //c "..."` rompe las comillas de rutas con espacios;
  usar este .ps1 o ejecutar build-driver.cmd desde cmd/PowerShell.)

.PARAMETER Configuration
  Release (por defecto; genera también out\cab\voxorameet.cab) o Debug.

.PARAMETER Version
  Versión a.b.c.d para DriverVer (stampinf) y el recurso de versión del .sys.
  Debe subir en cada envío a Partner Center. Por defecto 1.0.0.0.

.PARAMETER NoFetch
  No descargar el WDK de NuGet (falla si .wdk\ no está).

.PARAMETER NoCab
  No generar el .cab de Partner Center.

.PARAMETER Analyze
  Ejecuta además Code Analysis (/analyze) con el plugin de drivers del WDK.

.EXAMPLE
  PS> .\build-driver.ps1
  PS> .\build-driver.ps1 -Version 1.0.1.0 -Analyze
  PS> .\build-driver.ps1 -Configuration Debug
#>
[CmdletBinding()]
param(
    [ValidateSet('Release', 'Debug')]
    [string]$Configuration = 'Release',
    [ValidatePattern('^\d+\.\d+\.\d+\.\d+$')]
    [string]$Version,
    [switch]$NoFetch,
    [switch]$NoCab,
    [switch]$Analyze
)

$ErrorActionPreference = 'Stop'
$cmdArgs = @($Configuration)
if ($NoFetch) { $cmdArgs += '/nofetch' }
if ($NoCab)   { $cmdArgs += '/nocab' }
if ($Analyze) { $cmdArgs += '/analyze' }

$previous = $env:VOXORA_DRIVER_VERSION
try {
    if ($Version) { $env:VOXORA_DRIVER_VERSION = $Version }
    & (Join-Path $PSScriptRoot 'build-driver.cmd') @cmdArgs
    $code = $LASTEXITCODE
}
finally {
    $env:VOXORA_DRIVER_VERSION = $previous
}
exit $code
