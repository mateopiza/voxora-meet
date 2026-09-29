// IMFActivate registrado bajo el CLSID de la cámara. El FrameServer lo instancia con CoCreateInstance
// y llama ActivateObject(IID_IMFMediaSource). IMFAttributes se delega a un objeto de MF.
#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <wrl.h>

#include <mutex>

#include "media_source.h"

namespace voxora::vcam {

class __declspec(uuid("7A1E5C3B-0F4D-4B8A-9C2E-3D6F1B8E5A70")) Activate
    : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
                                          Microsoft::WRL::ChainInterfaces<IMFActivate, IMFAttributes>,
                                          Microsoft::WRL::FtmBase> {
 public:
  Activate() = default;
  HRESULT RuntimeClassInitialize();

  // IMFActivate
  IFACEMETHODIMP ActivateObject(REFIID riid, void** object) override;
  IFACEMETHODIMP ShutdownObject() override;
  IFACEMETHODIMP DetachObject() override;

  // IMFAttributes (delegación)
  IFACEMETHODIMP GetItem(REFGUID key, PROPVARIANT* itemValue) override;
  IFACEMETHODIMP GetItemType(REFGUID key, MF_ATTRIBUTE_TYPE* type) override;
  IFACEMETHODIMP CompareItem(REFGUID key, REFPROPVARIANT itemValue, BOOL* result) override;
  IFACEMETHODIMP Compare(IMFAttributes* other, MF_ATTRIBUTES_MATCH_TYPE matchType, BOOL* result) override;
  IFACEMETHODIMP GetUINT32(REFGUID key, UINT32* itemValue) override;
  IFACEMETHODIMP GetUINT64(REFGUID key, UINT64* itemValue) override;
  IFACEMETHODIMP GetDouble(REFGUID key, double* itemValue) override;
  IFACEMETHODIMP GetGUID(REFGUID key, GUID* itemValue) override;
  IFACEMETHODIMP GetStringLength(REFGUID key, UINT32* length) override;
  IFACEMETHODIMP GetString(REFGUID key, LPWSTR itemValue, UINT32 bufferSize, UINT32* length) override;
  IFACEMETHODIMP GetAllocatedString(REFGUID key, LPWSTR* itemValue, UINT32* length) override;
  IFACEMETHODIMP GetBlobSize(REFGUID key, UINT32* size) override;
  IFACEMETHODIMP GetBlob(REFGUID key, UINT8* buffer, UINT32 bufferSize, UINT32* size) override;
  IFACEMETHODIMP GetAllocatedBlob(REFGUID key, UINT8** buffer, UINT32* size) override;
  IFACEMETHODIMP GetUnknown(REFGUID key, REFIID riid, LPVOID* object) override;
  IFACEMETHODIMP SetItem(REFGUID key, REFPROPVARIANT itemValue) override;
  IFACEMETHODIMP DeleteItem(REFGUID key) override;
  IFACEMETHODIMP DeleteAllItems() override;
  IFACEMETHODIMP SetUINT32(REFGUID key, UINT32 itemValue) override;
  IFACEMETHODIMP SetUINT64(REFGUID key, UINT64 itemValue) override;
  IFACEMETHODIMP SetDouble(REFGUID key, double itemValue) override;
  IFACEMETHODIMP SetGUID(REFGUID key, REFGUID itemValue) override;
  IFACEMETHODIMP SetString(REFGUID key, LPCWSTR itemValue) override;
  IFACEMETHODIMP SetBlob(REFGUID key, const UINT8* buffer, UINT32 size) override;
  IFACEMETHODIMP SetUnknown(REFGUID key, IUnknown* object) override;
  IFACEMETHODIMP LockStore() override;
  IFACEMETHODIMP UnlockStore() override;
  IFACEMETHODIMP GetCount(UINT32* count) override;
  IFACEMETHODIMP GetItemByIndex(UINT32 index, GUID* key, PROPVARIANT* itemValue) override;
  IFACEMETHODIMP CopyAllItems(IMFAttributes* destination) override;

 private:
  std::mutex mutex_;
  Microsoft::WRL::ComPtr<IMFAttributes> attributes_;
  Microsoft::WRL::ComPtr<MediaSource> source_;
};

}  // namespace voxora::vcam
