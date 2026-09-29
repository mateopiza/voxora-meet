// Cliente del motor Node: lanza `node.exe engine.mjs` con pipes stdio y habla
// JSON-lines. Las respuestas se correlacionan por `id`; los eventos y los
// mensajes de stderr se entregan por callback desde el hilo lector (el
// consumidor debe marshallar al hilo de UI).
#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <atomic>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <thread>

#include "json.h"

namespace voxora {

class EngineClient {
 public:
  using ResponseCallback = std::function<void(bool ok, const json::Value& resultOrError)>;
  using EventCallback = std::function<void(const std::string& event, const json::Value& data)>;
  using LogCallback = std::function<void(const std::string& line)>;
  using ExitCallback = std::function<void(DWORD exitCode)>;

  EngineClient() = default;
  ~EngineClient();
  EngineClient(const EngineClient&) = delete;
  EngineClient& operator=(const EngineClient&) = delete;

  void onEvent(EventCallback cb) { onEvent_ = std::move(cb); }
  void onLog(LogCallback cb) { onLog_ = std::move(cb); }
  void onExit(ExitCallback cb) { onExit_ = std::move(cb); }

  // Lanza `nodePath engineScript --data-dir dataDir`. Devuelve false y rellena `error` si falla.
  bool start(const std::wstring& nodePath, const std::wstring& engineScript, const std::wstring& dataDir, std::wstring& error);
  void stop();
  bool running() const { return process_ != nullptr && !exited_.load(); }

  // Envía un comando; el callback se invoca desde el hilo lector cuando llega la respuesta.
  int call(const std::string& cmd, const json::Value& params, ResponseCallback cb);

 private:
  void readerLoop();
  void stderrLoop();
  void handleLine(const std::string& line);
  bool writeLine(const std::string& line);

  HANDLE process_ = nullptr;
  HANDLE stdinWrite_ = nullptr;
  HANDLE stdoutRead_ = nullptr;
  HANDLE stderrRead_ = nullptr;
  std::thread reader_;
  std::thread stderrReader_;
  std::atomic<bool> exited_{false};
  std::atomic<int> nextId_{1};
  std::mutex writeMutex_;
  std::mutex pendingMutex_;
  std::map<int, ResponseCallback> pending_;
  EventCallback onEvent_;
  LogCallback onLog_;
  ExitCallback onExit_;
};

// Utilidades de conversión de texto.
std::string wideToUtf8(const std::wstring& text);
std::wstring utf8ToWide(const std::string& text);

}  // namespace voxora
