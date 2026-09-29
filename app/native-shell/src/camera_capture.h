// Captura de webcam con Media Foundation (IMFSourceReader, RGB32 1280x720@30), imagen de la cámara
// (video_effects.h: espejo, volteo, rotación, 16:9/9:16, zoom, color) aplicada en la misma pasada que
// convierte el buffer de MF al lienzo RGBA 1280x720, ring de frames con el retraso de video vigente (0
// fuera de la sesión de doblaje, `delayMs` durante ella; ver docs/VIDEO-SYNC.md) y publicación en la
// memoria compartida de la cámara virtual con el productor común
// (windows-camera/native/common/frame_producer.h, el mismo que VoxoraMeetFrameWriter).
//
// El host de la cámara virtual (VoxoraMeetVCamHost.exe) NO lo gestiona esta clase: ver vcam_host.h.
#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <atomic>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "video_effects.h"

namespace voxora {

struct CameraDevice {
  std::wstring name;
  std::wstring symbolicLink;
};

std::vector<CameraDevice> enumerateCameras();

class CameraCapture {
 public:
  struct Stats {
    bool running = false;
    int width = 0;
    int height = 0;
    double captureFps = 0;
    int queuedFrames = 0;
    int delayMs = 0;
    bool sharedMemoryOk = false;  // el productor tiene abierto el mapping de la DLL
    bool sourceLost = false;
    uint64_t published = 0;
    int outputWidth = kTargetWidth;   // lienzo que se publica (siempre 1280x720)
    int outputHeight = kTargetHeight;
    double effectsMs = 0;             // imagen de la cámara: media de ms/frame en el último segundo
    double effectsPeakMs = 0;         // … y máximo en ese segundo
  };

  // Recibe cada frame justo después de publicarlo en la cámara virtual (RGBA del lienzo, tras efectos y
  // con el retraso vigente): exactamente lo que ve Meet. Se llama desde el hilo de publicación; puede
  // quedarse el buffer intercambiándolo por otro del mismo tamaño (o dejarlo tal cual).
  using FrameTap = std::function<void(std::vector<uint8_t>& rgba, uint32_t width, uint32_t height, int64_t timestamp100ns)>;

  CameraCapture() = default;
  ~CameraCapture();
  CameraCapture(const CameraCapture&) = delete;
  CameraCapture& operator=(const CameraCapture&) = delete;

  // `symbolicLink` vacío = primera cámara disponible. `delayMs` 0..6000 (0 = en vivo). El lado de la
  // cámara virtual (hilo de publicación) arranca siempre; si la webcam no abre queda "perdida" (la
  // cámara virtual muestra su imagen de espera) hasta que restartSource() la recupere.
  bool start(const std::wstring& symbolicLink, int delayMs, std::wstring& error);
  void stop();
  bool running() const { return running_.load(); }
  void setDelayMs(int delayMs);
  int delayMs() const { return delayMs_.load(); }
  Stats stats();

  // La webcam dejó de entregar frames (desconectada o invalidada). Cuando el ring se vacía se deja
  // de latir la memoria compartida y la cámara virtual pasa a su imagen de espera (no se congela).
  bool sourceLost() const { return sourceLost_.load(); }
  // Fuerza el estado "perdida" (la enumeración ya no la ve) y detiene solo la lectura.
  void markSourceLost();
  // Reabre solo la webcam (sin tocar la memoria compartida ni el hilo de publicación).
  bool restartSource(const std::wstring& symbolicLink, std::wstring& error);
  // symbolic link de la webcam abierta (resuelto si se pidió "primera disponible").
  std::wstring activeLink();

  // Imagen de la cámara: se aplica en caliente desde el siguiente frame capturado (sin reabrir la
  // webcam). Seguro desde cualquier hilo; si no cambia nada no hace nada.
  void setEffects(const VideoEffectsParams& params);
  VideoEffectsParams effects();
  void setFrameTap(FrameTap tap);  // vacío = quitarlo. Seguro desde cualquier hilo.

  static constexpr int kTargetWidth = 1280;
  static constexpr int kTargetHeight = 720;
  static constexpr int kTargetFps = 30;
  static constexpr int kMaxDelayMs = 6000;
  static constexpr size_t kRingBudgetBytes = 640ull * 1024 * 1024;

 private:
  struct Frame {
    int64_t timestamp100ns = 0;
    uint32_t width = 0;
    uint32_t height = 0;
    std::vector<uint8_t> rgba;
  };

  bool launchCapture(const std::wstring& symbolicLink, std::wstring& error);
  void captureLoop(std::wstring symbolicLink);
  void publishLoop();
  void enqueue(Frame&& frame);
  std::vector<uint8_t> takeBuffer(size_t bytes);  // del pool (evita reservar 3,6 MB por frame)
  void recycle(std::vector<uint8_t>&& buffer);

  std::atomic<bool> running_{false};
  std::atomic<bool> captureStop_{false};
  std::atomic<bool> sourceLost_{false};
  std::mutex linkMutex_;
  std::wstring activeLink_;
  std::atomic<int> delayMs_{0};
  std::thread captureThread_;
  std::thread publishThread_;
  std::mutex ringMutex_;
  std::deque<Frame> ring_;
  size_t ringCapacity_ = 1;
  uint64_t frameCounter_ = 0;
  std::atomic<uint64_t> published_{0};
  std::atomic<int> width_{0};
  std::atomic<int> height_{0};
  std::atomic<double> captureFps_{0};
  std::atomic<bool> sharedMemoryOk_{false};
  std::wstring startError_;
  std::atomic<bool> startFailed_{false};
  HANDLE startedEvent_ = nullptr;

  std::mutex fxMutex_;
  VideoEffectsParams fxParams_;
  std::atomic<uint32_t> fxGen_{0};
  std::atomic<double> fxAvgMs_{0};
  std::atomic<double> fxPeakMs_{0};
  std::mutex tapMutex_;
  FrameTap tap_;
  std::mutex poolMutex_;
  std::vector<std::vector<uint8_t>> pool_;
};

}  // namespace voxora
