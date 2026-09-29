// VoxoraMeetCameraTest.exe — consumidor de prueba E2E de la cámara virtual "VOXORA Meet Camera".
//
// Abre la cámara como lo haría Meet/Chrome (Media Foundation: MFEnumDeviceSources → MFCreateDeviceSource
// → IMFSourceReader, sin conversión: el formato nativo NV12 o RGB32 que produce la DLL), lee frames y
// clasifica cada uno:
//   pattern  → el patrón de prueba del productor (8 barras de color + contador binario), ver abajo
//   fallback → la imagen de espera de la DLL ("VOXORA MEET — ESPERANDO VIDEO", fondo #101418)
//   other    → cualquier otra cosa (p. ej. la webcam real de otro productor)
// Una línea JSON por frame en stdout; se detiene con `stop` o EOF en stdin, o al cumplirse --seconds.
//
// Patrón (definido en coordenadas relativas, lo genera windows-camera/scripts/e2e-camera.mjs):
//   - 3/4 superiores: 8 barras verticales de igual ancho: blanco, amarillo, cian, verde, magenta, rojo,
//     azul, negro.
//   - 1/4 inferior, dos filas de 16 celdas: fila A = bits del contador (MSB primero, blanco = 1), fila B =
//     complemento (validación). El contador avanza en cada frame del productor.
//
// Modos:
//   VoxoraMeetCameraTest.exe [--name "VOXORA Meet Camera"] [--format nv12|rgb32] [--width 1280 --height 720]
//                            [--seconds 120]
//   VoxoraMeetCameraTest.exe --list      dispositivos de video MF (JSON por línea)
//   VoxoraMeetCameraTest.exe --probe     estado de la memoria compartida (existe, frameSeq, edad del latido)
//                                         y comparación de relojes QPC vs MFGetSystemTime
// Códigos de salida: 0 OK · 2 uso · 3 cámara no encontrada · 4 no se pudo abrir · 5 formato no disponible
//                    · 6 error leyendo frames · 9 Media Foundation no disponible

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl/client.h>

#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#include "../common/shared_memory.h"

using Microsoft::WRL::ComPtr;
using namespace voxora::vcam;

namespace {

enum ExitCode : int {
  Exit_Ok = 0,
  Exit_Usage = 2,
  Exit_NotFound = 3,
  Exit_OpenFailed = 4,
  Exit_NoFormat = 5,
  Exit_ReadFailed = 6,
  Exit_MfFailed = 9,
};

std::atomic<bool> g_stop{false};

std::string toUtf8(const std::wstring& text) {
  if (text.empty()) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), int(text.size()), nullptr, 0, nullptr, nullptr);
  std::string out(size_t(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.c_str(), int(text.size()), out.data(), n, nullptr, nullptr);
  return out;
}

std::string jsonString(const std::wstring& text) {
  std::string out = "\"";
  for (char c : toUtf8(text)) {
    if (c == '"' || c == '\\') {
      out += '\\';
      out += c;
    } else if (static_cast<unsigned char>(c) < 0x20) {
      char buf[8];
      std::snprintf(buf, sizeof(buf), "\\u%04x", unsigned(static_cast<unsigned char>(c)));
      out += buf;
    } else {
      out += c;
    }
  }
  return out + "\"";
}

void emit(const std::string& line) {
  std::fwrite(line.data(), 1, line.size(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

struct Device {
  std::wstring name;
  std::wstring link;
  ComPtr<IMFActivate> activate;
};

std::vector<Device> enumerateVideoDevices() {
  std::vector<Device> out;
  ComPtr<IMFAttributes> attrs;
  if (FAILED(MFCreateAttributes(&attrs, 1))) return out;
  attrs->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
  IMFActivate** devices = nullptr;
  UINT32 count = 0;
  if (FAILED(MFEnumDeviceSources(attrs.Get(), &devices, &count))) return out;
  for (UINT32 i = 0; i < count; ++i) {
    Device d;
    wchar_t* value = nullptr;
    UINT32 len = 0;
    if (SUCCEEDED(devices[i]->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &value, &len))) {
      d.name = value;
      CoTaskMemFree(value);
    }
    if (SUCCEEDED(devices[i]->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, &value, &len))) {
      d.link = value;
      CoTaskMemFree(value);
    }
    d.activate.Attach(devices[i]);  // toma la referencia
    out.push_back(std::move(d));
  }
  CoTaskMemFree(devices);
  return out;
}

// ---- Clasificación ------------------------------------------------------------------------------

struct Rgb {
  int r, g, b;
};

constexpr Rgb kBars[8] = {{255, 255, 255}, {255, 255, 0}, {0, 255, 255}, {0, 255, 0},
                          {255, 0, 255},   {255, 0, 0},   {0, 0, 255},   {0, 0, 0}};
constexpr Rgb kFallbackBackground = {0x10, 0x14, 0x18};

int clamp255(double v) { return v < 0 ? 0 : v > 255 ? 255 : int(std::lround(v)); }

// Acceso a un frame NV12 o RGB32 (BGRX) con pitch arbitrario (negativo = bottom-up en RGB32).
struct FrameView {
  const uint8_t* scan0 = nullptr;
  LONG pitch = 0;
  uint32_t width = 0;
  uint32_t height = 0;
  bool nv12 = true;

  Rgb pixel(uint32_t x, uint32_t y) const {
    if (nv12) {
      const int Y = scan0[ptrdiff_t(y) * pitch + x];
      const uint8_t* uvPlane = scan0 + ptrdiff_t(pitch) * height;
      const uint8_t* uv = uvPlane + ptrdiff_t(y / 2) * pitch + (x & ~1u);
      const double c = 1.164 * (Y - 16);
      const double d = uv[0] - 128.0;  // U (Cb)
      const double e = uv[1] - 128.0;  // V (Cr)
      return {clamp255(c + 1.596 * e), clamp255(c - 0.392 * d - 0.813 * e), clamp255(c + 2.017 * d)};
    }
    const uint8_t* p = scan0 + ptrdiff_t(y) * pitch + ptrdiff_t(x) * 4;
    return {p[2], p[1], p[0]};
  }

  // Promedio de un bloque de 8x8 centrado en (fx, fy) (coordenadas relativas 0..1).
  Rgb sample(double fx, double fy) const {
    const int cx = int(fx * width);
    const int cy = int(fy * height);
    long r = 0, g = 0, b = 0, n = 0;
    for (int dy = -4; dy < 4; ++dy) {
      for (int dx = -4; dx < 4; ++dx) {
        const int x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= int(width) || y >= int(height)) continue;
        const Rgb p = pixel(uint32_t(x), uint32_t(y));
        r += p.r;
        g += p.g;
        b += p.b;
        ++n;
      }
    }
    if (n == 0) return {0, 0, 0};
    return {int(r / n), int(g / n), int(b / n)};
  }
};

bool closeTo(const Rgb& a, const Rgb& b, int tolerance) {
  return std::abs(a.r - b.r) <= tolerance && std::abs(a.g - b.g) <= tolerance && std::abs(a.b - b.b) <= tolerance;
}

struct Classification {
  const char* kind = "other";
  long counter = -1;
  int barsMatched = 0;
};

Classification classify(const FrameView& f) {
  Classification c;
  // Barras: centro de cada barra, a media altura de la zona superior (3/4 de la imagen).
  for (int i = 0; i < 8; ++i) {
    if (closeTo(f.sample((i + 0.5) / 8.0, 0.375), kBars[i], 48)) ++c.barsMatched;
  }
  if (c.barsMatched == 8) {
    // Contador: fila A (bits) y fila B (complemento), 16 celdas cada una.
    long value = 0;
    bool valid = true;
    for (int j = 0; j < 16; ++j) {
      const double fx = (j + 0.5) / 16.0;
      const Rgb a = f.sample(fx, (270.0 + 22.5) / 360.0);
      const Rgb b = f.sample(fx, (315.0 + 22.5) / 360.0);
      const bool bitA = (a.r + a.g + a.b) / 3 > 128;
      const bool bitB = (b.r + b.g + b.b) / 3 > 128;
      if (bitA == bitB) valid = false;
      value = (value << 1) | (bitA ? 1 : 0);
    }
    c.kind = "pattern";
    c.counter = valid ? value : -1;
    return c;
  }
  // Imagen de espera: las cuatro esquinas del color de fondo de la DLL.
  const double corners[4][2] = {{0.05, 0.05}, {0.95, 0.05}, {0.05, 0.95}, {0.95, 0.95}};
  int background = 0;
  for (const auto& corner : corners)
    if (closeTo(f.sample(corner[0], corner[1]), kFallbackBackground, 20)) ++background;
  if (background == 4) c.kind = "fallback";
  return c;
}

// ---- Modos --------------------------------------------------------------------------------------

int runList() {
  for (const Device& d : enumerateVideoDevices())
    emit("{\"type\":\"device\",\"name\":" + jsonString(d.name) + ",\"link\":" + jsonString(d.link) + "}");
  return Exit_Ok;
}

int runProbe() {
  const int64_t qpc = qpcNow100ns();
  const int64_t mf = MFGetSystemTime();
  std::string line = "{\"type\":\"probe\",\"clockDiff100ns\":" + std::to_string(mf - qpc);
  HANDLE h = OpenFileMappingW(FILE_MAP_READ, FALSE, kFramesMappingName);
  if (!h) {
    line += ",\"mapping\":false,\"error\":" + std::to_string(GetLastError()) + "}";
    emit(line);
    return Exit_Ok;
  }
  void* view = MapViewOfFile(h, FILE_MAP_READ, 0, 0, sizeof(SharedHeader));
  if (!view) {
    line += ",\"mapping\":true,\"view\":false}";
    emit(line);
    CloseHandle(h);
    return Exit_Ok;
  }
  const auto* header = static_cast<const SharedHeader*>(view);
  const int64_t heartbeat = header->producerHeartbeat100ns;
  line += ",\"mapping\":true,\"magicOk\":" + std::string(header->magic == kMagic ? "true" : "false") +
          ",\"version\":" + std::to_string(header->version) + ",\"frameSeq\":" + std::to_string(header->frameSeq) +
          ",\"width\":" + std::to_string(header->width) + ",\"height\":" + std::to_string(header->height) +
          ",\"heartbeatAgeMs\":" + (heartbeat ? std::to_string((qpcNow100ns() - heartbeat) / 10'000) : "null") + "}";
  emit(line);
  UnmapViewOfFile(view);
  CloseHandle(h);
  return Exit_Ok;
}

int runStream(const std::wstring& wantedName, bool nv12, uint32_t width, uint32_t height, double seconds) {
  auto devices = enumerateVideoDevices();
  const Device* device = nullptr;
  for (const Device& d : devices)
    if (_wcsicmp(d.name.c_str(), wantedName.c_str()) == 0) device = &d;
  if (!device)
    for (const Device& d : devices)
      if (d.name.find(wantedName) != std::wstring::npos) device = &d;
  if (!device) {
    std::string names;
    for (const Device& d : devices) names += (names.empty() ? "" : ",") + jsonString(d.name);
    emit("{\"type\":\"error\",\"code\":\"not_found\",\"devices\":[" + names + "]}");
    return Exit_NotFound;
  }

  ComPtr<IMFMediaSource> source;
  HRESULT hr = device->activate->ActivateObject(IID_PPV_ARGS(&source));
  if (FAILED(hr)) {
    emit("{\"type\":\"error\",\"code\":\"activate\",\"hr\":" + std::to_string(unsigned(hr)) + "}");
    return Exit_OpenFailed;
  }
  ComPtr<IMFAttributes> readerAttrs;
  MFCreateAttributes(&readerAttrs, 1);
  readerAttrs->SetUINT32(MF_READWRITE_DISABLE_CONVERTERS, TRUE);  // se analiza lo que produce la DLL
  ComPtr<IMFSourceReader> reader;
  hr = MFCreateSourceReaderFromMediaSource(source.Get(), readerAttrs.Get(), &reader);
  if (FAILED(hr)) {
    emit("{\"type\":\"error\",\"code\":\"reader\",\"hr\":" + std::to_string(unsigned(hr)) + "}");
    device->activate->ShutdownObject();
    return Exit_OpenFailed;
  }

  const DWORD stream = DWORD(MF_SOURCE_READER_FIRST_VIDEO_STREAM);
  const GUID wantedSubtype = nv12 ? MFVideoFormat_NV12 : MFVideoFormat_RGB32;
  ComPtr<IMFMediaType> chosen;
  for (DWORD i = 0;; ++i) {
    ComPtr<IMFMediaType> type;
    if (FAILED(reader->GetNativeMediaType(stream, i, &type))) break;
    GUID subtype{};
    UINT32 w = 0, h = 0;
    type->GetGUID(MF_MT_SUBTYPE, &subtype);
    MFGetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, &w, &h);
    if (subtype == wantedSubtype && w == width && h == height) {
      chosen = type;
      break;
    }
  }
  if (!chosen) {
    emit("{\"type\":\"error\",\"code\":\"no_format\"}");
    device->activate->ShutdownObject();
    return Exit_NoFormat;
  }
  hr = reader->SetCurrentMediaType(stream, nullptr, chosen.Get());
  if (SUCCEEDED(hr)) hr = reader->SetStreamSelection(stream, TRUE);
  if (FAILED(hr)) {
    emit("{\"type\":\"error\",\"code\":\"set_type\",\"hr\":" + std::to_string(unsigned(hr)) + "}");
    device->activate->ShutdownObject();
    return Exit_NoFormat;
  }
  emit("{\"type\":\"open\",\"name\":" + jsonString(device->name) + ",\"format\":\"" + (nv12 ? "nv12" : "rgb32") +
       "\",\"width\":" + std::to_string(width) + ",\"height\":" + std::to_string(height) + "}");

  const ULONGLONG start = GetTickCount64();
  uint64_t index = 0, patterns = 0, fallbacks = 0, others = 0, readErrors = 0;
  int exitCode = Exit_Ok;
  while (!g_stop.load() && (seconds <= 0 || double(GetTickCount64() - start) < seconds * 1000.0)) {
    DWORD actual = 0, flags = 0;
    LONGLONG ts = 0;
    ComPtr<IMFSample> sample;
    hr = reader->ReadSample(stream, 0, &actual, &flags, &ts, &sample);
    if (FAILED(hr) || (flags & (MF_SOURCE_READERF_ERROR | MF_SOURCE_READERF_ENDOFSTREAM))) {
      if (++readErrors > 20) {
        emit("{\"type\":\"error\",\"code\":\"read\",\"hr\":" + std::to_string(unsigned(hr)) + "}");
        exitCode = Exit_ReadFailed;
        break;
      }
      Sleep(50);
      continue;
    }
    if (!sample) continue;
    ComPtr<IMFMediaBuffer> buffer;
    if (FAILED(sample->GetBufferByIndex(0, &buffer))) continue;
    FrameView view;
    view.width = width;
    view.height = height;
    view.nv12 = nv12;
    ComPtr<IMF2DBuffer> buffer2d;
    BYTE* data = nullptr;
    bool locked2d = false;
    if (SUCCEEDED(buffer.As(&buffer2d)) && SUCCEEDED(buffer2d->Lock2D(&data, &view.pitch))) {
      locked2d = true;
    } else {
      DWORD maxLen = 0, curLen = 0;
      if (FAILED(buffer->Lock(&data, &maxLen, &curLen))) continue;
      view.pitch = LONG(nv12 ? width : width * 4);
    }
    view.scan0 = data;
    const Classification c = classify(view);
    if (locked2d) buffer2d->Unlock2D();
    else buffer->Unlock();

    ++index;
    if (c.kind[0] == 'p') ++patterns;
    else if (c.kind[0] == 'f') ++fallbacks;
    else ++others;
    emit("{\"type\":\"frame\",\"i\":" + std::to_string(index) + ",\"t\":" + std::to_string(GetTickCount64() - start) +
         ",\"kind\":\"" + c.kind + "\",\"counter\":" + std::to_string(c.counter) + ",\"bars\":" +
         std::to_string(c.barsMatched) + "}");
  }
  emit("{\"type\":\"summary\",\"frames\":" + std::to_string(index) + ",\"pattern\":" + std::to_string(patterns) +
       ",\"fallback\":" + std::to_string(fallbacks) + ",\"other\":" + std::to_string(others) + "}");
  reader.Reset();
  source.Reset();
  device->activate->ShutdownObject();
  return exitCode;
}

void printUsage() {
  std::fwprintf(stderr,
                L"Uso: VoxoraMeetCameraTest.exe [--name <cámara>] [--format nv12|rgb32] [--width W --height H] "
                L"[--seconds S]\n     VoxoraMeetCameraTest.exe --list | --probe\n");
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  std::wstring name = kFriendlyName;
  bool nv12 = true;
  uint32_t width = 1280, height = 720;
  double seconds = 120;
  enum class Mode { Stream, List, Probe } mode = Mode::Stream;
  for (int i = 1; i < argc; ++i) {
    const std::wstring arg = argv[i];
    auto next = [&]() -> const wchar_t* { return i + 1 < argc ? argv[++i] : nullptr; };
    if (arg == L"--list") mode = Mode::List;
    else if (arg == L"--probe") mode = Mode::Probe;
    else if (arg == L"--name") { const wchar_t* v = next(); if (!v) { printUsage(); return Exit_Usage; } name = v; }
    else if (arg == L"--format") {
      const wchar_t* v = next();
      if (!v || (_wcsicmp(v, L"nv12") != 0 && _wcsicmp(v, L"rgb32") != 0)) { printUsage(); return Exit_Usage; }
      nv12 = _wcsicmp(v, L"nv12") == 0;
    } else if (arg == L"--width") { const wchar_t* v = next(); if (!v) { printUsage(); return Exit_Usage; } width = uint32_t(_wtoi(v)); }
    else if (arg == L"--height") { const wchar_t* v = next(); if (!v) { printUsage(); return Exit_Usage; } height = uint32_t(_wtoi(v)); }
    else if (arg == L"--seconds") { const wchar_t* v = next(); if (!v) { printUsage(); return Exit_Usage; } seconds = _wtof(v); }
    else { printUsage(); return Exit_Usage; }
  }

  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) || FAILED(MFStartup(MF_VERSION))) return Exit_MfFailed;

  int code = Exit_Ok;
  if (mode == Mode::List) {
    code = runList();
  } else if (mode == Mode::Probe) {
    code = runProbe();
  } else {
    // stdin: `stop` o EOF detienen la lectura (el orquestador cierra stdin al terminar).
    std::thread([] {
      std::string line;
      while (std::getline(std::cin, line)) {
        if (line.rfind("stop", 0) == 0) break;
      }
      g_stop.store(true);
    }).detach();
    code = runStream(name, nv12, width, height, seconds);
  }
  MFShutdown();
  CoUninitialize();
  return code;
}
