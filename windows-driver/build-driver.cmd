@echo off
rem ===========================================================================
rem build-driver.cmd - Compila voxorameet.sys SIN instalar el WDK ni pedir admin.
rem
rem   build-driver.cmd [Release^|Debug] [/nofetch] [/nocab] [/analyze]
rem
rem Pasos:
rem   1. Descarga (una vez) los paquetes NuGet del WDK/SDK 10.0.26100 y los
rem      extrae en .wdk\ (curl.exe + tar.exe de Windows; nada a nivel sistema).
rem   2. Carga vcvars64.bat (MSVC 14.5x) y reemplaza INCLUDE/LIB por las rutas
rem      km/crt, km, shared y km\x64 del WDK extraido (como el toolset
rem      WindowsKernelModeDriver10.0).
rem   3. cl.exe + rc.exe + link.exe con los flags exactos de los .props del WDK
rem      (WindowsDriver.Shared.Props, .Common.props, .KernelMode.props,
rem      .KernelMode.Wdm.props, WindowsDriver.x64.props).
rem   4. stampinf (DriverVer), infverif /h (bloqueante) y /w (informativo),
rem      inf2cat, ApiValidator (informativo) y makecab (.cab para Partner Center).
rem
rem Salida:
rem   out\package\        voxorameet.sys, voxorameet.inf, voxorameet.cat  (Release)
rem   out\symbols\        voxorameet.pdb (aparte: NO va en el paquete que se instala)
rem   out\cab\            voxorameet.cab (inf+sys+pdb) -> firmar con el EV y subir
rem   out\package-debug\  idem para Debug (sin .cab)
rem
rem Variables opcionales:
rem   VOXORA_DRIVER_VERSION  version a.b.c.d para DriverVer y el recurso (1.0.0.0)
rem   VCVARS64               ruta a vcvars64.bat si no se detecta con vswhere
rem
rem NO firma, NO instala, NO toca bcdedit ni el registro.
rem ===========================================================================
setlocal EnableExtensions

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "CONFIG=Release"
set "DO_FETCH=1"
set "DO_CAB=1"
set "DO_ANALYZE=0"
:parse_args
if "%~1"=="" goto args_done
if /i "%~1"=="Release"  set "CONFIG=Release"& shift & goto parse_args
if /i "%~1"=="Debug"    set "CONFIG=Debug"& shift & goto parse_args
if /i "%~1"=="/nofetch" set "DO_FETCH=0"& shift & goto parse_args
if /i "%~1"=="/nocab"   set "DO_CAB=0"& shift & goto parse_args
if /i "%~1"=="/analyze" set "DO_ANALYZE=1"& shift & goto parse_args
echo [build] argumento desconocido: %~1
echo uso: build-driver.cmd [Release^|Debug] [/nofetch] [/nocab] [/analyze]
exit /b 2
:args_done

if "%VOXORA_DRIVER_VERSION%"=="" set "VOXORA_DRIVER_VERSION=1.0.0.0"
for /f "tokens=1-4 delims=." %%a in ("%VOXORA_DRIVER_VERSION%") do (
    set "VER_A=%%a"& set "VER_B=%%b"& set "VER_C=%%c"& set "VER_D=%%d"
)
if "%VER_D%"=="" (
    echo [build] VOXORA_DRIVER_VERSION debe tener 4 partes a.b.c.d ^(actual: %VOXORA_DRIVER_VERSION%^)
    exit /b 2
)

rem --- Versiones del kit (NuGet) ----------------------------------------------
rem Ultimo WDK 10.0.26100.x publicado en nuget.org (index.json de
rem microsoft.windows.wdk.x64). El SDK.CPP va a la MISMA version.
set "NUGET_VER=10.0.26100.6584"
set "KIT_VER=10.0.26100.0"
set "WDKROOT=%ROOT%\.wdk"
set "PKG_WDK=Microsoft.Windows.WDK.x64"
set "PKG_SDK=Microsoft.Windows.SDK.CPP"
set "PKG_SDK64=Microsoft.Windows.SDK.CPP.x64"

set "WDKC=%WDKROOT%\%PKG_WDK%\c"
set "SDKC=%WDKROOT%\%PKG_SDK%\c"
set "INC_KM=%WDKC%\Include\%KIT_VER%\km"
set "INC_CRT=%WDKC%\Include\%KIT_VER%\km\crt"
set "INC_SHARED=%SDKC%\Include\%KIT_VER%\shared"
set "INC_SHARED_WDK=%WDKC%\Include\%KIT_VER%\shared"
set "INC_UM=%SDKC%\Include\%KIT_VER%\um"
set "LIB_KM=%WDKC%\Lib\%KIT_VER%\km\x64"
set "WDKBIN=%WDKC%\bin\%KIT_VER%"
set "SDKBIN=%SDKC%\bin\%KIT_VER%\x64"
set "INFVERIF=%WDKC%\tools\%KIT_VER%\x64\infverif.exe"
set "UDDI=%WDKC%\build\%KIT_VER%\universalDDIs\x64"

rem Herramientas inbox explicitas (desde Git Bash el PATH trae otro tar/curl).
set "CURL=%SystemRoot%\System32\curl.exe"
set "TAR=%SystemRoot%\System32\tar.exe"
set "MAKECAB=%SystemRoot%\System32\makecab.exe"

rem --- 1. WDK/SDK desde NuGet ---------------------------------------------------
if exist "%INC_KM%\portcls.h" if exist "%SDKBIN%\rc.exe" if exist "%INC_SHARED%\ntverp.h" goto kit_ready
if "%DO_FETCH%"=="0" (
    echo [build] Falta el WDK en %WDKROOT% y se paso /nofetch.
    exit /b 1
)
call :fetch_pkg %PKG_WDK% || exit /b 1
call :fetch_pkg %PKG_SDK% || exit /b 1
call :fetch_pkg %PKG_SDK64% || exit /b 1
:kit_ready
if not exist "%INC_KM%\portcls.h" ( echo [build] WDK incompleto: falta %INC_KM%\portcls.h & exit /b 1 )
echo [build] WDK/SDK %NUGET_VER% en %WDKROOT%

rem --- 2. MSVC (vcvars64) ------------------------------------------------------------
if defined VCVARS64 goto have_vcvars
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" goto no_vswhere
rem "call" delante: si la linea de for /f empieza por comillas, cmd /c las
rem recorta y rompe la ruta "Program Files (x86)".
for /f "usebackq delims=" %%i in (`call "%VSWHERE%" -latest -prerelease -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSINSTALL=%%i"
:no_vswhere
if defined VSINSTALL set "VCVARS64=%VSINSTALL%\VC\Auxiliary\Build\vcvars64.bat"
if not defined VCVARS64 set "VCVARS64=%ProgramFiles%\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat"
:have_vcvars
if not exist "%VCVARS64%" ( echo [build] No se encuentra vcvars64.bat ^(define VCVARS64^) & exit /b 1 )
rem stderr a nul: VsDevCmd.bat invoca "vswhere.exe" relativo al directorio
rem actual solo para leer la version, y falla (inocuo) si el entorno define
rem NoDefaultCurrentDirectoryInExePath. El resultado real se comprueba abajo.
call "%VCVARS64%" >nul 2>nul
where cl.exe >nul 2>nul || ( echo [build] cl.exe no esta en PATH tras "%VCVARS64%" - ejecutalo a mano para ver el error & exit /b 1 )
echo [build] MSVC %VCToolsVersion% ^(%VCVARS64%^)

rem Igual que WindowsDriver.KernelMode.props:
rem   IncludePath = CRT_IncludePath;KM_IncludePath;KIT_SHARED_IncludePath;KIT_SHARED_INC_PATH_WDK
rem (sin los headers user-mode de MSVC/UCRT que mete vcvars).
set "INCLUDE=%INC_CRT%;%INC_KM%;%INC_SHARED%;%INC_SHARED_WDK%"
set "LIB=%LIB_KM%"
set "LIBPATH="

rem --- Directorios de salida ------------------------------------------------------------
set "OUT=%ROOT%\out"
set "OBJ=%OUT%\obj\%CONFIG%"
set "BIN=%OUT%\bin\%CONFIG%"
set "SYM=%OUT%\symbols"
set "CABDIR=%OUT%\cab"
if /i "%CONFIG%"=="Release" (set "PKG=%OUT%\package") else (set "PKG=%OUT%\package-debug")
for %%d in ("%OBJ%" "%BIN%" "%PKG%") do (
    if exist "%%~d" rmdir /s /q "%%~d"
    mkdir "%%~d"
)
if not exist "%SYM%" mkdir "%SYM%"

rem --- 3. Compilacion -----------------------------------------------------------------
rem NTDDI_VERSION = NTDDI_WIN10_VB (Windows 10 2004, build 19041): minimo real
rem del driver (ExAllocatePool2) y coherente con la decoracion del INF
rem (NTamd64.10.0...19041). El toolset por defecto usaria 0x0A000010 (Win11 24H2),
rem lo que permitiria colar APIs que no existen en Windows 10.
set "DEFS=/D_WIN64 /D_AMD64_ /DAMD64 /D_WIN32_WINNT=0x0A00 /DWINVER=0x0A00 /DWINNT=1 /DNTDDI_VERSION=0x0A000008"
set "RCDEFS=/D_WIN64 /D_AMD64_=1 /DAMD64 /D_WIN32_WINNT=0x0A00 /DWINVER=0x0A00 /DWINNT=1 /DNTDDI_VERSION=0x0A000008"

rem Flags comunes (WindowsDriver.*.props del WDK 10.0.26100):
rem   /kernel -cbstring (KernelMode.props), -d2epilogunwind (x64.props),
rem   /d1import_no_registry /d2AllowCompatibleILVersions /d2Zi+ (Shared.Props),
rem   /GS /Gz /Zc:wchar_t- /Zp8 /GF /Gy /GR- /Oy- (Shared.Props),
rem   /W4 /WX /Zi /guard:cf /FI warning.h (Common.props),
rem   /wd4603 /wd4627 /wd4986 /wd4987 (Shared.Props: DisableSpecificWarnings).
set "CFLAGS=/nologo /c /kernel -cbstring -d2epilogunwind /d1import_no_registry /d2AllowCompatibleILVersions /d2Zi+"
set "CFLAGS=%CFLAGS% /Zi /FS /W4 /WX /wd4603 /wd4627 /wd4986 /wd4987 /GS /Gz /Zc:wchar_t- /Zc:forScope /Zc:inline /fp:precise"
set "CFLAGS=%CFLAGS% /Zp8 /GF /Gy /GR- /Oy- /guard:cf /std:c++17 /diagnostics:caret"
if /i "%CONFIG%"=="Release" (
    set "CFLAGS=%CFLAGS% /Ox /Os /d1nodatetime"
) else (
    set "CFLAGS=%CFLAGS% /Od /Oi /homeparams /wd4748"
    set "DEFS=%DEFS% /DDBG=1 /DDEPRECATE_DDK_FUNCTIONS=1 /DMSC_NOOPT"
    set "RCDEFS=%RCDEFS% /DDBG=1 /DDEPRECATE_DDK_FUNCTIONS=1 /DMSC_NOOPT"
)

rem /analyze: Code Analysis con el plugin de drivers del WDK (reglas IRQL,
rem PAGED_CODE, spinlocks, SAL...) y el ruleset "DriverRecommendedRules" que usa
rem VS con RunCodeAnalysis. Los avisos de analisis NO rompen el build (/analyze:WX-).
rem /analyze:external- excluye los headers del WDK (INCLUDE), como CAExcludePath
rem en MSBuild; /external:W4 mantiene el nivel de aviso normal del compilador.
if "%DO_ANALYZE%"=="1" set "CFLAGS=%CFLAGS% /analyze /analyze:WX- /analyze:stacksize1024 /external:env:INCLUDE /external:W4 /analyze:external- /analyze:plugin"%WDKBIN%\x64\drivers.dll" /analyze:rulesetdirectory"%VSINSTALLDIR%Team Tools\Static Analysis Tools\Rule Sets;%WDKC%\CodeAnalysis" /analyze:ruleset"%WDKC%\CodeAnalysis\DriverRecommendedRules.ruleset""
echo [build] cl.exe (%CONFIG%, x64, /kernel /W4 /WX)
pushd "%ROOT%\src"
cl.exe %CFLAGS% %DEFS% /FI"%INC_SHARED%\warning.h" /I"%ROOT%\src" /I"%OBJ%" /Fo"%OBJ%\\" /Fd"%OBJ%\vc.pdb" adapter.cpp loopback.cpp mintopo.cpp minwavert.cpp
if errorlevel 1 ( popd & echo [build] ERROR de compilacion & exit /b 1 )
popd

echo [build] rc.exe
rem ResourceCompile: AdditionalIncludeDirectories = UM_IncludePath (windows.h).
"%SDKBIN%\rc.exe" /nologo %RCDEFS% /DVOXORA_VER_MAJOR=%VER_A% /DVOXORA_VER_MINOR=%VER_B% /DVOXORA_VER_BUILD=%VER_C% /DVOXORA_VER_REV=%VER_D% /I"%INC_UM%" /I"%ROOT%\src" /fo"%OBJ%\voxorameet.res" "%ROOT%\src\voxorameet.rc"
if errorlevel 1 ( echo [build] ERROR en rc.exe & exit /b 1 )

rem --- Enlace -------------------------------------------------------------------------
rem WindowsDriver.Shared.Props + KernelMode.props + KernelMode.Wdm.props + x64.props:
rem   /DRIVER /KERNEL /SUBSYSTEM:NATIVE,10.00 /ENTRY:GsDriverEntry /NODEFAULTLIB
rem   /OSVERSION:10.0 /VERSION:10.0 /pdbcompress /DEBUGTYPE:CV,PDATA /PROFILE
rem   /OPT:REF /OPT:ICF /INCREMENTAL:NO /MERGE:_TEXT=.text;_PAGE=PAGE /RELEASE
rem   /SECTION:INIT,d /IGNORE:... /WX /guard:cf
rem Extra (no esta en los .props): /PDBALTPATH:%_PDB% para que el .sys que se
rem distribuye no incruste la ruta local del PDB (solo "voxorameet.pdb").
rem Libs WDM: BufferOverflowFastFailK ntoskrnl hal wmilib (+ las del vcxproj).
set "LIBS=portcls.lib stdunk.lib ksguid.lib libcntpr.lib BufferOverflowFastFailK.lib ntoskrnl.lib hal.lib wmilib.lib"
set "LFLAGS=/nologo /DRIVER /KERNEL /SUBSYSTEM:NATIVE,10.00 /ENTRY:GsDriverEntry /NODEFAULTLIB /MANIFEST:NO"
set "LFLAGS=%LFLAGS% /DEBUG:FULL /DEBUGTYPE:CV,PDATA /pdbcompress /PDBALTPATH:%%_PDB%% /OSVERSION:10.0 /VERSION:10.0 /PROFILE"
set "LFLAGS=%LFLAGS% /OPT:REF /OPT:ICF /INCREMENTAL:NO /MERGE:_TEXT=.text /MERGE:_PAGE=PAGE /RELEASE /SECTION:INIT,d"
set "LFLAGS=%LFLAGS% /IGNORE:4198,4010,4037,4039,4065,4070,4078,4087,4089,4221,4108,4088,4218,4235 /WX /MACHINE:X64 /guard:cf"

echo [build] link.exe
link.exe %LFLAGS% /LIBPATH:"%LIB_KM%" /OUT:"%BIN%\voxorameet.sys" /PDB:"%BIN%\voxorameet.pdb" /MAP:"%BIN%\voxorameet.map" "%OBJ%\adapter.obj" "%OBJ%\loopback.obj" "%OBJ%\mintopo.obj" "%OBJ%\minwavert.obj" "%OBJ%\voxorameet.res" %LIBS%
if errorlevel 1 ( echo [build] ERROR de enlace & exit /b 1 )

rem --- 4. Paquete -------------------------------------------------------------------------
copy /y "%BIN%\voxorameet.sys" "%PKG%\" >nul || exit /b 1
copy /y "%ROOT%\voxorameet.inf" "%PKG%\" >nul || exit /b 1
if /i "%CONFIG%"=="Release" (copy /y "%BIN%\voxorameet.pdb" "%SYM%\voxorameet.pdb" >nul) else (copy /y "%BIN%\voxorameet.pdb" "%SYM%\voxorameet-debug.pdb" >nul)

echo [build] stampinf DriverVer = fecha de hoy, %VOXORA_DRIVER_VERSION%
set "SDK_INC_PATH=%INC_SHARED%"
"%WDKBIN%\x64\stampinf.exe" -f "%PKG%\voxorameet.inf" -a amd64 -d * -v %VOXORA_DRIVER_VERSION%
if errorlevel 1 ( echo [build] ERROR en stampinf & exit /b 1 )

echo [build] infverif /v /h  (requisitos de firma de Microsoft: lo que valida Partner Center)
"%INFVERIF%" /v /h "%PKG%\voxorameet.inf"
if errorlevel 1 ( echo [build] ERROR: infverif /h no pasa & exit /b 1 )

echo [build] infverif /w  (Windows Driver / DCH - informativo, ver README)
"%INFVERIF%" /w "%PKG%\voxorameet.inf"
if errorlevel 1 echo [build] AVISO: /w reporta el aislamiento de MediaCategories (esperado: driver Desktop, no DCH)

rem Igual que MSBuild (Inf2CatWindowsVersionList = 10_$(DDKPlatform)). El .cat local
rem solo sirve para testsigning: Microsoft genera el suyo en la atestacion.
echo [build] inf2cat /os:10_X64
"%WDKBIN%\x86\Inf2Cat.exe" /driver:"%PKG%" /os:10_X64 /uselocaltime
if errorlevel 1 ( echo [build] ERROR en inf2cat & exit /b 1 )

echo [build] ApiValidator (informativo: el driver es Desktop, no Universal)
"%WDKBIN%\x64\apivalidator.exe" -DriverPackagePath:"%PKG%" -SupportedApiXmlFiles:"%UDDI%\UniversalDDIs.xml" -ModuleWhiteListXmlFiles:"%UDDI%\ModuleWhitelist.xml" -ApiExtractorExePath:"%WDKBIN%\x64"
if errorlevel 1 echo [build] AVISO: ApiValidator reporta APIs fuera de UniversalDDIs (no bloquea la atestacion)

if /i not "%CONFIG%"=="Release" goto summary
if "%DO_CAB%"=="0" goto summary

echo [build] makecab /f signing\make-cab.ddf
if exist "%CABDIR%" rmdir /s /q "%CABDIR%"
mkdir "%CABDIR%"
pushd "%ROOT%\signing"
"%MAKECAB%" /f make-cab.ddf >"%CABDIR%\makecab.log"
if errorlevel 1 ( popd & type "%CABDIR%\makecab.log" & echo [build] ERROR en makecab & exit /b 1 )
popd
if not exist "%CABDIR%\voxorameet.cab" ( echo [build] makecab no genero %CABDIR%\voxorameet.cab & exit /b 1 )

:summary
echo.
echo [build] OK (%CONFIG%)
for %%f in ("%PKG%\voxorameet.sys" "%PKG%\voxorameet.inf" "%PKG%\voxorameet.cat") do echo     %%~f  %%~zf bytes
if /i "%CONFIG%"=="Release" echo     %SYM%\voxorameet.pdb
if exist "%CABDIR%\voxorameet.cab" if /i "%CONFIG%"=="Release" echo     %CABDIR%\voxorameet.cab  (sin firmar: firmar con el token EV, ver signing\README.md)
endlocal
exit /b 0

rem ===========================================================================
rem :fetch_pkg <id>  -> descarga .nupkg (cache en .wdk\dl) y lo extrae en .wdk\<id>
rem ===========================================================================
:fetch_pkg
set "_ID=%~1"
set "_NUPKG=%WDKROOT%\dl\%_ID%.%NUGET_VER%.nupkg"
if not exist "%WDKROOT%\dl" mkdir "%WDKROOT%\dl"
if not exist "%_NUPKG%" (
    echo [build] descargando %_ID% %NUGET_VER% de nuget.org ...
    "%CURL%" -fL --retry 3 -o "%_NUPKG%.part" "https://www.nuget.org/api/v2/package/%_ID%/%NUGET_VER%"
    if errorlevel 1 ( del /q "%_NUPKG%.part" 2>nul & echo [build] fallo la descarga de %_ID% & exit /b 1 )
    move /y "%_NUPKG%.part" "%_NUPKG%" >nul
)
echo [build] extrayendo %_ID% ...
if exist "%WDKROOT%\%_ID%" rmdir /s /q "%WDKROOT%\%_ID%"
mkdir "%WDKROOT%\%_ID%"
"%TAR%" -xf "%_NUPKG%" -C "%WDKROOT%\%_ID%"
if errorlevel 1 ( echo [build] fallo la extraccion de %_ID% & exit /b 1 )
exit /b 0
