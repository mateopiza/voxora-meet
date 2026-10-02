// IMFMediaStream2 de la cámara virtual: un único stream de vídeo (PINNAME_VIDEO_CAPTURE) que anuncia
// NV12 y RGB32 a 1280x720 @ 30 fps y produce muestras desde FrameSource en un hilo propio: cada frame
// sale cuando el productor lo publica (evento "frame listo"), con un waitable timer de alta resolución
// de respaldo (imagen de espera, productor retrasado).
#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mferror.h>
#include <wrl.h>

#include <deque>
#include <mutex>
#include <thread>

#include "frame_source.h"

namespace voxora::vcam {

class MediaSource;

class MediaStream
    : public Microsoft::WRL::RuntimeClass<
          Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
          Microsoft::WRL::ChainInterfaces<IMFMediaStream2, IMFMediaStream, IMFMediaEventGenerator>,
          Microsoft::WRL::FtmBase> {
 public:
  MediaStream() = default;
  ~MediaStream() override;

  HRESULT RuntimeClassInitialize(MediaSource* parent, DWORD streamId);

  // IMFMediaEventGenerator
  IFACEMETHODIMP BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state) override;
  IFACEMETHODIMP EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** event) override;
  IFACEMETHODIMP GetEvent(DWORD flags, IMFMediaEvent** event) override;
  IFACEMETHODIMP QueueEvent(MediaEventType type, REFGUID extendedType, HRESULT status,
                            const PROPVARIANT* eventValue) override;

  // IMFMediaStream
  IFACEMETHODIMP GetMediaSource(IMFMediaSource** source) override;
  IFACEMETHODIMP GetStreamDescriptor(IMFStreamDescriptor** descriptor) override;
  IFACEMETHODIMP RequestSample(IUnknown* token) override;

  // IMFMediaStream2
  IFACEMETHODIMP SetStreamState(MF_STREAM_STATE state) override;
  IFACEMETHODIMP GetStreamState(MF_STREAM_STATE* state) override;

  // Llamadas internas desde MediaSource.
  HRESULT Start(IMFMediaType* mediaType);
  HRESULT Stop();
  HRESULT Shutdown();
  HRESULT SetSampleAllocator(IUnknown* allocator);
  HRESULT GetStreamAttributes(IMFAttributes** attributes);
  DWORD streamId() const { return streamId_; }
  bool wasStarted() const { return everStarted_; }

 private:
  HRESULT createMediaTypes(std::vector<Microsoft::WRL::ComPtr<IMFMediaType>>& types);
  HRESULT applyMediaType(IMFMediaType* mediaType);
  HRESULT checkShutdown() const { return shutdown_ ? MF_E_SHUTDOWN : S_OK; }
  void workerLoop();
  HRESULT deliverSample(IUnknown* token);
  HRESULT fillSample(IMFSample* sample);

  std::mutex mutex_;
  MediaSource* parent_ = nullptr;  // sin AddRef: el source posee al stream y lo cierra en Shutdown
  DWORD streamId_ = 0;
  Microsoft::WRL::ComPtr<IMFMediaEventQueue> eventQueue_;
  Microsoft::WRL::ComPtr<IMFAttributes> attributes_;
  Microsoft::WRL::ComPtr<IMFStreamDescriptor> streamDescriptor_;
  Microsoft::WRL::ComPtr<IMFMediaType> currentType_;
  Microsoft::WRL::ComPtr<IMFVideoSampleAllocator> allocator_;

  MF_STREAM_STATE state_ = MF_STREAM_STATE_STOPPED;
  bool shutdown_ = false;
  bool everStarted_ = false;

  uint32_t width_ = 0;
  uint32_t height_ = 0;
  GUID subtype_ = GUID_NULL;
  int64_t frameDuration100ns_ = 333'333;
  uint32_t sampleSize_ = 0;

  FrameSource frameSource_;
  std::deque<Microsoft::WRL::ComPtr<IUnknown>> pendingTokens_;
  std::thread worker_;
  HANDLE stopEvent_ = nullptr;
  HANDLE tokenEvent_ = nullptr;  // auto-reset: RequestSample despierta al hilo productor
};

}  // namespace voxora::vcam
