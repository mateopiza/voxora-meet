#include "engine_client.h"

#include <vector>

#include "vcam_host.h"  // processSpawnMutex

namespace voxora {

std::string wideToUtf8(const std::wstring& text) {
  if (text.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  std::string out(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), out.data(), n, nullptr, nullptr);
  return out;
}

std::wstring utf8ToWide(const std::string& text) {
  if (text.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), nullptr, 0);
  std::wstring out(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), out.data(), n);
  return out;
}

EngineClient::~EngineClient() { stop(); }

static std::wstring quoteArg(const std::wstring& arg) {
  if (arg.find_first_of(L" \t\"") == std::wstring::npos) return arg;
  std::wstring out = L"\"";
  for (wchar_t c : arg) {
    if (c == L'"') out += L"\\\"";
    else out += c;
  }
  return out + L"\"";
}

bool EngineClient::start(const std::wstring& nodePath, const std::wstring& engineScript, const std::wstring& dataDir, std::wstring& error) {
  stop();
  exited_.store(false);

  // Mientras existan extremos heredables no debe lanzarse otro hijo (host de la cámara virtual).
  std::lock_guard<std::mutex> spawnLock(processSpawnMutex());
  SECURITY_ATTRIBUTES sa{};
  sa.nLength = sizeof(sa);
  sa.bInheritHandle = TRUE;

  HANDLE stdinRead = nullptr, stdoutWrite = nullptr, stderrWrite = nullptr;
  if (!CreatePipe(&stdinRead, &stdinWrite_, &sa, 0) ||
      !CreatePipe(&stdoutRead_, &stdoutWrite, &sa, 1 << 20) ||
      !CreatePipe(&stderrRead_, &stderrWrite, &sa, 1 << 16)) {
    error = L"CreatePipe falló";
    return false;
  }
  // Los extremos que quedan en este proceso no deben heredarse.
  SetHandleInformation(stdinWrite_, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(stdoutRead_, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(stderrRead_, HANDLE_FLAG_INHERIT, 0);

  std::wstring cmdLine = quoteArg(nodePath) + L" " + quoteArg(engineScript);
  if (!dataDir.empty()) cmdLine += L" --data-dir " + quoteArg(dataDir);
  std::vector<wchar_t> cmdBuf(cmdLine.begin(), cmdLine.end());
  cmdBuf.push_back(L'\0');

  STARTUPINFOW si{};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = stdinRead;
  si.hStdOutput = stdoutWrite;
  si.hStdError = stderrWrite;
  PROCESS_INFORMATION pi{};
  BOOL ok = CreateProcessW(nullptr, cmdBuf.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, nullptr, nullptr, &si, &pi);
  DWORD lastError = GetLastError();
  CloseHandle(stdinRead);
  CloseHandle(stdoutWrite);
  CloseHandle(stderrWrite);
  if (!ok) {
    error = L"No se pudo lanzar node.exe (" + nodePath + L"), error " + std::to_wstring(lastError);
    CloseHandle(stdinWrite_); stdinWrite_ = nullptr;
    CloseHandle(stdoutRead_); stdoutRead_ = nullptr;
    CloseHandle(stderrRead_); stderrRead_ = nullptr;
    return false;
  }
  CloseHandle(pi.hThread);
  process_ = pi.hProcess;
  reader_ = std::thread([this] { readerLoop(); });
  stderrReader_ = std::thread([this] { stderrLoop(); });
  return true;
}

void EngineClient::stop() {
  if (!process_) return;
  // Cerrar stdin: el motor detiene la sesión y sale solo (protocolo). Si no,
  // se termina a la fuerza tras un plazo.
  if (stdinWrite_) {
    CloseHandle(stdinWrite_);
    stdinWrite_ = nullptr;
  }
  if (WaitForSingleObject(process_, 3000) != WAIT_OBJECT_0) TerminateProcess(process_, 1);
  exited_.store(true);
  if (reader_.joinable()) reader_.join();
  if (stderrReader_.joinable()) stderrReader_.join();
  if (stdoutRead_) { CloseHandle(stdoutRead_); stdoutRead_ = nullptr; }
  if (stderrRead_) { CloseHandle(stderrRead_); stderrRead_ = nullptr; }
  CloseHandle(process_);
  process_ = nullptr;
  std::lock_guard<std::mutex> lock(pendingMutex_);
  for (auto& [id, cb] : pending_) {
    json::Value err;
    err.set("code", "engine_stopped").set("message", "el motor se detuvo");
    if (cb) cb(false, err);
  }
  pending_.clear();
}

bool EngineClient::writeLine(const std::string& line) {
  std::lock_guard<std::mutex> lock(writeMutex_);
  if (!stdinWrite_) return false;
  std::string data = line + "\n";
  DWORD written = 0;
  size_t offset = 0;
  while (offset < data.size()) {
    if (!WriteFile(stdinWrite_, data.data() + offset, static_cast<DWORD>(data.size() - offset), &written, nullptr)) return false;
    offset += written;
  }
  return true;
}

int EngineClient::call(const std::string& cmd, const json::Value& params, ResponseCallback cb) {
  int id = nextId_.fetch_add(1);
  json::Value msg;
  msg.set("id", id).set("cmd", cmd).set("params", params.isNull() ? json::Value(json::Object{}) : params);
  {
    std::lock_guard<std::mutex> lock(pendingMutex_);
    pending_[id] = std::move(cb);
  }
  if (!writeLine(msg.dump())) {
    ResponseCallback failed;
    {
      std::lock_guard<std::mutex> lock(pendingMutex_);
      failed = std::move(pending_[id]);
      pending_.erase(id);
    }
    json::Value err;
    err.set("code", "engine_unavailable").set("message", "no se pudo escribir al motor");
    if (failed) failed(false, err);
    return -1;
  }
  return id;
}

void EngineClient::handleLine(const std::string& line) {
  json::Value msg;
  try {
    msg = json::parse(line);
  } catch (const std::exception& e) {
    if (onLog_) onLog_(std::string("[json] ") + e.what() + ": " + line.substr(0, 200));
    return;
  }
  if (msg.has("event")) {
    if (onEvent_) onEvent_(msg["event"].asString(), msg["data"]);
    return;
  }
  if (msg.has("id") && msg["id"].isNumber()) {
    int id = msg["id"].asInt();
    ResponseCallback cb;
    {
      std::lock_guard<std::mutex> lock(pendingMutex_);
      auto it = pending_.find(id);
      if (it != pending_.end()) {
        cb = std::move(it->second);
        pending_.erase(it);
      }
    }
    bool ok = msg["ok"].asBool();
    if (cb) cb(ok, ok ? msg["result"] : msg["error"]);
    return;
  }
  if (onLog_) onLog_("[engine] " + line);
}

void EngineClient::readerLoop() {
  std::string pending;
  char buf[65536];
  DWORD read = 0;
  while (ReadFile(stdoutRead_, buf, sizeof(buf), &read, nullptr) && read > 0) {
    pending.append(buf, read);
    size_t pos;
    while ((pos = pending.find('\n')) != std::string::npos) {
      std::string line = pending.substr(0, pos);
      pending.erase(0, pos + 1);
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (!line.empty()) handleLine(line);
    }
  }
  DWORD code = 0;
  if (process_) {
    WaitForSingleObject(process_, 2000);
    GetExitCodeProcess(process_, &code);
  }
  bool alreadyStopping = exited_.exchange(true);
  if (!alreadyStopping && onExit_) onExit_(code);
}

void EngineClient::stderrLoop() {
  std::string pending;
  char buf[4096];
  DWORD read = 0;
  while (ReadFile(stderrRead_, buf, sizeof(buf), &read, nullptr) && read > 0) {
    pending.append(buf, read);
    size_t pos;
    while ((pos = pending.find('\n')) != std::string::npos) {
      std::string line = pending.substr(0, pos);
      pending.erase(0, pos + 1);
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (!line.empty() && onLog_) onLog_("[stderr] " + line);
    }
  }
}

}  // namespace voxora
