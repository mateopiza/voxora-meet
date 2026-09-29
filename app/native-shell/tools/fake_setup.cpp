// fake_setup.exe — «instalador» de prueba para scripts/test-update-flow.mjs: no instala nada; solo
// deja su línea de comandos en %VOXORA_FAKE_SETUP_OUT% para comprobar que el actualizador lo lanzó
// con `/S /relaunch`.
#include <windows.h>

#include <string>

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  wchar_t out[MAX_PATH * 2];
  const DWORD n = GetEnvironmentVariableW(L"VOXORA_FAKE_SETUP_OUT", out, MAX_PATH * 2);
  if (n == 0 || n >= MAX_PATH * 2) return 1;
  const std::wstring line = GetCommandLineW();
  const int bytes = WideCharToMultiByte(CP_UTF8, 0, line.c_str(), static_cast<int>(line.size()), nullptr, 0, nullptr, nullptr);
  std::string utf8(static_cast<size_t>(bytes), '\0');
  WideCharToMultiByte(CP_UTF8, 0, line.c_str(), static_cast<int>(line.size()), utf8.data(), bytes, nullptr, nullptr);
  HANDLE f = CreateFileW(out, GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (f == INVALID_HANDLE_VALUE) return 1;
  DWORD written = 0;
  WriteFile(f, utf8.data(), static_cast<DWORD>(utf8.size()), &written, nullptr);
  CloseHandle(f);
  return 0;
}
