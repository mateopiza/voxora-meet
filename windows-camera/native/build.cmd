@echo off
setlocal EnableExtensions
rem Compila VoxoraMeetVCam.dll, VoxoraMeetVCamHost.exe, VoxoraMeetFrameWriter.exe y el consumidor de
rem prueba E2E VoxoraMeetCameraTest.exe en native\bin\.
rem Debe ejecutarse desde un "x64 Native Tools Command Prompt" o tras `call vcvars64.bat`.
rem Usa CMake (NMake Makefiles) si esta disponible; si no, invoca cl.exe directamente.
rem
rem Uso: build.cmd [Release|Debug] [--no-cmake]

set "ROOT=%~dp0"
set "CONFIG=%~1"
set "FORCE_CL="
if "%CONFIG%"=="" set "CONFIG=Release"
if /I "%CONFIG%"=="--no-cmake" (
  set "CONFIG=Release"
  set "FORCE_CL=1"
)
if /I "%~2"=="--no-cmake" set "FORCE_CL=1"

where cl.exe >nul 2>nul
if errorlevel 1 (
  echo [build] cl.exe no esta en PATH. Ejecute primero vcvars64.bat.
  exit /b 1
)

if not exist "%ROOT%bin" mkdir "%ROOT%bin"

if defined FORCE_CL goto :direct
where cmake.exe >nul 2>nul
if errorlevel 1 goto :direct

echo [build] CMake + NMake (%CONFIG%)
cmake -S "%ROOT%." -B "%ROOT%build" -G "NMake Makefiles" -DCMAKE_BUILD_TYPE=%CONFIG%
if errorlevel 1 (
  echo [build] cmake configure fallo; se intenta compilacion directa con cl.exe
  goto :direct
)
cmake --build "%ROOT%build" --config %CONFIG%
if errorlevel 1 (
  echo [build] cmake build fallo; se intenta compilacion directa con cl.exe
  goto :direct
)
goto :verify

:direct
echo [build] Compilacion directa con cl.exe (%CONFIG%)
set "DEFS=/DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /DNOMINMAX /D_WIN32_WINNT=0x0A00 /DWINVER=0x0A00 /DNTDDI_VERSION=0x0A00000B"
set "CXXFLAGS=/nologo /std:c++17 /W4 /permissive- /EHsc /utf-8 /Zc:__cplusplus /wd4324 /I"%ROOT%common""
if /I "%CONFIG%"=="Debug" (
  set "CXXFLAGS=%CXXFLAGS% /Od /Zi /MTd"
) else (
  set "CXXFLAGS=%CXXFLAGS% /O2 /MT /DNDEBUG"
)
set "OBJ=%ROOT%build-cl"
if not exist "%OBJ%" mkdir "%OBJ%"

pushd "%OBJ%"
rem VERSIONINFO (version del package.json raiz, native-common\voxora_version.h).
for %%R in (vcam host writer) do (
  rc.exe /nologo /i "%ROOT%..\..\native-common" /fo "%OBJ%\%%R.res" "%ROOT%res\%%R.rc"
  if errorlevel 1 ( popd & exit /b 1 )
)
cl %CXXFLAGS% %DEFS% /LD ^
  "%ROOT%vcam-source\dllmain.cpp" "%ROOT%vcam-source\activate.cpp" "%ROOT%vcam-source\media_source.cpp" ^
  "%ROOT%vcam-source\media_stream.cpp" "%ROOT%vcam-source\frame_source.cpp" ^
  "%ROOT%vcam-source\fallback_frame.cpp" "%ROOT%vcam-source\pixel_convert.cpp" "%OBJ%\vcam.res" ^
  /Fe:"%ROOT%bin\VoxoraMeetVCam.dll" ^
  /link /DEF:"%ROOT%vcam-source\VoxoraMeetVCam.def" mfplat.lib mfuuid.lib mf.lib ole32.lib oleaut32.lib advapi32.lib runtimeobject.lib
if errorlevel 1 ( popd & exit /b 1 )

cl %CXXFLAGS% %DEFS% "%ROOT%vcam-host\main.cpp" "%OBJ%\host.res" /Fe:"%ROOT%bin\VoxoraMeetVCamHost.exe" ^
  /link mfplat.lib mfuuid.lib mf.lib mfsensorgroup.lib ole32.lib advapi32.lib
if errorlevel 1 ( popd & exit /b 1 )

cl %CXXFLAGS% %DEFS% "%ROOT%frame-writer\main.cpp" "%OBJ%\writer.res" /Fe:"%ROOT%bin\VoxoraMeetFrameWriter.exe" ^
  /link advapi32.lib
if errorlevel 1 ( popd & exit /b 1 )

cl %CXXFLAGS% %DEFS% "%ROOT%test-consumer\main.cpp" /Fe:"%ROOT%bin\VoxoraMeetCameraTest.exe" ^
  /link mfplat.lib mfuuid.lib mf.lib mfreadwrite.lib ole32.lib advapi32.lib
if errorlevel 1 ( popd & exit /b 1 )
popd

:verify
set "FAILED="
for %%F in (VoxoraMeetVCam.dll VoxoraMeetVCamHost.exe VoxoraMeetFrameWriter.exe VoxoraMeetCameraTest.exe) do (
  if exist "%ROOT%bin\%%F" (echo [build] OK  %%F) else (echo [build] FALTA %%F & set "FAILED=1")
)
if defined FAILED exit /b 1
echo [build] Binarios en %ROOT%bin
exit /b 0
