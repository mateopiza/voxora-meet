// Audio del shell: enumeración de micrófonos (MMDevice) y grabador WASAPI para
// el onboarding de clonación de voz (≥ 60 s a WAV s16le mono).
#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <atomic>
#include <cstdint>
#include <string>
#include <thread>
#include <vector>

namespace voxora {

struct AudioDevice {
  std::wstring name;
  std::wstring id;  // id WASAPI del endpoint (el mismo que acepta MicCapture --device)
  bool isDefault = false;
};

std::vector<AudioDevice> enumerateMicrophones();

// Salidas de audio activas (endpoints de render). Incluye los virtuales ("VOXORA Meet Speaker",
// "CABLE Input"): son destino válido del doblaje. isDefault = predeterminado de consola.
std::vector<AudioDevice> enumerateRenderEndpoints();

class VoiceRecorder {
 public:
  VoiceRecorder() = default;
  ~VoiceRecorder();
  VoiceRecorder(const VoiceRecorder&) = delete;
  VoiceRecorder& operator=(const VoiceRecorder&) = delete;

  // Graba `deviceId` (vacío = predeterminado) a `wavPath` hasta stop() o `maxSeconds`.
  bool start(const std::wstring& deviceId, const std::wstring& wavPath, int maxSeconds, std::wstring& error);
  // Devuelve true si se escribió un WAV válido; `seconds` = duración grabada.
  bool stop(double& seconds);
  bool recording() const { return recording_.load(); }
  double seconds() const { return seconds_.load(); }
  double levelDb() const { return levelDb_.load(); }
  // Máximo real de la toma (min(maxSeconds, 10 MiB a la tasa del dispositivo)).
  double maxSecondsEffective() const { return maxSecondsEffective_.load(); }
  static constexpr size_t kMaxWavBytes = 10 * 1024 * 1024 - 4096;
  const std::wstring& path() const { return wavPath_; }

 private:
  void loop();
  void finalize();

  std::atomic<bool> recording_{false};
  std::atomic<double> seconds_{0};
  std::atomic<double> levelDb_{-100};
  std::atomic<double> maxSecondsEffective_{0};
  std::thread thread_;
  std::wstring deviceId_;
  std::wstring wavPath_;
  int maxSeconds_ = 90;
  uint32_t sampleRate_ = 48000;
  std::vector<int16_t> samples_;
  std::wstring error_;
  std::atomic<bool> failed_{false};
  bool finalized_ = false;
  HANDLE startedEvent_ = nullptr;
};

}  // namespace voxora
