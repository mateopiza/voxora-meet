@echo off
rem build.cmd — Compila el helper user-mode wasapi-render.exe con MSVC (x64).
rem Requiere un entorno con vcvars64.bat cargado (lo hace scripts/build-native.mjs
rem o: cmd /c "call "%VS%\VC\Auxiliary\Build\vcvars64.bat" && build.cmd").
rem Sin dependencias externas: solo Windows SDK (mmdeviceapi/audioclient/avrt).

setlocal
cd /d "%~dp0"
if not exist bin mkdir bin
if not exist obj mkdir obj

where cl.exe >nul 2>nul
if errorlevel 1 (
  echo [build] cl.exe no esta en PATH: carga vcvars64.bat primero.
  exit /b 1
)

rem VERSIONINFO con la version del package.json raiz (native-common\voxora_version.h).
rc.exe /nologo /i "..\..\native-common" /fo "obj\version.res" version.rc
if errorlevel 1 (
  echo [build] fallo rc.exe ^(version.rc^)
  exit /b 1
)

cl.exe /nologo /std:c++17 /EHsc /O2 /W4 /WX /DUNICODE /D_UNICODE /utf-8 ^
  /Fo"obj\\" /Fe"bin\wasapi-render.exe" wasapi-render.cpp "obj\version.res" ^
  /link /SUBSYSTEM:CONSOLE ole32.lib avrt.lib
if errorlevel 1 (
  echo [build] fallo la compilacion de wasapi-render.exe
  exit /b 1
)

echo [build] OK: %~dp0bin\wasapi-render.exe
endlocal
exit /b 0
