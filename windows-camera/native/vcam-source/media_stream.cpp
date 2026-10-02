#include "media_stream.h"

#include <ks.h>
#include <algorithm>
#include <ksmedia.h>

#include "media_source.h"
#include "pixel_convert.h"

using Microsoft::WRL::ComPtr;

namespace voxora::vcam {

namespace {

struct Resolution {
  uint32_t width;
  uint32_t height;
};
// Solo 1280x720: es el lienzo del shell. Anunciar 1920x1080 hacía que algunas apps lo eligieran y la DLL
// ampliaba 720p a 1080p (más blando y 2,25x más píxeles que codificar); a 720p la app escala si quiere.
constexpr Resolution kResolutions[] = {{1280, 720}};
const GUID kSubtypes[] = {MFVideoFormat_NV12, MFVideoFormat_RGB32};
constexpr uint32_t kFrameRateNumerator = 30;
constexpr uint32_t kFrameRateDenominator = 1;

HRESULT setStreamAttributes(IMFAttributes* attributes, DWORD streamId) {
  HRESULT hr = attributes->SetGUID(MF_DEVICESTREAM_STREAM_CATEGORY, PINNAME_VIDEO_CAPTURE);
  if (SUCCEEDED(hr)) hr = attributes->SetUINT32(MF_DEVICESTREAM_STREAM_ID, streamId);
  if (SUCCEEDED(hr)) hr = attributes->SetUINT32(MF_DEVICESTREAM_FRAMESERVER_SHARED, 1);
  if (SUCCEEDED(hr)) hr = attributes->SetUINT32(MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES, MFFrameSourceTypes_Color);
  return hr;
}

uint32_t frameBytes(const GUID& subtype, uint32_t width, uint32_t height) {
  return subtype == MFVideoFormat_NV12 ? uint32_t(nv12Size(width, height)) : width * height * 4;
}

}  // namespace

MediaStream::~MediaStream() { Shutdown(); }

HRESULT MediaStream::RuntimeClassInitialize(MediaSource* parent, DWORD streamId) {
  parent_ = parent;
  streamId_ = streamId;

  HRESULT hr = MFCreateEventQueue(&eventQueue_);
  if (FAILED(hr)) return hr;

  hr = MFCreateAttributes(&attributes_, 8);
  if (FAILED(hr)) return hr;
  hr = setStreamAttributes(attributes_.Get(), streamId_);
  if (FAILED(hr)) return hr;

  std::vector<ComPtr<IMFMediaType>> types;
  hr = createMediaTypes(types);
  if (FAILED(hr)) return hr;

  std::vector<IMFMediaType*> rawTypes;
  for (auto& t : types) rawTypes.push_back(t.Get());
  hr = MFCreateStreamDescriptor(streamId_, DWORD(rawTypes.size()), rawTypes.data(), &streamDescriptor_);
  if (FAILED(hr)) return hr;

  ComPtr<IMFMediaTypeHandler> handler;
  hr = streamDescriptor_->GetMediaTypeHandler(&handler);
  if (FAILED(hr)) return hr;
  hr = handler->SetCurrentMediaType(rawTypes[0]);
  if (FAILED(hr)) return hr;

  // El FrameServer lee la categoría/ID también desde el descriptor.
  hr = setStreamAttributes(streamDescriptor_.Get(), streamId_);
  if (FAILED(hr)) return hr;

  stopEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!stopEvent_) return HRESULT_FROM_WIN32(GetLastError());
  tokenEvent_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!tokenEvent_) return HRESULT_FROM_WIN32(GetLastError());

  return applyMediaType(rawTypes[0]);
}

HRESULT MediaStream::createMediaTypes(std::vector<ComPtr<IMFMediaType>>& types) {
  for (const GUID& subtype : kSubtypes) {
    for (const Resolution& res : kResolutions) {
      ComPtr<IMFMediaType> type;
      HRESULT hr = MFCreateMediaType(&type);
      if (FAILED(hr)) return hr;
      const uint32_t stride = subtype == MFVideoFormat_NV12 ? res.width : res.width * 4;
      const uint32_t size = frameBytes(subtype, res.width, res.height);
      hr = type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
      if (SUCCEEDED(hr)) hr = type->SetGUID(MF_MT_SUBTYPE, subtype);
      if (SUCCEEDED(hr)) hr = type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
      if (SUCCEEDED(hr)) hr = type->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);
      if (SUCCEEDED(hr)) hr = type->SetUINT32(MF_MT_FIXED_SIZE_SAMPLES, TRUE);
      if (SUCCEEDED(hr)) hr = type->SetUINT32(MF_MT_DEFAULT_STRIDE, stride);
      if (SUCCEEDED(hr)) hr = type->SetUINT32(MF_MT_SAMPLE_SIZE, size);
      if (SUCCEEDED(hr)) hr = type->SetUINT32(MF_MT_AVG_BITRATE, size * 8 * kFrameRateNumerator);
      if (SUCCEEDED(hr)) hr = MFSetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, res.width, res.height);
      if (SUCCEEDED(hr)) hr = MFSetAttributeRatio(type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
      if (SUCCEEDED(hr)) hr = MFSetAttributeRatio(type.Get(), MF_MT_FRAME_RATE, kFrameRateNumerator, kFrameRateDenominator);
      if (SUCCEEDED(hr)) hr = MFSetAttributeRatio(type.Get(), MF_MT_FRAME_RATE_RANGE_MIN, kFrameRateNumerator, kFrameRateDenominator);
      if (SUCCEEDED(hr)) hr = MFSetAttributeRatio(type.Get(), MF_MT_FRAME_RATE_RANGE_MAX, kFrameRateNumerator, kFrameRateDenominator);
      if (SUCCEEDED(hr) && subtype == MFVideoFormat_NV12) {
        hr = type->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235);
        if (SUCCEEDED(hr)) hr = type->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT601);
      }
      if (FAILED(hr)) return hr;
      types.push_back(type);
    }
  }
  return S_OK;
}

HRESULT MediaStream::applyMediaType(IMFMediaType* mediaType) {
  GUID subtype = GUID_NULL;
  UINT32 width = 0, height = 0, num = 0, den = 0;
  HRESULT hr = mediaType->GetGUID(MF_MT_SUBTYPE, &subtype);
  if (SUCCEEDED(hr)) hr = MFGetAttributeSize(mediaType, MF_MT_FRAME_SIZE, &width, &height);
  if (FAILED(hr)) return hr;
  if (subtype != MFVideoFormat_NV12 && subtype != MFVideoFormat_RGB32) return MF_E_INVALIDMEDIATYPE;
  if (width == 0 || height == 0 || width > kMaxWidth || height > kMaxHeight || (width & 1) || (height & 1))
    return MF_E_INVALIDMEDIATYPE;

  if (SUCCEEDED(MFGetAttributeRatio(mediaType, MF_MT_FRAME_RATE, &num, &den)) && num > 0 && den > 0)
    frameDuration100ns_ = int64_t(10'000'000) * den / num;
  else
    frameDuration100ns_ = int64_t(10'000'000) * kFrameRateDenominator / kFrameRateNumerator;

  width_ = width;
  height_ = height;
  subtype_ = subtype;
  sampleSize_ = frameBytes(subtype, width, height);
  currentType_ = mediaType;
  frameSource_.configure(width, height, subtype == MFVideoFormat_NV12 ? OutputFormat::NV12 : OutputFormat::RGB32);
  return S_OK;
}

// ---- IMFMediaEventGenerator -------------------------------------------------------------------

IFACEMETHODIMP MediaStream::BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state) {
  std::lock_guard<std::mutex> lock(mutex_);
  HRESULT hr = checkShutdown();
  if (FAILED(hr)) return hr;
  return eventQueue_->BeginGetEvent(callback, state);
}

IFACEMETHODIMP MediaStream::EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** event) {
  std::lock_guard<std::mutex> lock(mutex_);
  HRESULT hr = checkShutdown();
  if (FAILED(hr)) return hr;
  return eventQueue_->EndGetEvent(result, event);
}

IFACEMETHODIMP MediaStream::GetEvent(DWORD flags, IMFMediaEvent** event) {
  // No se mantiene el lock durante GetEvent: puede bloquear hasta que haya un evento.
  ComPtr<IMFMediaEventQueue> queue;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    HRESULT hr = checkShutdown();
    if (FAILED(hr)) return hr;
    queue = eventQueue_;
  }
  return queue->GetEvent(flags, event);
}

IFACEMETHODIMP MediaStream::QueueEvent(MediaEventType type, REFGUID extendedType, HRESULT status,
                                       const PROPVARIANT* eventValue) {
  std::lock_guard<std::mutex> lock(mutex_);
  HRESULT hr = checkShutdown();
  if (FAILED(hr)) return hr;
  return eventQueue_->QueueEventParamVar(type, extendedType, status, eventValue);
}

// ---- IMFMediaStream ---------------------------------------------------------------------------

IFACEMETHODIMP MediaStream::GetMediaSource(IMFMediaSource** source) {
  if (!source) return E_POINTER;
  std::lock_guard<std::mutex> lock(mutex_);
  HRESULT hr = checkShutdown();
  if (FAILED(hr)) return hr;
  return parent_->QueryInterface(IID_PPV_ARGS(source));
}

IFACEMETHODIMP MediaStream::GetStreamDescriptor(IMFStreamDescriptor** descriptor) {
  if (!descriptor) return E_POINTER;
  std::lock_guard<std::mutex> lock(mutex_);
  HRESULT hr = checkShutdown();
  if (FAILED(hr)) return hr;
  return streamDescriptor_.CopyTo(descriptor);
}

IFACEMETHODIMP MediaStream::RequestSample(IUnknown* token) {
  std::lock_guard<std::mutex> lock(mutex_);
  HRESULT hr = checkShutdown();
  if (FAILED(hr)) return hr;
  if (state_ != MF_STREAM_STATE_RUNNING) return MF_E_INVALIDREQUEST;
  // Se encola la petición; el hilo productor la satisface con el siguiente frame (o al vencer el
  // periodo). Se acotan las peticiones pendientes para no acumular latencia si el consumidor pide más
  // rápido que 30 fps.
  if (pendingTokens_.size() >= 4) pendingTokens_.pop_front();
  pendingTokens_.emplace_back(token);
  SetEvent(tokenEvent_);
  return S_OK;
}

// ---- IMFMediaStream2 --------------------------------------------------------------------------

IFACEMETHODIMP MediaStream::SetStreamState(MF_STREAM_STATE state) {
  MF_STREAM_STATE current;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    HRESULT hr = checkShutdown();
    if (FAILED(hr)) return hr;
    current = state_;
  }
  if (current == state) return S_OK;
  switch (state) {
    case MF_STREAM_STATE_RUNNING:
      return Start(nullptr);
    case MF_STREAM_STATE_STOPPED:
    case MF_STREAM_STATE_PAUSED:
      return Stop();
    default:
      return MF_E_INVALID_STATE_TRANSITION;
  }
}

IFACEMETHODIMP MediaStream::GetStreamState(MF_STREAM_STATE* state) {
  if (!state) return E_POINTER;
  std::lock_guard<std::mutex> lock(mutex_);
  HRESULT hr = checkShutdown();
  if (FAILED(hr)) return hr;
  *state = state_;
  return S_OK;
}

// ---- Control interno --------------------------------------------------------------------------

HRESULT MediaStream::GetStreamAttributes(IMFAttributes** attributes) {
  if (!attributes) return E_POINTER;
  std::lock_guard<std::mutex> lock(mutex_);
  HRESULT hr = checkShutdown();
  if (FAILED(hr)) return hr;
  return attributes_.CopyTo(attributes);
}

HRESULT MediaStream::SetSampleAllocator(IUnknown* allocator) {
  std::lock_guard<std::mutex> lock(mutex_);
  HRESULT hr = checkShutdown();
  if (FAILED(hr)) return hr;
  allocator_.Reset();
  if (!allocator) return S_OK;
  return allocator->QueryInterface(IID_PPV_ARGS(&allocator_));
}

HRESULT MediaStream::Start(IMFMediaType* mediaType) {
  // Si ya hay un hilo productor (re-Start con tipo nuevo, MEUpdatedStream) se detiene primero para
  // no reconfigurar FrameSource mientras produce.
  std::thread toJoin;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    HRESULT hr = checkShutdown();
    if (FAILED(hr)) return hr;
    if (worker_.joinable()) {
      SetEvent(stopEvent_);
      toJoin = std::move(worker_);
    }
  }
  if (toJoin.joinable()) toJoin.join();

  std::lock_guard<std::mutex> lock(mutex_);
  HRESULT hr = checkShutdown();
  if (FAILED(hr)) return hr;
  ResetEvent(stopEvent_);

  // Si no se pasa tipo, se toma el actual del handler (el FrameServer lo fija antes de Start).
  ComPtr<IMFMediaType> type = mediaType;
  if (!type) {
    ComPtr<IMFMediaTypeHandler> handler;
    hr = streamDescriptor_->GetMediaTypeHandler(&handler);
    if (SUCCEEDED(hr)) hr = handler->GetCurrentMediaType(&type);
    if (FAILED(hr)) return hr;
  }
  hr = applyMediaType(type.Get());
  if (FAILED(hr)) return hr;

  if (allocator_) {
    hr = allocator_->InitializeSampleAllocator(10, currentType_.Get());
    if (FAILED(hr)) return hr;
  }

  pendingTokens_.clear();
  state_ = MF_STREAM_STATE_RUNNING;
  everStarted_ = true;
  worker_ = std::thread([this] { workerLoop(); });
  return eventQueue_->QueueEventParamVar(MEStreamStarted, GUID_NULL, S_OK, nullptr);
}

HRESULT MediaStream::Stop() {
  std::thread toJoin;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    HRESULT hr = checkShutdown();
    if (FAILED(hr)) return hr;
    if (state_ == MF_STREAM_STATE_STOPPED) return S_OK;
    state_ = MF_STREAM_STATE_STOPPED;
    SetEvent(stopEvent_);
    toJoin = std::move(worker_);
    pendingTokens_.clear();
  }
  if (toJoin.joinable()) toJoin.join();
  std::lock_guard<std::mutex> lock(mutex_);
  return eventQueue_->QueueEventParamVar(MEStreamStopped, GUID_NULL, S_OK, nullptr);
}

HRESULT MediaStream::Shutdown() {
  std::thread toJoin;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (shutdown_) return S_OK;
    shutdown_ = true;
    state_ = MF_STREAM_STATE_STOPPED;
    if (stopEvent_) SetEvent(stopEvent_);
    toJoin = std::move(worker_);
    pendingTokens_.clear();
  }
  if (toJoin.joinable()) toJoin.join();

  std::lock_guard<std::mutex> lock(mutex_);
  if (eventQueue_) eventQueue_->Shutdown();
  eventQueue_.Reset();
  allocator_.Reset();
  streamDescriptor_.Reset();
  attributes_.Reset();
  currentType_.Reset();
  frameSource_.close();
  if (stopEvent_) {
    CloseHandle(stopEvent_);
    stopEvent_ = nullptr;
  }
  if (tokenEvent_) {
    CloseHandle(tokenEvent_);
    tokenEvent_ = nullptr;
  }
  parent_ = nullptr;
  return S_OK;
}

// ---- Hilo de producción -----------------------------------------------------------------------

void MediaStream::workerLoop() {
  // Entrega guiada por el productor: cada frame publicado en la memoria compartida avisa con el evento
  // "frame listo" y la muestra sale en ese momento. Antes un timer propio a 30 fps leía «el último
  // frame» con una fase arbitraria respecto a la webcam: cuando ambas fases coincidían, el jitter de unos
  // ms alternaba frames repetidos y saltados (vídeo a tirones) y se sumaba hasta un frame de latencia.
  // El timer (alta resolución, Windows 10 1803+) queda de respaldo: imagen de espera a 30 fps sin
  // productor, repetición del último frame si el productor se retrasa, o todo si no hay evento.
  HANDLE timer = CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
  if (!timer) timer = CreateWaitableTimerExW(nullptr, nullptr, 0, TIMER_ALL_ACCESS);
  HANDLE frameEvent = frameSource_.frameReadyEvent();  // nullptr si no se pudo abrir: solo timer

  const int64_t period = frameDuration100ns_;
  int64_t lastDelivery = 0;  // MFGetSystemTime() de la última muestra entregada (0 = ninguna aún)
  bool fresh = false;        // el productor avisó de un frame que aún no salió

  for (;;) {
    bool haveToken = false;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (shutdown_ || state_ != MF_STREAM_STATE_RUNNING) break;
      haveToken = !pendingTokens_.empty();
    }
    // Frame nuevo: sale en cuanto pasó medio periodo desde la anterior (sin ráfagas). Sin frame nuevo:
    // a 1 periodo sin productor (animación de espera) o a 1,5 con productor (su siguiente frame llega
    // antes; si no, se repite el último en vez de quedarse sin muestra).
    const int64_t gap = fresh ? period / 2 : (frameSource_.producerLive() ? period + period / 2 : period);
    const int64_t due = lastDelivery == 0 ? 0 : lastDelivery + gap - MFGetSystemTime();
    if (haveToken && due <= 0) {
      ComPtr<IUnknown> token;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!pendingTokens_.empty()) {
          token = pendingTokens_.front();
          pendingTokens_.pop_front();
        }
      }
      if (token) {
        // Cadencia de inicio a inicio: medirla tras deliverSample sumaba lo que tarda llenar la muestra
        // (imagen de espera a ~26 fps en vez de 30).
        lastDelivery = MFGetSystemTime();
        deliverSample(token.Get());
        fresh = false;
      }
      continue;
    }

    HANDLE handles[4];
    DWORD count = 0;
    handles[count++] = stopEvent_;
    handles[count++] = tokenEvent_;
    const DWORD frameIndex = count;
    if (frameEvent) handles[count++] = frameEvent;
    DWORD timeoutMs = INFINITE;
    if (haveToken) {  // hay petición pendiente: despertar cuando toque entregar
      if (timer) {
        LARGE_INTEGER dueTime;
        dueTime.QuadPart = -std::max<int64_t>(due, 1);  // relativo, 100 ns
        SetWaitableTimer(timer, &dueTime, 0, nullptr, nullptr, FALSE);
        handles[count++] = timer;
      } else {
        timeoutMs = DWORD(std::max<int64_t>(1, due / 10'000));
      }
    }
    const DWORD result = WaitForMultipleObjects(count, handles, FALSE, timeoutMs);
    if (result == WAIT_OBJECT_0) break;  // stop
    if (result == WAIT_FAILED) Sleep(5);  // no debería ocurrir; sin esto el bucle giraría en vacío
    else if (frameEvent && result == WAIT_OBJECT_0 + frameIndex) fresh = true;
    // Petición nueva, timer o timeout: se reevalúa arriba.
  }
  if (timer) {
    CancelWaitableTimer(timer);
    CloseHandle(timer);
  }
}

HRESULT MediaStream::fillSample(IMFSample* sample) {
  ComPtr<IMFMediaBuffer> buffer;
  HRESULT hr = sample->GetBufferByIndex(0, &buffer);
  if (FAILED(hr)) return hr;

  const int64_t now = MFGetSystemTime();
  int64_t timestamp = now;

  ComPtr<IMF2DBuffer2> buffer2d2;
  ComPtr<IMF2DBuffer> buffer2d;
  if (SUCCEEDED(buffer.As(&buffer2d2))) {
    BYTE* scanline0 = nullptr;
    LONG pitch = 0;
    BYTE* bufferStart = nullptr;
    DWORD bufferLength = 0;
    hr = buffer2d2->Lock2DSize(MF2DBuffer_LockFlags_Write, &scanline0, &pitch, &bufferStart, &bufferLength);
    if (FAILED(hr)) return hr;
    timestamp = frameSource_.produce(now, scanline0, pitch);
    buffer2d2->Unlock2D();
  } else if (SUCCEEDED(buffer.As(&buffer2d))) {
    BYTE* scanline0 = nullptr;
    LONG pitch = 0;
    hr = buffer2d->Lock2D(&scanline0, &pitch);
    if (FAILED(hr)) return hr;
    timestamp = frameSource_.produce(now, scanline0, pitch);
    buffer2d->Unlock2D();
  } else {
    BYTE* data = nullptr;
    DWORD maxLength = 0;
    hr = buffer->Lock(&data, &maxLength, nullptr);
    if (FAILED(hr)) return hr;
    if (maxLength < sampleSize_) {
      buffer->Unlock();
      return MF_E_BUFFERTOOSMALL;
    }
    const int32_t pitch = int32_t(subtype_ == MFVideoFormat_NV12 ? width_ : width_ * 4);
    timestamp = frameSource_.produce(now, data, pitch);
    buffer->Unlock();
  }
  hr = buffer->SetCurrentLength(sampleSize_);
  if (FAILED(hr)) return hr;

  hr = sample->SetSampleTime(timestamp);
  if (SUCCEEDED(hr)) hr = sample->SetSampleDuration(frameDuration100ns_);
  if (SUCCEEDED(hr)) hr = sample->SetUINT64(MFSampleExtension_DeviceTimestamp, UINT64(timestamp));
  return hr;
}

HRESULT MediaStream::deliverSample(IUnknown* token) {
  ComPtr<IMFVideoSampleAllocator> allocator;
  ComPtr<IMFMediaEventQueue> queue;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (shutdown_) return MF_E_SHUTDOWN;
    allocator = allocator_;
    queue = eventQueue_;
  }

  ComPtr<IMFSample> sample;
  HRESULT hr = E_FAIL;
  if (allocator) hr = allocator->AllocateSample(&sample);
  if (FAILED(hr) || !sample) {
    // Sin allocator del FrameServer (o agotado): buffer 2D propio.
    ComPtr<IMFMediaBuffer> buffer;
    const DWORD fourcc = subtype_.Data1;  // los subtipos de vídeo MF codifican el FOURCC/D3DFMT en Data1
    hr = MFCreate2DMediaBuffer(width_, height_, fourcc, FALSE, &buffer);
    if (FAILED(hr)) return hr;
    hr = MFCreateSample(&sample);
    if (FAILED(hr)) return hr;
    hr = sample->AddBuffer(buffer.Get());
    if (FAILED(hr)) return hr;
  }

  hr = fillSample(sample.Get());
  if (FAILED(hr)) return hr;
  if (token) {
    hr = sample->SetUnknown(MFSampleExtension_Token, token);
    if (FAILED(hr)) return hr;
  }

  PROPVARIANT eventValue;
  PropVariantInit(&eventValue);
  eventValue.vt = VT_UNKNOWN;
  eventValue.punkVal = sample.Detach();
  hr = queue->QueueEventParamVar(MEMediaSample, GUID_NULL, S_OK, &eventValue);
  PropVariantClear(&eventValue);
  return hr;
}

}  // namespace voxora::vcam
