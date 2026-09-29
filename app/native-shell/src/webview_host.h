// Host de WebView2 para la UI local (app/ui) de VOXORA Meet.
//
//   - Carpeta de datos: %LOCALAPPDATA%\VOXORA Meet\WebView2.
//   - La carpeta de la UI se sirve como https://app.voxora-meet/ con
//     SetVirtualHostNameToFolderMapping(..., DENY_CORS): contexto seguro (getUserMedia)
//     sin servidor local ni acceso a file://.
//   - Menú contextual por defecto, zoom, atajos del navegador, autofill y
//     guardado de contraseñas desactivados. DevTools solo en build Debug.
//   - Navegación restringida al host virtual; enlaces externos → navegador.
//   - Permisos de cámara/micrófono concedidos solo al origen propio.
//   - Puente: la UI usa window.chrome.webview.postMessage(obj) y recibe
//     PostWebMessageAsJson. Los mensajes de otros orígenes se descartan.
#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <functional>
#include <string>
#include <utility>
#include <vector>

struct ICoreWebView2Environment;
struct ICoreWebView2Controller;
struct ICoreWebView2;

namespace voxora {

class WebViewHost {
 public:
  struct Options {
    std::wstring userDataDir;
    std::wstring uiFolder;
    std::wstring hostName = L"app.voxora-meet";
    std::wstring startPage = L"index.html";
    // Carpetas extra servidas como https://<host>/ (p. ej. las tomas de voz para escucharlas).
    std::vector<std::pair<std::wstring, std::wstring>> extraMappings;
    bool devTools = false;
    COLORREF background = RGB(0, 0, 0);
  };
  using MessageHandler = std::function<void(const std::wstring& json)>;
  using CreatedHandler = std::function<void(bool ok, const std::wstring& error)>;
  using FailureHandler = std::function<void(bool browserProcessGone)>;

  WebViewHost() = default;
  ~WebViewHost();
  WebViewHost(const WebViewHost&) = delete;
  WebViewHost& operator=(const WebViewHost&) = delete;

  // Versión del runtime Evergreen instalado ("" si falta).
  static std::wstring runtimeVersion();

  // Crea el entorno y el controlador de forma asíncrona (callbacks en el hilo de UI).
  void create(HWND hwnd, const Options& options, MessageHandler onMessage, CreatedHandler onCreated, FailureHandler onFailure);
  void close();

  bool ready() const { return webview_ != nullptr; }
  void resize();
  void setVisible(bool visible);
  void focus();
  void notifyParentMoved();
  bool postJson(const std::wstring& json);
  void reload();
  std::wstring origin() const { return L"https://" + options_.hostName + L"/"; }

 private:
  void configure();

  HWND hwnd_ = nullptr;
  Options options_;
  MessageHandler onMessage_;
  CreatedHandler onCreated_;
  FailureHandler onFailure_;
  ICoreWebView2Environment* environment_ = nullptr;
  ICoreWebView2Controller* controller_ = nullptr;
  ICoreWebView2* webview_ = nullptr;
  unsigned generation_ = 0;  // invalida callbacks de creaciones anteriores
};

}  // namespace voxora
