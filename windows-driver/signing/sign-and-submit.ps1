<#
.SYNOPSIS
  Prepara y firma con el certificado EV el .cab de voxorameet para la firma
  por atestación en Microsoft Partner Center, y verifica el paquete devuelto.

.DESCRIPTION
  Modo "Prepare" (por defecto), tras `build-driver.cmd` (Release):
    1. Valida out\package\voxorameet.inf con infverif /h (reglas de firma de
       Microsoft, las que aplica Partner Center).
    2. makecab /f make-cab.ddf  ->  out\cab\voxorameet.cab (inf+sys+pdb)
    3. signtool sign /fd sha256 /tr <timestamp> /td sha256 con el EV
       (/sha1 <huella>, /n <sujeto> o /a si no se indica ninguno).
    4. signtool verify /pa /v sobre el .cab.
    5. Imprime los pasos de subida (la subida es manual en el dashboard; no
       hay API pública para crear submissions de hardware).

  Modo "VerifySigned":
    Verifica el zip/carpeta devuelto por Microsoft: signtool verify /kp sobre
    el .sys (política de firma de kernel) y el .cat firmado por
    "Microsoft Windows Hardware Compatibility Publisher".

.PARAMETER CertThumbprint
  Huella SHA-1 del certificado EV en el almacén CurrentUser\My (o en el token
  USB/HSM expuesto por el CSP del proveedor). Alternativa: -CertSubject. Si no
  se indica ninguno se usa `signtool /a` (elige automáticamente el mejor
  certificado de firma de código disponible: comprobar el firmante en la
  salida).

.PARAMETER TimestampUrl
  Servidor RFC 3161. DigiCert: http://timestamp.digicert.com  ·
  Sectigo: http://timestamp.sectigo.com · SSL.com: http://ts.ssl.com

.EXAMPLE
  PS> .\sign-and-submit.ps1 -CertThumbprint 0123ABCD...
  PS> .\sign-and-submit.ps1 -Mode VerifySigned -SignedPackage C:\Downloads\Signed_1234\
#>
[CmdletBinding()]
param(
    [ValidateSet('Prepare', 'VerifySigned')]
    [string]$Mode = 'Prepare',
    [string]$CertThumbprint,
    [string]$CertSubject,
    [string]$TimestampUrl = 'http://timestamp.digicert.com',
    [string]$SignedPackage,
    [switch]$SkipInfVerif
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $root 'out\package'
$cabPath = Join-Path $root 'out\cab\voxorameet.cab'

function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

function Find-Tool([string]$name) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    # WDK/SDK locales de NuGet (build-driver.cmd) y, si no, el Windows Kit instalado.
    foreach ($base in @((Join-Path $root '.wdk'), "${env:ProgramFiles(x86)}\Windows Kits\10\bin")) {
        if (-not (Test-Path $base)) { continue }
        $hit = Get-ChildItem -Path $base -Recurse -Filter $name -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\x64\\' } |
            Sort-Object FullName -Descending | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}

$signtool = Find-Tool 'signtool.exe'
if (-not $signtool) { throw "signtool.exe no encontrado (instala el Windows SDK o el WDK)." }

if ($Mode -eq 'VerifySigned') {
    if (-not $SignedPackage) { throw "Indica -SignedPackage <carpeta o zip descargado de Partner Center>." }
    $dir = $SignedPackage
    if ($SignedPackage -like '*.zip') {
        $dir = Join-Path $env:TEMP ("voxorameet-signed-" + [guid]::NewGuid().ToString('N'))
        Expand-Archive -Path $SignedPackage -DestinationPath $dir -Force
    }
    $sys = Get-ChildItem -Path $dir -Recurse -Filter 'voxorameet.sys' | Select-Object -First 1
    $cat = Get-ChildItem -Path $dir -Recurse -Filter 'voxorameet.cat' | Select-Object -First 1
    if (-not $sys -or -not $cat) { throw "El paquete firmado debe contener voxorameet.sys y voxorameet.cat." }

    Write-Step "signtool verify /kp (política de kernel) sobre $($sys.FullName)"
    & $signtool verify /v /kp $sys.FullName
    if ($LASTEXITCODE -ne 0) { throw "El .sys no pasa la política de firma de kernel." }

    Write-Step "signtool verify /pa sobre el catálogo"
    & $signtool verify /v /pa $cat.FullName
    if ($LASTEXITCODE -ne 0) { throw "El .cat no verifica." }

    $signer = (Get-AuthenticodeSignature $cat.FullName).SignerCertificate.Subject
    Write-Host "Firmante del catálogo: $signer"
    if ($signer -notmatch 'Microsoft Windows Hardware Compatibility Publisher') {
        Write-Warning "El firmante no es el esperado para atestación."
    }
    Write-Host "Paquete listo para instalar en cualquier Windows 10/11 x64 (Secure Boot/HVCI incluidos)." -ForegroundColor Green
    return
}

# --------------------------------------------------------------------------
# Modo Prepare
# --------------------------------------------------------------------------
if (-not (Test-Path (Join-Path $releaseDir 'voxorameet.sys'))) {
    throw "No existe el paquete Release en $releaseDir. Ejecuta build-driver.cmd (Release)."
}
if (-not (Test-Path (Join-Path $root 'out\symbols\voxorameet.pdb'))) {
    throw "Falta out\symbols\voxorameet.pdb (lo genera build-driver.cmd)."
}

if (-not $SkipInfVerif) {
    $infverif = Find-Tool 'infverif.exe'
    if ($infverif) {
        # /h = requisitos de firma de Microsoft (lo que valida Partner Center).
        # /w (DCH) falla a propósito por las claves HKLM\...\MediaCategories.
        Write-Step "infverif /v /h (requisitos de firma de Microsoft)"
        & $infverif /v /h (Join-Path $releaseDir 'voxorameet.inf')
        if ($LASTEXITCODE -ne 0) { throw "infverif reporta errores: corrígelos antes de enviar (Partner Center también los rechaza)." }
    } else {
        Write-Warning "infverif.exe no encontrado (WDK); se omite la validación del INF."
    }
}

Push-Location $PSScriptRoot
try {
    Write-Step "makecab /f make-cab.ddf"
    $cabDir = Split-Path -Parent $cabPath
    if (-not (Test-Path $cabDir)) { New-Item -ItemType Directory $cabDir | Out-Null }
    if (Test-Path $cabPath) { Remove-Item -Force $cabPath }
    & makecab.exe /f make-cab.ddf | Out-Null
    $cab = $cabPath
    if (-not (Test-Path $cab)) { throw "makecab no generó $cab" }

    $certArgs = if ($CertThumbprint) { @('/sha1', $CertThumbprint) }
                elseif ($CertSubject) { @('/n', $CertSubject) }
                else { Write-Warning "Sin -CertThumbprint/-CertSubject: signtool /a elige el certificado."; @('/a') }
    Write-Step "signtool sign (EV, SHA-256, timestamp RFC 3161)"
    & $signtool sign /v /fd sha256 /tr $TimestampUrl /td sha256 @certArgs $cab
    if ($LASTEXITCODE -ne 0) { throw "signtool sign falló. ¿Token EV conectado / PIN?" }

    Write-Step "signtool verify /pa /v"
    & $signtool verify /v /pa $cab
    if ($LASTEXITCODE -ne 0) { throw "El .cab firmado no verifica." }

    Write-Host ""
    Write-Host "CAB firmado: $cab" -ForegroundColor Green
    Write-Host @"

Siguiente (manual, ~10-60 min):
  1. https://partner.microsoft.com/dashboard/hardware  -> Submit new hardware
  2. Nombre: "VOXORA Meet Virtual Audio <versión>"; arrastra out\cab\voxorameet.cab
  3. Marca solo "Windows 10/11 Client x64" (todas las versiones que soportes);
     NO adjuntes HLKX; acepta la casilla de atestación.
  4. Submit -> espera el estado "Signed" -> "Download signed files".
  5. Verifica:  .\sign-and-submit.ps1 -Mode VerifySigned -SignedPackage <zip>
  6. Copia inf/sys/cat firmados al instalador (installer\install.ps1 -InfPath ...).
"@
}
finally {
    Pop-Location
}
