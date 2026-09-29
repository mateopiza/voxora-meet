// Punto de entrada COM de VoxoraMeetVCam.dll: fábrica de clases (WRL), DllRegisterServer /
// DllUnregisterServer (HKLM\Software\Classes\CLSID\{...}\InprocServer32, ThreadingModel=Both).
//
// Esta DLL se carga dentro del servicio FrameServer (svchost.exe, LocalService): no debe depender de
// nada de la aplicación VOXORA ni del runtime de VC redistribuible (se enlaza con /MT).

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <wrl.h>

#include <string>

#include "../common/vcam_shared.h"
#include "activate.h"

using namespace Microsoft::WRL;

namespace {
HMODULE g_module = nullptr;

// Escribe (o borra) las claves de registro del CLSID. `path` es la ruta absoluta de esta DLL.
HRESULT writeRegistration(const std::wstring& dllPath) {
  const std::wstring base = std::wstring(L"Software\\Classes\\CLSID\\") + voxora::vcam::kActivateClsidString;
  HKEY clsidKey = nullptr;
  LSTATUS status = RegCreateKeyExW(HKEY_LOCAL_MACHINE, base.c_str(), 0, nullptr, REG_OPTION_NON_VOLATILE,
                                   KEY_WRITE, nullptr, &clsidKey, nullptr);
  if (status != ERROR_SUCCESS) return HRESULT_FROM_WIN32(status);

  const wchar_t description[] = L"VOXORA Meet Virtual Camera Source";
  status = RegSetValueExW(clsidKey, nullptr, 0, REG_SZ, reinterpret_cast<const BYTE*>(description),
                          DWORD(sizeof(description)));
  HKEY inprocKey = nullptr;
  if (status == ERROR_SUCCESS)
    status = RegCreateKeyExW(clsidKey, L"InprocServer32", 0, nullptr, REG_OPTION_NON_VOLATILE, KEY_WRITE, nullptr,
                             &inprocKey, nullptr);
  if (status == ERROR_SUCCESS)
    status = RegSetValueExW(inprocKey, nullptr, 0, REG_SZ, reinterpret_cast<const BYTE*>(dllPath.c_str()),
                            DWORD((dllPath.size() + 1) * sizeof(wchar_t)));
  if (status == ERROR_SUCCESS) {
    const wchar_t threading[] = L"Both";
    status = RegSetValueExW(inprocKey, L"ThreadingModel", 0, REG_SZ, reinterpret_cast<const BYTE*>(threading),
                            DWORD(sizeof(threading)));
  }
  if (inprocKey) RegCloseKey(inprocKey);
  RegCloseKey(clsidKey);
  return status == ERROR_SUCCESS ? S_OK : HRESULT_FROM_WIN32(status);
}
}  // namespace

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID /*reserved*/) {
  if (reason == DLL_PROCESS_ATTACH) {
    g_module = instance;
    DisableThreadLibraryCalls(instance);
  }
  return TRUE;
}

// Registra la clase Activate en la fábrica del módulo WRL (la macro no admite nombres calificados).
namespace voxora::vcam {
CoCreatableClass(Activate);
}

STDAPI DllGetClassObject(REFCLSID rclsid, REFIID riid, void** ppv) {
  return Module<InProc>::GetModule().GetClassObject(rclsid, riid, ppv);
}

STDAPI DllCanUnloadNow() { return Module<InProc>::GetModule().GetObjectCount() == 0 ? S_OK : S_FALSE; }

STDAPI DllRegisterServer() {
  wchar_t path[MAX_PATH * 2] = {};
  const DWORD length = GetModuleFileNameW(g_module, path, DWORD(std::size(path)));
  if (length == 0 || length >= std::size(path)) return HRESULT_FROM_WIN32(GetLastError());
  return writeRegistration(path);
}

STDAPI DllUnregisterServer() {
  const std::wstring base = std::wstring(L"Software\\Classes\\CLSID\\") + voxora::vcam::kActivateClsidString;
  const LSTATUS status = RegDeleteTreeW(HKEY_LOCAL_MACHINE, base.c_str());
  if (status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND) return S_OK;
  return HRESULT_FROM_WIN32(status);
}
