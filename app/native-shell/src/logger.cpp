#include "logger.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <dbghelp.h>
#include <shellapi.h>
#include <shlobj.h>

#include <algorithm>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <mutex>
#include <vector>

#pragma comment(lib, "dbghelp.lib")

namespace voxora::logging {
namespace {

constexpr ULONGLONG kMaxBytes = 2ull * 1024 * 1024;  // rota a 2 MiB
constexpr int kKeepRotated = 4;                      // shell.1.log … shell.4.log
constexpr size_t kKeepDumps = 5;

// En el heap y sin liberar: otros hilos (actualizador, lectores del motor) pueden registrar mientras
// corren los destructores estáticos al salir.
std::mutex& g_mutex = *new std::mutex;
HANDLE g_file = INVALID_HANDLE_VALUE;
ULONGLONG g_size = 0;
std::wstring& g_base = *new std::wstring(L"shell");
std::wstring& g_dumpPrefix = *new std::wstring(L"crash-shell");
LONG g_crashing = 0;

std::string toUtf8(const std::wstring& text) {
  if (text.empty()) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  std::string out(static_cast<size_t>(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), out.data(), n, nullptr, nullptr);
  return out;
}

std::wstring toWide(const std::string& text) {
  if (text.empty()) return {};
  const int n = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), nullptr, 0);
  std::wstring out(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), out.data(), n);
  return out;
}

std::wstring filePath(int index) {
  std::wstring p = logsDir() + L"\\" + g_base;
  if (index > 0) p += L"." + std::to_wstring(index);
  return p + L".log";
}

// Con g_mutex tomado.
void openFileLocked() {
  g_file = CreateFileW(filePath(0).c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                       nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  g_size = 0;
  if (g_file != INVALID_HANDLE_VALUE) {
    LARGE_INTEGER size{};
    if (GetFileSizeEx(g_file, &size)) g_size = static_cast<ULONGLONG>(size.QuadPart);
  }
}

// Con g_mutex tomado: shell.log → shell.1.log → … → shell.4.log (se descarta el más viejo).
void rotateLocked() {
  if (g_file != INVALID_HANDLE_VALUE) CloseHandle(g_file);
  g_file = INVALID_HANDLE_VALUE;
  DeleteFileW(filePath(kKeepRotated).c_str());
  for (int i = kKeepRotated - 1; i >= 0; --i) MoveFileExW(filePath(i).c_str(), filePath(i + 1).c_str(), MOVEFILE_REPLACE_EXISTING);
  openFileLocked();
}

std::string timestamp() {
  SYSTEMTIME st;
  GetLocalTime(&st);
  char buf[40];
  std::snprintf(buf, sizeof(buf), "%04u-%02u-%02u %02u:%02u:%02u.%03u", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute,
                st.wSecond, st.wMilliseconds);
  return buf;
}

// Solo se conservan los últimos kKeepDumps volcados.
void pruneDumps() {
  WIN32_FIND_DATAW fd{};
  const std::wstring pattern = logsDir() + L"\\crash-*.dmp";
  HANDLE find = FindFirstFileW(pattern.c_str(), &fd);
  if (find == INVALID_HANDLE_VALUE) return;
  std::vector<std::pair<ULONGLONG, std::wstring>> dumps;
  do {
    const ULONGLONG t = (static_cast<ULONGLONG>(fd.ftLastWriteTime.dwHighDateTime) << 32) | fd.ftLastWriteTime.dwLowDateTime;
    dumps.emplace_back(t, fd.cFileName);
  } while (FindNextFileW(find, &fd));
  FindClose(find);
  if (dumps.size() <= kKeepDumps) return;
  std::sort(dumps.begin(), dumps.end(), [](const auto& a, const auto& b) { return a.first > b.first; });
  for (size_t i = kKeepDumps; i < dumps.size(); ++i) DeleteFileW((logsDir() + L"\\" + dumps[i].second).c_str());
}

struct DumpJob {
  EXCEPTION_POINTERS* pointers;
  DWORD threadId;
  std::wstring path;
  bool ok;
};

DWORD WINAPI dumpThread(LPVOID param) {
  auto* job = static_cast<DumpJob*>(param);
  HANDLE file = CreateFileW(job->path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return 0;
  MINIDUMP_EXCEPTION_INFORMATION info{};
  info.ThreadId = job->threadId;
  info.ExceptionPointers = job->pointers;
  info.ClientPointers = FALSE;
  const auto type = static_cast<MINIDUMP_TYPE>(MiniDumpWithIndirectlyReferencedMemory | MiniDumpScanMemory |
                                                MiniDumpWithThreadInfo | MiniDumpWithUnloadedModules);
  job->ok = MiniDumpWriteDump(GetCurrentProcess(), GetCurrentProcessId(), file, type,
                              job->pointers ? &info : nullptr, nullptr, nullptr) != FALSE;
  CloseHandle(file);
  return 0;
}

// Escribe el volcado desde un hilo aparte: el hilo que falló puede no tener pila (desbordamiento).
void writeDump(EXCEPTION_POINTERS* pointers, const char* reason) {
  if (InterlockedExchange(&g_crashing, 1) != 0) return;  // un solo volcado por proceso
  SYSTEMTIME st;
  GetLocalTime(&st);
  wchar_t name[96];
  swprintf_s(name, L"\\%ls-%04u%02u%02u-%02u%02u%02u-%lu.dmp", g_dumpPrefix.c_str(), st.wYear, st.wMonth, st.wDay, st.wHour,
             st.wMinute, st.wSecond, GetCurrentProcessId());
  DumpJob job{pointers, GetCurrentThreadId(), logsDir() + name, false};
  HANDLE thread = CreateThread(nullptr, 256 * 1024, dumpThread, &job, 0, nullptr);
  if (thread) {
    WaitForSingleObject(thread, 60000);
    CloseHandle(thread);
  }
  char line[160];
  if (pointers && pointers->ExceptionRecord) {
    std::snprintf(line, sizeof(line), "CAÍDA (%s): excepción 0x%08lX en %p", reason,
                  static_cast<unsigned long>(pointers->ExceptionRecord->ExceptionCode), pointers->ExceptionRecord->ExceptionAddress);
  } else {
    std::snprintf(line, sizeof(line), "CAÍDA (%s)", reason);
  }
  write("FATAL", std::string(line) + (job.ok ? " · volcado: " + toUtf8(job.path) : " · no se pudo escribir el volcado"));
  pruneDumps();
}

LONG WINAPI unhandledFilter(EXCEPTION_POINTERS* pointers) {
  writeDump(pointers, "excepción no controlada");
  return EXCEPTION_EXECUTE_HANDLER;  // termina el proceso sin el diálogo de WER
}

// Volcado con contexto del punto de llamada (para errores del CRT que no son excepciones SEH).
void dumpHere(const char* reason) {
  __try {
    RaiseException(0xE0564F58 /* 'VOX' */, EXCEPTION_NONCONTINUABLE, 0, nullptr);
  } __except (writeDump(GetExceptionInformation(), reason), EXCEPTION_EXECUTE_HANDLER) {
  }
}

void onInvalidParameter(const wchar_t*, const wchar_t*, const wchar_t*, unsigned int, uintptr_t) {
  dumpHere("parámetro inválido del CRT");
  TerminateProcess(GetCurrentProcess(), 0xC000000D);
}

void onPureCall() {
  dumpHere("llamada a función virtual pura");
  TerminateProcess(GetCurrentProcess(), 0xC0000025);
}

void onTerminate() {
  dumpHere("std::terminate");
  TerminateProcess(GetCurrentProcess(), 3);
}

void onAbort(int) {
  dumpHere("abort()");
  TerminateProcess(GetCurrentProcess(), 3);
}

// ── Captura de OutputDebugString ──────────────────────────────────────────────
// El shell (y sus módulos) reporta problemas con OutputDebugString("[módulo] …"). Sin depurador,
// OutputDebugString lanza DBG_PRINTEXCEPTION(_WIDE)_C: un manejador vectorizado las ve primero y copia
// al registro las líneas con el prefijo "[…]" (las propias; el ruido de otros componentes se ignora).
thread_local bool t_inLogger = false;
thread_local const void* t_lastAnsiFromWide = nullptr;
constexpr DWORD kDbgPrintWide = 0x4001000A;  // DBG_PRINTEXCEPTION_WIDE_C
constexpr DWORD kDbgPrint = 0x40010006;      // DBG_PRINTEXCEPTION_C

void captureDebugLine(std::string line) {
  while (!line.empty() && (line.back() == '\n' || line.back() == '\r' || line.back() == '\0')) line.pop_back();
  if (line.size() < 3 || line[0] != '[') return;
  write("DEBUG", line);
}

void captureWide(const wchar_t* text, size_t len) {
  t_inLogger = true;
  captureDebugLine(toUtf8(std::wstring(text, wcsnlen(text, len))));
  t_inLogger = false;
}

void captureAnsi(const char* text, size_t len) {
  t_inLogger = true;
  captureDebugLine(std::string(text, strnlen(text, len)));  // los mensajes del shell son UTF-8 (/utf-8)
  t_inLogger = false;
}

// Sin objetos con destructor aquí: __try no admite desenrollado de C++ en la misma función.
LONG CALLBACK debugOutputHandler(EXCEPTION_POINTERS* info) {
  const EXCEPTION_RECORD* rec = info ? info->ExceptionRecord : nullptr;
  if (!rec || t_inLogger) return EXCEPTION_CONTINUE_SEARCH;
  if (rec->ExceptionCode != kDbgPrintWide && rec->ExceptionCode != kDbgPrint) return EXCEPTION_CONTINUE_SEARCH;
  if (rec->NumberParameters < 2) return EXCEPTION_CONTINUE_SEARCH;
  const auto len = static_cast<size_t>(rec->ExceptionInformation[0]);
  if (len == 0 || len >= 64 * 1024) return EXCEPTION_CONTINUE_SEARCH;
  __try {
    if (rec->ExceptionCode == kDbgPrintWide) {
      t_lastAnsiFromWide = rec->NumberParameters >= 4 ? reinterpret_cast<const void*>(rec->ExceptionInformation[3]) : nullptr;
      const auto* text = reinterpret_cast<const wchar_t*>(rec->ExceptionInformation[1]);
      if (text) captureWide(text, len);
    } else {
      const auto* text = reinterpret_cast<const char*>(rec->ExceptionInformation[1]);
      // OutputDebugStringW repite el mensaje en ANSI tras la versión ancha: no se registra dos veces.
      if (text && text == t_lastAnsiFromWide) t_lastAnsiFromWide = nullptr;
      else if (text) captureAnsi(text, len);
    }
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    t_inLogger = false;
  }
  return EXCEPTION_CONTINUE_SEARCH;
}

}  // namespace

void captureDebugOutput() {
  static PVOID handler = nullptr;
  if (!handler) handler = AddVectoredExceptionHandler(0, debugOutputHandler);
}

void startForProcess(const std::wstring& baseName, const std::string& banner) {
  init(baseName);
  installCrashHandler((L"crash-" + baseName).c_str());
  captureDebugOutput();
  if (!banner.empty()) info(banner);
}

std::wstring logsDir() {
  static const std::wstring& dir = *new std::wstring([] {
    PWSTR base = nullptr;
    std::wstring d;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &base)) && base) {
      d = base;
      CoTaskMemFree(base);
    } else {
      wchar_t buf[MAX_PATH];
      d = GetEnvironmentVariableW(L"LOCALAPPDATA", buf, MAX_PATH) ? buf : L".";
    }
    d += L"\\VOXORA Meet";
    CreateDirectoryW(d.c_str(), nullptr);
    d += L"\\logs";
    CreateDirectoryW(d.c_str(), nullptr);
    return d;
  }());
  return dir;
}

void init(const std::wstring& baseName) {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (g_file != INVALID_HANDLE_VALUE) return;
  g_base = baseName.empty() ? L"shell" : baseName;
  openFileLocked();
  if (g_size > kMaxBytes) rotateLocked();
}

void shutdown() {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (g_file != INVALID_HANDLE_VALUE) CloseHandle(g_file);
  g_file = INVALID_HANDLE_VALUE;
}

void write(const char* level, const std::string& utf8Message) {
  std::string line = timestamp() + " [" + level + "] [" + std::to_string(GetCurrentThreadId()) + "] " + utf8Message;
  while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) line.pop_back();
  line += "\r\n";
  if (!t_inLogger) {
    t_inLogger = true;  // no volver a capturar nuestra propia salida de depuración
    OutputDebugStringW(toWide(line).c_str());
    t_inLogger = false;
  }
  std::lock_guard<std::mutex> lock(g_mutex);
  if (g_file == INVALID_HANDLE_VALUE) return;
  DWORD written = 0;
  if (WriteFile(g_file, line.data(), static_cast<DWORD>(line.size()), &written, nullptr)) g_size += written;
  if (g_size > kMaxBytes) rotateLocked();
}

void infoW(const std::wstring& m) { write("INFO", toUtf8(m)); }
void warnW(const std::wstring& m) { write("WARN", toUtf8(m)); }
void errorW(const std::wstring& m) { write("ERROR", toUtf8(m)); }

void installCrashHandler(const wchar_t* dumpPrefix) {
  if (dumpPrefix && *dumpPrefix) g_dumpPrefix = dumpPrefix;
  SetUnhandledExceptionFilter(unhandledFilter);
  _set_invalid_parameter_handler(onInvalidParameter);
  _set_purecall_handler(onPureCall);
  std::set_terminate(onTerminate);
  std::signal(SIGABRT, onAbort);
  _set_abort_behavior(0, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
  // Sin el diálogo «X dejó de funcionar»: el volcado propio ya queda en logs.
  SetErrorMode(GetErrorMode() | SEM_NOGPFAULTERRORBOX);
  pruneDumps();
}

bool openLogsFolder() {
  const std::wstring dir = logsDir();
  const auto result = reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr, L"open", dir.c_str(), nullptr, nullptr, SW_SHOWNORMAL));
  return result > 32;
}

}  // namespace voxora::logging
