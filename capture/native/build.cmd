@echo off
rem Compila wasapi-capture.exe con MSVC (cl.exe). Requiere un entorno de desarrollador
rem (vcvars64.bat) ya cargado. Deja el binario en native\bin\wasapi-capture.exe.
setlocal
cd /d "%~dp0"
where cl.exe >nul 2>nul
if errorlevel 1 (
  echo [build] cl.exe no esta en el PATH. Ejecuta antes vcvars64.bat.
  exit /b 1
)
if not exist bin mkdir bin
if not exist obj mkdir obj
rem VERSIONINFO con la version del package.json raiz (native-common\voxora_version.h).
rc.exe /nologo /i "..\..\native-common" /fo obj\version.res version.rc
if errorlevel 1 (
  echo [build] fallo rc.exe ^(version.rc^)
  if exist obj rmdir /s /q obj
  exit /b 1
)
cl.exe /nologo /std:c++17 /O2 /W4 /WX /EHsc /MT /permissive- /utf-8 ^
  /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /DNOMINMAX ^
  /Fo:obj\ /Fe:bin\wasapi-capture.exe wasapi-capture.cpp obj\version.res ^
  /link /SUBSYSTEM:CONSOLE ole32.lib avrt.lib ksuser.lib
set "result=%errorlevel%"
if exist obj rmdir /s /q obj
if not "%result%"=="0" (
  echo [build] fallo la compilacion ^(codigo %result%^)
  exit /b %result%
)
echo [build] ok: bin\wasapi-capture.exe
exit /b 0
