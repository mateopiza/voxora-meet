#include "vcam_host.h"

#include <vector>

namespace voxora {

std::mutex& processSpawnMutex() {
  static std::mutex m;
  return m;
}

bool VcamHost::alive() {
  std::lock_guard<std::mutex> lock(mutex_);
  return process_ && WaitForSingleObject(process_, 0) == WAIT_TIMEOUT;
}

DWORD VcamHost::exitCode() {
  std::lock_guard<std::mutex> lock(mutex_);
  if (process_) {
    DWORD code = STILL_ACTIVE;
    if (GetExitCodeProcess(process_, &code)) return code;
  }
  return lastExitCode_;
}

std::string VcamHost::lastErrorLine() {
  std::lock_guard<std::mutex> lock(lineMutex_);
  return lastError_;
}

bool VcamHost::start(const std::wstring& exePath, std::wstring& error) {
  if (alive()) return true;
  stop(0);  // limpia restos de un host que murió solo
  if (GetFileAttributesW(exePath.c_str()) == INVALID_FILE_ATTRIBUTES) {
    error = L"No se encontró VoxoraMeetVCamHost.exe";
    return false;
  }

  std::lock_guard<std::mutex> spawnLock(processSpawnMutex());
  SECURITY_ATTRIBUTES sa{};
  sa.nLength = sizeof(sa);
  sa.bInheritHandle = TRUE;
  HANDLE stdinRead = nullptr, stdinWrite = nullptr, stdoutRead = nullptr, stdoutWrite = nullptr;
  if (!CreatePipe(&stdinRead, &stdinWrite, &sa, 0)) {
    error = L"CreatePipe (stdin del host) falló";
    return false;
  }
  if (!CreatePipe(&stdoutRead, &stdoutWrite, &sa, 1 << 14)) {
    CloseHandle(stdinRead);
    CloseHandle(stdinWrite);
    error = L"CreatePipe (stdout del host) falló";
    return false;
  }
  // Los extremos del shell nunca se heredan (ni al host ni al motor): si el extremo de escritura de stdin
  // se colara en otro hijo, el host no vería EOF cuando el shell muera.
  SetHandleInformation(stdinWrite, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0);

  // El host hereda SOLO sus dos extremos (lista explícita), no cualquier otro handle heredable del shell.
  HANDLE inherit[2] = {stdinRead, stdoutWrite};
  SIZE_T attrSize = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attrSize);
  std::vector<unsigned char> attrBuf(attrSize);
  auto* attrs = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attrBuf.data());
  const bool attrsOk = InitializeProcThreadAttributeList(attrs, 1, 0, &attrSize) &&
                       UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherit, sizeof(inherit),
                                                 nullptr, nullptr);

  STARTUPINFOEXW si{};
  si.StartupInfo.cb = sizeof(si);
  si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput = stdinRead;
  si.StartupInfo.hStdOutput = stdoutWrite;
  si.StartupInfo.hStdError = stdoutWrite;
  si.lpAttributeList = attrsOk ? attrs : nullptr;

  std::wstring cmd = L"\"" + exePath + L"\"";
  std::vector<wchar_t> buf(cmd.begin(), cmd.end());
  buf.push_back(L'\0');
  PROCESS_INFORMATION pi{};
  const DWORD flags = CREATE_NO_WINDOW | (attrsOk ? EXTENDED_STARTUPINFO_PRESENT : 0);
  const BOOL ok = CreateProcessW(nullptr, buf.data(), nullptr, nullptr, TRUE, flags, nullptr, nullptr,
                                 &si.StartupInfo, &pi);
  const DWORD lastError = GetLastError();
  if (attrsOk) DeleteProcThreadAttributeList(attrs);
  CloseHandle(stdinRead);
  CloseHandle(stdoutWrite);
  if (!ok) {
    CloseHandle(stdinWrite);
    CloseHandle(stdoutRead);
    error = L"No se pudo lanzar VoxoraMeetVCamHost.exe (error " + std::to_wstring(lastError) + L")";
    return false;
  }
  CloseHandle(pi.hThread);
  {
    std::lock_guard<std::mutex> lock(mutex_);
    process_ = pi.hProcess;
    stdinWrite_ = stdinWrite;
    lastExitCode_ = STILL_ACTIVE;
  }
  {
    std::lock_guard<std::mutex> lock(lineMutex_);
    lastError_.clear();
  }
  ready_.store(false);
  reader_ = std::thread([this, stdoutRead] { readerLoop(stdoutRead); });
  return true;
}

void VcamHost::stop(DWORD waitMs) {
  HANDLE process = nullptr;
  HANDLE stdinWrite = nullptr;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    process = process_;
    stdinWrite = stdinWrite_;
    stdinWrite_ = nullptr;
  }
  if (stdinWrite) {
    // `stop` explícito y, además, EOF al cerrar: cualquiera de los dos apaga el host limpiamente.
    static const char kStop[] = "stop\n";
    DWORD written = 0;
    WriteFile(stdinWrite, kStop, sizeof(kStop) - 1, &written, nullptr);
    CloseHandle(stdinWrite);
  }
  if (process) {
    if (WaitForSingleObject(process, waitMs) != WAIT_OBJECT_0) {
      TerminateProcess(process, 1);
      WaitForSingleObject(process, 2000);
    }
  }
  // El lector termina al cerrarse el extremo de escritura de stdout (al salir el host).
  if (reader_.joinable()) reader_.join();
  if (process) {
    std::lock_guard<std::mutex> lock(mutex_);
    DWORD code = STILL_ACTIVE;
    if (GetExitCodeProcess(process, &code)) lastExitCode_ = code;
    CloseHandle(process);
    process_ = nullptr;
  }
  ready_.store(false);
}

void VcamHost::readerLoop(HANDLE stdoutRead) {
  std::string pending;
  char chunk[512];
  DWORD got = 0;
  auto handleLine = [this](std::string line) {
    while (!line.empty() && (line.back() == '\r' || line.back() == '\n' || line.back() == ' ')) line.pop_back();
    if (line.empty()) return;
    OutputDebugStringA(("[vcam-host] " + line + "\n").c_str());
    if (line.rfind("READY", 0) == 0) ready_.store(true);
    if (line.rfind("ERROR", 0) == 0 || line.rfind("AVISO", 0) == 0) {
      std::lock_guard<std::mutex> lock(lineMutex_);
      lastError_ = line;
    }
  };
  while (ReadFile(stdoutRead, chunk, sizeof(chunk), &got, nullptr) && got > 0) {
    pending.append(chunk, got);
    size_t nl;
    while ((nl = pending.find('\n')) != std::string::npos) {
      handleLine(pending.substr(0, nl));
      pending.erase(0, nl + 1);
    }
    if (pending.size() > 4096) pending.clear();  // línea absurda: se descarta
  }
  if (!pending.empty()) handleLine(pending);
  CloseHandle(stdoutRead);
  ready_.store(false);
}

}  // namespace voxora
