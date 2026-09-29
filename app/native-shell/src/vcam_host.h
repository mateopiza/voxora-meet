// Proceso VoxoraMeetVCamHost.exe (registra "VOXORA Meet Camera" con MFCreateVirtualCamera y la mantiene
// viva: Lifetime_Session, la cámara existe mientras el host viva).
//
// Se lanza con stdin por TUBERÍA cuyo extremo de escritura solo tiene el shell: el host trata EOF de
// stdin como `stop`, así que si el shell muere (o se cierra sin avisar) el sistema cierra el handle, el
// host lee EOF y retira la cámara él solo — no queda una cámara huérfana. (Con CREATE_NO_WINDOW y sin
// redirigir, stdin era una consola oculta que nunca da EOF.) stdout/stderr van a un hilo lector que
// detecta READY y guarda la última línea de error para diagnóstico.
#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <atomic>
#include <mutex>
#include <string>
#include <thread>

namespace voxora {

class VcamHost {
 public:
  VcamHost() = default;
  ~VcamHost() { stop(); }
  VcamHost(const VcamHost&) = delete;
  VcamHost& operator=(const VcamHost&) = delete;

  // Lanza el host (si no está ya vivo). false + `error` si CreateProcess falla.
  bool start(const std::wstring& exePath, std::wstring& error);
  // Manda `stop`, cierra la tubería de stdin (EOF) y espera hasta `waitMs`; si no sale, lo termina.
  void stop(DWORD waitMs = 3000);

  bool alive();                                   // proceso en marcha
  bool ready() const { return ready_.load(); }    // imprimió READY (la cámara ya existe)
  // Código de salida del último host que terminó (STILL_ACTIVE si sigue vivo o nunca se lanzó).
  DWORD exitCode();
  std::string lastErrorLine();                    // última línea `ERROR: …` / `AVISO: …` del host

 private:
  void readerLoop(HANDLE stdoutRead);

  std::mutex mutex_;
  HANDLE process_ = nullptr;
  HANDLE stdinWrite_ = nullptr;
  std::thread reader_;
  std::atomic<bool> ready_{false};
  DWORD lastExitCode_ = STILL_ACTIVE;
  std::mutex lineMutex_;
  std::string lastError_;
};

// Serializa los CreateProcess que heredan handles (motor y host): mientras un proceso crea sus tuberías
// con extremos heredables, otro CreateProcess(bInheritHandles=TRUE) concurrente podría llevárselos y
// romper la detección de EOF de ambos lados.
std::mutex& processSpawnMutex();

}  // namespace voxora
