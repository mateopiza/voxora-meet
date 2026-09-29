#include "webview_host.h"

#include <objbase.h>
#include <WebView2.h>
#include <WebView2EnvironmentOptions.h>
#include <shellapi.h>
#include <wrl.h>

#include "native_dialogs.h"

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Make;

namespace voxora {

namespace {

template <typename T>
void releaseAndNull(T*& p) {
  if (p) {
    p->Release();
    p = nullptr;
  }
}

std::wstring takeString(LPWSTR s) {
  std::wstring out = s ? s : L"";
  if (s) CoTaskMemFree(s);
  return out;
}

bool startsWith(const std::wstring& s, const std::wstring& prefix) { return s.rfind(prefix, 0) == 0; }

}  // namespace

WebViewHost::~WebViewHost() { close(); }

std::wstring WebViewHost::runtimeVersion() {
  LPWSTR version = nullptr;
  if (FAILED(GetAvailableCoreWebView2BrowserVersionString(nullptr, &version))) return L"";
  return takeString(version);
}

void WebViewHost::create(HWND hwnd, const Options& options, MessageHandler onMessage, CreatedHandler onCreated, FailureHandler onFailure) {
  close();
  hwnd_ = hwnd;
  options_ = options;
  onMessage_ = std::move(onMessage);
  onCreated_ = std::move(onCreated);
  onFailure_ = std::move(onFailure);
  const unsigned generation = ++generation_;

  auto envOptions = Make<CoreWebView2EnvironmentOptions>();
  envOptions->put_Language(L"es-ES");

  const HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(
      nullptr, options_.userDataDir.c_str(), envOptions.Get(),
      Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
          [this, generation](HRESULT result, ICoreWebView2Environment* env) -> HRESULT {
            if (generation != generation_) return S_OK;
            if (FAILED(result) || !env) {
              if (onCreated_) onCreated_(false, L"No se pudo iniciar Microsoft Edge WebView2 (entorno).");
              return S_OK;
            }
            environment_ = env;
            environment_->AddRef();
            return environment_->CreateCoreWebView2Controller(
                hwnd_, Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                           [this, generation](HRESULT res, ICoreWebView2Controller* controller) -> HRESULT {
                             if (generation != generation_) return S_OK;
                             if (FAILED(res) || !controller) {
                               if (onCreated_) onCreated_(false, L"No se pudo crear la vista de Microsoft Edge WebView2.");
                               return S_OK;
                             }
                             controller_ = controller;
                             controller_->AddRef();
                             controller_->get_CoreWebView2(&webview_);
                             configure();
                             if (onCreated_) onCreated_(true, L"");
                             return S_OK;
                           })
                           .Get());
          })
          .Get());
  if (FAILED(hr) && onCreated_) onCreated_(false, L"Microsoft Edge WebView2 Runtime no está disponible.");
}

void WebViewHost::configure() {
  // Fondo de marca mientras carga (evita el destello blanco).
  ComPtr<ICoreWebView2Controller2> controller2;
  if (SUCCEEDED(controller_->QueryInterface(IID_PPV_ARGS(&controller2)))) {
    COREWEBVIEW2_COLOR color{255, GetRValue(options_.background), GetGValue(options_.background), GetBValue(options_.background)};
    controller2->put_DefaultBackgroundColor(color);
  }

  ComPtr<ICoreWebView2Settings> settings;
  if (SUCCEEDED(webview_->get_Settings(&settings))) {
    settings->put_IsScriptEnabled(TRUE);
    settings->put_IsWebMessageEnabled(TRUE);
    settings->put_AreDefaultScriptDialogsEnabled(TRUE);
    settings->put_AreDefaultContextMenusEnabled(FALSE);
    settings->put_AreDevToolsEnabled(options_.devTools ? TRUE : FALSE);
    settings->put_IsStatusBarEnabled(FALSE);
    settings->put_IsZoomControlEnabled(FALSE);
    settings->put_IsBuiltInErrorPageEnabled(TRUE);
    ComPtr<ICoreWebView2Settings3> s3;
    // Sin atajos del navegador (F5, Ctrl+P, Ctrl+F, Ctrl+±…); en Debug se dejan para F12.
    if (SUCCEEDED(settings.As(&s3))) s3->put_AreBrowserAcceleratorKeysEnabled(options_.devTools ? TRUE : FALSE);
    ComPtr<ICoreWebView2Settings4> s4;
    if (SUCCEEDED(settings.As(&s4))) {
      s4->put_IsPasswordAutosaveEnabled(FALSE);  // las API keys no se guardan en el perfil
      s4->put_IsGeneralAutofillEnabled(FALSE);
    }
    ComPtr<ICoreWebView2Settings5> s5;
    if (SUCCEEDED(settings.As(&s5))) s5->put_IsPinchZoomEnabled(FALSE);
    ComPtr<ICoreWebView2Settings6> s6;
    if (SUCCEEDED(settings.As(&s6))) s6->put_IsSwipeNavigationEnabled(FALSE);
  }

  ComPtr<ICoreWebView2_3> webview3;
  if (SUCCEEDED(webview_->QueryInterface(IID_PPV_ARGS(&webview3)))) {
    webview3->SetVirtualHostNameToFolderMapping(options_.hostName.c_str(), options_.uiFolder.c_str(),
                                                COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS);
    for (const auto& [host, folder] : options_.extraMappings) {
      webview3->SetVirtualHostNameToFolderMapping(host.c_str(), folder.c_str(), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS);
    }
  }

  const std::wstring origin = this->origin();
  EventRegistrationToken token{};

  webview_->add_WebMessageReceived(
      Callback<ICoreWebView2WebMessageReceivedEventHandler>(
          [this, origin](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
            LPWSTR source = nullptr;
            args->get_Source(&source);
            if (!startsWith(takeString(source), origin)) return S_OK;  // origen ajeno: ignorar
            LPWSTR json = nullptr;
            if (SUCCEEDED(args->get_WebMessageAsJson(&json)) && onMessage_) onMessage_(takeString(json));
            return S_OK;
          })
          .Get(),
      &token);

  webview_->add_PermissionRequested(
      Callback<ICoreWebView2PermissionRequestedEventHandler>(
          [origin](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* args) -> HRESULT {
            LPWSTR uri = nullptr;
            args->get_Uri(&uri);
            COREWEBVIEW2_PERMISSION_KIND kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
            args->get_PermissionKind(&kind);
            const bool own = startsWith(takeString(uri), origin);
            const bool media = kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA || kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE;
            args->put_State(own && media ? COREWEBVIEW2_PERMISSION_STATE_ALLOW : COREWEBVIEW2_PERMISSION_STATE_DENY);
            return S_OK;
          })
          .Get(),
      &token);

  webview_->add_NavigationStarting(
      Callback<ICoreWebView2NavigationStartingEventHandler>(
          [origin](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
            LPWSTR uri = nullptr;
            args->get_Uri(&uri);
            const std::wstring target = takeString(uri);
            if (!startsWith(target, origin)) {
              args->put_Cancel(TRUE);
              BOOL userInitiated = FALSE;
              args->get_IsUserInitiated(&userInitiated);
              if (userInitiated) openExternalUrl(target);  // solo https/http/ms-settings
            }
            return S_OK;
          })
          .Get(),
      &token);

  webview_->add_NewWindowRequested(
      Callback<ICoreWebView2NewWindowRequestedEventHandler>(
          [](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
            args->put_Handled(TRUE);  // nunca ventanas nuevas dentro de la app
            LPWSTR uri = nullptr;
            args->get_Uri(&uri);
            openExternalUrl(takeString(uri));
            return S_OK;
          })
          .Get(),
      &token);

  webview_->add_ProcessFailed(
      Callback<ICoreWebView2ProcessFailedEventHandler>(
          [this](ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs* args) -> HRESULT {
            COREWEBVIEW2_PROCESS_FAILED_KIND kind{};
            args->get_ProcessFailedKind(&kind);
            const bool browserGone = kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED;
            if (onFailure_) onFailure_(browserGone);
            return S_OK;
          })
          .Get(),
      &token);

  resize();
  const std::wstring url = origin + options_.startPage;
  webview_->Navigate(url.c_str());
}

void WebViewHost::close() {
  ++generation_;
  if (controller_) controller_->Close();
  releaseAndNull(webview_);
  releaseAndNull(controller_);
  releaseAndNull(environment_);
}

void WebViewHost::resize() {
  if (!controller_ || !hwnd_) return;
  RECT rc;
  GetClientRect(hwnd_, &rc);
  controller_->put_Bounds(rc);
}

void WebViewHost::setVisible(bool visible) {
  if (controller_) controller_->put_IsVisible(visible ? TRUE : FALSE);
}

void WebViewHost::focus() {
  if (controller_) controller_->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
}

void WebViewHost::notifyParentMoved() {
  if (controller_) controller_->NotifyParentWindowPositionChanged();
}

bool WebViewHost::postJson(const std::wstring& json) {
  return webview_ && SUCCEEDED(webview_->PostWebMessageAsJson(json.c_str()));
}

void WebViewHost::reload() {
  if (webview_) webview_->Reload();
}

}  // namespace voxora
