// IMFMediaSource de la cámara virtual VOXORA Meet. Expone un único stream de vídeo y las interfaces
// que el FrameServer espera de una fuente de cámara: IMFMediaSourceEx, IMFGetService, IKsControl e
// IMFSampleAllocatorControl.
#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <unknwn.h>
#include <ks.h>
#include <ksproxy.h>  // IKsControl en modo usuario (la de ks.h es solo kernel)
#include <mfapi.h>
#include <mfidl.h>
#include <mferror.h>
#include <wrl.h>

#include <mutex>
#include <vector>

#include "media_stream.h"

namespace voxora::vcam {

class MediaSource
    : public Microsoft::WRL::RuntimeClass<
          Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
          Microsoft::WRL::ChainInterfaces<IMFMediaSourceEx, IMFMediaSource, IMFMediaEventGenerator>,
          IMFGetService, IKsControl, IMFSampleAllocatorControl, Microsoft::WRL::FtmBase> {
 public:
  MediaSource() = default;
  ~MediaSource() override;

  HRESULT RuntimeClassInitialize();

  // IMFMediaEventGenerator
  IFACEMETHODIMP BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state) override;
  IFACEMETHODIMP EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** event) override;
  IFACEMETHODIMP GetEvent(DWORD flags, IMFMediaEvent** event) override;
  IFACEMETHODIMP QueueEvent(MediaEventType type, REFGUID extendedType, HRESULT status,
                            const PROPVARIANT* eventValue) override;

  // IMFMediaSource
  IFACEMETHODIMP GetCharacteristics(DWORD* characteristics) override;
  IFACEMETHODIMP CreatePresentationDescriptor(IMFPresentationDescriptor** descriptor) override;
  IFACEMETHODIMP Start(IMFPresentationDescriptor* descriptor, const GUID* timeFormat,
                       const PROPVARIANT* startPosition) override;
  IFACEMETHODIMP Stop() override;
  IFACEMETHODIMP Pause() override;
  IFACEMETHODIMP Shutdown() override;

  // IMFMediaSourceEx
  IFACEMETHODIMP GetSourceAttributes(IMFAttributes** attributes) override;
  IFACEMETHODIMP GetStreamAttributes(DWORD streamIdentifier, IMFAttributes** attributes) override;
  IFACEMETHODIMP SetD3DManager(IUnknown* manager) override;

  // IMFGetService
  IFACEMETHODIMP GetService(REFGUID service, REFIID riid, LPVOID* object) override;

  // IKsControl
  IFACEMETHODIMP KsProperty(PKSPROPERTY property, ULONG propertyLength, LPVOID propertyData,
                            ULONG dataLength, ULONG* bytesReturned) override;
  IFACEMETHODIMP KsMethod(PKSMETHOD method, ULONG methodLength, LPVOID methodData, ULONG dataLength,
                          ULONG* bytesReturned) override;
  IFACEMETHODIMP KsEvent(PKSEVENT event, ULONG eventLength, LPVOID eventData, ULONG dataLength,
                         ULONG* bytesReturned) override;

  // IMFSampleAllocatorControl
  IFACEMETHODIMP SetDefaultAllocator(DWORD outputStreamId, IUnknown* allocator) override;
  IFACEMETHODIMP GetAllocatorUsage(DWORD outputStreamId, DWORD* inputStreamId,
                                   MFSampleAllocatorUsage* usage) override;

 private:
  HRESULT checkShutdown() const { return shutdown_ ? MF_E_SHUTDOWN : S_OK; }
  MediaStream* findStream(DWORD streamId);

  std::mutex mutex_;
  bool shutdown_ = false;
  Microsoft::WRL::ComPtr<IMFMediaEventQueue> eventQueue_;
  Microsoft::WRL::ComPtr<IMFAttributes> attributes_;
  Microsoft::WRL::ComPtr<IMFPresentationDescriptor> presentationDescriptor_;
  std::vector<Microsoft::WRL::ComPtr<MediaStream>> streams_;
};

}  // namespace voxora::vcam
