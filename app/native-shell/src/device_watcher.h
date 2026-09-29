// Detección en caliente de cámaras y dispositivos de audio.
//
//   - RegisterDeviceNotification para las interfaces KSCATEGORY_VIDEO_CAMERA,
//     KSCATEGORY_CAPTURE y KSCATEGORY_AUDIO (llegan como WM_DEVICECHANGE a la
//     ventana principal; el dueño llama a isRelevantDeviceChange()).
//   - IMMNotificationClient (IMMDeviceEnumerator::RegisterEndpointNotificationCallback)
//     para altas/bajas/cambios de estado y de predeterminado de endpoints de audio;
//     los callbacks llegan en hilos de MMDevice y solo hacen PostMessage(notifyMsg).
//
// El debounce (≈600 ms) lo hace la ventana con un timer: todas las fuentes
// reinician el mismo timer y al vencer se re-enumera una sola vez.
#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <vector>

struct IMMDeviceEnumerator;

namespace voxora {

class EndpointNotifier;

class DeviceWatcher {
 public:
  DeviceWatcher() = default;
  ~DeviceWatcher();
  DeviceWatcher(const DeviceWatcher&) = delete;
  DeviceWatcher& operator=(const DeviceWatcher&) = delete;

  // Registra ambas fuentes. `notifyMsg` se publica en `hwnd` ante cambios de endpoints de audio.
  bool start(HWND hwnd, UINT notifyMsg);
  void stop();

  // true si el WM_DEVICECHANGE corresponde a llegada/salida de una interfaz vigilada.
  static bool isRelevantDeviceChange(WPARAM wParam, LPARAM lParam);

 private:
  std::vector<HDEVNOTIFY> notifications_;
  IMMDeviceEnumerator* enumerator_ = nullptr;
  EndpointNotifier* notifier_ = nullptr;
};

}  // namespace voxora
