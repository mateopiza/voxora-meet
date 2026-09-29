# Binarios nativos de la cámara virtual VOXORA Meet (Media Foundation Virtual Camera API).
# Requiere MSVC (VS 2022+/18) y Windows SDK >= 10.0.22000 (mfvirtualcamera.h). Salida en native/bin/.
cmake_minimum_required(VERSION 3.20)
project(VoxoraMeetVCam LANGUAGES CXX RC)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# CRT estático: la DLL se carga en svchost (FrameServer), donde no se puede asumir el VC redist.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

set(VOXORA_BIN_DIR "${CMAKE_CURRENT_SOURCE_DIR}/bin")
foreach(cfg "" _DEBUG _RELEASE _RELWITHDEBINFO _MINSIZEREL)
  set(CMAKE_RUNTIME_OUTPUT_DIRECTORY${cfg} "${VOXORA_BIN_DIR}")
  set(CMAKE_LIBRARY_OUTPUT_DIRECTORY${cfg} "${VOXORA_BIN_DIR}")
endforeach()

add_compile_definitions(
  UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX
  _WIN32_WINNT=0x0A00 WINVER=0x0A00 NTDDI_VERSION=0x0A00000B  # NTDDI_WIN10_CO: habilita mfvirtualcamera.h
)
add_compile_options($<$<COMPILE_LANGUAGE:CXX>:/W4> $<$<COMPILE_LANGUAGE:CXX>:/permissive-> $<$<COMPILE_LANGUAGE:CXX>:/EHsc>
                    $<$<COMPILE_LANGUAGE:CXX>:/utf-8> $<$<COMPILE_LANGUAGE:CXX>:/Zc:__cplusplus> $<$<COMPILE_LANGUAGE:CXX>:/wd4324>)
# VERSIONINFO: versión única del package.json raíz (native-common/voxora_version.h, scripts/stamp-version.mjs).
include_directories(${CMAKE_CURRENT_SOURCE_DIR}/../../native-common)

# --- DLL COM: media source --------------------------------------------------------------------
add_library(VoxoraMeetVCam SHARED
  vcam-source/dllmain.cpp
  vcam-source/activate.cpp
  vcam-source/media_source.cpp
  vcam-source/media_stream.cpp
  vcam-source/frame_source.cpp
  vcam-source/fallback_frame.cpp
  vcam-source/pixel_convert.cpp
  vcam-source/VoxoraMeetVCam.def
  res/vcam.rc
)
target_include_directories(VoxoraMeetVCam PRIVATE common)
target_link_libraries(VoxoraMeetVCam PRIVATE mfplat mfuuid mf ole32 oleaut32 advapi32 runtimeobject)
set_target_properties(VoxoraMeetVCam PROPERTIES OUTPUT_NAME "VoxoraMeetVCam" PREFIX "")

# --- Host: registra la cámara y la mantiene viva ----------------------------------------------
add_executable(VoxoraMeetVCamHost vcam-host/main.cpp res/host.rc)
target_include_directories(VoxoraMeetVCamHost PRIVATE common)
target_link_libraries(VoxoraMeetVCamHost PRIVATE mfplat mfuuid mf mfsensorgroup ole32 advapi32)

# --- FrameWriter: productor stdin -> memoria compartida ---------------------------------------
add_executable(VoxoraMeetFrameWriter frame-writer/main.cpp res/writer.rc)
target_include_directories(VoxoraMeetFrameWriter PRIVATE common)
target_link_libraries(VoxoraMeetFrameWriter PRIVATE advapi32)

# --- Consumidor de prueba E2E: abre "VOXORA Meet Camera" con IMFSourceReader y clasifica frames ---
add_executable(VoxoraMeetCameraTest test-consumer/main.cpp)
target_include_directories(VoxoraMeetCameraTest PRIVATE common)
target_link_libraries(VoxoraMeetCameraTest PRIVATE mfplat mfuuid mf mfreadwrite ole32 advapi32)
