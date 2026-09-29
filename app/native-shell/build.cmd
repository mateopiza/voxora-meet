@echo off
setlocal
rem Compila VoxoraMeet.exe en bin\ (requiere entorno MSVC: ejecutar desde un
rem "x64 Native Tools Command Prompt" o tras `call vcvars64.bat`).
cd /d "%~dp0"
if not defined VSCMD_ARG_TGT_ARCH (
  set "VCVARS=C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat"
  if exist "%VCVARS%" call "%VCVARS%" >nul 2>nul
  cd /d "%~dp0"
)
where cmake >nul 2>nul
if errorlevel 1 (
  if exist "C:\Program Files\CMake\bin\cmake.exe" set "PATH=C:\Program Files\CMake\bin;%PATH%"
  if exist "%VSINSTALLDIR%Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe" set "PATH=%VSINSTALLDIR%Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin;%PATH%"
)
where cmake >nul 2>nul || (echo cmake no encontrado en PATH & exit /b 1)
cmake -S . -B build -G "NMake Makefiles" -DCMAKE_BUILD_TYPE=Release || exit /b 1
cmake --build build --config Release || exit /b 1
if exist bin\VoxoraMeet.exe (echo OK: bin\VoxoraMeet.exe) else (echo No se genero bin\VoxoraMeet.exe & exit /b 1)
endlocal