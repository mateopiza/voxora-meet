#define INITGUID
#include "audio_capture.h"

#include <audioclient.h>
#include <propkeydef.h>
#include <functiondiscoverykeys_devpkey.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>

#include <algorithm>
#include <cmath>

using Microsoft::WRL::ComPtr;

namespace voxora {

namespace {

struct ComInit {
  HRESULT hr;
  ComInit() : hr(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) {}
  ~ComInit() { if (SUCCEEDED(hr)) CoUninitialize(); }
};

bool isFloatFormat(const WAVEFORMATEX* fmt) {
  if (fmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) return true;
  if (fmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
    auto* ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(fmt);
    return ext->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
  }
  return false;
}

void writeU32(std::string& out, uint32_t v) { out.append(reinterpret_cast<const char*>(&v), 4); }
void writeU16(std::string& out, uint16_t v) { out.append(reinterpret_cast<const char*>(&v), 2); }

}  // namespace

namespace {

// Enumeración común de endpoints activos de `flow`, con marca de predeterminado para `role`.
std::vector<AudioDevice> enumerateEndpoints(EDataFlow flow, ERole role) {
  std::vector<AudioDevice> out;
  ComInit com;
  ComPtr<IMMDeviceEnumerator> enumerator;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)))) return out;
  std::wstring defaultId;
  {
    ComPtr<IMMDevice> def;
    wchar_t* id = nullptr;
    if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(flow, role, &def)) && SUCCEEDED(def->GetId(&id))) {
      defaultId = id;
      CoTaskMemFree(id);
    }
  }
  ComPtr<IMMDeviceCollection> collection;
  if (FAILED(enumerator->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &collection))) return out;
  UINT count = 0;
  collection->GetCount(&count);
  for (UINT i = 0; i < count; i++) {
    ComPtr<IMMDevice> device;
    if (FAILED(collection->Item(i, &device))) continue;
    AudioDevice dev;
    wchar_t* id = nullptr;
    if (SUCCEEDED(device->GetId(&id))) {
      dev.id = id;
      CoTaskMemFree(id);
    }
    ComPtr<IPropertyStore> props;
    if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &props))) {
      PROPVARIANT name;
      PropVariantInit(&name);
      if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &name)) && name.vt == VT_LPWSTR) dev.name = name.pwszVal;
      PropVariantClear(&name);
    }
    dev.isDefault = (dev.id == defaultId);
    out.push_back(std::move(dev));
  }
  return out;
}

}  // namespace

std::vector<AudioDevice> enumerateRenderEndpoints() {
  auto out = enumerateEndpoints(eRender, eConsole);
  std::stable_sort(out.begin(), out.end(), [](const AudioDevice& a, const AudioDevice& b) { return a.isDefault && !b.isDefault; });
  return out;
}

std::vector<AudioDevice> enumerateMicrophones() {
  std::vector<AudioDevice> out;
  ComInit com;
  ComPtr<IMMDeviceEnumerator> enumerator;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)))) return out;
  std::wstring defaultId;
  {
    ComPtr<IMMDevice> def;
    wchar_t* id = nullptr;
    if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(eCapture, eCommunications, &def)) && SUCCEEDED(def->GetId(&id))) {
      defaultId = id;
      CoTaskMemFree(id);
    }
  }
  ComPtr<IMMDeviceCollection> collection;
  if (FAILED(enumerator->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &collection))) return out;
  UINT count = 0;
  collection->GetCount(&count);
  for (UINT i = 0; i < count; i++) {
    ComPtr<IMMDevice> device;
    if (FAILED(collection->Item(i, &device))) continue;
    AudioDevice dev;
    wchar_t* id = nullptr;
    if (SUCCEEDED(device->GetId(&id))) {
      dev.id = id;
      CoTaskMemFree(id);
    }
    ComPtr<IPropertyStore> props;
    if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &props))) {
      PROPVARIANT name;
      PropVariantInit(&name);
      if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &name)) && name.vt == VT_LPWSTR) dev.name = name.pwszVal;
      PropVariantClear(&name);
    }
    dev.isDefault = (dev.id == defaultId);
    // Los micrófonos virtuales (VOXORA / VB-Cable) son la salida del doblaje, no la fuente del hablante.
    if (dev.name.find(L"VOXORA Meet") != std::wstring::npos || dev.name.rfind(L"CABLE Output", 0) == 0) continue;
    out.push_back(std::move(dev));
  }
  std::stable_sort(out.begin(), out.end(), [](const AudioDevice& a, const AudioDevice& b) { return a.isDefault && !b.isDefault; });
  return out;
}

VoiceRecorder::~VoiceRecorder() {
  double s = 0;
  if (recording_.load() || thread_.joinable()) stop(s);
}

bool VoiceRecorder::start(const std::wstring& deviceId, const std::wstring& wavPath, int maxSeconds, std::wstring& error) {
  if (recording_.load()) return true;
  deviceId_ = deviceId;
  wavPath_ = wavPath;
  maxSeconds_ = std::max(1, maxSeconds);
  samples_.clear();
  finalized_ = false;
  seconds_.store(0);
  levelDb_.store(-100);
  failed_.store(false);
  error_.clear();
  startedEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  recording_.store(true);
  thread_ = std::thread([this] { loop(); });
  WaitForSingleObject(startedEvent_, 5000);
  CloseHandle(startedEvent_);
  startedEvent_ = nullptr;
  if (failed_.load()) {
    recording_.store(false);
    if (thread_.joinable()) thread_.join();
    error = error_;
    return false;
  }
  return true;
}

bool VoiceRecorder::stop(double& seconds) {
  // También se llama cuando el hilo ya paró solo (máximo por toma alcanzado): en ese caso
  // recording_ ya es false pero la toma aún no se ha escrito.
  recording_.store(false);
  if (thread_.joinable()) thread_.join();
  seconds = seconds_.load();
  if (finalized_) return !failed_.load();
  if (samples_.empty()) return false;
  finalize();
  finalized_ = true;
  samples_.clear();
  samples_.shrink_to_fit();
  return !failed_.load();
}

void VoiceRecorder::finalize() {
  // WAV PCM s16le mono a la tasa del dispositivo; el motor lo lee con wavToPcm.
  std::string out;
  const uint32_t dataBytes = static_cast<uint32_t>(samples_.size() * 2);
  out.reserve(44 + dataBytes);
  out += "RIFF";
  writeU32(out, 36 + dataBytes);
  out += "WAVE";
  out += "fmt ";
  writeU32(out, 16);
  writeU16(out, 1);
  writeU16(out, 1);
  writeU32(out, sampleRate_);
  writeU32(out, sampleRate_ * 2);
  writeU16(out, 2);
  writeU16(out, 16);
  out += "data";
  writeU32(out, dataBytes);
  out.append(reinterpret_cast<const char*>(samples_.data()), dataBytes);
  HANDLE h = CreateFileW(wavPath_.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) {
    failed_.store(true);
    return;
  }
  DWORD written = 0;
  if (!WriteFile(h, out.data(), static_cast<DWORD>(out.size()), &written, nullptr) || written != out.size()) failed_.store(true);
  CloseHandle(h);
}

void VoiceRecorder::loop() {
  ComInit com;
  auto fail = [this](const std::wstring& what) {
    error_ = what;
    failed_.store(true);
    if (startedEvent_) SetEvent(startedEvent_);
  };
  ComPtr<IMMDeviceEnumerator> enumerator;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)))) { fail(L"MMDeviceEnumerator"); return; }
  ComPtr<IMMDevice> device;
  HRESULT hr = deviceId_.empty() ? enumerator->GetDefaultAudioEndpoint(eCapture, eCommunications, &device)
                                 : enumerator->GetDevice(deviceId_.c_str(), &device);
  if (FAILED(hr)) { fail(L"Micrófono no disponible"); return; }
  ComPtr<IAudioClient> client;
  if (FAILED(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &client))) { fail(L"IAudioClient"); return; }
  WAVEFORMATEX* fmt = nullptr;
  if (FAILED(client->GetMixFormat(&fmt))) { fail(L"GetMixFormat"); return; }
  const bool isFloat = isFloatFormat(fmt);
  const uint16_t channels = fmt->nChannels;
  const uint16_t bits = fmt->wBitsPerSample;
  sampleRate_ = fmt->nSamplesPerSec;
  if (!isFloat && bits != 16) { CoTaskMemFree(fmt); fail(L"Formato de mezcla no soportado"); return; }
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 200 * 10'000, 0, fmt, nullptr);
  CoTaskMemFree(fmt);
  if (FAILED(hr)) { fail(L"IAudioClient::Initialize"); return; }
  HANDLE event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  client->SetEventHandle(event);
  ComPtr<IAudioCaptureClient> capture;
  if (FAILED(client->GetService(IID_PPV_ARGS(&capture)))) { CloseHandle(event); fail(L"IAudioCaptureClient"); return; }
  if (FAILED(client->Start())) { CloseHandle(event); fail(L"IAudioClient::Start"); return; }
  if (startedEvent_) SetEvent(startedEvent_);

  // ElevenLabs IVC admite archivos de hasta 10 MiB: la toma se corta antes de pasarse.
  const size_t maxSamples = std::min<size_t>(static_cast<size_t>(maxSeconds_) * sampleRate_, kMaxWavBytes / 2);
  maxSecondsEffective_.store(static_cast<double>(maxSamples) / sampleRate_);
  samples_.reserve(maxSamples);
  double windowSum = 0;
  size_t windowCount = 0;
  while (recording_.load()) {
    WaitForSingleObject(event, 100);
    UINT32 packet = 0;
    while (SUCCEEDED(capture->GetNextPacketSize(&packet)) && packet > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
      for (UINT32 i = 0; i < frames; i++) {
        float mono = 0;
        for (uint16_t c = 0; c < channels; c++) {
          if (flags & AUDCLNT_BUFFERFLAGS_SILENT) break;
          if (isFloat) mono += reinterpret_cast<const float*>(data)[i * channels + c];
          else mono += reinterpret_cast<const int16_t*>(data)[i * channels + c] / 32768.0f;
        }
        mono /= channels;
        windowSum += mono * mono;
        windowCount++;
        const int v = static_cast<int>(std::lround(mono * 32767.0f));
        samples_.push_back(static_cast<int16_t>(std::clamp(v, -32768, 32767)));
      }
      capture->ReleaseBuffer(frames);
    }
    seconds_.store(static_cast<double>(samples_.size()) / sampleRate_);
    if (windowCount >= sampleRate_ / 20) {
      const double rms = std::sqrt(windowSum / windowCount);
      levelDb_.store(rms > 1e-6 ? 20 * std::log10(rms) : -100);
      windowSum = 0;
      windowCount = 0;
    }
    if (samples_.size() >= maxSamples) break;
  }
  client->Stop();
  CloseHandle(event);
  recording_.store(false);
}

}  // namespace voxora
