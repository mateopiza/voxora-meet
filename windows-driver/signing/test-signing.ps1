<#
.SYNOPSIS
  Firma de PRUEBA para desarrollo de voxorameet.sys (sin Partner Center):
  crea un certificado autofirmado, lo instala como raíz/publicador de
  confianza, activa testsigning y firma .sys + .cat.

.DESCRIPTION
  SOLO para máquinas de desarrollo/VM. Windows mostrará "Modo de prueba" en
  el escritorio. Para producción usa la firma por atestación (README.md).

  Pasos:
    1. New-SelfSignedCertificate (Code Signing, RSA 2048, SHA-256) en
       Cert:\CurrentUser\My — o makecert si prefieres el flujo clásico:
         makecert -r -pe -ss PrivateCertStore -n "CN=VOXORA Meet Test" voxora-test.cer
    2. Importa el .cer en LocalMachine\Root y LocalMachine\TrustedPublisher.
    3. bcdedit /set testsigning on   (requiere reinicio; con Secure Boot
       activo hay que desactivarlo en la UEFI, testsigning no arranca con SB).
    4. inf2cat /driver:<dir> /os:10_X64   (WDK) para generar el .cat.
    5. signtool sign /fd sha256 /v /s My /n "VOXORA Meet Test" sobre .cat y .sys.

.EXAMPLE
  PS> .\test-signing.ps1                       # out\package (build-driver.cmd Release)
  PS> .\test-signing.ps1 -PackageDir ..\out\package-debug
#>
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$PackageDir,
    [string]$CertName = 'VOXORA Meet Test',
    [switch]$SkipBcdEdit
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

$root = Split-Path -Parent $PSScriptRoot

function Find-Tool([string]$name) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    # WDK/SDK locales de NuGet (build-driver.cmd) y, si no, el Windows Kit instalado.
    foreach ($base in @((Join-Path $root '.wdk'), "${env:ProgramFiles(x86)}\Windows Kits\10\bin")) {
        if (-not (Test-Path $base)) { continue }
        $hit = Get-ChildItem -Path $base -Recurse -Filter $name -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\(x64|x86)\\' } |
            Sort-Object @{ Expression = { $_.FullName -match '\\x64\\' }; Descending = $true },
                        @{ Expression = 'FullName'; Descending = $true } | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}

if (-not $PackageDir) {
    $PackageDir = @(
        (Join-Path $root 'out\package'),
        (Join-Path $root 'build\x64\Release\voxorameet')
    ) | Where-Object { Test-Path (Join-Path $_ 'voxorameet.sys') } | Select-Object -First 1
    if (-not $PackageDir) { throw "No hay paquete compilado: ejecuta build-driver.cmd (o pasa -PackageDir)." }
}
$PackageDir = (Resolve-Path $PackageDir).Path
$sys = Join-Path $PackageDir 'voxorameet.sys'
$inf = Join-Path $PackageDir 'voxorameet.inf'
$cat = Join-Path $PackageDir 'voxorameet.cat'
if (-not (Test-Path $sys)) { throw "No existe $sys (ejecuta build-driver.cmd primero)." }

$signtool = Find-Tool 'signtool.exe'
if (-not $signtool) { throw "signtool.exe no encontrado." }

# --- 1. Certificado de prueba --------------------------------------------------
Write-Step "Certificado de prueba '$CertName'"
$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq "CN=$CertName" } | Select-Object -First 1
if (-not $cert) {
    $cert = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject "CN=$CertName" `
        -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
        -KeyUsage DigitalSignature `
        -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3') `
        -CertStoreLocation Cert:\CurrentUser\My `
        -NotAfter (Get-Date).AddYears(3)
    Write-Host "    creado: $($cert.Thumbprint)"
} else {
    Write-Host "    reutilizado: $($cert.Thumbprint)"
}

$cerPath = Join-Path $PSScriptRoot 'voxora-test.cer'
Export-Certificate -Cert $cert -FilePath $cerPath -Force | Out-Null

# --- 2. Confianza local ------------------------------------------------------------
Write-Step "Importando en LocalMachine\Root y LocalMachine\TrustedPublisher"
Import-Certificate -FilePath $cerPath -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
Import-Certificate -FilePath $cerPath -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null

# --- 3. testsigning ----------------------------------------------------------------
if (-not $SkipBcdEdit) {
    Write-Step "bcdedit /set testsigning on"
    & bcdedit.exe /set testsigning on | ForEach-Object { Write-Host "    $_" }
    $secureBoot = $false
    try { $secureBoot = Confirm-SecureBootUEFI -ErrorAction Stop } catch { }
    if ($secureBoot) {
        Write-Warning "Secure Boot está ACTIVO: testsigning no tendrá efecto hasta desactivarlo en la UEFI (o usa una VM)."
    }
    Write-Host "    Reinicia para que testsigning aplique." -ForegroundColor Yellow
}

# --- 4. Catálogo --------------------------------------------------------------------
$inf2cat = Find-Tool 'inf2cat.exe'
if ($inf2cat) {
    Write-Step "inf2cat /driver:$PackageDir /os:10_X64"
    & $inf2cat /driver:"$PackageDir" /os:10_X64 /verbose | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) { throw "inf2cat falló." }
} elseif (-not (Test-Path $cat)) {
    Write-Warning "inf2cat.exe no encontrado y no existe voxorameet.cat: la instalación con INF fallará (el build del WDK ya genera el .cat)."
}

# --- 5. Firmar ---------------------------------------------------------------------------
$targets = @($sys)
if (Test-Path $cat) { $targets += $cat }
foreach ($file in $targets) {
    Write-Step "signtool sign /fd sha256 $file"
    & $signtool sign /v /fd sha256 /s My /n "$CertName" $file
    if ($LASTEXITCODE -ne 0) { throw "signtool sign falló en $file" }
}

Write-Step "Verificación (política de kernel en modo de prueba)"
& $signtool verify /v /pa $sys
Write-Host ""
Write-Host "Listo. Tras reiniciar en modo testsigning: installer\install.ps1 -InfPath `"$inf`"" -ForegroundColor Green
