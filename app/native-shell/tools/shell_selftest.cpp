// shell_selftest.exe — autodiagnóstico de la imagen de la cámara y de «Grabar prueba» sin abrir la app
// (útil con VoxoraMeet.exe ya abierto: lee lo que publica en la cámara virtual por la memoria compartida).
//
//   shell_selftest bench                  ms/frame de VideoEffectsRenderer (1280x720 y 1920x1080 sintéticos)
//   shell_selftest snap <carpeta>         BMP de cada ajuste aplicado al frame vivo de la cámara virtual
//   shell_selftest record <s> <mp4>       graba <s> segundos: video de la cámara virtual + audio del mic virtual
//   shell_selftest probe <mp4>            duración y pistas de un MP4 (Media Foundation)
//   shell_selftest segmentation           ¿las cámaras exponen segmentación de fondo (Windows Studio Effects)?
// Salida: una línea JSON por resultado.

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <initguid.h>
#include <audioclient.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mmdeviceapi.h>
#include <propkeydef.h>
#include <functiondiscoverykeys_devpkey.h>
#include <wrl/client.h>

#include <cmath>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "../../../windows-camera/native/common/nv12.h"
#include "../../../windows-camera/native/common/vcam_shared.h"
#include "test_recording.h"
#include "video_effects.h"

using Microsoft::WRL::ComPtr;
using namespace voxora;

namespace {

std::string narrow(const std::wstring& w) {
  if (w.empty()) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
  std::string s(static_cast<size_t>(n), char{});
  WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr);
  return s;
}

double nowMs() {
  static const LARGE_INTEGER f = [] {
    LARGE_INTEGER x;
    QueryPerformanceFrequency(&x);
    return x;
  }();
  LARGE_INTEGER c;
  QueryPerformanceCounter(&c);
  return static_cast<double>(c.QuadPart) * 1000.0 / static_cast<double>(f.QuadPart);
}

// Lector de la memoria compartida de la cámara virtual (solo lectura, seqlock por slot).
class VcamReader {
 public:
  ~VcamReader() {
    if (view_) UnmapViewOfFile(view_);
    if (handle_) CloseHandle(handle_);
  }
  bool open() {
    handle_ = OpenFileMappingW(FILE_MAP_READ, FALSE, vcam::kFramesMappingName);
    if (!handle_) return false;
    view_ = MapViewOfFile(handle_, FILE_MAP_READ, 0, 0, static_cast<SIZE_T>(vcam::kMappingSize));
    return view_ != nullptr;
  }
  // Copia el último frame completo (RGBA; si el shell publica NV12 se convierte). false si no hay frame
  // nuevo desde `lastSeq` o no es legible.
  bool read(std::vector<uint8_t>& rgba, uint32_t& w, uint32_t& h, uint32_t& lastSeq) {
    if (!view_) return false;
    const auto* header = static_cast<const volatile vcam::SharedHeader*>(view_);
    if (header->magic != vcam::kMagic) return false;
    const uint32_t seq = header->frameSeq;
    if (seq == lastSeq) return false;
    const uint32_t index = header->writeIndex % vcam::kSlotCount;
    auto* slot = vcam::slotAt(view_, index);
    const uint32_t begin = slot->seqBegin;
    MemoryBarrier();
    const uint32_t sw = slot->width, sh = slot->height, format = slot->format;
    if (sw < 2 || sh < 2 || sw > vcam::kMaxWidth || sh > vcam::kMaxHeight) return false;
    const bool nv12 = format == vcam::PixelFormat_NV12;
    if (!nv12 && format != vcam::PixelFormat_RGBA8) return false;
    raw_.resize(nv12 ? vcam::nv12Bytes(sw, sh) : static_cast<size_t>(sw) * sh * 4);
    std::memcpy(raw_.data(), vcam::slotPixels(slot), raw_.size());
    MemoryBarrier();
    if (slot->seqEnd != begin || slot->seqBegin != begin) return false;  // se escribió mientras copiábamos
    if (nv12) {
      rgba.resize(static_cast<size_t>(sw) * sh * 4);
      vcam::nv12ToRgbaRows<false>(raw_.data(), sw, raw_.data() + static_cast<size_t>(sw) * sh, sw, sw, 0, sh, rgba.data(),
                                  static_cast<ptrdiff_t>(sw) * 4);
    } else {
      rgba.swap(raw_);
    }
    w = sw;
    h = sh;
    lastSeq = seq;
    format_ = format;
    return true;
  }
  uint32_t lastFormat() const { return format_; }

 private:
  HANDLE handle_ = nullptr;
  void* view_ = nullptr;
  std::vector<uint8_t> raw_;
  uint32_t format_ = 0;
};

// RGBA → BGRX (formato de entrada del renderizador, como el RGB32 de Media Foundation).
std::vector<uint8_t> toBgrx(const std::vector<uint8_t>& rgba) {
  std::vector<uint8_t> out(rgba.size());
  for (size_t i = 0; i + 3 < rgba.size(); i += 4) {
    out[i] = rgba[i + 2];
    out[i + 1] = rgba[i + 1];
    out[i + 2] = rgba[i];
    out[i + 3] = 255;
  }
  return out;
}

std::vector<uint8_t> synthetic(int w, int h) {
  std::vector<uint8_t> px(static_cast<size_t>(w) * h * 4);
  for (int y = 0; y < h; y++) {
    for (int x = 0; x < w; x++) {
      uint8_t* p = &px[(static_cast<size_t>(y) * w + x) * 4];
      p[0] = static_cast<uint8_t>(x * 255 / w);         // B
      p[1] = static_cast<uint8_t>(y * 255 / h);         // G
      p[2] = static_cast<uint8_t>(((x / 40) + (y / 40)) % 2 ? 220 : 40);  // R: tablero
      p[3] = 255;
    }
  }
  // Marca asimétrica arriba a la izquierda (para comprobar espejo/volteo/rotación).
  for (int y = 20; y < 120; y++)
    for (int x = 20; x < 60; x++) std::memset(&px[(static_cast<size_t>(y) * w + x) * 4], 255, 4);
  return px;
}

bool writeBmp(const std::wstring& path, const std::vector<uint8_t>& rgba, int w, int h) {
  const int rowBytes = (w * 3 + 3) & ~3;
  BITMAPFILEHEADER fh{};
  BITMAPINFOHEADER ih{};
  fh.bfType = 0x4D42;
  fh.bfOffBits = sizeof(fh) + sizeof(ih);
  fh.bfSize = fh.bfOffBits + static_cast<DWORD>(rowBytes * h);
  ih.biSize = sizeof(ih);
  ih.biWidth = w;
  ih.biHeight = h;  // de abajo arriba
  ih.biPlanes = 1;
  ih.biBitCount = 24;
  std::vector<uint8_t> row(static_cast<size_t>(rowBytes));
  HANDLE f = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (f == INVALID_HANDLE_VALUE) return false;
  DWORD n = 0;
  WriteFile(f, &fh, sizeof(fh), &n, nullptr);
  WriteFile(f, &ih, sizeof(ih), &n, nullptr);
  for (int y = h - 1; y >= 0; y--) {
    for (int x = 0; x < w; x++) {
      const uint8_t* p = &rgba[(static_cast<size_t>(y) * w + x) * 4];
      row[x * 3] = p[2];
      row[x * 3 + 1] = p[1];
      row[x * 3 + 2] = p[0];
    }
    WriteFile(f, row.data(), static_cast<DWORD>(rowBytes), &n, nullptr);
  }
  CloseHandle(f);
  return true;
}

struct Case {
  const char* name;
  VideoEffectsParams p;
};

std::vector<Case> cases() {
  std::vector<Case> c;
  auto add = [&](const char* name, auto fn) {
    VideoEffectsParams p;
    fn(p);
    c.push_back({name, p});
  };
  add("identidad", [](VideoEffectsParams&) {});
  add("espejo", [](VideoEffectsParams& p) { p.mirror = true; });
  add("volteo", [](VideoEffectsParams& p) { p.flip = true; });
  add("rot90", [](VideoEffectsParams& p) { p.rotation = 90; });
  add("rot180", [](VideoEffectsParams& p) { p.rotation = 180; });
  add("rot270-9x16", [](VideoEffectsParams& p) { p.rotation = 270; p.portrait = true; });
  add("9x16", [](VideoEffectsParams& p) { p.portrait = true; });
  add("zoom1.5-pan", [](VideoEffectsParams& p) { p.zoom = 1.5; p.panX = 0.6; p.panY = -0.4; });
  add("brillo", [](VideoEffectsParams& p) { p.brightness = 0.3; });
  add("color", [](VideoEffectsParams& p) { p.brightness = 0.35; p.contrast = 0.25; p.saturation = 0.3; p.temperature = 0.5; });
  add("bn-fria", [](VideoEffectsParams& p) { p.saturation = -1; p.temperature = -0.6; p.contrast = 0.3; });
  add("todo", [](VideoEffectsParams& p) {
    p.mirror = true; p.portrait = true; p.zoom = 1.3; p.panY = -0.3; p.brightness = 0.2; p.contrast = 0.15; p.saturation = 0.2;
    p.temperature = 0.3;
  });
  return c;
}

int cmdBench() {
  const int W = 1280, H = 720;
  std::vector<uint8_t> dst(static_cast<size_t>(W) * H * 4);
  for (auto [sw, sh] : {std::pair{1280, 720}, std::pair{1920, 1080}}) {
    const std::vector<uint8_t> src = synthetic(sw, sh);
    for (const Case& c : cases()) {
      VideoEffectsRenderer r;
      r.setParams(c.p);
      r.render(src.data(), sw * 4, sw, sh, dst.data(), W, H);  // calentamiento + tablas
      const int iters = 150;
      double worst = 0;
      const double t0 = nowMs();
      for (int i = 0; i < iters; i++) {
        const double a = nowMs();
        r.render(src.data(), sw * 4, sw, sh, dst.data(), W, H);
        worst = std::max(worst, nowMs() - a);
      }
      const double avg = (nowMs() - t0) / iters;
      std::printf("{\"bench\":\"%s\",\"source\":\"%dx%d\",\"avgMs\":%.3f,\"maxMs\":%.3f}\n", c.name, sw, sh, avg, worst);
    }
  }
  // Fuente de abajo arriba (pitch negativo), como un RGB32 DIB.
  {
    const std::vector<uint8_t> src = synthetic(W, H);
    VideoEffectsRenderer r;
    const uint8_t* lastRow = src.data() + static_cast<size_t>(W) * 4 * (H - 1);
    r.render(lastRow, -static_cast<ptrdiff_t>(W) * 4, W, H, dst.data(), W, H);
    std::printf("{\"bench\":\"pitch-negativo\",\"ok\":true}\n");
  }
  // Salida NV12 (lo que va al ring y a la cámara virtual): coste por frame y error de ida y vuelta.
  {
    const std::vector<uint8_t> src = synthetic(W, H);
    std::vector<uint8_t> nv12(vcam::nv12Bytes(W, H)), back(static_cast<size_t>(W) * H * 4);
    for (const Case& c : cases()) {
      if (std::strcmp(c.name, "identidad") != 0 && std::strcmp(c.name, "color") != 0 && std::strcmp(c.name, "todo") != 0) continue;
      VideoEffectsRenderer r;
      r.setParams(c.p);
      r.renderNv12(src.data(), W * 4, W, H, nv12.data(), W, H);
      const int iters = 150;
      double worst = 0;
      const double t0 = nowMs();
      for (int i = 0; i < iters; i++) {
        const double a = nowMs();
        r.renderNv12(src.data(), W * 4, W, H, nv12.data(), W, H);
        worst = std::max(worst, nowMs() - a);
      }
      std::printf("{\"bench\":\"nv12-%s\",\"source\":\"1280x720\",\"avgMs\":%.3f,\"maxMs\":%.3f}\n", c.name, (nowMs() - t0) / iters, worst);
    }
    // Ida y vuelta RGBA → NV12 → RGBA sobre la luma (la croma va a 2x2 a propósito).
    VideoEffectsRenderer r;
    r.render(src.data(), W * 4, W, H, dst.data(), W, H);
    r.renderNv12(src.data(), W * 4, W, H, nv12.data(), W, H);
    vcam::nv12ToRgbaRows<false>(nv12.data(), W, nv12.data() + static_cast<size_t>(W) * H, W, W, 0, H, back.data(), W * 4);
    int maxLumaErr = 0;
    for (size_t i = 0; i + 3 < dst.size(); i += 4) {
      const int ya = (77 * dst[i] + 150 * dst[i + 1] + 29 * dst[i + 2]) >> 8;
      const int yb = (77 * back[i] + 150 * back[i + 1] + 29 * back[i + 2]) >> 8;
      maxLumaErr = std::max(maxLumaErr, std::abs(ya - yb));
    }
    // Escalado de la DLL (720p → 1080p, y 4:3 con barras) sin salirse de los buffers.
    std::vector<uint8_t> big(vcam::nv12Bytes(1920, 1080)), box(vcam::nv12Bytes(640, 480));
    vcam::scaleNv12Letterbox(nv12.data(), W, H, big.data(), 1920, 1080);
    vcam::scaleNv12Letterbox(nv12.data(), W, H, box.data(), 640, 480);
    const bool barsOk = box[0] == 16 && box[static_cast<size_t>(640) * 240 + 320] != 16;
    std::printf("{\"bench\":\"nv12-ida-vuelta\",\"maxLumaErr\":%d,\"ok\":%s,\"letterboxOk\":%s}\n", maxLumaErr, maxLumaErr <= 3 ? "true" : "false",
                barsOk ? "true" : "false");
  }
  return 0;
}

int cmdSnap(const std::wstring& dir) {
  CreateDirectoryW(dir.c_str(), nullptr);
  std::vector<uint8_t> rgba;
  uint32_t w = 0, h = 0, seq = 0;
  VcamReader reader;
  bool live = reader.open();
  if (live) {
    live = false;
    for (int i = 0; i < 40 && !live; i++) {
      live = reader.read(rgba, w, h, seq);
      if (!live) Sleep(50);
    }
  }
  if (!live) {
    w = 1280;
    h = 720;
    rgba = synthetic(1280, 720);
    // synthetic() ya está en BGRX: se pasa tal cual abajo.
  }
  const std::vector<uint8_t> src = live ? toBgrx(rgba) : rgba;
  std::vector<uint8_t> out(1280ull * 720 * 4);
  for (const Case& c : cases()) {
    VideoEffectsRenderer r;
    r.setParams(c.p);
    r.render(src.data(), static_cast<ptrdiff_t>(w) * 4, static_cast<int>(w), static_cast<int>(h), out.data(), 1280, 720);
    const std::wstring path = dir + L"\\" + std::wstring(c.name, c.name + std::strlen(c.name)) + L".bmp";
    writeBmp(path, out, 1280, 720);
    std::printf("{\"snap\":\"%s\",\"source\":\"%s\",\"size\":\"%ux%u\",\"file\":\"%s\"}\n", c.name, live ? "virtual-camera" : "synthetic", w, h,
                narrow(path).c_str());
  }
  return 0;
}

void printResult(const TestRecordingResult& r) {
  std::printf(
      "{\"ok\":%s,\"reason\":\"%s\",\"path\":\"%s\",\"durationSec\":%.3f,\"sizeBytes\":%llu,\"hasVideo\":%s,\"hasAudio\":%s,"
      "\"audioDevice\":\"%s\",\"videoFrames\":%d,\"cameraFrames\":%d,\"encoder\":\"%s\",\"message\":\"%s\"}\n",
      r.ok ? "true" : "false", r.reason.c_str(), narrow(r.path).c_str(), r.durationSec, static_cast<unsigned long long>(r.sizeBytes),
      r.hasVideo ? "true" : "false", r.hasAudio ? "true" : "false", narrow(r.audioDevice).c_str(), r.videoFrames, r.cameraFrames,
      narrow(r.encoder).c_str(), narrow(r.message).c_str());
}

void playTone(const std::wstring& name, double startSec, double seconds, std::atomic<bool>& cancel);

int cmdRecord(int seconds, const std::wstring& path, const std::wstring& toneDevice) {
  std::atomic<bool> toneCancel{false};
  std::thread tone;
  if (!toneDevice.empty()) tone = std::thread([&] { playTone(toneDevice, 4.0, 2.0, toneCancel); });
  VcamReader reader;
  const bool shm = reader.open();
  std::printf("{\"virtualCameraSharedMemory\":%s}\n", shm ? "true" : "false");
  TestRecorder recorder;
  std::mutex m;
  std::condition_variable cv;
  bool done = false;
  TestRecordingResult result;
  TestRecorder::Options o;
  o.path = path;
  o.seconds = seconds;
  o.audioCandidates = {L"VOXORA Meet Microphone", L"CABLE Output"};
  std::atomic<bool> feeding{true};
  recorder.start(
      o,
      [](bool ok, const std::wstring& error, const std::wstring& audio) {
        std::printf("{\"started\":%s,\"error\":\"%s\",\"audioDevice\":\"%s\"}\n", ok ? "true" : "false", narrow(error).c_str(), narrow(audio).c_str());
      },
      [](double elapsed, double levelDb, int frames) { std::printf("{\"progress\":%.2f,\"levelDb\":%.1f,\"cameraFrames\":%d}\n", elapsed, levelDb, frames); },
      [&](const TestRecordingResult& r) {
        std::lock_guard<std::mutex> lock(m);
        result = r;
        done = true;
        cv.notify_all();
      });
  // Alimenta el grabador como el hilo de publicación del shell: cada frame nuevo de la cámara virtual.
  std::thread feeder([&] {
    std::vector<uint8_t> rgba;
    uint32_t w = 0, h = 0, seq = 0;
    while (feeding.load()) {
      if (shm && reader.read(rgba, w, h, seq)) recorder.offerFrame(rgba, w, h);
      Sleep(10);
    }
  });
  {
    std::unique_lock<std::mutex> lock(m);
    cv.wait(lock, [&] { return done; });
  }
  feeding.store(false);
  feeder.join();
  recorder.join();
  toneCancel.store(true);
  if (tone.joinable()) tone.join();
  printResult(result);
  return result.ok ? 0 : 1;
}

// Decodifica el MP4: nivel de audio por segundo (dBFS), frames de video, luma media y una miniatura BMP
// del frame central (para ver que no es negro ni está de cabeza).
int cmdProbe(const std::wstring& path, const std::wstring& thumb) {
  double d = 0;
  bool v = false, a = false;
  const bool ok = probeMp4(path, d, v, a);
  std::printf("{\"probe\":%s,\"durationSec\":%.3f,\"hasVideo\":%s,\"hasAudio\":%s}\n", ok ? "true" : "false", d, v ? "true" : "false",
              a ? "true" : "false");
  if (!ok || FAILED(MFStartup(MF_VERSION, MFSTARTUP_LITE))) return 1;
  ComPtr<IMFAttributes> attrs;
  MFCreateAttributes(&attrs, 1);
  attrs->SetUINT32(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, TRUE);
  ComPtr<IMFSourceReader> reader;
  if (FAILED(MFCreateSourceReaderFromURL(path.c_str(), attrs.Get(), &reader))) return 1;
  const DWORD kVideo = static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM), kAudio = static_cast<DWORD>(MF_SOURCE_READER_FIRST_AUDIO_STREAM);
  ComPtr<IMFMediaType> vt, at;
  MFCreateMediaType(&vt);
  vt->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  vt->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
  reader->SetCurrentMediaType(kVideo, nullptr, vt.Get());
  MFCreateMediaType(&at);
  at->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
  at->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM);
  at->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16);
  if (a) reader->SetCurrentMediaType(kAudio, nullptr, at.Get());
  UINT32 w = 0, h = 0, rate = 48000, ch = 2;
  ComPtr<IMFMediaType> cur;
  if (SUCCEEDED(reader->GetCurrentMediaType(kVideo, &cur))) MFGetAttributeSize(cur.Get(), MF_MT_FRAME_SIZE, &w, &h);
  cur.Reset();
  if (a && SUCCEEDED(reader->GetCurrentMediaType(kAudio, &cur))) {
    cur->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, &rate);
    cur->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS, &ch);
  }
  // Video.
  int frames = 0;
  double luma = -1;
  for (;;) {
    DWORD idx = 0, flags = 0;
    LONGLONG ts = 0;
    ComPtr<IMFSample> sample;
    if (FAILED(reader->ReadSample(kVideo, 0, &idx, &flags, &ts, &sample)) || (flags & MF_SOURCE_READERF_ENDOFSTREAM)) break;
    if (!sample) continue;
    frames++;
    if (luma < 0 && ts >= static_cast<LONGLONG>(d * 5e6)) {  // frame central
      ComPtr<IMFMediaBuffer> buf;
      sample->ConvertToContiguousBuffer(&buf);
      BYTE* data = nullptr;
      DWORD len = 0;
      if (buf && SUCCEEDED(buf->Lock(&data, nullptr, &len)) && len >= w * h * 4) {
        std::vector<uint8_t> rgba(static_cast<size_t>(w) * h * 4);
        double sum = 0;
        for (UINT32 i = 0; i < w * h; i++) {
          // RGB32 de MF es B,G,R,X de arriba abajo (el procesador de vídeo entrega stride positivo).
          rgba[i * 4] = data[i * 4 + 2];
          rgba[i * 4 + 1] = data[i * 4 + 1];
          rgba[i * 4 + 2] = data[i * 4];
          sum += 0.299 * data[i * 4 + 2] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4];
        }
        buf->Unlock();
        luma = sum / (static_cast<double>(w) * h);
        if (!thumb.empty()) writeBmp(thumb, rgba, static_cast<int>(w), static_cast<int>(h));
      }
    }
  }
  std::printf("{\"videoFrames\":%d,\"size\":\"%ux%u\",\"middleFrameLuma\":%.1f}\n", frames, w, h, luma);
  // Audio: RMS por segundo.
  if (a) {
    std::vector<double> perSecond;
    double acc = 0;
    uint64_t n = 0, total = 0;
    for (;;) {
      DWORD idx = 0, flags = 0;
      LONGLONG ts = 0;
      ComPtr<IMFSample> sample;
      if (FAILED(reader->ReadSample(kAudio, 0, &idx, &flags, &ts, &sample)) || (flags & MF_SOURCE_READERF_ENDOFSTREAM)) break;
      if (!sample) continue;
      ComPtr<IMFMediaBuffer> buf;
      sample->ConvertToContiguousBuffer(&buf);
      BYTE* data = nullptr;
      DWORD len = 0;
      if (!buf || FAILED(buf->Lock(&data, nullptr, &len))) continue;
      const auto* s = reinterpret_cast<const int16_t*>(data);
      for (DWORD i = 0; i + 1 < len; i += 2) {
        const double x = s[i / 2] / 32768.0;
        acc += x * x;
        if (++n == static_cast<uint64_t>(rate) * ch) {
          perSecond.push_back(acc > 0 ? 10 * std::log10(acc / static_cast<double>(n)) : -100);
          acc = 0;
          n = 0;
        }
        total++;
      }
      buf->Unlock();
    }
    std::printf("{\"audioSeconds\":%.3f,\"rate\":%u,\"channels\":%u,\"dbfsPerSecond\":[", static_cast<double>(total) / (static_cast<double>(rate) * ch), rate, ch);
    for (size_t i = 0; i < perSecond.size(); i++) std::printf("%s%.1f", i ? "," : "", perSecond[i]);
    std::printf("]}\n");
  }
  reader.Reset();
  MFShutdown();
  return 0;
}

// Tono de prueba (-24 dBFS, 440 Hz) en el endpoint de render cuyo nombre contiene `name` (p. ej. «CABLE
// Input»): lo que el micrófono virtual entrega a Meet, para comprobar que la grabación captura audio real.
void playTone(const std::wstring& name, double startSec, double seconds, std::atomic<bool>& cancel) {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  ComPtr<IMMDeviceEnumerator> en;
  ComPtr<IMMDeviceCollection> col;
  ComPtr<IMMDevice> dev;
  if (SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en))) &&
      SUCCEEDED(en->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &col))) {
    UINT count = 0;
    col->GetCount(&count);
    for (UINT i = 0; i < count && !dev; i++) {
      ComPtr<IMMDevice> d;
      ComPtr<IPropertyStore> props;
      if (FAILED(col->Item(i, &d)) || FAILED(d->OpenPropertyStore(STGM_READ, &props))) continue;
      PROPVARIANT v;
      PropVariantInit(&v);
      if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &v)) && v.vt == VT_LPWSTR && wcsstr(v.pwszVal, name.c_str())) dev = d;
      PropVariantClear(&v);
    }
  }
  ComPtr<IAudioClient> client;
  WAVEFORMATEX* fmt = nullptr;
  if (!dev || FAILED(dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &client)) || FAILED(client->GetMixFormat(&fmt)) ||
      FAILED(client->Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 2'000'000, 0, fmt, nullptr))) {
    std::printf("{\"tone\":false}\n");
    if (fmt) CoTaskMemFree(fmt);
    CoUninitialize();
    return;
  }
  const bool isFloat = fmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT ||
                       (fmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE && reinterpret_cast<WAVEFORMATEXTENSIBLE*>(fmt)->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
  const UINT32 rate = fmt->nSamplesPerSec;
  const WORD chans = fmt->nChannels;
  ComPtr<IAudioRenderClient> render;
  client->GetService(IID_PPV_ARGS(&render));
  UINT32 bufferFrames = 0;
  client->GetBufferSize(&bufferFrames);
  for (int i = 0; i < static_cast<int>(startSec * 100) && !cancel.load(); i++) Sleep(10);
  client->Start();
  std::printf("{\"tone\":true,\"device\":\"%s\",\"rate\":%u}\n", narrow(name).c_str(), rate);
  uint64_t written = 0;
  const uint64_t total = static_cast<uint64_t>(seconds * rate);
  while (written < total && !cancel.load()) {
    UINT32 padding = 0;
    client->GetCurrentPadding(&padding);
    const UINT32 avail = std::min<UINT32>(bufferFrames - padding, static_cast<UINT32>(total - written));
    BYTE* data = nullptr;
    if (avail > 0 && SUCCEEDED(render->GetBuffer(avail, &data))) {
      for (UINT32 f = 0; f < avail; f++) {
        const float s = 0.063f * static_cast<float>(std::sin(2 * 3.14159265358979 * 440.0 * static_cast<double>(written + f) / rate));
        for (WORD c = 0; c < chans; c++) {
          if (isFloat) reinterpret_cast<float*>(data)[f * chans + c] = s;
          else reinterpret_cast<int16_t*>(data)[f * chans + c] = static_cast<int16_t>(s * 32767);
        }
      }
      render->ReleaseBuffer(avail, 0);
      written += avail;
    }
    Sleep(10);
  }
  Sleep(200);
  client->Stop();
  CoTaskMemFree(fmt);
  CoUninitialize();
}

// Windows Studio Effects / cámaras con segmentación de fondo exponen
// KSPROPERTY_CAMERACONTROL_EXTENDED_BACKGROUNDSEGMENTATION (41) como control extendido del dispositivo.
int cmdSegmentation() {
  if (FAILED(MFStartup(MF_VERSION, MFSTARTUP_LITE))) return 9;
  ComPtr<IMFAttributes> attrs;
  MFCreateAttributes(&attrs, 1);
  attrs->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
  IMFActivate** devices = nullptr;
  UINT32 count = 0;
  MFEnumDeviceSources(attrs.Get(), &devices, &count);
  for (UINT32 i = 0; i < count; i++) {
    wchar_t* name = nullptr;
    UINT32 len = 0;
    devices[i]->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &name, &len);
    const std::string friendly = narrow(name ? name : L"");
    CoTaskMemFree(name);
    ComPtr<IMFMediaSource> source;
    const HRESULT hrOpen = devices[i]->ActivateObject(IID_PPV_ARGS(&source));
    std::string detail;
    long long caps = -1;
    HRESULT hrCtl = E_NOINTERFACE;
    if (SUCCEEDED(hrOpen)) {
      ComPtr<IMFExtendedCameraController> controller;
      HRESULT hr = MFGetService(source.Get(), GUID_NULL, IID_PPV_ARGS(&controller));
      if (FAILED(hr)) hr = source.As(&controller);
      if (SUCCEEDED(hr)) {
        ComPtr<IMFExtendedCameraControl> control;
        hrCtl = controller->GetExtendedCameraControl(0xFFFFFFFF /* MF_CAPTURE_ENGINE_MEDIASOURCE */, 41, &control);
        if (SUCCEEDED(hrCtl)) caps = static_cast<long long>(control->GetCapabilities());
      } else {
        hrCtl = hr;
      }
      source->Shutdown();
    }
    std::printf("{\"camera\":\"%s\",\"open\":\"0x%08X\",\"backgroundSegmentation\":\"0x%08X\",\"caps\":%lld,\"blur\":%s,\"mask\":%s,\"shallowFocus\":%s}\n",
                friendly.c_str(), static_cast<unsigned>(hrOpen), static_cast<unsigned>(hrCtl), caps, caps > 0 && (caps & 1) ? "true" : "false",
                caps > 0 && (caps & 2) ? "true" : "false", caps > 0 && (caps & 4) ? "true" : "false");
    devices[i]->Release();
  }
  CoTaskMemFree(devices);
  MFShutdown();
  return 0;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const std::wstring cmd = argc > 1 ? argv[1] : L"";
  int rc = 2;
  if (cmd == L"bench") rc = cmdBench();
  else if (cmd == L"snap" && argc > 2) rc = cmdSnap(argv[2]);
  else if (cmd == L"record" && argc > 3) rc = cmdRecord(_wtoi(argv[2]), argv[3], argc > 4 ? argv[4] : L"");
  else if (cmd == L"probe" && argc > 2) rc = cmdProbe(argv[2], argc > 3 ? argv[3] : L"");
  else if (cmd == L"segmentation") rc = cmdSegmentation();
  else std::printf("uso: shell_selftest bench | snap <carpeta> | record <s> <mp4> [render-tono] | probe <mp4> [bmp] | segmentation\n");
  std::fflush(stdout);
  CoUninitialize();
  return rc;
}
