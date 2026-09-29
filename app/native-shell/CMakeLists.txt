cmake_minimum_required(VERSION 3.20)
project(VoxoraMeetShell LANGUAGES CXX RC)

# Shell nativo de VOXORA Meet (C++17, MSVC): ventana Win32 + UI HTML local en WebView2.
# Única dependencia vendorizada: SDK de WebView2 (cabeceras + loader estático x64) en
# third_party/webview2 — no hace falta WebView2Loader.dll junto al exe.
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release)
endif()

set(WEBVIEW2_DIR ${CMAKE_CURRENT_SOURCE_DIR}/third_party/webview2)

add_executable(VoxoraMeet WIN32
  src/main.cpp
  src/engine_client.cpp
  src/settings.cpp
  src/camera_capture.cpp
  src/vcam_host.cpp
  src/audio_capture.cpp
  src/device_watcher.cpp
  src/native_dialogs.cpp
  src/webview_host.cpp
  res/app.rc
)

target_compile_definitions(VoxoraMeet PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN _CRT_SECURE_NO_WARNINGS)
target_compile_options(VoxoraMeet PRIVATE $<$<COMPILE_LANGUAGE:CXX>:/W4 /permissive- /utf-8 /EHsc /external:W0>)
target_include_directories(VoxoraMeet PRIVATE
  src
  ${CMAKE_CURRENT_SOURCE_DIR}/../../windows-camera/native/common
)
target_include_directories(VoxoraMeet SYSTEM PRIVATE ${WEBVIEW2_DIR}/include)
target_link_libraries(VoxoraMeet PRIVATE
  ${WEBVIEW2_DIR}/x64/WebView2LoaderStatic.lib
  user32 gdi32 dwmapi shell32 shlwapi ole32 oleaut32 uuid advapi32 crypt32 version
  mf mfplat mfreadwrite mfuuid
)
set_target_properties(VoxoraMeet PROPERTIES
  WIN32_EXECUTABLE TRUE
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_SOURCE_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_CURRENT_SOURCE_DIR}/bin"
  MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
)
target_link_options(VoxoraMeet PRIVATE /ENTRY:wWinMainCRTStartup /SUBSYSTEM:WINDOWS)

# ── Estabilidad y actualizaciones (docs/RELEASE.md) ────────────────────────────
# logger: registro a archivo con rotación + minidump en caída; updater: canal S3 de MEGA.
# La versión sale del package.json raíz: native-common/voxora_version.h (scripts/stamp-version.mjs).
target_sources(VoxoraMeet PRIVATE src/logger.cpp src/updater.cpp)
target_include_directories(VoxoraMeet PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../../native-common)
target_link_libraries(VoxoraMeet PRIVATE winhttp wintrust bcrypt dbghelp)

# Herramientas de prueba del actualizador (no se empaquetan): scripts/test-update-flow.mjs.
add_executable(updater_selftest tools/updater_selftest.cpp src/logger.cpp src/updater.cpp)
add_executable(fake_setup WIN32 tools/fake_setup.cpp)
foreach(tool updater_selftest fake_setup)
  target_compile_definitions(${tool} PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN _CRT_SECURE_NO_WARNINGS)
  target_compile_options(${tool} PRIVATE /W4 /permissive- /utf-8 /EHsc)
  target_include_directories(${tool} PRIVATE src ${CMAKE_CURRENT_SOURCE_DIR}/../../native-common)
  set_target_properties(${tool} PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/tools"
    MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endforeach()
target_link_libraries(updater_selftest PRIVATE winhttp wintrust crypt32 bcrypt dbghelp shell32 ole32)
target_link_options(fake_setup PRIVATE /ENTRY:wWinMainCRTStartup)

# ── Imagen de la cámara y «Grabar prueba» (docs/APP-SHELL.md) ──────────────────
target_sources(VoxoraMeet PRIVATE src/video_effects.cpp src/test_recording.cpp)
# Autodiagnóstico (no se empaqueta): ms/frame de la imagen de la cámara, capturas de cada ajuste desde la
# cámara virtual en marcha, grabación MP4 real y sondeo de segmentación de fondo (build\tools).
add_executable(shell_selftest tools/shell_selftest.cpp src/video_effects.cpp src/test_recording.cpp)
target_compile_definitions(shell_selftest PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN _CRT_SECURE_NO_WARNINGS)
target_compile_options(shell_selftest PRIVATE /W4 /permissive- /utf-8 /EHsc)
target_include_directories(shell_selftest PRIVATE src ${CMAKE_CURRENT_SOURCE_DIR}/../../windows-camera/native/common)
target_link_libraries(shell_selftest PRIVATE mf mfplat mfreadwrite mfuuid ole32 shell32 uuid)
set_target_properties(shell_selftest PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/tools"
  MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
