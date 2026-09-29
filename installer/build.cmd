@echo off
setlocal EnableExtensions
rem Compila el instalador propio de VOXORA Meet (MSVC x64, CRT estático, sin dependencias externas salvo el
rem SDK de WebView2 vendorizado en app\native-shell\third_party\webview2). Requiere vcvars64 cargado
rem (lo hace scripts/build-native.mjs o scripts/release.mjs) y la UI generada en build\gen\setup-ui.html.
rem
rem   build.cmd           vxpack.exe + VoxoraMeetUninstall.exe (sin carga útil) en bin\
rem   build.cmd setup     ademas VoxoraMeetSetup.exe con build\gen\payload.rc (carga útil) en bin\
cd /d "%~dp0"
where cl.exe >nul 2>nul || (echo [installer] cl.exe no esta en PATH: carga vcvars64.bat & exit /b 1)
if not exist build\gen\setup-ui.html (echo [installer] falta build\gen\setup-ui.html: node scripts/build-installer.mjs & exit /b 1)
if not exist bin mkdir bin
if not exist build\obj mkdir build\obj

set "WV=..\app\native-shell\third_party\webview2"
set "CXXFLAGS=/nologo /std:c++17 /O2 /W4 /WX /EHsc /MT /permissive- /utf-8 /Zc:__cplusplus /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /DNOMINMAX /DNDEBUG /Isrc /I..\native-common /I..\app\native-shell\src /external:W0 /external:I%WV%\include"
set "LIBS=%WV%\x64\WebView2LoaderStatic.lib user32.lib gdi32.lib shell32.lib ole32.lib oleaut32.lib advapi32.lib shlwapi.lib comctl32.lib dwmapi.lib urlmon.lib wintrust.lib crypt32.lib bcrypt.lib cabinet.lib version.lib uuid.lib"

echo [installer] vxpack.exe
cl %CXXFLAGS% /Fobuild\obj\ /Febin\vxpack.exe tools\vxpack.cpp src\payload.cpp /link /SUBSYSTEM:CONSOLE bcrypt.lib cabinet.lib || exit /b 1

echo [installer] objetos
cl %CXXFLAGS% /c /Fobuild\obj\ src\setup_main.cpp src\install_ops.cpp src\payload.cpp || exit /b 1

echo [installer] VoxoraMeetUninstall.exe
pushd res
rc /nologo /i ..\build /i ..\..\native-common /fo ..\build\obj\uninstall.res uninstall.rc
set "RCERR=%ERRORLEVEL%"
popd
if not "%RCERR%"=="0" exit /b 1
link /nologo /OUT:bin\VoxoraMeetUninstall.exe /SUBSYSTEM:WINDOWS /MANIFEST:NO /OPT:REF /OPT:ICF /DYNAMICBASE /NXCOMPAT /CETCOMPAT ^
  build\obj\setup_main.obj build\obj\install_ops.obj build\obj\payload.obj build\obj\uninstall.res %LIBS% || exit /b 1

if /I not "%~1"=="setup" goto :done
if not exist build\gen\payload.rc (echo [installer] falta build\gen\payload.rc & exit /b 1)
echo [installer] VoxoraMeetSetup.exe (con carga util)
pushd res
rc /nologo /i ..\build /i ..\..\native-common /fo ..\build\obj\setup.res setup.rc
set "RCERR=%ERRORLEVEL%"
popd
if not "%RCERR%"=="0" exit /b 1
link /nologo /OUT:bin\VoxoraMeetSetup.exe /SUBSYSTEM:WINDOWS /MANIFEST:NO /OPT:REF /OPT:ICF /DYNAMICBASE /NXCOMPAT /CETCOMPAT ^
  build\obj\setup_main.obj build\obj\install_ops.obj build\obj\payload.obj build\obj\setup.res %LIBS% || exit /b 1

:done
echo [installer] OK
exit /b 0
