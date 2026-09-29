#include "device_watcher.h"

#include <dbt.h>
#include <mmdeviceapi.h>

#include <atomic>

namespace voxora {

namespace {

// GUIDs de categoría KS (ks.h / ksmedia.h) definidos aquí para no arrastrar INITGUID.
constexpr GUID kCategoryVideoCamera = {0xE5323777, 0xF976, 0x4F5B, {0x9B, 0x55, 0xB9, 0x46, 0x99, 0xC4, 0x6E, 0x44}};
constexpr GUID kCategoryCapture = {0x65E8773D, 0x8F56, 0x11D0, {0xA3, 0xB9, 0x00, 0xA0, 0xC9, 0x22, 0x31, 0x96}};
constexpr GUID kCategoryAudio = {0x6994AD04, 0x93EF, 0x11D0, {0xA3, 0xCC, 0x00, 0xA0, 0xC9, 0x22, 0x31, 0x96}};

}  // namespace

// Callback de endpoints de audio: solo avisa a la ventana (el trabajo real se hace en el hilo de UI).
class EndpointNotifier final : public IMMNotificationClient {
 public:
  EndpointNotifier(HWND hwnd, UINT msg) : hwnd_(hwnd), msg_(msg) {}

  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs_; }
  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG n = --refs_;
    if (n == 0) delete this;
    return n;
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** out) override {
    if (!out) return E_POINTER;
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IMMNotificationClient)) {
      *out = static_cast<IMMNotificationClient*>(this);
      AddRef();
      return S_OK;
    }
    *out = nullptr;
    return E_NOINTERFACE;
  }

  HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR, DWORD) override { return notify(); }
  HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR) override { return notify(); }
  HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR) override { return notify(); }
  HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow, ERole role, LPCWSTR) override {
    // Se dispara una vez por rol; basta con reaccionar a uno.
    return role == eConsole ? notify() : S_OK;
  }
  HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR, const PROPERTYKEY) override { return S_OK; }

 private:
  HRESULT notify() {
    PostMessageW(hwnd_, msg_, 0, 0);
    return S_OK;
  }

  std::atomic<ULONG> refs_{1};
  HWND hwnd_;
  UINT msg_;
};

DeviceWatcher::~DeviceWatcher() { stop(); }

bool DeviceWatcher::start(HWND hwnd, UINT notifyMsg) {
  stop();
  for (const GUID& category : {kCategoryVideoCamera, kCategoryCapture, kCategoryAudio}) {
    DEV_BROADCAST_DEVICEINTERFACE_W filter{};
    filter.dbcc_size = sizeof(filter);
    filter.dbcc_devicetype = DBT_DEVTYP_DEVICEINTERFACE;
    filter.dbcc_classguid = category;
    HDEVNOTIFY h = RegisterDeviceNotificationW(hwnd, &filter, DEVICE_NOTIFY_WINDOW_HANDLE);
    if (h) notifications_.push_back(h);
  }
  if (SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator_)))) {
    notifier_ = new EndpointNotifier(hwnd, notifyMsg);
    if (FAILED(enumerator_->RegisterEndpointNotificationCallback(notifier_))) {
      notifier_->Release();
      notifier_ = nullptr;
    }
  }
  return !notifications_.empty() || notifier_ != nullptr;
}

void DeviceWatcher::stop() {
  for (HDEVNOTIFY h : notifications_) UnregisterDeviceNotification(h);
  notifications_.clear();
  if (enumerator_ && notifier_) enumerator_->UnregisterEndpointNotificationCallback(notifier_);
  if (notifier_) {
    notifier_->Release();
    notifier_ = nullptr;
  }
  if (enumerator_) {
    enumerator_->Release();
    enumerator_ = nullptr;
  }
}

bool DeviceWatcher::isRelevantDeviceChange(WPARAM wParam, LPARAM lParam) {
  if (wParam != DBT_DEVICEARRIVAL && wParam != DBT_DEVICEREMOVECOMPLETE) return false;
  const auto* hdr = reinterpret_cast<const DEV_BROADCAST_HDR*>(lParam);
  if (!hdr || hdr->dbch_devicetype != DBT_DEVTYP_DEVICEINTERFACE) return false;
  const auto* iface = reinterpret_cast<const DEV_BROADCAST_DEVICEINTERFACE_W*>(hdr);
  return iface->dbcc_classguid == kCategoryVideoCamera || iface->dbcc_classguid == kCategoryCapture ||
         iface->dbcc_classguid == kCategoryAudio;
}

}  // namespace voxora
