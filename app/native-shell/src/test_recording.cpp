#include "test_recording.h"

#include <initguid.h>  // PKEY_Device_FriendlyName (selectany: no choca con audio_capture.cpp)
#include <audioclient.h>
#include <codecapi.h>
#include <propkeydef.h>
#include <functiondiscoverykeys_devpkey.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mmdeviceapi.h>
#include <shellapi.h>
#include <shlobj.h>
#include <knownfolders.h>
#include <wrl/client.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <cwctype>
#include <iterator>

using Microsoft::WRL::ComPtr;

namespace voxora {

namespace {

// UTF-8 ⇄ UTF-16 locales (el módulo no depende del cliente del motor; lo usa también shell_selftest).
std::string wideToUtf8(const std::wstring& text) {
  if (text.empty()) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  std::string out(static_cast<size_t>(n), char{});
  WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), n, nullptr, nullptr);
  return out;
}

std::wstring utf8ToWide(const std::string& text) {
  if (text.empty()) return {};
  const int n = MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0);
  std::wstring out(static_cast<size_t>(n), wchar_t{});
  MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), n);
  return out;
}

struct ComInit {
  HRESULT hr;
  ComInit() : hr(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) {}
  ~ComInit() { if (SUCCEEDED(hr)) CoUninitialize(); }
};

struct MfSession {
  bool ok = false;
  MfSession() { ok = SUCCEEDED(MFStartup(MF_VERSION, MFSTARTUP_LITE)); }
  ~MfSession() { if (ok) MFShutdown(); }
};

int64_t qpc100ns() {
  static const LARGE_INTEGER freq = [] {
    LARGE_INTEGER f;
    QueryPerformanceFrequency(&f);
    return f;
  }();
  LARGE_INTEGER now;
  QueryPerformanceCounter(&now);
  return now.QuadPart / freq.QuadPart * 10'000'000 + (now.QuadPart % freq.QuadPart) * 10'000'000 / freq.QuadPart;
}

bool containsNoCase(const std::wstring& haystack, const std::wstring& needle) {
  if (needle.empty()) return false;
  auto it = std::search(haystack.begin(), haystack.end(), needle.begin(), needle.end(),
                        [](wchar_t a, wchar_t b) { return std::towlower(a) == std::towlower(b); });
  return it != haystack.end();
}

// Endpoint de captura cuyo nombre contiene alguno de los candidatos (por orden de preferencia).
ComPtr<IMMDevice> findCaptureEndpoint(const std::vector<std::wstring>& candidates, std::wstring& name) {
  ComPtr<IMMDeviceEnumerator> enumerator;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)))) return nullptr;
  ComPtr<IMMDeviceCollection> collection;
  if (FAILED(enumerator->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &collection))) return nullptr;
  UINT count = 0;
  collection->GetCount(&count);
  std::vector<std::pair<std::wstring, ComPtr<IMMDevice>>> all;
  for (UINT i = 0; i < count; i++) {
    ComPtr<IMMDevice> device;
    if (FAILED(collection->Item(i, &device))) continue;
    ComPtr<IPropertyStore> props;
    std::wstring friendly;
    if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &props))) {
      PROPVARIANT v;
      PropVariantInit(&v);
      if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &v)) && v.vt == VT_LPWSTR) friendly = v.pwszVal;
      PropVariantClear(&v);
    }
    all.emplace_back(friendly, device);
  }
  for (const auto& wanted : candidates) {
    for (const auto& [friendly, device] : all) {
      if (containsNoCase(friendly, wanted)) {
        name = friendly;
        return device;
      }
    }
  }
  return nullptr;
}

enum class SampleKind { Float32, Int16, Int32, Int24 };

// RGBA8 → NV12 (BT.709, rango limitado 16–235), croma 2x2 promediado.
void rgbaToNv12(const uint8_t* rgba, int w, int h, uint8_t* yPlane, uint8_t* uvPlane) {
  for (int y = 0; y < h; y += 2) {
    const uint8_t* r0 = rgba + static_cast<size_t>(y) * w * 4;
    const uint8_t* r1 = y + 1 < h ? r0 + static_cast<size_t>(w) * 4 : r0;
    uint8_t* y0 = yPlane + static_cast<size_t>(y) * w;
    uint8_t* y1 = y + 1 < h ? y0 + w : nullptr;
    uint8_t* uv = uvPlane + static_cast<size_t>(y / 2) * w;
    for (int x = 0; x < w; x += 2) {
      int sr = 0, sg = 0, sb = 0;
      for (int k = 0; k < 2; k++) {
        const uint8_t* p = r0 + (x + k) * 4;
        y0[x + k] = static_cast<uint8_t>(((47 * p[0] + 157 * p[1] + 16 * p[2] + 128) >> 8) + 16);
        sr += p[0];
        sg += p[1];
        sb += p[2];
        const uint8_t* q = r1 + (x + k) * 4;
        if (y1) y1[x + k] = static_cast<uint8_t>(((47 * q[0] + 157 * q[1] + 16 * q[2] + 128) >> 8) + 16);
        sr += q[0];
        sg += q[1];
        sb += q[2];
      }
      sr >>= 2;
      sg >>= 2;
      sb >>= 2;
      uv[x] = static_cast<uint8_t>(std::clamp(((-26 * sr - 87 * sg + 112 * sb + 128) >> 8) + 128, 0, 255));
      uv[x + 1] = static_cast<uint8_t>(std::clamp(((112 * sr - 102 * sg - 10 * sb + 128) >> 8) + 128, 0, 255));
    }
  }
}

HRESULT makeNv12Buffer(int w, int h, ComPtr<IMFMediaBuffer>& buffer, BYTE*& data) {
  const DWORD bytes = static_cast<DWORD>(w * h * 3 / 2);
  HRESULT hr = MFCreateMemoryBuffer(bytes, &buffer);
  if (FAILED(hr)) return hr;
  DWORD maxLen = 0;
  hr = buffer->Lock(&data, &maxLen, nullptr);
  if (FAILED(hr)) return hr;
  buffer->SetCurrentLength(bytes);
  return S_OK;
}

}  // namespace

bool probeMp4(const std::wstring& path, double& durationSec, bool& hasVideo, bool& hasAudio) {
  durationSec = 0;
  hasVideo = hasAudio = false;
  ComInit com;
  MfSession mf;
  if (!mf.ok) return false;
  ComPtr<IMFSourceReader> reader;
  if (FAILED(MFCreateSourceReaderFromURL(path.c_str(), nullptr, &reader))) return false;
  PROPVARIANT var;
  PropVariantInit(&var);
  if (SUCCEEDED(reader->GetPresentationAttribute(static_cast<DWORD>(MF_SOURCE_READER_MEDIASOURCE), MF_PD_DURATION, &var)) &&
      var.vt == VT_UI8) {
    durationSec = static_cast<double>(var.uhVal.QuadPart) / 1e7;
  }
  PropVariantClear(&var);
  ComPtr<IMFMediaType> type;
  hasVideo = SUCCEEDED(reader->GetNativeMediaType(static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM), 0, &type));
  type.Reset();
  hasAudio = SUCCEEDED(reader->GetNativeMediaType(static_cast<DWORD>(MF_SOURCE_READER_FIRST_AUDIO_STREAM), 0, &type));
  return true;
}

// ── Grabador ────────────────────────────────────────────────────────────────
TestRecorder::~TestRecorder() {
  requestStop("shutdown");
  join();
}

bool TestRecorder::start(const Options& options, Started started, Progress progress, Finished finished) {
  if (running_.load()) return false;
  join();
  options_ = options;
  options_.seconds = std::clamp(options_.seconds, 1, 120);
  started_ = std::move(started);
  progress_ = std::move(progress);
  finished_ = std::move(finished);
  stop_.store(false);
  stopReason_ = "user";
  cameraFrames_.store(0);
  {
    std::lock_guard<std::mutex> lock(frameMutex_);
    latestFresh_ = false;
  }
  running_.store(true);
  thread_ = std::thread([this] { loop(); });
  return true;
}

void TestRecorder::requestStop(const char* reason) {
  if (!running_.load()) return;
  {
    std::lock_guard<std::mutex> lock(frameMutex_);
    if (!stop_.load()) stopReason_ = reason ? reason : "user";
  }
  stop_.store(true);
}

void TestRecorder::join() {
  if (thread_.joinable() && thread_.get_id() != std::this_thread::get_id()) thread_.join();
}

void TestRecorder::offerFrame(std::vector<uint8_t>& rgba, uint32_t width, uint32_t height) {
  if (!running_.load()) return;
  std::lock_guard<std::mutex> lock(frameMutex_);
  latest_.swap(rgba);  // el de antes vuelve al pool de la cámara
  latestW_ = width;
  latestH_ = height;
  latestFresh_ = true;
  cameraFrames_.fetch_add(1);
}

void TestRecorder::loop() {
  ComInit com;
  MfSession mf;
  TestRecordingResult result;
  result.path = options_.path;
  bool startedSent = false;
  auto fail = [&](const std::wstring& message) {
    result.ok = false;
    result.reason = "error";
    result.message = message;
    if (!startedSent && started_) started_(false, message, L"");
    startedSent = true;
  };

  const int W = options_.width, H = options_.height, fps = options_.fps;
  // Instante exacto del frame k a `fps` (sin acumular el redondeo de 333 333,3 × 100 ns).
  auto frameTime = [fps](int k) { return static_cast<LONGLONG>(k) * 10'000'000 / fps; };

  // ── Audio: endpoint de captura del micrófono virtual (WASAPI compartido) ──
  ComPtr<IAudioClient> audioClient;
  ComPtr<IAudioCaptureClient> capture;
  HANDLE audioEvent = nullptr;
  UINT32 inRate = 48000, outRate = 48000;
  WORD inChannels = 2, outChannels = 2;
  SampleKind kind = SampleKind::Float32;
  if (mf.ok) {
    std::wstring name;
    ComPtr<IMMDevice> device = findCaptureEndpoint(options_.audioCandidates, name);
    WAVEFORMATEX* fmt = nullptr;
    if (device && SUCCEEDED(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &audioClient)) &&
        SUCCEEDED(audioClient->GetMixFormat(&fmt))) {
      inRate = fmt->nSamplesPerSec;
      inChannels = fmt->nChannels;
      bool isFloat = fmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
      if (fmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE)
        isFloat = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(fmt)->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
      const WORD bits = fmt->wBitsPerSample;
      bool supported = true;
      if (isFloat && bits == 32) kind = SampleKind::Float32;
      else if (!isFloat && bits == 16) kind = SampleKind::Int16;
      else if (!isFloat && bits == 32) kind = SampleKind::Int32;
      else if (!isFloat && bits == 24) kind = SampleKind::Int24;
      else supported = false;
      // 2 s de buffer: si el codificador frena un momento el bucle no se pierde audio.
      if (supported && inChannels > 0 &&
          SUCCEEDED(audioClient->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 20'000'000, 0, fmt, nullptr))) {
        audioEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        audioClient->SetEventHandle(audioEvent);
        if (SUCCEEDED(audioClient->GetService(IID_PPV_ARGS(&capture)))) result.audioDevice = name;
      }
      CoTaskMemFree(fmt);
    }
    if (result.audioDevice.empty()) {
      capture.Reset();
      audioClient.Reset();
      if (audioEvent) CloseHandle(audioEvent);
      audioEvent = nullptr;
    }
  }
  outChannels = static_cast<WORD>(std::min<int>(2, std::max<int>(1, inChannels)));
  outRate = (inRate == 44100 || inRate == 48000) ? inRate : 48000;  // el codificador AAC solo admite 44,1/48 kHz
  const bool withAudio = !result.audioDevice.empty();

  // ── Sink writer: H.264 (+ AAC). Primero con codificadores por hardware; si no, por software ──
  ComPtr<IMFSinkWriter> writer;
  DWORD videoStream = 0, audioStream = 0;
  auto createWriter = [&](bool hardware) -> HRESULT {
    writer.Reset();
    DeleteFileW(options_.path.c_str());
    ComPtr<IMFAttributes> attrs;
    HRESULT hr = MFCreateAttributes(&attrs, 3);
    if (FAILED(hr)) return hr;
    attrs->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, hardware ? TRUE : FALSE);
    attrs->SetGUID(MF_TRANSCODE_CONTAINERTYPE, MFTranscodeContainerType_MPEG4);
    hr = MFCreateSinkWriterFromURL(options_.path.c_str(), nullptr, attrs.Get(), &writer);
    if (FAILED(hr)) return hr;

    ComPtr<IMFMediaType> vOut, vIn;
    MFCreateMediaType(&vOut);
    vOut->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    vOut->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
    vOut->SetUINT32(MF_MT_AVG_BITRATE, 5'000'000);
    vOut->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    vOut->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Main);
    MFSetAttributeSize(vOut.Get(), MF_MT_FRAME_SIZE, W, H);
    MFSetAttributeRatio(vOut.Get(), MF_MT_FRAME_RATE, fps, 1);
    MFSetAttributeRatio(vOut.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    hr = writer->AddStream(vOut.Get(), &videoStream);
    if (FAILED(hr)) return hr;
    MFCreateMediaType(&vIn);
    vIn->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    vIn->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
    vIn->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    vIn->SetUINT32(MF_MT_DEFAULT_STRIDE, static_cast<UINT32>(W));
    vIn->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709);
    vIn->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235);
    MFSetAttributeSize(vIn.Get(), MF_MT_FRAME_SIZE, W, H);
    MFSetAttributeRatio(vIn.Get(), MF_MT_FRAME_RATE, fps, 1);
    MFSetAttributeRatio(vIn.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    hr = writer->SetInputMediaType(videoStream, vIn.Get(), nullptr);
    if (FAILED(hr)) return hr;

    if (withAudio) {
      ComPtr<IMFMediaType> aOut, aIn;
      MFCreateMediaType(&aOut);
      aOut->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
      aOut->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_AAC);
      aOut->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
      aOut->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, outRate);
      aOut->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, outChannels);
      aOut->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, outChannels == 2 ? 20000 : 12000);
      hr = writer->AddStream(aOut.Get(), &audioStream);
      if (FAILED(hr)) return hr;
      MFCreateMediaType(&aIn);
      aIn->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
      aIn->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM);
      aIn->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
      aIn->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, outRate);
      aIn->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, outChannels);
      aIn->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, outChannels * 2u);
      aIn->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, outRate * outChannels * 2u);
      hr = writer->SetInputMediaType(audioStream, aIn.Get(), nullptr);
      if (FAILED(hr)) return hr;
    }
    return writer->BeginWriting();
  };

  if (!mf.ok) {
    fail(L"Media Foundation no está disponible en este equipo.");
  } else {
    HRESULT hr = options_.allowHardware ? createWriter(true) : E_FAIL;
    result.encoder = L"auto";
    if (FAILED(hr)) {
      hr = createWriter(false);
      result.encoder = L"software";
    }
    if (FAILED(hr)) {
      wchar_t buf[96];
      swprintf_s(buf, L"No se pudo preparar el archivo MP4 (0x%08X).", static_cast<unsigned>(hr));
      writer.Reset();
      fail(buf);
    }
  }

  if (writer) {
    if (started_) started_(true, L"", result.audioDevice);
    startedSent = true;

    // Negro (Y=16, UV=128) mientras no llegue ningún frame de la cámara virtual.
    ComPtr<IMFMediaBuffer> frameBuffer;
    {
      BYTE* data = nullptr;
      if (SUCCEEDED(makeNv12Buffer(W, H, frameBuffer, data))) {
        std::memset(data, 16, static_cast<size_t>(W) * H);
        std::memset(data + static_cast<size_t>(W) * H, 128, static_cast<size_t>(W) * H / 2);
        frameBuffer->Unlock();
      }
    }
    std::vector<uint8_t> work;  // frame RGBA que se está convirtiendo
    std::vector<int16_t> pcm;   // audio pendiente de escribir (intercalado, outChannels)
    float prev[2] = {0, 0}, cur[2] = {0, 0};
    double resamplePos = 1.0;
    const double resampleStep = static_cast<double>(inRate) / outRate;
    const bool resample = withAudio && inRate != outRate;
    uint64_t audioWritten = 0;  // frames de audio escritos (a outRate)
    int videoWritten = 0;
    double levelSum = 0;
    size_t levelCount = 0;
    double levelDb = -100;
    bool writeError = false;

    auto writeAudio = [&](bool force) {
      const size_t chunk = outRate / 50;  // 20 ms
      while (!pcm.empty() && (force || pcm.size() / outChannels >= chunk)) {
        const size_t frames = std::min(pcm.size() / outChannels, chunk);
        if (frames == 0) break;
        const DWORD bytes = static_cast<DWORD>(frames * outChannels * 2);
        ComPtr<IMFMediaBuffer> buf;
        BYTE* data = nullptr;
        if (FAILED(MFCreateMemoryBuffer(bytes, &buf)) || FAILED(buf->Lock(&data, nullptr, nullptr))) {
          writeError = true;
          return;
        }
        std::memcpy(data, pcm.data(), bytes);
        buf->Unlock();
        buf->SetCurrentLength(bytes);
        ComPtr<IMFSample> sample;
        MFCreateSample(&sample);
        sample->AddBuffer(buf.Get());
        sample->SetSampleTime(static_cast<LONGLONG>(audioWritten * 10'000'000ull / outRate));
        sample->SetSampleDuration(static_cast<LONGLONG>(frames * 10'000'000ull / outRate));
        if (FAILED(writer->WriteSample(audioStream, sample.Get()))) {
          writeError = true;
          return;
        }
        audioWritten += frames;
        pcm.erase(pcm.begin(), pcm.begin() + static_cast<ptrdiff_t>(frames * outChannels));
      }
    };
    auto pushFrame = [&](const float* f) {
      for (WORD c = 0; c < outChannels; c++) {
        const float v = std::clamp(f[c], -1.0f, 1.0f);
        pcm.push_back(static_cast<int16_t>(std::lround(v * 32767.0f)));
        levelSum += static_cast<double>(v) * v;
        levelCount++;
      }
    };
    auto drainAudio = [&]() {
      if (!capture) return;
      UINT32 packet = 0;
      while (SUCCEEDED(capture->GetNextPacketSize(&packet)) && packet > 0) {
        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
        const bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
        float in[2] = {0, 0};
        for (UINT32 i = 0; i < frames; i++) {
          // Mezcla a mono o estéreo (canales extra fuera) en float.
          for (WORD c = 0; c < outChannels; c++) {
            float v = 0;
            if (!silent) {
              const size_t idx = static_cast<size_t>(i) * inChannels + (inChannels == 1 ? 0 : c);
              switch (kind) {
                case SampleKind::Float32: v = reinterpret_cast<const float*>(data)[idx]; break;
                case SampleKind::Int16: v = reinterpret_cast<const int16_t*>(data)[idx] / 32768.0f; break;
                case SampleKind::Int32: v = static_cast<float>(reinterpret_cast<const int32_t*>(data)[idx] / 2147483648.0); break;
                case SampleKind::Int24: {
                  const uint8_t* p = data + idx * 3;
                  const int32_t s = static_cast<int32_t>((static_cast<uint32_t>(p[0]) << 8) | (static_cast<uint32_t>(p[1]) << 16) |
                                                         (static_cast<uint32_t>(p[2]) << 24)) >> 8;
                  v = s / 8388608.0f;
                  break;
                }
              }
            }
            in[c] = v;
          }
          if (!resample) {
            pushFrame(in);
            continue;
          }
          // Remuestreo lineal a 48 kHz (solo si el dispositivo no está a 44,1/48 kHz).
          for (WORD c = 0; c < outChannels; c++) {
            prev[c] = cur[c];
            cur[c] = in[c];
          }
          while (resamplePos <= 1.0) {
            float o[2] = {0, 0};
            for (WORD c = 0; c < outChannels; c++) o[c] = prev[c] + (cur[c] - prev[c]) * static_cast<float>(resamplePos);
            pushFrame(o);
            resamplePos += resampleStep;
          }
          resamplePos -= 1.0;
        }
        capture->ReleaseBuffer(frames);
      }
    };
    auto writeVideoFrame = [&](int index) {
      bool fresh = false;
      {
        std::lock_guard<std::mutex> lock(frameMutex_);
        if (latestFresh_ && latestW_ == static_cast<uint32_t>(W) && latestH_ == static_cast<uint32_t>(H) &&
            latest_.size() >= static_cast<size_t>(W) * H * 4) {
          work.swap(latest_);
          latestFresh_ = false;
          fresh = true;
        }
      }
      if (fresh) {
        // Frame nuevo: se convierte en un buffer nuevo (el anterior puede seguir en el codificador).
        ComPtr<IMFMediaBuffer> buf;
        BYTE* data = nullptr;
        if (SUCCEEDED(makeNv12Buffer(W, H, buf, data))) {
          rgbaToNv12(work.data(), W, H, data, data + static_cast<size_t>(W) * H);
          buf->Unlock();
          frameBuffer = buf;
        }
      }
      if (!frameBuffer) return;
      ComPtr<IMFSample> sample;
      MFCreateSample(&sample);
      sample->AddBuffer(frameBuffer.Get());
      sample->SetSampleTime(frameTime(index));
      sample->SetSampleDuration(frameTime(index + 1) - frameTime(index));
      if (FAILED(writer->WriteSample(videoStream, sample.Get()))) writeError = true;
      else videoWritten++;
    };

    if (audioClient) audioClient->Start();
    const int64_t t0 = qpc100ns();
    const int64_t total100ns = static_cast<int64_t>(options_.seconds) * 10'000'000;
    int64_t lastProgress = 0;
    int64_t end100ns = total100ns;
    bool stoppedEarly = false;
    while (!writeError) {
      const int64_t elapsed = qpc100ns() - t0;
      if (stop_.load()) {
        end100ns = std::min(elapsed, total100ns);
        stoppedEarly = true;
        break;
      }
      if (elapsed >= total100ns) break;
      if (audioEvent) WaitForSingleObject(audioEvent, 5);
      else Sleep(5);
      drainAudio();
      if (withAudio) {
        // Si el dispositivo no entrega paquetes (nadie reproduce), se rellena con silencio.
        const uint64_t expected = static_cast<uint64_t>((qpc100ns() - t0) * static_cast<double>(outRate) / 1e7);
        const uint64_t have = audioWritten + pcm.size() / outChannels;
        if (expected > have + outRate / 4) pcm.insert(pcm.end(), static_cast<size_t>(expected - have - outRate / 20) * outChannels, int16_t{0});
        writeAudio(false);
        if (levelCount >= outRate / 10) {
          const double rms = std::sqrt(levelSum / static_cast<double>(levelCount));
          levelDb = rms > 1e-6 ? 20 * std::log10(rms) : -100;
          levelSum = 0;
          levelCount = 0;
        }
      }
      const int64_t now = qpc100ns() - t0;
      while (!writeError && frameTime(videoWritten) <= now && frameTime(videoWritten) < total100ns) {
        writeVideoFrame(videoWritten);
      }
      if (now - lastProgress >= 2'500'000 && progress_) {
        lastProgress = now;
        progress_(static_cast<double>(now) / 1e7, levelDb, cameraFrames_.load());
      }
    }
    if (audioClient) audioClient->Stop();

    // Cierre: completar hasta la duración final (30 fps exactos y audio de la misma longitud).
    const int targetFrames = static_cast<int>((end100ns * fps + 9'999'999) / 10'000'000);
    while (!writeError && videoWritten < targetFrames) writeVideoFrame(videoWritten);
    if (withAudio && !writeError) {
      drainAudio();
      const uint64_t target = static_cast<uint64_t>(static_cast<double>(frameTime(videoWritten)) * outRate / 1e7);
      const uint64_t have = audioWritten + pcm.size() / outChannels;
      if (have < target) pcm.insert(pcm.end(), static_cast<size_t>(target - have) * outChannels, int16_t{0});
      else if (have > target) pcm.resize(static_cast<size_t>(target > audioWritten ? target - audioWritten : 0) * outChannels);
      writeAudio(true);
    }
    const HRESULT fin = writer->Finalize();
    writer.Reset();
    frameBuffer.Reset();
    result.videoFrames = videoWritten;
    result.cameraFrames = cameraFrames_.load();
    if (writeError || FAILED(fin)) {
      result.ok = false;
      result.reason = "error";
      result.message = L"No se pudo terminar de escribir el MP4.";
    } else {
      result.ok = true;
      std::lock_guard<std::mutex> lock(frameMutex_);
      result.reason = stoppedEarly ? stopReason_ : "complete";
    }
  }
  if (audioEvent) CloseHandle(audioEvent);
  capture.Reset();
  audioClient.Reset();

  // Verificación del archivo final (duración y pistas).
  WIN32_FILE_ATTRIBUTE_DATA info{};
  if (GetFileAttributesExW(options_.path.c_str(), GetFileExInfoStandard, &info)) {
    result.sizeBytes = (static_cast<uint64_t>(info.nFileSizeHigh) << 32) | info.nFileSizeLow;
  }
  if (result.ok) {
    if (!probeMp4(options_.path, result.durationSec, result.hasVideo, result.hasAudio) || !result.hasVideo) {
      result.ok = false;
      result.reason = "error";
      result.message = L"El MP4 no se pudo leer después de grabarlo.";
    } else if (!withAudio) {
      result.message = L"Sin audio: no se encontró el micrófono virtual (VOXORA Meet Microphone o CABLE Output).";
    } else if (result.cameraFrames == 0) {
      result.message = L"La cámara virtual no publicó imagen durante la prueba: el video sale en negro.";
    }
  } else if (result.sizeBytes == 0) {
    DeleteFileW(options_.path.c_str());
  }
  {
    std::lock_guard<std::mutex> lock(frameMutex_);
    latest_.clear();
    latest_.shrink_to_fit();
  }
  running_.store(false);
  if (finished_) finished_(result);
}

// ── Controlador de comandos ─────────────────────────────────────────────────
std::wstring TestRecordingController::directory() {
  PWSTR base = nullptr;
  std::wstring dir;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &base)) && base) {
    dir = base;
    CoTaskMemFree(base);
  } else {
    wchar_t buf[MAX_PATH];
    dir = GetEnvironmentVariableW(L"LOCALAPPDATA", buf, MAX_PATH) ? buf : L".";
  }
  dir += L"\\VOXORA Meet";
  CreateDirectoryW(dir.c_str(), nullptr);
  dir += L"\\recordings";
  CreateDirectoryW(dir.c_str(), nullptr);
  return dir;
}

void TestRecordingController::init(Bridge bridge, Hooks hooks) {
  bridge_ = std::move(bridge);
  hooks_ = std::move(hooks);
}

bool TestRecordingController::isOwnFile(const std::wstring& path) const {
  wchar_t full[MAX_PATH * 2], dirFull[MAX_PATH * 2];
  if (!GetFullPathNameW(path.c_str(), static_cast<DWORD>(std::size(full)), full, nullptr)) return false;
  if (!GetFullPathNameW(directory().c_str(), static_cast<DWORD>(std::size(dirFull)), dirFull, nullptr)) return false;
  const std::wstring f = full, d = std::wstring(dirFull) + L"\\";
  if (f.size() <= d.size() || _wcsnicmp(f.c_str(), d.c_str(), d.size()) != 0) return false;
  if (f.find(L'\\', d.size()) != std::wstring::npos || f.find(L"..") != std::wstring::npos) return false;
  return f.size() > 4 && _wcsicmp(f.c_str() + f.size() - 4, L".mp4") == 0;
}

json::Value TestRecordingController::fileJson(const std::wstring& path) const {
  const size_t slash = path.find_last_of(L"\\/");
  const std::wstring name = slash == std::wstring::npos ? path : path.substr(slash + 1);
  json::Value v;
  v.set("path", wideToUtf8(path)).set("name", wideToUtf8(name)).set("url", "https://" + wideToUtf8(kHost) + "/" + wideToUtf8(name));
  WIN32_FILE_ATTRIBUTE_DATA info{};
  if (GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &info)) {
    const uint64_t size = (static_cast<uint64_t>(info.nFileSizeHigh) << 32) | info.nFileSizeLow;
    ULARGE_INTEGER t;
    t.LowPart = info.ftLastWriteTime.dwLowDateTime;
    t.HighPart = info.ftLastWriteTime.dwHighDateTime;
    // FILETIME (100 ns desde 1601) → ms Unix.
    const double unixMs = (static_cast<double>(t.QuadPart) - 116444736000000000.0) / 10000.0;
    v.set("sizeBytes", static_cast<double>(size)).set("modifiedAt", unixMs);
  }
  return v;
}

json::Value TestRecordingController::resultJson(const TestRecordingResult& r) const {
  json::Value v = fileJson(r.path);
  v.set("ok", r.ok).set("reason", r.reason).set("message", wideToUtf8(r.message))
      .set("durationMs", static_cast<int>(std::lround(r.durationSec * 1000))).set("hasVideo", r.hasVideo).set("hasAudio", r.hasAudio)
      .set("audioDevice", r.audioDevice.empty() ? json::Value() : json::Value(wideToUtf8(r.audioDevice)))
      .set("videoFrames", r.videoFrames).set("cameraFrames", r.cameraFrames).set("encoder", wideToUtf8(r.encoder));
  if (!r.ok && r.sizeBytes == 0) v.set("url", json::Value());
  return v;
}

bool TestRecordingController::handle(const json::Value& id, const std::string& cmd, const json::Value& params) {
  if (cmd.rfind("native.recording.", 0) != 0) return false;
  auto error = [](const std::string& code, const std::string& message) {
    json::Value e;
    e.set("code", code).set("message", message);
    return e;
  };

  if (cmd == "native.recording.start") {
    if (active_) {
      bridge_.reply(id, false, error("busy", "Ya hay una grabación de prueba en curso."));
      return true;
    }
    const int seconds = std::clamp(params["seconds"].asInt(10), 10, 30);
    SYSTEMTIME st;
    GetLocalTime(&st);
    wchar_t name[64];
    swprintf_s(name, L"\\prueba-%04d%02d%02d-%02d%02d%02d.mp4", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    TestRecorder::Options options;
    options.path = directory() + name;
    options.seconds = seconds;
    const std::wstring resolved = hooks_.virtualMicCapture ? hooks_.virtualMicCapture() : L"";
    for (const std::wstring& n : {resolved, std::wstring(L"VOXORA Meet Microphone"), std::wstring(L"CABLE Output")}) {
      if (!n.empty() && std::find(options.audioCandidates.begin(), options.audioCandidates.end(), n) == options.audioCandidates.end())
        options.audioCandidates.push_back(n);
    }
    const bool videoActive = hooks_.videoActive ? hooks_.videoActive() : false;
    active_ = true;
    currentPath_ = options.path;
    currentSeconds_ = seconds;
    elapsed_ = 0;
    if (hooks_.setFrameTap) {
      hooks_.setFrameTap([this](std::vector<uint8_t>& rgba, uint32_t w, uint32_t h, int64_t) { recorder_.offerFrame(rgba, w, h); });
    }
    Bridge bridge = bridge_;
    const json::Value replyId = id;
    const bool started = recorder_.start(
        options,
        [this, bridge, replyId, options, videoActive](bool ok, const std::wstring& message, const std::wstring& audioDevice) {
          bridge.runOnUi([this, bridge, replyId, options, videoActive, ok, message, audioDevice] {
            if (!ok) {
              json::Value e;
              e.set("code", "record_failed").set("message", wideToUtf8(message));
              bridge.reply(replyId, false, e);
              return;
            }
            json::Value r = fileJson(options.path);
            r.set("seconds", options.seconds).set("videoActive", videoActive)
                .set("audioDevice", audioDevice.empty() ? json::Value() : json::Value(wideToUtf8(audioDevice)));
            std::string warning;
            if (audioDevice.empty()) warning = "No se encontró el micrófono virtual: la prueba se graba sin audio.";
            else if (!videoActive) warning = "La cámara virtual no está publicando imagen: el video saldrá en negro.";
            if (!warning.empty()) r.set("warning", warning);
            bridge.reply(replyId, true, r);
          });
        },
        [this, bridge](double elapsed, double levelDb, int cameraFrames) {
          bridge.runOnUi([this, bridge, elapsed, levelDb, cameraFrames] {
            elapsed_ = elapsed;
            json::Value d;
            d.set("elapsedMs", static_cast<int>(elapsed * 1000)).set("seconds", currentSeconds_).set("levelDb", levelDb)
                .set("cameraFrames", cameraFrames);
            bridge.event("recording.progress", d);
          });
        },
        [this, bridge](const TestRecordingResult& result) {
          bridge.runOnUi([this, bridge, result] {
            if (hooks_.setFrameTap) hooks_.setFrameTap(nullptr);
            recorder_.join();
            active_ = false;
            currentPath_.clear();
            bridge.event("recording.done", resultJson(result));
          });
        });
    if (!started) {
      active_ = false;
      if (hooks_.setFrameTap) hooks_.setFrameTap(nullptr);
      bridge_.reply(id, false, error("busy", "Ya hay una grabación de prueba en curso."));
    }
    return true;
  }

  if (cmd == "native.recording.stop") {
    recorder_.requestStop("user");
    bridge_.reply(id, true, json::Value(json::Object{}));
    return true;
  }

  if (cmd == "native.recording.status") {
    json::Value r;
    r.set("recording", active_).set("elapsedMs", static_cast<int>(elapsed_ * 1000)).set("seconds", currentSeconds_)
        .set("path", wideToUtf8(currentPath_)).set("dir", wideToUtf8(directory()));
    bridge_.reply(id, true, r);
    return true;
  }

  if (cmd == "native.recording.list") {
    struct Item { std::wstring path; ULONGLONG time; };
    std::vector<Item> items;
    WIN32_FIND_DATAW fd;
    const std::wstring dir = directory();
    HANDLE find = FindFirstFileW((dir + L"\\*.mp4").c_str(), &fd);
    if (find != INVALID_HANDLE_VALUE) {
      do {
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
        const std::wstring path = dir + L"\\" + fd.cFileName;
        if (active_ && _wcsicmp(path.c_str(), currentPath_.c_str()) == 0) continue;
        items.push_back({path, (static_cast<ULONGLONG>(fd.ftLastWriteTime.dwHighDateTime) << 32) | fd.ftLastWriteTime.dwLowDateTime});
      } while (FindNextFileW(find, &fd));
      FindClose(find);
    }
    std::sort(items.begin(), items.end(), [](const Item& a, const Item& b) { return a.time > b.time; });
    json::Value list(json::Array{});
    for (size_t i = 0; i < items.size() && i < 12; i++) list.push(fileJson(items[i].path));
    json::Value r;
    r.set("items", list).set("dir", wideToUtf8(directory()));
    bridge_.reply(id, true, r);
    return true;
  }

  if (cmd == "native.recording.delete") {
    const std::wstring path = utf8ToWide(params["path"].asString());
    if (!isOwnFile(path) || (active_ && _wcsicmp(path.c_str(), currentPath_.c_str()) == 0)) {
      bridge_.reply(id, false, error("bad_request", "Solo se pueden borrar pruebas grabadas por la app (y no la que se está grabando)."));
      return true;
    }
    // La vista previa de la UI puede tardar un momento en soltar el archivo: se reintenta hasta ~2 s.
    Bridge bridge = bridge_;
    const json::Value replyId = id;
    std::thread([bridge, replyId, path] {
      bool ok = false;
      for (int i = 0; i < 20 && !ok; i++) {
        ok = DeleteFileW(path.c_str()) || GetLastError() == ERROR_FILE_NOT_FOUND;
        if (!ok) Sleep(100);
      }
      bridge.runOnUi([bridge, replyId, ok] {
        if (ok) {
          bridge.reply(replyId, true, json::Value(json::Object{}));
        } else {
          json::Value e;
          e.set("code", "busy").set("message", "No se pudo borrar: el archivo está abierto en otra aplicación.");
          bridge.reply(replyId, false, e);
        }
      });
    }).detach();
    return true;
  }

  if (cmd == "native.recording.reveal") {
    const std::wstring path = params["path"].isString() ? utf8ToWide(params["path"].asString()) : L"";
    bool ok;
    if (!path.empty() && isOwnFile(path) && GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES) {
      const std::wstring args = L"/select,\"" + path + L"\"";
      ok = reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr, L"open", L"explorer.exe", args.c_str(), nullptr, SW_SHOWNORMAL)) > 32;
    } else {
      ok = reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr, L"open", directory().c_str(), nullptr, nullptr, SW_SHOWNORMAL)) > 32;
    }
    bridge_.reply(id, ok, ok ? json::Value(json::Object{}) : error("internal", "No se pudo abrir la carpeta de pruebas."));
    return true;
  }

  bridge_.reply(id, false, error("unknown_command", "Comando nativo desconocido."));
  return true;
}

void TestRecordingController::shutdown() {
  if (hooks_.setFrameTap) hooks_.setFrameTap(nullptr);
  recorder_.requestStop("shutdown");
  recorder_.join();
}

}  // namespace voxora
