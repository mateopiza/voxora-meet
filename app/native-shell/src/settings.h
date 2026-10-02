// Ajustes del shell: %APPDATA%\VOXORA Meet\settings.json (mismo archivo y
// claves que el motor) y keys de proveedor cifradas con DPAPI
// (`provider-keys.dpapi`, blob crudo de CryptProtectData — compatible con
// ProtectedData.Protect que usa el motor).
#pragma once

#include <string>

#include "json.h"
#include "video_effects.h"

namespace voxora {

struct Settings {
  int delayMs = 3000;
  std::string targetLanguage = "en";
  std::string sourceLanguage = "es";
  std::string tone = "professional";  // professional | formal | neutral
  std::string styleInstruction;       // instrucción libre de estilo para el traductor (≤ 400 chars)
  std::string fallbackMode = "silence";
  int memoryTurns = 8;
  std::string micDeviceId;
  std::string cameraDeviceId;
  std::string voiceId;
  std::string voiceName;
  std::string nodePath;  // vacío = buscar node.exe (junto al exe, `node\`, PATH)
  std::string virtualMicDevice = "VOXORA Meet Speaker";  // endpoint de render donde sale el doblaje
  std::string monitorDevice;                             // "" = sin escucha local del doblaje
  bool cameraAlwaysOn = true;  // cámara virtual activa (en vivo, sin retraso) aunque no haya sesión
  // Imagen de la cámara (la aplica el shell en caliente antes de publicar; ver video_effects.h).
  bool camMirror = false;
  bool camFlip = false;
  int camRotation = 0;             // 0 | 90 | 180 | 270
  std::string camAspect = "16:9";  // "16:9" | "9:16"
  double camZoom = 1, camPanX = 0, camPanY = 0;
  double camBrightness = 0, camContrast = 0, camSaturation = 0, camTemperature = 0;

  json::Value toJson() const;
  static Settings fromJson(const json::Value& v);
  VideoEffectsParams cameraEffects() const;
  // Solo las claves cam* presentes en `v` (native.camera.effects); el resto se conserva.
  void mergeCameraEffects(const json::Value& v);
  json::Value cameraEffectsJson() const;
};

std::wstring dataDir();                       // %APPDATA%\VOXORA Meet (se crea si falta)
std::wstring settingsPath();
std::wstring providerKeysPath();

Settings loadSettings();
bool saveSettings(const Settings& s);

// Keys de proveedor (groq = STT + traducción, elevenlabs = TTS + STT, openai = traducción + STT) — objeto JSON plano.
json::Value loadProviderKeys();
bool saveProviderKeys(const json::Value& keys);

// DPAPI (CurrentUser).
bool dpapiProtect(const std::string& plain, std::string& blob);
bool dpapiUnprotect(const std::string& blob, std::string& plain);

bool readFileBytes(const std::wstring& path, std::string& out);
bool writeFileBytesAtomic(const std::wstring& path, const std::string& data);

}  // namespace voxora
