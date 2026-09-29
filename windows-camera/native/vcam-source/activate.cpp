#include "activate.h"

#include "../common/vcam_shared.h"

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::MakeAndInitialize;

namespace voxora::vcam {

HRESULT Activate::RuntimeClassInitialize() {
  HRESULT hr = MFCreateAttributes(&attributes_, 4);
  if (FAILED(hr)) return hr;
  // Nombre amigable por si algún enumerador lo consulta en el activate (el FrameServer usa el que se
  // pasó a MFCreateVirtualCamera).
  return attributes_->SetString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, kFriendlyName);
}

IFACEMETHODIMP Activate::ActivateObject(REFIID riid, void** object) {
  if (!object) return E_POINTER;
  *object = nullptr;
  std::lock_guard<std::mutex> lock(mutex_);
  if (!source_) {
    HRESULT hr = MakeAndInitialize<MediaSource>(&source_);
    if (FAILED(hr)) return hr;
  }
  return source_->QueryInterface(riid, object);
}

IFACEMETHODIMP Activate::ShutdownObject() {
  ComPtr<MediaSource> source;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    source.Swap(source_);
  }
  if (source) source->Shutdown();
  return S_OK;
}

IFACEMETHODIMP Activate::DetachObject() {
  std::lock_guard<std::mutex> lock(mutex_);
  source_.Reset();
  return S_OK;
}

// ---- IMFAttributes: delegación directa --------------------------------------------------------

IFACEMETHODIMP Activate::GetItem(REFGUID key, PROPVARIANT* itemValue) { return attributes_->GetItem(key, itemValue); }
IFACEMETHODIMP Activate::GetItemType(REFGUID key, MF_ATTRIBUTE_TYPE* type) { return attributes_->GetItemType(key, type); }
IFACEMETHODIMP Activate::CompareItem(REFGUID key, REFPROPVARIANT itemValue, BOOL* result) {
  return attributes_->CompareItem(key, itemValue, result);
}
IFACEMETHODIMP Activate::Compare(IMFAttributes* other, MF_ATTRIBUTES_MATCH_TYPE matchType, BOOL* result) {
  return attributes_->Compare(other, matchType, result);
}
IFACEMETHODIMP Activate::GetUINT32(REFGUID key, UINT32* itemValue) { return attributes_->GetUINT32(key, itemValue); }
IFACEMETHODIMP Activate::GetUINT64(REFGUID key, UINT64* itemValue) { return attributes_->GetUINT64(key, itemValue); }
IFACEMETHODIMP Activate::GetDouble(REFGUID key, double* itemValue) { return attributes_->GetDouble(key, itemValue); }
IFACEMETHODIMP Activate::GetGUID(REFGUID key, GUID* itemValue) { return attributes_->GetGUID(key, itemValue); }
IFACEMETHODIMP Activate::GetStringLength(REFGUID key, UINT32* length) { return attributes_->GetStringLength(key, length); }
IFACEMETHODIMP Activate::GetString(REFGUID key, LPWSTR itemValue, UINT32 bufferSize, UINT32* length) {
  return attributes_->GetString(key, itemValue, bufferSize, length);
}
IFACEMETHODIMP Activate::GetAllocatedString(REFGUID key, LPWSTR* itemValue, UINT32* length) {
  return attributes_->GetAllocatedString(key, itemValue, length);
}
IFACEMETHODIMP Activate::GetBlobSize(REFGUID key, UINT32* size) { return attributes_->GetBlobSize(key, size); }
IFACEMETHODIMP Activate::GetBlob(REFGUID key, UINT8* buffer, UINT32 bufferSize, UINT32* size) {
  return attributes_->GetBlob(key, buffer, bufferSize, size);
}
IFACEMETHODIMP Activate::GetAllocatedBlob(REFGUID key, UINT8** buffer, UINT32* size) {
  return attributes_->GetAllocatedBlob(key, buffer, size);
}
IFACEMETHODIMP Activate::GetUnknown(REFGUID key, REFIID riid, LPVOID* object) {
  return attributes_->GetUnknown(key, riid, object);
}
IFACEMETHODIMP Activate::SetItem(REFGUID key, REFPROPVARIANT itemValue) { return attributes_->SetItem(key, itemValue); }
IFACEMETHODIMP Activate::DeleteItem(REFGUID key) { return attributes_->DeleteItem(key); }
IFACEMETHODIMP Activate::DeleteAllItems() { return attributes_->DeleteAllItems(); }
IFACEMETHODIMP Activate::SetUINT32(REFGUID key, UINT32 itemValue) { return attributes_->SetUINT32(key, itemValue); }
IFACEMETHODIMP Activate::SetUINT64(REFGUID key, UINT64 itemValue) { return attributes_->SetUINT64(key, itemValue); }
IFACEMETHODIMP Activate::SetDouble(REFGUID key, double itemValue) { return attributes_->SetDouble(key, itemValue); }
IFACEMETHODIMP Activate::SetGUID(REFGUID key, REFGUID itemValue) { return attributes_->SetGUID(key, itemValue); }
IFACEMETHODIMP Activate::SetString(REFGUID key, LPCWSTR itemValue) { return attributes_->SetString(key, itemValue); }
IFACEMETHODIMP Activate::SetBlob(REFGUID key, const UINT8* buffer, UINT32 size) {
  return attributes_->SetBlob(key, buffer, size);
}
IFACEMETHODIMP Activate::SetUnknown(REFGUID key, IUnknown* object) { return attributes_->SetUnknown(key, object); }
IFACEMETHODIMP Activate::LockStore() { return attributes_->LockStore(); }
IFACEMETHODIMP Activate::UnlockStore() { return attributes_->UnlockStore(); }
IFACEMETHODIMP Activate::GetCount(UINT32* count) { return attributes_->GetCount(count); }
IFACEMETHODIMP Activate::GetItemByIndex(UINT32 index, GUID* key, PROPVARIANT* itemValue) {
  return attributes_->GetItemByIndex(index, key, itemValue);
}
IFACEMETHODIMP Activate::CopyAllItems(IMFAttributes* destination) { return attributes_->CopyAllItems(destination); }

}  // namespace voxora::vcam
