// «Grabar prueba»: MP4 (H.264 + AAC con IMFSinkWriter) con exactamente lo que recibe Meet:
//   - video: los frames que el shell publica en la cámara virtual (tras la imagen de la cámara y con el
//     retraso vigente), tomados en el hilo de publicación (CameraCapture::FrameTap, sin copias: el
//     buffer se intercambia) y escritos a 30 fps constantes (se repite el último si no llega otro; negro
//     si la cámara virtual no publica nada);
//   - audio: el endpoint de CAPTURA emparejado con el micrófono virtual («VOXORA Meet Microphone» o
//     «CABLE Output», el `virtualMic.captureName` de devices.list) con WASAPI compartido: lo mismo que
//     oye Meet (doblaje en sesión; silencio sin sesión).
// Los archivos van a %LOCALAPPDATA%\VOXORA Meet\recordings y la UI los reproduce desde
// https://recordings.voxora-meet/<archivo>.mp4 (mapeo de carpeta de WebView2).
#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "json.h"

namespace voxora {

struct TestRecordingResult {
  bool ok = false;
  std::wstring path;
  std::string reason;         // complete | user | error | shutdown
  std::wstring message;       // en español, para la UI (vacío si todo fue bien)
  double durationSec = 0;     // medida en el MP4 final (MF_PD_DURATION)
  uint64_t sizeBytes = 0;
  bool hasVideo = false;      // pistas presentes en el MP4 final
  bool hasAudio = false;
  std::wstring audioDevice;   // endpoint grabado ("" = sin audio)
  int videoFrames = 0;        // frames escritos (30 fps)
  int cameraFrames = 0;       // frames recibidos de la cámara virtual
  std::wstring encoder;       // «hardware» | «software»
};

// Lee un MP4 con Media Foundation: duración y pistas. false si no se pudo abrir.
bool probeMp4(const std::wstring& path, double& durationSec, bool& hasVideo, bool& hasAudio);

class TestRecorder {
 public:
  struct Options {
    std::wstring path;
    int seconds = 10;
    std::vector<std::wstring> audioCandidates;  // nombres (o subcadenas) de endpoints de captura, por orden
    int width = 1280, height = 720, fps = 30;
    bool allowHardware = true;
  };
  using Started = std::function<void(bool ok, const std::wstring& error, const std::wstring& audioDevice)>;
  using Progress = std::function<void(double elapsedSec, double levelDb, int cameraFrames)>;
  using Finished = std::function<void(const TestRecordingResult&)>;

  TestRecorder() = default;
  ~TestRecorder();
  TestRecorder(const TestRecorder&) = delete;
  TestRecorder& operator=(const TestRecorder&) = delete;

  // No bloquea: prepara WASAPI y el sink writer en su hilo y avisa con `started`; luego `progress`
  // cada ~250 ms y `finished` al cerrar el MP4. Todos los callbacks llegan desde el hilo del grabador.
  bool start(const Options& options, Started started, Progress progress, Finished finished);
  void requestStop(const char* reason);  // termina antes de tiempo (el MP4 queda válido)
  bool running() const { return running_.load(); }
  void join();

  // Hilo de publicación de la cámara: se queda con el frame (intercambia el buffer).
  void offerFrame(std::vector<uint8_t>& rgba, uint32_t width, uint32_t height);

 private:
  void loop();

  Options options_;
  Started started_;
  Progress progress_;
  Finished finished_;
  std::thread thread_;
  std::atomic<bool> running_{false};
  std::atomic<bool> stop_{false};
  std::string stopReason_ = "user";
  std::mutex frameMutex_;
  std::vector<uint8_t> latest_;  // último frame RGBA recibido
  bool latestFresh_ = false;
  uint32_t latestW_ = 0, latestH_ = 0;
  std::atomic<int> cameraFrames_{0};
};

// Comandos nativos `native.recording.*` y eventos `recording.progress` / `recording.done`.
class TestRecordingController {
 public:
  struct Bridge {
    std::function<void(const json::Value& id, bool ok, const json::Value& payload)> reply;
    std::function<void(const std::string& event, const json::Value& data)> event;
    std::function<void(std::function<void()>)> runOnUi;
  };
  struct Hooks {
    // Conecta/desconecta la salida de frames publicados (CameraCapture::setFrameTap).
    std::function<void(std::function<void(std::vector<uint8_t>&, uint32_t, uint32_t, int64_t)>)> setFrameTap;
    std::function<bool()> videoActive;                // la cámara virtual está publicando frames
    std::function<std::wstring()> virtualMicCapture;  // captureName resuelto (devices.list)
  };

  static constexpr const wchar_t* kHost = L"recordings.voxora-meet";
  static std::wstring directory();  // %LOCALAPPDATA%\VOXORA Meet\recordings (se crea)

  void init(Bridge bridge, Hooks hooks);
  // true si `cmd` es de grabación (ya respondido).
  bool handle(const json::Value& id, const std::string& cmd, const json::Value& params);
  bool recording() const { return recorder_.running(); }
  void shutdown();  // cierra el MP4 en curso (válido) antes de salir

 private:
  json::Value resultJson(const TestRecordingResult& r) const;
  json::Value fileJson(const std::wstring& path) const;
  bool isOwnFile(const std::wstring& path) const;

  Bridge bridge_;
  Hooks hooks_;
  TestRecorder recorder_;
  std::wstring currentPath_;
  int currentSeconds_ = 0;
  double elapsed_ = 0;
  bool active_ = false;  // hay una grabación arrancando o en curso (hilo de UI)
};

}  // namespace voxora
