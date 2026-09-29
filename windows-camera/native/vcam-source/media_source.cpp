#include "media_source.h"

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::MakeAndInitialize;

namespace voxora::vcam {

namespace {
constexpr DWORD kVideoStreamId = 0;
}

MediaSource::~MediaSource() { Shutdown(); }

HRESULT MediaSource::RuntimeClassInitialize() {
  HRESULT hr = MFCreateEventQueue(&eventQueue_);
  if (FAILED(hr)) return hr;
  hr = MFCreateAttributes(&attributes_, 2);
  if (FAILED(hr)) return hr;

  ComPtr<MediaStream> stream;
  hr = MakeAndInitialize<MediaStream>(&stream, this, kVideoStreamId);
  if (FAILED(hr)) return hr;
  streams_.push_back(stream);

  std::vector<IMFStreamDescriptor*> descriptors;
  std::vector<ComPtr<IMFStreamDescriptor>> holders;
  for (auto& s : streams_) {
    ComPtr<IMFStreamDescriptor> sd;
    hr = s->GetStreamDescriptor(&sd);
    if (FAILED(hr)) return hr;
    descriptors.push_back(sd.Get());
    holders.push_back(sd);
  }
  hr = MFCreatePresentationDescriptor(DWORD(descriptors.size()), descriptors.data(), &presentationDescriptor_);
  if (FAILED(hr)) return hr;
  for (DWORD i = 0; i < DWORD(descriptors.size()); ++i) {
    hr = presentationDescriptor_->SelectStream(i);
    if (FAILED(hr)) return hr;
  }
  return S_OK;
}

MediaStream* MediaSource::findStream(DWORD streamId) {
  for (auto& s : streams_)
    if (s->streamId() == streamId) return s.Get();
  return nullptr;
}

// ---- IMFMediaEventGenerator -------------------------------------------------------------------

IFACEMETHODIMP MediaSource::BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state) {
  std::lock_guard<std::mutex> lock(mutex_);
  HRESULT hr = checkShutdown();
  if (FAILED(hr)) return hr;
  return eventQueue_->BeginGetEvent(callback, state);
}

IFACEMETHODIMP MediaSource::EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** event) {
  std::lock_guard<std::mutex> lock(mutex_);
  HRESULT hr = checkShutdown();
  if (FAILED(hr)) return hr;
  return eventQueue_->EndGetEvent(result, event);
}

IFACEMETHODIMP MediaSource::GetEvent(DWORD flags, IMFMediaEvent** event) {
  ComPtr<IMFMediaEventQueue> queue;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    HRESULT hr = checkShutdown();
    if (FAILED(hr)) return hr;
    queue = eventQueue_;
  }
  return queue->GetEvent(flags, event);
}

IFACEMETHODIMP MediaSource::QueueEvent(MediaEventType type, REFGUID extendedType, HRESULT status,
                                       const PROPVARIANT* eventValue) {
  std::lock_guard<std::mutex> lock(mutex_);
  HRESULT hr = checkShutdown();
  if (FAILED(hr)) return hr;
  return eventQueue_->QueueEventParamVar(type, extendedType, status, eventValue);
}

// ---- IMFMediaSource ---------------------------------------------------------------------------

IFACEMETHODIMP MediaSource::GetCharacteristics(DWORD* characteristics) {
  if (!characteristics) return E_POINTER;
  std::lock_guard<std::mutex> lock(mutex_);
  HRESULT hr = checkShutdown();
  if (FAILED(hr)) return hr;
  *characteristics = MFMEDIASOURCE_IS_LIVE;
  return S_OK;
}

IFACEMETHODIMP MediaSource::CreatePresentationDescriptor(IMFPresentationDescriptor** descriptor) {
  if (!descriptor) return E_POINTER;
  std::lock_guard<std::mutex> lock(mutex_);
  HRESULT hr = checkShutdown();
  if (FAILED(hr)) return hr;
  return presentationDescriptor_->Clone(descriptor);
}

IFACEMETHODIMP MediaSource::Start(IMFPresentationDescriptor* descriptor, const GUID* timeFormat,
                                  const PROPVARIANT* startPosition) {
  if (!descriptor) return E_INVALIDARG;
  if (timeFormat && *timeFormat != GUID_NULL) return MF_E_UNSUPPORTED_TIME_FORMAT;
  if (startPosition && startPosition->vt != VT_EMPTY && startPosition->vt != VT_I8) return MF_E_INVALIDREQUEST;

  // Se recogen bajo lock los streams a arrancar/parar y se actúa fuera del lock: MediaStream::Start
  // sincroniza con su hilo y no debe anidarse con el mutex del source.
  struct Action {
    ComPtr<MediaStream> stream;
    ComPtr<IMFMediaType> type;
    bool select;
    bool isNew;
  };
  std::vector<Action> actions;
  ComPtr<IMFMediaEventQueue> queue;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    HRESULT hr = checkShutdown();
    if (FAILED(hr)) return hr;
    queue = eventQueue_;

    DWORD count = 0;
    hr = descriptor->GetStreamDescriptorCount(&count);
    if (FAILED(hr)) return hr;
    for (DWORD i = 0; i < count; ++i) {
      BOOL selected = FALSE;
      ComPtr<IMFStreamDescriptor> sd;
      hr = descriptor->GetStreamDescriptorByIndex(i, &selected, &sd);
      if (FAILED(hr)) return hr;
      DWORD streamId = 0;
      hr = sd->GetStreamIdentifier(&streamId);
      if (FAILED(hr)) return hr;
      MediaStream* stream = findStream(streamId);
      if (!stream) return MF_E_INVALIDSTREAMNUMBER;

      Action action{stream, nullptr, selected == TRUE, !stream->wasStarted()};
      if (selected) {
        ComPtr<IMFMediaTypeHandler> handler;
        hr = sd->GetMediaTypeHandler(&handler);
        if (SUCCEEDED(hr)) hr = handler->GetCurrentMediaType(&action.type);
        if (FAILED(hr)) return hr;
      }
      actions.push_back(action);
    }
  }

  for (Action& action : actions) {
    if (action.select) {
      // MENewStream la primera vez, MEUpdatedStream en re-Starts. Se emite antes de MEStreamStarted.
      PROPVARIANT streamValue;
      PropVariantInit(&streamValue);
      streamValue.vt = VT_UNKNOWN;
      HRESULT hr = action.stream->QueryInterface(IID_PPV_ARGS(&streamValue.punkVal));
      if (FAILED(hr)) return hr;
      hr = queue->QueueEventParamVar(action.isNew ? MENewStream : MEUpdatedStream, GUID_NULL, S_OK, &streamValue);
      PropVariantClear(&streamValue);
      if (FAILED(hr)) return hr;
      hr = action.stream->Start(action.type.Get());
      if (FAILED(hr)) return hr;
    } else if (action.stream->wasStarted()) {
      HRESULT hr = action.stream->Stop();
      if (FAILED(hr)) return hr;
    }
  }

  PROPVARIANT startValue;
  PropVariantInit(&startValue);
  if (startPosition && startPosition->vt == VT_I8) {
    startValue.vt = VT_I8;
    startValue.hVal = startPosition->hVal;
  }
  HRESULT hr = queue->QueueEventParamVar(MESourceStarted, GUID_NULL, S_OK, &startValue);
  PropVariantClear(&startValue);
  return hr;
}

IFACEMETHODIMP MediaSource::Stop() {
  std::vector<ComPtr<MediaStream>> streams;
  ComPtr<IMFMediaEventQueue> queue;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    HRESULT hr = checkShutdown();
    if (FAILED(hr)) return hr;
    streams.assign(streams_.begin(), streams_.end());
    queue = eventQueue_;
  }
  for (auto& s : streams) s->Stop();
  return queue->QueueEventParamVar(MESourceStopped, GUID_NULL, S_OK, nullptr);
}

IFACEMETHODIMP MediaSource::Pause() {
  std::lock_guard<std::mutex> lock(mutex_);
  HRESULT hr = checkShutdown();
  if (FAILED(hr)) return hr;
  return MF_E_INVALID_STATE_TRANSITION;  // fuente en vivo: no se pausa
}

IFACEMETHODIMP MediaSource::Shutdown() {
  std::vector<ComPtr<MediaStream>> streams;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (shutdown_) return S_OK;
    shutdown_ = true;
    streams.swap(streams_);
    if (eventQueue_) eventQueue_->Shutdown();
    eventQueue_.Reset();
    presentationDescriptor_.Reset();
    attributes_.Reset();
  }
  for (auto& s : streams) s->Shutdown();
  return S_OK;
}

// ---- IMFMediaSourceEx -------------------------------------------------------------------------

IFACEMETHODIMP MediaSource::GetSourceAttributes(IMFAttributes** attributes) {
  if (!attributes) return E_POINTER;
  std::lock_guard<std::mutex> lock(mutex_);
  HRESULT hr = checkShutdown();
  if (FAILED(hr)) return hr;
  return attributes_.CopyTo(attributes);
}

IFACEMETHODIMP MediaSource::GetStreamAttributes(DWORD streamIdentifier, IMFAttributes** attributes) {
  if (!attributes) return E_POINTER;
  ComPtr<MediaStream> stream;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    HRESULT hr = checkShutdown();
    if (FAILED(hr)) return hr;
    stream = findStream(streamIdentifier);
  }
  if (!stream) return MF_E_INVALIDSTREAMNUMBER;
  return stream->GetStreamAttributes(attributes);
}

IFACEMETHODIMP MediaSource::SetD3DManager(IUnknown* /*manager*/) {
  // La fuente produce en memoria de sistema; se acepta el manager sin usarlo.
  std::lock_guard<std::mutex> lock(mutex_);
  return checkShutdown();
}

// ---- IMFGetService ----------------------------------------------------------------------------

IFACEMETHODIMP MediaSource::GetService(REFGUID /*service*/, REFIID /*riid*/, LPVOID* object) {
  if (object) *object = nullptr;
  return MF_E_UNSUPPORTED_SERVICE;
}

// ---- IKsControl (sin propiedades de cámara: el FrameServer lo tolera) ------------------------

IFACEMETHODIMP MediaSource::KsProperty(PKSPROPERTY, ULONG, LPVOID, ULONG, ULONG* bytesReturned) {
  if (bytesReturned) *bytesReturned = 0;
  return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
}

IFACEMETHODIMP MediaSource::KsMethod(PKSMETHOD, ULONG, LPVOID, ULONG, ULONG* bytesReturned) {
  if (bytesReturned) *bytesReturned = 0;
  return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
}

IFACEMETHODIMP MediaSource::KsEvent(PKSEVENT, ULONG, LPVOID, ULONG, ULONG* bytesReturned) {
  if (bytesReturned) *bytesReturned = 0;
  return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
}

// ---- IMFSampleAllocatorControl ----------------------------------------------------------------

IFACEMETHODIMP MediaSource::SetDefaultAllocator(DWORD outputStreamId, IUnknown* allocator) {
  ComPtr<MediaStream> stream;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    HRESULT hr = checkShutdown();
    if (FAILED(hr)) return hr;
    stream = findStream(outputStreamId);
  }
  if (!stream) return MF_E_INVALIDSTREAMNUMBER;
  return stream->SetSampleAllocator(allocator);
}

IFACEMETHODIMP MediaSource::GetAllocatorUsage(DWORD outputStreamId, DWORD* inputStreamId,
                                              MFSampleAllocatorUsage* usage) {
  if (!inputStreamId || !usage) return E_POINTER;
  std::lock_guard<std::mutex> lock(mutex_);
  HRESULT hr = checkShutdown();
  if (FAILED(hr)) return hr;
  if (!findStream(outputStreamId)) return MF_E_INVALIDSTREAMNUMBER;
  *inputStreamId = outputStreamId;
  *usage = MFSampleAllocatorUsage_UsesProvidedAllocator;
  return S_OK;
}

}  // namespace voxora::vcam
