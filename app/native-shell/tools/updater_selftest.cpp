// updater_selftest.exe — ejercita el actualizador real del shell (src/updater.cpp) sin ventana ni UI.
// Lo usa scripts/test-update-flow.mjs contra un servidor HTTP local (127.0.0.1) que sirve un
// latest.json y un instalador de prueba (fake_setup.exe). Imprime una línea JSON por cada estado.
//
//   updater_selftest.exe [--apply] [--session-running] [--timeout-ms N]
//
// Configuración por entorno (la misma que el shell): VOXORA_UPDATE_FEED, VOXORA_UPDATE_DIR,
// VOXORA_UPDATE_ALLOW_UNSIGNED, VOXORA_UPDATE_DELAY_MS, VOXORA_UPDATE_TEST_NO_ELEVATE.
// Código de salida: 0 si terminó en ready/uptodate/error (se evalúa el JSON), 2 si agotó el tiempo.
#include <windows.h>
#include <objbase.h>

#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <functional>
#include <mutex>
#include <string>

#include "logger.h"
#include "updater.h"

namespace {
std::mutex g_mutex;
std::condition_variable g_cv;
std::deque<std::function<void()>> g_queue;

void post(std::function<void()> fn) {
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_queue.push_back(std::move(fn));
  }
  g_cv.notify_one();
}

void print(const char* kind, const voxora::json::Value& v) {
  std::printf("{\"kind\":\"%s\",\"data\":%s}\n", kind, v.dump().c_str());
  std::fflush(stdout);
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  bool apply = false, sessionRunning = false;
  DWORD timeoutMs = 60000;
  for (int i = 1; i < argc; ++i) {
    const std::wstring a = argv[i];
    if (a == L"--apply") apply = true;
    else if (a == L"--session-running") sessionRunning = true;
    else if (a == L"--timeout-ms" && i + 1 < argc) timeoutMs = static_cast<DWORD>(_wtoi(argv[++i]));
    else if (a == L"--log-capture-test") {
      // Registro del shell: lo que el cliente del motor manda a OutputDebugString (stderr del motor)
      // debe quedar en el .log una sola vez, sin depurador adjunto (scripts/test-update-flow.mjs).
      voxora::logging::init(L"log-capture-selftest");
      voxora::logging::captureDebugOutput();
      OutputDebugStringA("[stderr] vx-capture-ansi\n");
      OutputDebugStringW(L"[engine] vx-capture-wide ñ\n");
      voxora::logging::shutdown();
      std::printf("{\"ok\":true}\n");
      return 0;
    }
  }
  voxora::logging::init(L"updater-selftest");
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  std::string finalState;
  bool quit = false;
  voxora::updater::Hooks hooks;
  hooks.runOnUi = post;
  hooks.onStatus = [&](const voxora::json::Value& s) {
    print("status", s);
    const std::string st = s["state"].asString("");
    if (st == "ready" || st == "uptodate" || st == "error" || st == "disabled") finalState = st;
  };
  hooks.sessionRunning = [&] { return sessionRunning; };
  hooks.quitApp = [&] { quit = true; };
  voxora::updater::start(hooks);
  if (voxora::updater::status()["state"].asString("") == "disabled") finalState = "disabled";

  const ULONGLONG deadline = GetTickCount64() + timeoutMs;
  while (finalState.empty() && GetTickCount64() < deadline) {
    std::function<void()> fn;
    {
      std::unique_lock<std::mutex> lock(g_mutex);
      g_cv.wait_for(lock, std::chrono::milliseconds(100), [] { return !g_queue.empty(); });
      if (g_queue.empty()) continue;
      fn = std::move(g_queue.front());
      g_queue.pop_front();
    }
    fn();
  }
  if (finalState.empty()) {
    print("timeout", voxora::updater::status());
    voxora::updater::stop();
    return 2;
  }
  if (apply) {
    voxora::updater::handleNative("native.update.apply", voxora::json::Value(), [](bool ok, const voxora::json::Value& v) {
      voxora::json::Value r;
      r.set("ok", ok).set("value", v);
      print("apply", r);
    });
    // Drena lo que el apply haya encolado (quitApp).
    for (int i = 0; i < 20; ++i) {
      std::function<void()> fn;
      {
        std::lock_guard<std::mutex> lock(g_mutex);
        if (!g_queue.empty()) {
          fn = std::move(g_queue.front());
          g_queue.pop_front();
        }
      }
      if (fn) fn();
      else Sleep(50);
    }
    voxora::json::Value q;
    q.set("quit", quit);
    print("quit", q);
  }
  print("final", voxora::updater::status());
  voxora::updater::stop();
  CoUninitialize();
  return 0;
}
