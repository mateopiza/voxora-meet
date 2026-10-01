#include "camera_capture.h"

#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl/client.h>

#include <algorithm>
#include <chrono>
#include <cmath>

#include "../../../windows-camera/native/common/frame_producer.h"

using Microsoft::WRL::ComPtr;

namespace voxora {

namespace {

constexpr DWORD kVideoStream = static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM);

struct MfSession {
  bool ok = false;
  MfSession() { ok = SUCCEEDED(MFStartup(MF_VERSION, MFSTARTUP_LITE)); }
  ~MfSession() { if (ok) MFShutdown(); }
};

struct ComInit {
  HRESULT hr;
  ComInit() : hr(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) {}
  ~ComInit() { if (SUCCEEDED(hr)) CoUninitialize(); }
};

bool getFrameSize(IMFMediaType* type, UINT32& w, UINT32& h) {
  return SUCCEEDED(MFGetAttributeSize(type, MF_MT_FRAME_SIZE, &w, &h));
}

double getFrameRate(IMFMediaType* type) {
  UINT32 num = 0, den = 1;
  if (FAILED(MFGetAttributeRatio(type, MF_MT_FRAME_RATE, &num, &den)) || den == 0) return 0;
  return static_cast<double>(num) / den;
}

// Elige el tipo nativo más cercano a 1280x720@30 (prioriza tamaño exacto, luego fps).
HRESULT selectNativeType(IMFSourceReader* reader) {
  ComPtr<IMFMediaType> best;
  double bestScore = -1;
  for (DWORD i = 0;; i++) {
    ComPtr<IMFMediaType> type;
    HRESULT hr = reader->GetNativeMediaType(kVideoStream, i, &type);
    if (hr == MF_E_NO_MORE_TYPES) break;
    if (FAILED(hr)) return hr;
    UINT32 w = 0, h = 0;
    if (!getFrameSize(type.Get(), w, h)) continue;
    double fps = getFrameRate(type.Get());
    GUID subtype{};
    type->GetGUID(MF_MT_SUBTYPE, &subtype);
    double score = 0;
    if (w == CameraCapture::kTargetWidth && h == CameraCapture::kTargetHeight) score += 1000;
    else score -= std::fabs(static_cast<double>(w) * h - 1280.0 * 720.0) / (1280.0 * 720.0) * 100;
    score -= std::fabs(fps - CameraCapture::kTargetFps) * 5;
    // Formatos que el procesador de vídeo convierte a RGB32 sin decodificador extra.
    if (subtype == MFVideoFormat_NV12 || subtype == MFVideoFormat_YUY2 || subtype == MFVideoFormat_RGB32) score += 20;
    else if (subtype == MFVideoFormat_MJPG) score += 5;
    if (score > bestScore) {
      bestScore = score;
      best = type;
    }
  }
  if (!best) return MF_E_INVALIDMEDIATYPE;
  return reader->SetCurrentMediaType(kVideoStream, nullptr, best.Get());
}

}  // namespace

std::vector<CameraDevice> enumerateCameras() {
  std::vector<CameraDevice> out;
  ComInit com;
  MfSession mf;
  if (!mf.ok) return out;
  ComPtr<IMFAttributes> attrs;
  if (FAILED(MFCreateAttributes(&attrs, 1))) return out;
  attrs->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
  IMFActivate** devices = nullptr;
  UINT32 count = 0;
  if (FAILED(MFEnumDeviceSources(attrs.Get(), &devices, &count))) return out;
  for (UINT32 i = 0; i < count; i++) {
    wchar_t* name = nullptr;
    wchar_t* link = nullptr;
    UINT32 len = 0;
    CameraDevice dev;
    if (SUCCEEDED(devices[i]->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &name, &len))) {
      dev.name = name;
      CoTaskMemFree(name);
    }
    if (SUCCEEDED(devices[i]->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, &link, &len))) {
      dev.symbolicLink = link;
      CoTaskMemFree(link);
    }
    // La propia cámara virtual VOXORA no es una fuente válida para nosotros.
    if (dev.name.find(L"VOXORA Meet") == std::wstring::npos && !dev.symbolicLink.empty()) out.push_back(std::move(dev));
    devices[i]->Release();
  }
  CoTaskMemFree(devices);
  return out;
}

CameraCapture::~CameraCapture() { stop(); }

bool CameraCapture::start(const std::wstring& symbolicLink, int delayMs, std::wstring& error) {
  if (running_.load()) return true;
  delayMs_.store(std::clamp(delayMs, 0, kMaxDelayMs));

  // El hilo de publicación (memoria compartida de la cámara virtual) arranca siempre; si la webcam no
  // abre, queda "perdida" y la cámara virtual muestra su imagen de espera hasta que restartSource() la
  // recupere. El mapping lo abre el hilo en cuanto existe (lo crea la DLL al arrancar el host).
  running_.store(true);
  publishThread_ = std::thread([this] { publishLoop(); });
  return launchCapture(symbolicLink, error);
}

void CameraCapture::setDelayMs(int delayMs) {
  delayMs_.store(std::clamp(delayMs, 0, kMaxDelayMs));
  std::lock_guard<std::mutex> lock(ringMutex_);
  presentation_.reset();
}

void CameraCapture::setAudioPresentation(double ageMs, double sourceRate, double validForMs) {
  std::lock_guard<std::mutex> lock(ringMutex_);
  if (!presentation_.update(static_cast<double>(vcam::qpcNow100ns()) / 10000.0, ageMs, sourceRate, validForMs))
    presentationMisses_.fetch_add(1);
}

bool CameraCapture::launchCapture(const std::wstring& symbolicLink, std::wstring& error) {
  captureStop_.store(true);
  if (captureThread_.joinable()) captureThread_.join();
  if (startedEvent_) {
    CloseHandle(startedEvent_);
    startedEvent_ = nullptr;
  }
  captureStop_.store(false);
  startError_.clear();
  startFailed_.store(false);
  sourceLost_.store(true);  // hasta que captureLoop confirme el primer tipo de medio
  startedEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  captureThread_ = std::thread([this, symbolicLink] { captureLoop(symbolicLink); });
  const DWORD wait = WaitForSingleObject(startedEvent_, 8000);
  if (startFailed_.load()) {
    error = startError_;
    if (captureThread_.joinable()) captureThread_.join();
    return false;
  }
  if (wait != WAIT_OBJECT_0) {
    error = L"La cámara tardó demasiado en responder";
    return false;  // el hilo sigue intentándolo; si abre, sourceLost_ vuelve a false
  }
  return true;
}

void CameraCapture::markSourceLost() {
  sourceLost_.store(true);
  captureStop_.store(true);
  if (captureThread_.joinable()) captureThread_.join();
}

bool CameraCapture::restartSource(const std::wstring& symbolicLink, std::wstring& error) {
  if (!running_.load()) {
    error = L"La captura no está en marcha";
    return false;
  }
  return launchCapture(symbolicLink, error);
}

std::wstring CameraCapture::activeLink() {
  std::lock_guard<std::mutex> lock(linkMutex_);
  return activeLink_;
}

void CameraCapture::stop() {
  if (!running_.exchange(false)) return;
  captureStop_.store(true);
  if (captureThread_.joinable()) captureThread_.join();
  if (publishThread_.joinable()) publishThread_.join();
  if (startedEvent_) {
    CloseHandle(startedEvent_);
    startedEvent_ = nullptr;
  }
  sourceLost_.store(false);
  {
    std::lock_guard<std::mutex> lock(linkMutex_);
    activeLink_.clear();
  }
  {
    std::lock_guard<std::mutex> lock(ringMutex_);
    ring_.clear();
  }
  {
    std::lock_guard<std::mutex> lock(poolMutex_);
    pool_.clear();
  }
  fxAvgMs_.store(0);
  fxPeakMs_.store(0);
  sharedMemoryOk_.store(false);
  width_.store(0);
  height_.store(0);
  captureFps_.store(0);
}

CameraCapture::Stats CameraCapture::stats() {
  Stats s;
  s.presentationErrorMs = presentationErrorMs_.load();
  s.presentationMisses = presentationMisses_.load();
  s.running = running_.load();
  s.width = width_.load();
  s.height = height_.load();
  s.captureFps = captureFps_.load();
  s.delayMs = delayMs_.load();
  s.sharedMemoryOk = sharedMemoryOk_.load();
  s.published = published_.load();
  s.sourceLost = sourceLost_.load();
  s.effectsMs = fxAvgMs_.load();
  s.effectsPeakMs = fxPeakMs_.load();
  {
    std::lock_guard<std::mutex> lock(ringMutex_);
    s.queuedFrames = static_cast<int>(ring_.size());
  }
  return s;
}

void CameraCapture::setEffects(const VideoEffectsParams& params) {
  const VideoEffectsParams p = params.sanitized();
  std::lock_guard<std::mutex> lock(fxMutex_);
  if (p == fxParams_) return;
  fxParams_ = p;
  fxGen_.fetch_add(1);
}

VideoEffectsParams CameraCapture::effects() {
  std::lock_guard<std::mutex> lock(fxMutex_);
  return fxParams_;
}

void CameraCapture::setFrameTap(FrameTap tap) {
  std::lock_guard<std::mutex> lock(tapMutex_);
  tap_ = std::move(tap);
}

std::vector<uint8_t> CameraCapture::takeBuffer(size_t bytes) {
  {
    std::lock_guard<std::mutex> lock(poolMutex_);
    while (!pool_.empty()) {
      std::vector<uint8_t> b = std::move(pool_.back());
      pool_.pop_back();
      if (b.size() == bytes) return b;
    }
  }
  return std::vector<uint8_t>(bytes);
}

void CameraCapture::recycle(std::vector<uint8_t>&& buffer) {
  if (buffer.empty()) return;
  std::lock_guard<std::mutex> lock(poolMutex_);
  if (pool_.size() < 4) pool_.push_back(std::move(buffer));
}

void CameraCapture::enqueue(Frame&& frame) {
  std::lock_guard<std::mutex> lock(ringMutex_);
  const size_t frameBytes = frame.rgba.size();
  if (frameBytes == 0) return;
  ringCapacity_ = std::max<size_t>(2, kRingBudgetBytes / frameBytes);
  // Frames necesarios para cubrir el delay actual (+ margen de medio segundo).
  const double fps = std::max(1.0, captureFps_.load() > 0 ? captureFps_.load() : static_cast<double>(kTargetFps));
  const double nowMs = static_cast<double>(vcam::qpcNow100ns()) / 10000.0;
  const double nominalHistory = delayMs_.load() > 0 ? delayMs_.load() + 1500.0 : 500.0;
  const double historyMs = std::min(AudioPresentation::kMaxHistoryMs,
      std::max(nominalHistory, presentation_.active(nowMs) ? nowMs - presentation_.target(nowMs, delayMs_.load()) + 500 : 0));
  const size_t needed = static_cast<size_t>(std::ceil(historyMs / 1000.0 * fps));
  // Si no cabe, se diezma la cadencia de entrada (p. ej. 30 → 15 fps) en vez de perder el delay.
  const size_t stride = std::max<size_t>(1, (needed + ringCapacity_ - 1) / ringCapacity_);
  frameCounter_++;
  if (frameCounter_ % stride != 0) {
    recycle(std::move(frame.rgba));
    return;
  }
  ring_.push_back(std::move(frame));
  while (ring_.size() > ringCapacity_) {
    recycle(std::move(ring_.front().rgba));
    ring_.pop_front();
  }
}

void CameraCapture::publishLoop() {
  ComInit com;
  vcam::FrameProducer producer;  // misma lógica de apertura/publicación que VoxoraMeetFrameWriter
  constexpr int64_t kHeartbeatEvery100ns = 5'000'000;  // 500 ms
  int64_t lastHeartbeat = 0;
  bool heartbeatCleared = false;
  int64_t lastSourceTimestamp = -1;
  while (running_.load()) {
    const int64_t now = vcam::qpcNow100ns();
    Frame toPublish;
    bool found = false;
    bool ringEmpty = false;
    {
      std::lock_guard<std::mutex> lock(ringMutex_);
      const double nowMs = static_cast<double>(now) / 10000.0;
      const bool tracking = delayMs_.load() > 0 && presentation_.active(nowMs);
      const int64_t cutoff = static_cast<int64_t>((tracking ? presentation_.target(nowMs, delayMs_.load()) : nowMs - delayMs_.load()) * 10000.0);
      const double historyMs = std::min(AudioPresentation::kMaxHistoryMs,
          std::max(delayMs_.load() > 0 ? delayMs_.load() + 1500.0 : 500.0, tracking ? nowMs - static_cast<double>(cutoff) / 10000.0 + 500 : 0));
      const int64_t oldest = now - static_cast<int64_t>(historyMs * 10000.0);
      while (!ring_.empty() && ring_.front().timestamp100ns < oldest) {
        recycle(std::move(ring_.front().rgba));
        ring_.pop_front();
      }
      const Frame* selected = nullptr;
      for (const auto& frame : ring_) {
        if (frame.timestamp100ns > cutoff) break;
        selected = &frame;
      }
      if (selected && selected->timestamp100ns != lastSourceTimestamp) {
        toPublish.timestamp100ns = selected->timestamp100ns;
        toPublish.width = selected->width;
        toPublish.height = selected->height;
        toPublish.rgba = takeBuffer(selected->rgba.size());
        std::copy(selected->rgba.begin(), selected->rgba.end(), toPublish.rgba.begin());
        lastSourceTimestamp = selected->timestamp100ns;
        found = true;
      }
      if (tracking) {
        const double error = selected ? static_cast<double>(cutoff - selected->timestamp100ns) / 10000.0 : historyMs;
        presentationErrorMs_.store(error);
        if (error > 300) presentationMisses_.fetch_add(1);
      } else presentationErrorMs_.store(0);
      ringEmpty = ring_.empty();
    }

    // El mapping `Global\` lo crea la DLL cuando el FrameServer instancia la fuente (≈0,6 s después de
    // que el host haga Start) y este proceso no puede crearlo: se reintenta abrirlo cada 500 ms SIEMPRE
    // que no se tenga, lleguen o no frames. Antes se intentaba una vez ANTES de lanzar el host (siempre
    // fallaba) y luego solo en la rama "sin frames": con la webcam activa nunca se conectaba y Meet
    // mostraba para siempre la imagen de espera.
    const bool wasConnected = producer.connected();
    if (producer.ensureOpen(now) && !wasConnected) {
      // Recién conectado (o reconectado tras recargarse la DLL): el estado del latido es el del objeto.
      heartbeatCleared = false;
      lastHeartbeat = 0;
    }
    sharedMemoryOk_.store(producer.connected());

    if (found) {
      // Presentation timestamps stay monotonic even when selecting older source frames.
      if (producer.publish(toPublish.rgba.data(), toPublish.width, toPublish.height, now, now))
        published_.fetch_add(1);
      heartbeatCleared = false;
      lastHeartbeat = now;
      // Lo publicado va también a la grabación de prueba (si hay); el buffer vuelve al pool.
      {
        std::lock_guard<std::mutex> lock(tapMutex_);
        if (tap_) tap_(toPublish.rgba, toPublish.width, toPublish.height, now);
      }
      recycle(std::move(toPublish.rgba));
    } else if (sourceLost_.load() && ringEmpty) {
      // Webcam perdida y ya se publicó todo lo retenido: sin latido la DLL pasa a la imagen de
      // "esperando" en lugar de dejar el último frame congelado. A 0 para que el cambio sea inmediato.
      if (!heartbeatCleared && producer.connected()) {
        producer.clearHeartbeat();
        heartbeatCleared = true;
      }
    } else if (now - lastHeartbeat > kHeartbeatEvery100ns) {  // sin frame elegible (p. ej. al subir el delay)
      producer.heartbeat(now);
      lastHeartbeat = now;
    }
    Sleep(1000 / kTargetFps / 2);
  }
  // Al parar: la cámara virtual pasa a la imagen de espera de inmediato (si alguna app la mira).
  producer.clearHeartbeat();
  producer.close();
}

void CameraCapture::captureLoop(std::wstring symbolicLink) {
  ComInit com;
  MfSession mf;
  auto fail = [this](const std::wstring& what, HRESULT hr) {
    // El HRESULT solo va al log de depuración: la UI muestra el texto en español.
    wchar_t buf[64];
    swprintf_s(buf, L" (hr=0x%08X)\n", static_cast<unsigned>(hr));
    OutputDebugStringW((L"[camera] " + what + buf).c_str());
    startError_ = what;
    sourceLost_.store(true);
    startFailed_.store(true);
    if (startedEvent_) SetEvent(startedEvent_);
  };
  if (!mf.ok) { fail(L"Media Foundation no está disponible en este equipo", E_FAIL); return; }

  if (symbolicLink.empty()) {
    auto cams = enumerateCameras();
    if (cams.empty()) { fail(L"No hay ninguna cámara conectada", MF_E_NOT_FOUND); return; }
    symbolicLink = cams.front().symbolicLink;
  }

  ComPtr<IMFAttributes> attrs;
  HRESULT hr = MFCreateAttributes(&attrs, 2);
  if (FAILED(hr)) { fail(L"No se pudo preparar la cámara", hr); return; }
  attrs->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
  attrs->SetString(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, symbolicLink.c_str());
  ComPtr<IMFMediaSource> source;
  hr = MFCreateDeviceSource(attrs.Get(), &source);
  if (FAILED(hr)) { fail(L"No se pudo abrir la cámara: puede que esté desconectada o que otra app la use en exclusiva", hr); return; }

  // ENABLE_VIDEO_PROCESSING y ENABLE_ADVANCED_VIDEO_PROCESSING son excluyentes: con ambos,
  // MFCreateSourceReaderFromMediaSource devuelve E_INVALIDARG y la webcam nunca abre (verificado con
  // una BRIO 4K). Se usa el avanzado (conversión acelerada a RGB32) y, si el sistema no lo admite,
  // el básico.
  ComPtr<IMFSourceReader> reader;
  for (const GUID& processing : {MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING}) {
    ComPtr<IMFAttributes> readerAttrs;
    MFCreateAttributes(&readerAttrs, 2);
    readerAttrs->SetUINT32(processing, TRUE);
    readerAttrs->SetUINT32(MF_READWRITE_DISABLE_CONVERTERS, FALSE);
    hr = MFCreateSourceReaderFromMediaSource(source.Get(), readerAttrs.Get(), &reader);
    if (SUCCEEDED(hr)) break;
  }
  if (FAILED(hr)) { fail(L"No se pudo leer la cámara", hr); return; }

  selectNativeType(reader.Get());  // mejor esfuerzo; si falla se usa el tipo por defecto
  ComPtr<IMFMediaType> outType;
  MFCreateMediaType(&outType);
  outType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  outType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
  hr = reader->SetCurrentMediaType(kVideoStream, nullptr, outType.Get());
  if (FAILED(hr)) { fail(L"La cámara no ofrece un formato de video compatible", hr); return; }
  reader->SetStreamSelection(kVideoStream, TRUE);

  ComPtr<IMFMediaType> current;
  hr = reader->GetCurrentMediaType(kVideoStream, &current);
  if (FAILED(hr)) { fail(L"No se pudo leer el formato de la cámara", hr); return; }
  UINT32 width = 0, height = 0;
  getFrameSize(current.Get(), width, height);
  // Solo orienta la copia si el buffer no admite IMF2DBuffer (ver bucle de lectura).
  LONG stride = static_cast<LONG>(width) * 4;
  bool strideFromType = false;
  UINT32 strideAttr = 0;
  if (SUCCEEDED(current->GetUINT32(MF_MT_DEFAULT_STRIDE, &strideAttr)) && strideAttr != 0) {
    stride = static_cast<LONG>(static_cast<INT32>(strideAttr));
    strideFromType = true;
  }
  if (width == 0 || height == 0 || width > vcam::kMaxWidth || height > vcam::kMaxHeight) {
    fail(L"La resolución de la cámara no es compatible (máx. 1920x1080)", MF_E_INVALIDMEDIATYPE);
    return;
  }
  width_.store(static_cast<int>(width));
  height_.store(static_cast<int>(height));
  captureFps_.store(getFrameRate(current.Get()));
  {
    std::lock_guard<std::mutex> lock(linkMutex_);
    activeLink_ = symbolicLink;
  }
  sourceLost_.store(false);
  if (startedEvent_) SetEvent(startedEvent_);

  auto fpsWindowStart = std::chrono::steady_clock::now();
  int fpsFrames = 0;
  int consecutiveFailures = 0;
  VideoEffectsRenderer effects;
  uint32_t fxAppliedGen = fxGen_.load() - 1;  // fuerza cargar los parámetros vigentes en el primer frame
  double fxSumMs = 0, fxPeak = 0;
  int fxCount = 0;
  LARGE_INTEGER qpcFreq;
  QueryPerformanceFrequency(&qpcFreq);
  while (running_.load() && !captureStop_.load()) {
    DWORD streamIndex = 0, flags = 0;
    LONGLONG sampleTime = 0;
    ComPtr<IMFSample> sample;
    hr = reader->ReadSample(kVideoStream, 0, &streamIndex, &flags, &sampleTime, &sample);
    if (FAILED(hr)) {
      // Webcam desconectada / invalidada (o ~1 s de errores seguidos): se da por perdida.
      const bool gone = hr == MF_E_VIDEO_RECORDING_DEVICE_INVALIDATED || hr == MF_E_VIDEO_RECORDING_DEVICE_PREEMPTED;
      if (gone || ++consecutiveFailures >= 20) {
        sourceLost_.store(true);
        break;
      }
      Sleep(50);
      continue;
    }
    consecutiveFailures = 0;
    if (flags & (MF_SOURCE_READERF_ENDOFSTREAM | MF_SOURCE_READERF_ERROR)) {
      sourceLost_.store(true);
      break;
    }
    if (flags & MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED) {
      ComPtr<IMFMediaType> changed;
      if (SUCCEEDED(reader->GetCurrentMediaType(kVideoStream, &changed))) {
        getFrameSize(changed.Get(), width, height);
        UINT32 s = 0;
        strideFromType = SUCCEEDED(changed->GetUINT32(MF_MT_DEFAULT_STRIDE, &s)) && s != 0;
        stride = strideFromType ? static_cast<LONG>(static_cast<INT32>(s)) : static_cast<LONG>(width) * 4;
        width_.store(static_cast<int>(width));
        height_.store(static_cast<int>(height));
      }
    }
    if (!sample) continue;
    ComPtr<IMFMediaBuffer> buffer;
    if (FAILED(sample->GetBufferByIndex(0, &buffer))) continue;

    // Orientación: IMF2DBuffer::Lock2D devuelve la primera fila VISIBLE y el pitch real (negativo si
    // la imagen está de abajo arriba). Deducirlo de MF_MT_DEFAULT_STRIDE fallaba: el procesador de
    // vídeo no siempre publica ese atributo y MFGetStrideForBitmapInfoHeader(RGB32) devuelve un
    // stride negativo (convención DIB), así que la imagen salía de cabeza en Meet.
    BYTE* firstRow = nullptr;
    LONG pitch = 0;
    ComPtr<IMF2DBuffer> buffer2d;
    bool locked2d = false;
    DWORD curLen = 0;
    if (SUCCEEDED(buffer.As(&buffer2d)) && SUCCEEDED(buffer2d->Lock2D(&firstRow, &pitch))) {
      locked2d = true;
      curLen = static_cast<DWORD>(static_cast<size_t>(pitch < 0 ? -pitch : pitch) * height);
    } else {
      BYTE* data = nullptr;
      DWORD maxLen = 0;
      if (FAILED(buffer->Lock(&data, &maxLen, &curLen))) continue;
      // Buffer lineal: el signo del stride del tipo de medio indica la orientación; sin atributo
      // (stride de respaldo negativo) se asume de arriba abajo, que es lo que entrega el procesador.
      pitch = stride < 0 && strideFromType ? stride : static_cast<LONG>(width) * 4;
      firstRow = pitch < 0 ? data + static_cast<size_t>(-pitch) * (height - 1) : data;
    }

    // Imagen de la cámara: parámetros nuevos desde el siguiente frame (sin reabrir la webcam).
    const uint32_t gen = fxGen_.load();
    if (gen != fxAppliedGen) {
      std::lock_guard<std::mutex> lock(fxMutex_);
      effects.setParams(fxParams_);
      fxAppliedGen = gen;
    }

    // Una sola pasada del buffer de MF (B,G,R,X) al lienzo RGBA 1280x720 del contrato (R,G,B,A), con
    // orientación, encuadre y color aplicados; sin copias intermedias.
    Frame frame;
    frame.timestamp100ns = vcam::qpcNow100ns();
    frame.width = kTargetWidth;
    frame.height = kTargetHeight;
    const size_t rowBytes = static_cast<size_t>(width) * 4;
    const size_t absPitch = static_cast<size_t>(pitch < 0 ? -pitch : pitch);
    const bool valid = absPitch >= rowBytes && curLen >= absPitch * height;
    if (valid) {
      frame.rgba = takeBuffer(static_cast<size_t>(kTargetWidth) * kTargetHeight * 4);
      LARGE_INTEGER t0, t1;
      QueryPerformanceCounter(&t0);
      effects.render(firstRow, static_cast<ptrdiff_t>(pitch), static_cast<int>(width), static_cast<int>(height), frame.rgba.data(),
                     kTargetWidth, kTargetHeight);
      QueryPerformanceCounter(&t1);
      const double ms = static_cast<double>(t1.QuadPart - t0.QuadPart) * 1000.0 / static_cast<double>(qpcFreq.QuadPart);
      fxSumMs += ms;
      fxPeak = std::max(fxPeak, ms);
      fxCount++;
    }
    if (locked2d) buffer2d->Unlock2D();
    else buffer->Unlock();
    if (valid) enqueue(std::move(frame));

    fpsFrames++;
    auto now = std::chrono::steady_clock::now();
    double elapsed = std::chrono::duration<double>(now - fpsWindowStart).count();
    if (elapsed >= 1.0) {
      captureFps_.store(fpsFrames / elapsed);
      fxAvgMs_.store(fxCount ? fxSumMs / fxCount : 0);
      fxPeakMs_.store(fxPeak);
      fxSumMs = fxPeak = 0;
      fxCount = 0;
      fpsFrames = 0;
      fpsWindowStart = now;
    }
  }
}

}  // namespace voxora
