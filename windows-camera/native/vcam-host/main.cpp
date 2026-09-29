// VoxoraMeetVCamHost.exe — registra la cámara virtual "VOXORA Meet Camera" con MFCreateVirtualCamera y
// se mantiene vivo (Lifetime_Session: la cámara desaparece cuando este proceso termina). Se controla por
// stdin con líneas de texto: `ping` → `pong`, `status` → estado, `stop` → apaga y sale. EOF equivale a `stop`.
//
// Modos adicionales:
//   --version                 imprime la versión y sale (0)
//   --check-registered        0 si el CLSID está registrado en HKLM, 1 si no
//   --register-dll <ruta>     ejecuta DllRegisterServer de la DLL (requiere elevación)
//   --unregister-dll <ruta>   ejecuta DllUnregisterServer de la DLL (requiere elevación)
//   --name <nombre>           nombre amigable de la cámara (por defecto "VOXORA Meet Camera")
//
// Códigos de salida:
//   0 OK · 2 uso incorrecto · 3 requiere elevación · 4 cámara virtual no soportada en este Windows
//   5 fallo en MFCreateVirtualCamera (¿DLL no registrada?) · 6 fallo en Start · 7 fallo de (des)registro
//   8 no se pudo cargar la DLL · 9 fallo de inicialización de Media Foundation

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfvirtualcamera.h>
#include <wrl/client.h>

#include <cstdio>
#include <cwchar>
#include <iostream>
#include <mutex>
#include <string>

#include "../common/vcam_shared.h"

using Microsoft::WRL::ComPtr;

namespace {

constexpr wchar_t kVersion[] = L"0.1.0";

enum ExitCode : int {
  Exit_Ok = 0,
  Exit_Usage = 2,
  Exit_NeedsElevation = 3,
  Exit_NotSupported = 4,
  Exit_CreateFailed = 5,
  Exit_StartFailed = 6,
  Exit_RegisterFailed = 7,
  Exit_DllLoadFailed = 8,
  Exit_MfStartupFailed = 9,
};

void printUsage() {
  std::fwprintf(stderr,
                L"Uso: VoxoraMeetVCamHost.exe [--name <nombre>] | --version | --check-registered |\n"
                L"     --register-dll <ruta.dll> | --unregister-dll <ruta.dll>\n");
}

bool isElevated() {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  TOKEN_ELEVATION elevation{};
  DWORD size = sizeof(elevation);
  const bool ok = GetTokenInformation(token, TokenElevation, &elevation, size, &size) && elevation.TokenIsElevated;
  CloseHandle(token);
  return ok;
}

bool isRegistered() {
  const std::wstring key = std::wstring(L"Software\\Classes\\CLSID\\") + voxora::vcam::kActivateClsidString +
                           L"\\InprocServer32";
  HKEY h = nullptr;
  if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, key.c_str(), 0, KEY_READ, &h) != ERROR_SUCCESS) return false;
  RegCloseKey(h);
  return true;
}

// Equivalente a regsvr32 [/u] sin depender del binario del sistema ni de sus cuadros de diálogo.
int runDllEntry(const wchar_t* dllPath, const char* entryName) {
  if (!isElevated()) {
    std::fwprintf(stderr, L"ERROR: --register-dll/--unregister-dll escriben en HKLM y requieren elevación.\n");
    return Exit_NeedsElevation;
  }
  HMODULE dll = LoadLibraryW(dllPath);
  if (!dll) {
    std::fwprintf(stderr, L"ERROR: no se pudo cargar %ls (Win32 %lu)\n", dllPath, GetLastError());
    return Exit_DllLoadFailed;
  }
  using EntryFn = HRESULT(STDAPICALLTYPE*)();
  auto entry = reinterpret_cast<EntryFn>(GetProcAddress(dll, entryName));
  if (!entry) {
    std::fwprintf(stderr, L"ERROR: la DLL no exporta %hs\n", entryName);
    FreeLibrary(dll);
    return Exit_DllLoadFailed;
  }
  const HRESULT hr = entry();
  FreeLibrary(dll);
  if (FAILED(hr)) {
    std::fwprintf(stderr, L"ERROR: %hs devolvió 0x%08lX\n", entryName, static_cast<unsigned long>(hr));
    return hr == E_ACCESSDENIED ? Exit_NeedsElevation : Exit_RegisterFailed;
  }
  std::wprintf(L"OK %hs %ls\n", entryName, dllPath);
  return Exit_Ok;
}

// Estado global mínimo para que el manejador de Ctrl+C pueda apagar la cámara limpiamente.
std::mutex g_cameraMutex;
ComPtr<IMFVirtualCamera> g_camera;

void shutdownCamera() {
  std::lock_guard<std::mutex> lock(g_cameraMutex);
  if (!g_camera) return;
  g_camera->Stop();
  g_camera->Shutdown();
  g_camera.Reset();
}

BOOL WINAPI consoleHandler(DWORD /*type*/) {
  shutdownCamera();
  MFShutdown();
  ExitProcess(Exit_Ok);
}

int runHost(const std::wstring& friendlyName) {
  HRESULT hr = MFStartup(MF_VERSION);
  if (FAILED(hr)) {
    std::fwprintf(stderr, L"ERROR: MFStartup 0x%08lX\n", static_cast<unsigned long>(hr));
    return Exit_MfStartupFailed;
  }

  BOOL supported = FALSE;
  hr = MFIsVirtualCameraTypeSupported(MFVirtualCameraType_SoftwareCameraSource, &supported);
  if (FAILED(hr) || !supported) {
    std::fwprintf(stderr, L"ERROR: este Windows no soporta MFVirtualCameraType_SoftwareCameraSource (0x%08lX)\n",
                  static_cast<unsigned long>(hr));
    MFShutdown();
    return Exit_NotSupported;
  }

  if (!isRegistered()) {
    std::fwprintf(stderr, L"AVISO: el CLSID %ls no está registrado en HKLM; MFCreateVirtualCamera fallará. "
                          L"Ejecute --register-dll con elevación.\n",
                  voxora::vcam::kActivateClsidString);
  }

  ComPtr<IMFVirtualCamera> camera;
  hr = MFCreateVirtualCamera(MFVirtualCameraType_SoftwareCameraSource, MFVirtualCameraLifetime_Session,
                             MFVirtualCameraAccess_CurrentUser, friendlyName.c_str(),
                             voxora::vcam::kActivateClsidString, nullptr, 0, &camera);
  if (FAILED(hr)) {
    std::fwprintf(stderr, L"ERROR: MFCreateVirtualCamera 0x%08lX\n", static_cast<unsigned long>(hr));
    MFShutdown();
    return Exit_CreateFailed;
  }

  hr = camera->Start(nullptr);
  if (FAILED(hr)) {
    std::fwprintf(stderr, L"ERROR: IMFVirtualCamera::Start 0x%08lX\n", static_cast<unsigned long>(hr));
    camera->Shutdown();
    MFShutdown();
    return Exit_StartFailed;
  }
  {
    std::lock_guard<std::mutex> lock(g_cameraMutex);
    g_camera = camera;
  }
  SetConsoleCtrlHandler(consoleHandler, TRUE);

  std::wprintf(L"READY %ls\n", friendlyName.c_str());
  std::fflush(stdout);

  std::string line;
  while (std::getline(std::cin, line)) {
    while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
    if (line == "stop" || line == "quit" || line == "exit") break;
    if (line == "ping") {
      std::wprintf(L"pong\n");
    } else if (line == "status") {
      std::wprintf(L"running %ls %ls\n", friendlyName.c_str(), voxora::vcam::kActivateClsidString);
    } else if (!line.empty()) {
      std::wprintf(L"unknown %hs\n", line.c_str());
    }
    std::fflush(stdout);
  }

  shutdownCamera();
  MFShutdown();
  std::wprintf(L"STOPPED\n");
  std::fflush(stdout);
  return Exit_Ok;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  std::wstring friendlyName = voxora::vcam::kFriendlyName;
  for (int i = 1; i < argc; ++i) {
    const std::wstring arg = argv[i];
    if (arg == L"--version") {
      std::wprintf(L"VoxoraMeetVCamHost %ls clsid=%ls\n", kVersion, voxora::vcam::kActivateClsidString);
      return Exit_Ok;
    }
    if (arg == L"--help" || arg == L"-h") {
      printUsage();
      return Exit_Ok;
    }
    if (arg == L"--check-registered") {
      const bool registered = isRegistered();
      std::wprintf(L"%ls\n", registered ? L"registered" : L"not-registered");
      return registered ? Exit_Ok : 1;
    }
    if (arg == L"--register-dll" || arg == L"--unregister-dll") {
      if (i + 1 >= argc) {
        printUsage();
        return Exit_Usage;
      }
      return runDllEntry(argv[i + 1], arg == L"--register-dll" ? "DllRegisterServer" : "DllUnregisterServer");
    }
    if (arg == L"--name") {
      if (i + 1 >= argc) {
        printUsage();
        return Exit_Usage;
      }
      friendlyName = argv[++i];
      continue;
    }
    printUsage();
    return Exit_Usage;
  }
  return runHost(friendlyName);
}
