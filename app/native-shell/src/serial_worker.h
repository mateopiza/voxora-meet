// Hilo de trabajo serie: ejecuta tareas en orden, fuera del hilo de UI.
// Se usa para todo lo que puede bloquear (abrir la webcam con Media Foundation,
// enumerar dispositivos, iniciar WASAPI, medir duraciones de archivos) y así la
// WebView nunca se congela. El hilo inicializa COM en MTA.
#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <objbase.h>

#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>

namespace voxora {

class SerialWorker {
 public:
  SerialWorker() = default;
  ~SerialWorker() { shutdown(); }
  SerialWorker(const SerialWorker&) = delete;
  SerialWorker& operator=(const SerialWorker&) = delete;

  void start() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (thread_.joinable()) return;
    stopping_ = false;
    thread_ = std::thread([this] { loop(); });
  }

  void post(std::function<void()> task) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (stopping_) return;
      tasks_.push_back(std::move(task));
    }
    cv_.notify_one();
  }

  // Termina las tareas pendientes y une el hilo.
  void shutdown() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!thread_.joinable()) return;
      stopping_ = true;
    }
    cv_.notify_one();
    thread_.join();
  }

 private:
  void loop() {
    const HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    for (;;) {
      std::function<void()> task;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        cv_.wait(lock, [this] { return stopping_ || !tasks_.empty(); });
        if (tasks_.empty()) break;  // stopping_ y sin trabajo pendiente
        task = std::move(tasks_.front());
        tasks_.pop_front();
      }
      if (task) task();
    }
    if (SUCCEEDED(hr)) CoUninitialize();
  }

  std::mutex mutex_;
  std::condition_variable cv_;
  std::deque<std::function<void()>> tasks_;
  std::thread thread_;
  bool stopping_ = false;
};

}  // namespace voxora
