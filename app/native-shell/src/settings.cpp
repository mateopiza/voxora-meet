#include "settings.h"

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <shlobj.h>
#include <wincrypt.h>

#include <algorithm>
#include <cmath>
#include <vector>

#include "engine_client.h"  // wideToUtf8 / utf8ToWide

namespace voxora {

json::Value Settings::toJson() const {
  json::Value v;
  v.set("delayMs", delayMs)
      .set("targetLanguage", targetLanguage)
      .set("sourceLanguage", sourceLanguage)
      .set("tone", tone)
      .set("styleInstruction", styleInstruction)
      .set("fallbackMode", fallbackMode)
      .set("memoryTurns", memoryTurns)
      .set("micDeviceId", micDeviceId)
      .set("cameraDeviceId", cameraDeviceId)
      .set("voiceId", voiceId)
      .set("voiceName", voiceName)
      .set("nodePath", nodePath)
      .set("virtualMicDevice", virtualMicDevice)
      .set("monitorDevice", monitorDevice)
      .set("cameraAlwaysOn", cameraAlwaysOn);
  for (const auto& [k, value] : cameraEffectsJson().asObject()) v.set(k, value);
  return v;
}

namespace {

bool boolish(const json::Value& v, bool fallback) {
  if (v.isBool()) return v.asBool();
  if (v.isNumber()) return v.asNumber() == 1 ? true : v.asNumber() == 0 ? false : fallback;
  if (v.isString()) return v.asString() == "true" || v.asString() == "1" ? true : v.asString() == "false" || v.asString() == "0" ? false : fallback;
  return fallback;
}

double clampNumber(const json::Value& v, double fallback, double lo, double hi) {
  if (!v.isNumber() || !std::isfinite(v.asNumber())) return fallback;
  return std::min(hi, std::max(lo, v.asNumber()));
}

}  // namespace

void Settings::mergeCameraEffects(const json::Value& v) {
  if (v.has("camMirror")) camMirror = boolish(v["camMirror"], camMirror);
  if (v.has("camFlip")) camFlip = boolish(v["camFlip"], camFlip);
  if (v.has("camRotation") && v["camRotation"].isNumber()) {
    const int r = v["camRotation"].asInt();
    if (r % 90 == 0) camRotation = ((r % 360) + 360) % 360;
  }
  if (v.has("camAspect") && v["camAspect"].isString()) {
    const std::string a = v["camAspect"].asString();
    if (a == "16:9" || a == "9:16") camAspect = a;
  }
  if (v.has("camZoom")) camZoom = clampNumber(v["camZoom"], camZoom, 1, 2);
  if (v.has("camPanX")) camPanX = clampNumber(v["camPanX"], camPanX, -1, 1);
  if (v.has("camPanY")) camPanY = clampNumber(v["camPanY"], camPanY, -1, 1);
  if (v.has("camBrightness")) camBrightness = clampNumber(v["camBrightness"], camBrightness, -1, 1);
  if (v.has("camContrast")) camContrast = clampNumber(v["camContrast"], camContrast, -1, 1);
  if (v.has("camSaturation")) camSaturation = clampNumber(v["camSaturation"], camSaturation, -1, 1);
  if (v.has("camTemperature")) camTemperature = clampNumber(v["camTemperature"], camTemperature, -1, 1);
}

json::Value Settings::cameraEffectsJson() const {
  json::Value v;
  v.set("camMirror", camMirror).set("camFlip", camFlip).set("camRotation", camRotation).set("camAspect", camAspect)
      .set("camZoom", camZoom).set("camPanX", camPanX).set("camPanY", camPanY).set("camBrightness", camBrightness)
      .set("camContrast", camContrast).set("camSaturation", camSaturation).set("camTemperature", camTemperature);
  return v;
}

VideoEffectsParams Settings::cameraEffects() const {
  VideoEffectsParams p;
  p.mirror = camMirror;
  p.flip = camFlip;
  p.rotation = camRotation;
  p.portrait = camAspect == "9:16";
  p.zoom = camZoom;
  p.panX = camPanX;
  p.panY = camPanY;
  p.brightness = camBrightness;
  p.contrast = camContrast;
  p.saturation = camSaturation;
  p.temperature = camTemperature;
  return p.sanitized();
}

Settings Settings::fromJson(const json::Value& v) {
  Settings s;
  s.delayMs = std::clamp(v["delayMs"].asInt(s.delayMs), 2000, 6000);
  s.targetLanguage = v["targetLanguage"].asString(s.targetLanguage);
  s.sourceLanguage = v["sourceLanguage"].asString(s.sourceLanguage);
  s.tone = v["tone"].asString(s.tone);
  s.styleInstruction = v["styleInstruction"].asString();  // el motor recorta a 400 chars
  s.fallbackMode = v["fallbackMode"].asString(s.fallbackMode);
  s.memoryTurns = std::clamp(v["memoryTurns"].asInt(s.memoryTurns), 0, 64);
  s.micDeviceId = v["micDeviceId"].asString();
  s.cameraDeviceId = v["cameraDeviceId"].asString();
  s.voiceId = v["voiceId"].asString();
  s.voiceName = v["voiceName"].asString();
  s.nodePath = v["nodePath"].asString();
  s.virtualMicDevice = v["virtualMicDevice"].asString(s.virtualMicDevice);
  s.monitorDevice = v["monitorDevice"].asString();
  s.cameraAlwaysOn = v["cameraAlwaysOn"].asBool(s.cameraAlwaysOn);
  s.mergeCameraEffects(v);
  return s;
}

std::wstring dataDir() {
  static std::wstring cached;
  if (!cached.empty()) return cached;
  PWSTR appData = nullptr;
  std::wstring base;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_RoamingAppData, 0, nullptr, &appData)) && appData) {
    base = appData;
    CoTaskMemFree(appData);
  } else {
    wchar_t buf[MAX_PATH];
    base = GetEnvironmentVariableW(L"APPDATA", buf, MAX_PATH) ? buf : L".";
  }
  cached = base + L"\\VOXORA Meet";
  CreateDirectoryW(cached.c_str(), nullptr);
  return cached;
}

std::wstring settingsPath() { return dataDir() + L"\\settings.json"; }
std::wstring providerKeysPath() { return dataDir() + L"\\provider-keys.dpapi"; }

bool readFileBytes(const std::wstring& path, std::string& out) {
  HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return false;
  LARGE_INTEGER size{};
  GetFileSizeEx(h, &size);
  out.resize(static_cast<size_t>(size.QuadPart));
  DWORD read = 0;
  bool ok = out.empty() || (ReadFile(h, out.data(), static_cast<DWORD>(out.size()), &read, nullptr) && read == out.size());
  CloseHandle(h);
  return ok;
}

bool writeFileBytesAtomic(const std::wstring& path, const std::string& data) {
  std::wstring tmp = path + L".tmp";
  HANDLE h = CreateFileW(tmp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return false;
  DWORD written = 0;
  bool ok = data.empty() || (WriteFile(h, data.data(), static_cast<DWORD>(data.size()), &written, nullptr) && written == data.size());
  CloseHandle(h);
  if (!ok) return false;
  return MoveFileExW(tmp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
}

Settings loadSettings() {
  std::string text;
  if (!readFileBytes(settingsPath(), text)) return Settings{};
  try {
    return Settings::fromJson(json::parse(text));
  } catch (...) {
    return Settings{};
  }
}

bool saveSettings(const Settings& s) {
  // Fusiona sobre el JSON existente para no pisar claves que solo conoce el motor.
  json::Value merged;
  std::string text;
  if (readFileBytes(settingsPath(), text)) {
    try { merged = json::parse(text); } catch (...) { merged = json::Value(); }
  }
  for (const auto& [k, v] : s.toJson().asObject()) merged.set(k, v);
  return writeFileBytesAtomic(settingsPath(), merged.dump());
}

bool dpapiProtect(const std::string& plain, std::string& blob) {
  DATA_BLOB in{static_cast<DWORD>(plain.size()), reinterpret_cast<BYTE*>(const_cast<char*>(plain.data()))};
  DATA_BLOB out{};
  if (!CryptProtectData(&in, L"VOXORA Meet provider keys", nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &out)) return false;
  blob.assign(reinterpret_cast<char*>(out.pbData), out.cbData);
  LocalFree(out.pbData);
  return true;
}

bool dpapiUnprotect(const std::string& blob, std::string& plain) {
  DATA_BLOB in{static_cast<DWORD>(blob.size()), reinterpret_cast<BYTE*>(const_cast<char*>(blob.data()))};
  DATA_BLOB out{};
  if (!CryptUnprotectData(&in, nullptr, nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &out)) return false;
  plain.assign(reinterpret_cast<char*>(out.pbData), out.cbData);
  SecureZeroMemory(out.pbData, out.cbData);
  LocalFree(out.pbData);
  return true;
}

json::Value loadProviderKeys() {
  std::string blob, plain;
  if (!readFileBytes(providerKeysPath(), blob) || !dpapiUnprotect(blob, plain)) return json::Value(json::Object{});
  try {
    json::Value v = json::parse(plain);
    return v.isObject() ? v : json::Value(json::Object{});
  } catch (...) {
    return json::Value(json::Object{});
  }
}

bool saveProviderKeys(const json::Value& keys) {
  json::Value clean;
  for (const char* name : {"groq", "elevenlabs"}) {
    const std::string& value = keys[name].asString();
    if (!value.empty()) clean.set(name, value);
  }
  if (!clean.isObject() || clean.asObject().empty()) {
    DeleteFileW(providerKeysPath().c_str());
    return true;
  }
  std::string blob;
  if (!dpapiProtect(clean.dump(), blob)) return false;
  return writeFileBytesAtomic(providerKeysPath(), blob);
}

}  // namespace voxora
