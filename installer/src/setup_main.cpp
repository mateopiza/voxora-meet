// VoxoraMeetSetup.exe / VoxoraMeetUninstall.exe — instalador propio de VOXORA Meet con UI en WebView2.
//
// Modos (docs/RELEASE.md):
//   (sin argumentos)          asistente: Bienvenida → Licencia/Privacidad → Ubicación → Progreso → Listo
//   /S [/D=<carpeta>] [/relaunch] [/log=<archivo>]
//                             instalación silenciosa (actualizaciones): cierra la app si está abierta,
//                             instala y la vuelve a abrir (si estaba abierta o con /relaunch)
//   /uninstall [/S] [/purge]  desinstala (desregistra la cámara, cierra la app, borra archivos y accesos;
//                             conserva los datos del usuario salvo /purge o la casilla «Borrar mis datos»).
//                             El desinstalador instalado (VoxoraMeetUninstall.exe) es este mismo programa
//                             sin carga útil: sin argumentos, desinstala.
//   /extract <carpeta>        solo extrae y verifica la carga útil (no toca el sistema, no pide elevación)
//   /preview [/screen=<id>] [/capture=<png>] [/uninstall]
//                             muestra la UI sin instalar nada (la instalación se simula); con /capture
//                             guarda una captura PNG de la pantalla indicada y sale
//   /fallback                 fuerza la UI mínima (TaskDialog) que se usa si falta WebView2
//
// Requiere elevación (manifest requireAdministrator) salvo /extract y /preview, que se relanzan sin
// pedirla cuando se ejecutan con __COMPAT_LAYER=RunAsInvoker (pruebas) y no escriben fuera de su carpeta.
#include <windows.h>
#include <commctrl.h>
#include <dwmapi.h>
#include <objbase.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <wrl.h>

#include <WebView2.h>

#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "common.h"
#include "install_ops.h"
#include "json.h"
#include "payload.h"
#include "voxora_version.h"

#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "shlwapi.lib")
// Manifest propio (res/setup.manifest: requireAdministrator, PerMonitorV2, Common Controls 6) como recurso.

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;
using namespace vxsetup;
namespace json = voxora::json;

namespace {

constexpr int IDI_SETUP = 101;
constexpr UINT WM_APP_POST = WM_APP + 1;  // lParam = std::wstring* con JSON para la UI
constexpr UINT WM_APP_DONE = WM_APP + 2;
constexpr wchar_t kWindowClass[] = L"VoxoraMeetSetupWindow";
const COLORREF kCanvas = RGB(247, 245, 255);

struct Args {
  bool silent = false, uninstall = false, preview = false, fallback = false, relaunch = false, purge = false, fromTemp = false;
  std::wstring extractDir, installDir, logFile, screen, capture, targetDir;
};

Args parseArgs() {
  Args a;
  int argc = 0;
  LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  for (int i = 1; argv && i < argc; ++i) {
    const std::wstring s = argv[i];
    auto value = [&](const wchar_t* prefix) -> const wchar_t* {
      const size_t n = wcslen(prefix);
      return _wcsnicmp(s.c_str(), prefix, n) == 0 ? s.c_str() + n : nullptr;
    };
    if (_wcsicmp(s.c_str(), L"/S") == 0) a.silent = true;
    else if (_wcsicmp(s.c_str(), L"/uninstall") == 0) a.uninstall = true;
    else if (_wcsicmp(s.c_str(), L"/preview") == 0) a.preview = true;
    else if (_wcsicmp(s.c_str(), L"/fallback") == 0) a.fallback = true;
    else if (_wcsicmp(s.c_str(), L"/relaunch") == 0) a.relaunch = true;
    else if (_wcsicmp(s.c_str(), L"/purge") == 0) a.purge = true;
    else if (_wcsicmp(s.c_str(), L"/_fromtemp") == 0) a.fromTemp = true;
    else if (_wcsicmp(s.c_str(), L"/extract") == 0 && i + 1 < argc) a.extractDir = argv[++i];
    else if (auto v = value(L"/D=")) a.installDir = v;
    else if (auto v2 = value(L"/log=")) a.logFile = v2;
    else if (auto v3 = value(L"/screen=")) a.screen = v3;
    else if (auto v4 = value(L"/capture=")) a.capture = v4;
    else if (auto v5 = value(L"/dir=")) a.targetDir = v5;
  }
  LocalFree(argv);
  return a;
}

std::wstring quote(const std::wstring& s) { return L"\"" + s + L"\""; }

// Relanza este mismo exe con «runas» y los mismos argumentos; devuelve su código de salida.
int relaunchElevated() {
  const std::wstring self = exePath();
  const wchar_t* args = PathGetArgsW(GetCommandLineW());
  SHELLEXECUTEINFOW sei{};
  sei.cbSize = sizeof(sei);
  sei.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
  sei.lpVerb = L"runas";
  sei.lpFile = self.c_str();
  sei.lpParameters = args;
  sei.nShow = SW_SHOWNORMAL;
  if (!ShellExecuteExW(&sei)) return GetLastError() == ERROR_CANCELLED ? 1223 : 1;
  DWORD code = 1;
  if (sei.hProcess) {
    WaitForSingleObject(sei.hProcess, INFINITE);
    GetExitCodeProcess(sei.hProcess, &code);
    CloseHandle(sei.hProcess);
  }
  return static_cast<int>(code);
}

// Carpeta de la instalación a desinstalar: /dir=, la carpeta del propio exe (si es una instalación) o el registro.
std::wstring uninstallTarget(const Args& a) {
  if (!a.targetDir.empty()) return a.targetDir;
  const std::wstring here = dirOf(exePath());
  if (fileExists(here + L"\\" + kAppExe) || fileExists(here + L"\\" + kManifestFile)) return here;
  return installedDir();
}

// El desinstalador no puede borrarse a sí mismo: se copia a %TEMP% y sigue desde ahí.
bool continueFromTemp(const Args& a) {
  const std::wstring dir = uninstallTarget(a);
  const std::wstring copy = tempDir() + L"\\VoxoraMeetUninstall-" + std::to_wstring(GetCurrentProcessId()) + L".exe";
  if (!CopyFileW(exePath().c_str(), copy.c_str(), FALSE)) return false;
  std::wstring cmd = quote(copy) + L" /uninstall /_fromtemp /dir=" + quote(dir);
  if (a.silent) cmd += L" /S";
  if (a.purge) cmd += L" /purge";
  if (!a.logFile.empty()) cmd += L" /log=" + quote(a.logFile);
  std::vector<wchar_t> buf(cmd.begin(), cmd.end());
  buf.push_back(L'\0');
  STARTUPINFOW si{};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi{};
  if (!CreateProcessW(nullptr, buf.data(), nullptr, nullptr, FALSE, 0, nullptr, tempDir().c_str(), &si, &pi)) {
    DeleteFileW(copy.c_str());
    return false;
  }
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return true;
}

// La copia temporal se borra sola al terminar.
void scheduleSelfDelete() {
  const std::wstring self = exePath();
  std::wstring cmd = L"cmd.exe /d /c ping 127.0.0.1 -n 3 >nul & del /f /q " + quote(self);
  std::vector<wchar_t> buf(cmd.begin(), cmd.end());
  buf.push_back(L'\0');
  STARTUPINFOW si{};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi{};
  if (CreateProcessW(nullptr, buf.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, tempDir().c_str(), &si, &pi)) {
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
  }
  MoveFileExW(self.c_str(), nullptr, MOVEFILE_DELAY_UNTIL_REBOOT);
}

std::string loadUiHtml() {
  HRSRC res = FindResourceW(nullptr, L"SETUP_UI", MAKEINTRESOURCEW(10));
  if (!res) return {};
  const char* data = static_cast<const char*>(LockResource(LoadResource(nullptr, res)));
  return data ? std::string(data, SizeofResource(nullptr, res)) : std::string();
}

json::Value resultJson(const OpResult& r) {
  json::Value v;
  json::Value mic;
  mic.set("present", r.virtualMic.present).set("ownDriver", r.virtualMic.ownDriver).set("name", toUtf8(r.virtualMic.name));
  v.set("type", "done").set("ok", r.ok).set("error", toUtf8(r.error)).set("cameraRegistered", r.cameraRegistered)
      .set("cameraMessage", toUtf8(r.cameraMessage)).set("rebootNeeded", r.rebootNeeded).set("virtualMic", mic)
      .set("logPath", toUtf8(logPath()));
  return v;
}

// ── UI WebView2 ───────────────────────────────────────────────────────────────
class WebUi {
 public:
  WebUi(const Args& args, const Payload& payload, bool uninstallMode) : args_(args), payload_(payload), uninstall_(uninstallMode) {}

  int run(HINSTANCE instance) {
    html_ = loadUiHtml();
    if (html_.empty()) return -1;
    WNDCLASSEXW wc{};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = &WebUi::wndProcThunk;
    wc.hInstance = instance;
    wc.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(IDI_SETUP));
    wc.hIconSm = static_cast<HICON>(LoadImageW(instance, MAKEINTRESOURCEW(IDI_SETUP), IMAGE_ICON, GetSystemMetrics(SM_CXSMICON),
                                               GetSystemMetrics(SM_CYSMICON), 0));
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.lpszClassName = kWindowClass;
    RegisterClassExW(&wc);

    const UINT dpi = GetDpiForSystem();
    const int w = MulDiv(920, static_cast<int>(dpi), 96), h = MulDiv(600, static_cast<int>(dpi), 96);
    RECT work{};
    SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
    const int x = work.left + ((work.right - work.left) - w) / 2, y = work.top + ((work.bottom - work.top) - h) / 2;
    const std::wstring title = uninstall_ ? L"Desinstalar VOXORA Meet" : L"Instalar VOXORA Meet " VOXORA_VERSION_WSTR;
    hwnd_ = CreateWindowExW(WS_EX_APPWINDOW, kWindowClass, title.c_str(), WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
                            x, y, w, h, nullptr, nullptr, instance, this);
    if (!hwnd_) return -1;
    const int corner = 2;  // DWMWCP_ROUND (Windows 11)
    DwmSetWindowAttribute(hwnd_, 33 /* DWMWA_WINDOW_CORNER_PREFERENCE */, &corner, sizeof(corner));
    const COLORREF border = RGB(226, 220, 250);
    DwmSetWindowAttribute(hwnd_, 34 /* DWMWA_BORDER_COLOR */, &border, sizeof(border));
    const MARGINS margins{0, 0, 1, 0};
    DwmExtendFrameIntoClientArea(hwnd_, &margins);
    SetWindowPos(hwnd_, nullptr, 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER);
    createWebView();
    ShowWindow(hwnd_, SW_SHOWNORMAL);
    SetForegroundWindow(hwnd_);

    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
    if (worker_.joinable()) worker_.join();
    return exitCode_;
  }

 private:
  static LRESULT CALLBACK wndProcThunk(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    WebUi* self = nullptr;
    if (msg == WM_NCCREATE) {
      self = static_cast<WebUi*>(reinterpret_cast<CREATESTRUCTW*>(lp)->lpCreateParams);
      SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
    } else {
      self = reinterpret_cast<WebUi*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    }
    return self ? self->wndProc(hwnd, msg, wp, lp) : DefWindowProcW(hwnd, msg, wp, lp);
  }

  LRESULT wndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
      case WM_NCCALCSIZE:
        if (wp) return 0;  // sin barra de título del sistema: la UI dibuja la suya (sombra y esquinas de DWM se conservan)
        break;
      case WM_NCHITTEST: {
        // Solo llega aquí lo que la vista declara arrastrable (app-region: drag) o el borde: se mueve la
        // ventana; los botones fantasma de la barra de título no existen.
        const LRESULT hit = DefWindowProcW(hwnd, msg, wp, lp);
        if (hit == HTCLIENT || hit == HTCAPTION || hit == HTCLOSE || hit == HTMINBUTTON || hit == HTMAXBUTTON || hit == HTSYSMENU) return HTCAPTION;
        return hit;
      }
      case WM_SIZE:
        if (controller_) {
          RECT rc;
          GetClientRect(hwnd, &rc);
          controller_->put_Bounds(rc);
        }
        return 0;
      case WM_ERASEBKGND: {
        RECT rc;
        GetClientRect(hwnd, &rc);
        HBRUSH b = CreateSolidBrush(kCanvas);
        FillRect(reinterpret_cast<HDC>(wp), &rc, b);
        DeleteObject(b);
        return 1;
      }
      case WM_DPICHANGED: {
        const auto* r = reinterpret_cast<const RECT*>(lp);
        SetWindowPos(hwnd, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER | SWP_NOACTIVATE);
        return 0;
      }
      case WM_APP_POST: {
        std::unique_ptr<std::wstring> text(reinterpret_cast<std::wstring*>(lp));
        if (webview_ && text) webview_->PostWebMessageAsJson(text->c_str());
        return 0;
      }
      case WM_APP_DONE:
        busy_ = false;
        return 0;
      case WM_CLOSE:
        if (busy_) return 0;  // no se cierra a mitad de la instalación
        DestroyWindow(hwnd);
        return 0;
      case WM_DESTROY:
        if (controller_) controller_->Close();
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
  }

  void post(const json::Value& v) {
    auto* text = new std::wstring(toWide(v.dump()));
    if (!PostMessageW(hwnd_, WM_APP_POST, 0, reinterpret_cast<LPARAM>(text))) delete text;
  }

  void createWebView() {
    const std::wstring userData = tempDir() + L"\\VoxoraMeetSetup\\WebView2";
    SHCreateDirectoryExW(nullptr, userData.c_str(), nullptr);
    CreateCoreWebView2EnvironmentWithOptions(
        nullptr, userData.c_str(), nullptr,
        Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>([this](HRESULT hr, ICoreWebView2Environment* env) -> HRESULT {
          if (FAILED(hr) || !env) return fail(L"No se pudo iniciar Microsoft Edge WebView2.");
          return env->CreateCoreWebView2Controller(
              hwnd_, Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                         [this](HRESULT res, ICoreWebView2Controller* controller) -> HRESULT {
                           if (FAILED(res) || !controller) return fail(L"No se pudo crear la vista de WebView2.");
                           controller_ = controller;
                           controller_->get_CoreWebView2(&webview_);
                           configure();
                           return S_OK;
                         })
                         .Get());
        }).Get());
  }

  HRESULT fail(const wchar_t* message) {
    logLine(message);
    webFailed_ = true;
    DestroyWindow(hwnd_);
    return S_OK;
  }

  void configure() {
    ComPtr<ICoreWebView2Controller2> c2;
    if (SUCCEEDED(controller_.As(&c2))) {
      COREWEBVIEW2_COLOR color{};
      color.A = 255;
      color.R = 247;  // --canvas #F7F5FF
      color.G = 245;
      color.B = 255;
      c2->put_DefaultBackgroundColor(color);
    }
    ComPtr<ICoreWebView2Settings> s;
    if (SUCCEEDED(webview_->get_Settings(&s))) {
      wchar_t dev[4] = L"";
      const bool devTools = GetEnvironmentVariableW(L"VOXORA_SETUP_DEVTOOLS", dev, 4) && dev[0] == L'1';
      s->put_AreDefaultContextMenusEnabled(devTools);
      s->put_AreDevToolsEnabled(devTools);
      s->put_IsStatusBarEnabled(FALSE);
      s->put_IsZoomControlEnabled(FALSE);
      s->put_AreDefaultScriptDialogsEnabled(FALSE);
      ComPtr<ICoreWebView2Settings3> s3;
      if (SUCCEEDED(s.As(&s3))) s3->put_AreBrowserAcceleratorKeysEnabled(devTools);
      ComPtr<ICoreWebView2Settings5> s5;
      if (SUCCEEDED(s.As(&s5))) s5->put_IsPinchZoomEnabled(FALSE);
      ComPtr<ICoreWebView2Settings9> s9;
      if (SUCCEEDED(s.As(&s9))) s9->put_IsNonClientRegionSupportEnabled(TRUE);  // CSS app-region: drag
    }
    // Enlaces y ventanas nuevas: nunca dentro del instalador.
    EventRegistrationToken token{};
    webview_->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>(
                                         [](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* e) -> HRESULT {
                                           e->put_Handled(TRUE);
                                           return S_OK;
                                         }).Get(),
                                     &token);
    webview_->add_NavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>(
                                         [](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* e) -> HRESULT {
                                           LPWSTR uri = nullptr;
                                           e->get_Uri(&uri);
                                           const std::wstring u = uri ? uri : L"";
                                           CoTaskMemFree(uri);
                                           if (u.rfind(L"data:", 0) != 0 && u != L"about:blank") e->put_Cancel(TRUE);
                                           return S_OK;
                                         }).Get(),
                                     &token);
    webview_->add_WebMessageReceived(Callback<ICoreWebView2WebMessageReceivedEventHandler>(
                                         [this](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* e) -> HRESULT {
                                           LPWSTR raw = nullptr;
                                           if (SUCCEEDED(e->get_WebMessageAsJson(&raw)) && raw) {
                                             const std::string text = toUtf8(raw);
                                             CoTaskMemFree(raw);
                                             try {
                                               onMessage(json::parse(text));
                                             } catch (...) {
                                             }
                                           }
                                           return S_OK;
                                         }).Get(),
                                     &token);
    RECT rc;
    GetClientRect(hwnd_, &rc);
    controller_->put_Bounds(rc);
    webview_->NavigateToString(toWide(html_).c_str());
  }

  json::Value dirInfo(const std::wstring& raw) {
    const std::wstring dir = normalizeDir(raw);
    const uint64_t free = dir.empty() ? 0 : freeSpaceFor(dir);
    const uint64_t need = payload_.present() ? payload_.index.totalBytes : 0;
    json::Value v;
    v.set("type", "dirInfo").set("dir", toUtf8(dir.empty() ? raw : dir)).set("valid", !dir.empty())
        .set("freeBytes", static_cast<double>(free)).set("freeText", toUtf8(formatBytes(free)))
        .set("requiredBytes", static_cast<double>(need)).set("requiredText", toUtf8(formatBytes(need)))
        .set("enoughSpace", free > need + 16ull * 1024 * 1024).set("programFiles", !dir.empty() && isProgramFilesPath(dir));
    return v;
  }

  void sendInit() {
    const std::wstring existing = installedDir();
    const std::wstring proposed = !args_.installDir.empty() ? args_.installDir : !existing.empty() ? existing : defaultInstallDir();
    json::Value init = dirInfo(proposed);
    init.set("type", "init").set("mode", uninstall_ ? "uninstall" : "install").set("version", VOXORA_VERSION_STR)
        .set("preview", args_.preview).set("capture", !args_.capture.empty()).set("screen", toUtf8(args_.screen))
        .set("defaultDir", toUtf8(defaultInstallDir())).set("webview", toUtf8(webView2Version()));
    const std::wstring existingVersion = installedVersion();
    if (!existingVersion.empty()) {
      json::Value inst;
      inst.set("version", toUtf8(existingVersion)).set("dir", toUtf8(existing));
      init.set("installed", inst);
    } else {
      init.set("installed", json::Value());
    }
    if (uninstall_) init.set("uninstallDir", toUtf8(uninstallTarget(args_)));
    post(init);
  }

  void startWork(bool install, const std::wstring& dir, bool desktop, bool purge) {
    if (busy_) return;
    busy_ = true;
    if (worker_.joinable()) worker_.join();
    worker_ = std::thread([this, install, dir, desktop, purge] {
      CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
      Progress progress = [this](double pct, const std::string& step, const std::wstring& detail) {
        json::Value p;
        p.set("type", "progress").set("step", step).set("detail", toUtf8(detail));
        if (pct >= 0) p.set("percent", pct);
        post(p);
      };
      OpResult r;
      if (args_.preview) {
        r = simulate(install, progress);
      } else if (install) {
        r = runInstall({dir, desktop}, payload_, progress);
      } else {
        r = runUninstall(dir, purge, progress);
      }
      installDir_ = normalizeDir(dir);
      ok_ = r.ok;
      exitCode_ = r.ok ? 0 : 1;
      post(resultJson(r));
      PostMessageW(hwnd_, WM_APP_DONE, 0, 0);
      CoUninitialize();
    });
  }

  // /preview: recorre las fases con tiempos realistas sin tocar el sistema.
  OpResult simulate(bool install, const Progress& progress) {
    const struct { double pct; const char* step; const wchar_t* text; DWORD ms; } installSteps[] = {
        {1, "verify", L"Verificando el paquete…", 500},        {4, "close", L"Preparando la instalación…", 400},
        {6, "files", L"Copiando archivos…", 0},                  {87, "cleanup", L"Quitando restos de la versión anterior…", 350},
        {90, "camera", L"Registrando la cámara virtual…", 700}, {94, "shortcuts", L"Creando accesos directos…", 400},
        {97, "registry", L"Registrando VOXORA Meet en Windows…", 400}, {100, "done", L"VOXORA Meet está instalado.", 200}};
    const struct { double pct; const char* step; const wchar_t* text; DWORD ms; } uninstallSteps[] = {
        {3, "close", L"Cerrando VOXORA Meet…", 500}, {15, "camera", L"Quitando la cámara virtual…", 600},
        {30, "shortcuts", L"Quitando accesos directos…", 400}, {40, "files", L"Borrando archivos…", 0},
        {88, "registry", L"Quitando VOXORA Meet de Windows…", 400}, {100, "done", L"VOXORA Meet se desinstaló.", 200}};
    auto run = [&](const auto& steps) {
      for (const auto& s : steps) {
        progress(s.pct, s.step, s.text);
        if (std::string(s.step) == "files") {
          const double from = s.pct, to = install ? 86 : 85;
          for (int i = 1; i <= 60; ++i) {
            Sleep(60);
            progress(from + (to - from) * i / 60.0, "files", install ? L"Copiando node\\node.exe" : L"Borrando archivos…");
          }
        } else {
          Sleep(s.ms);
        }
      }
    };
    if (install) run(installSteps);
    else run(uninstallSteps);
    OpResult r;
    r.ok = true;
    r.cameraRegistered = install;
    r.cameraMessage = L"Cámara virtual «VOXORA Meet Camera» registrada.";
    r.virtualMic = detectVirtualMic();
    return r;
  }

  void capture() {
    ComPtr<IStream> stream;
    if (FAILED(SHCreateStreamOnFileEx(args_.capture.c_str(), STGM_CREATE | STGM_WRITE, FILE_ATTRIBUTE_NORMAL, TRUE, nullptr, &stream))) {
      exitCode_ = 3;
      DestroyWindow(hwnd_);
      return;
    }
    webview_->CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, stream.Get(),
                             Callback<ICoreWebView2CapturePreviewCompletedHandler>([this, stream](HRESULT hr) -> HRESULT {
                               exitCode_ = SUCCEEDED(hr) ? 0 : 3;
                               logLine(L"Captura " + args_.capture + (SUCCEEDED(hr) ? L" guardada" : L" falló"));
                               DestroyWindow(hwnd_);
                               return S_OK;
                             }).Get());
  }

  void onMessage(const json::Value& m) {
    const std::string type = m["type"].asString("");
    if (type == "ready") {
      sendInit();
    } else if (type == "rendered") {
      if (!args_.capture.empty() && !captured_) {
        captured_ = true;
        SetTimer(hwnd_, 1, 900, [](HWND h, UINT, UINT_PTR id, DWORD) {
          KillTimer(h, id);
          auto* self = reinterpret_cast<WebUi*>(GetWindowLongPtrW(h, GWLP_USERDATA));
          if (self) self->capture();
        });
      }
    } else if (type == "drag") {
      ReleaseCapture();
      SendMessageW(hwnd_, WM_NCLBUTTONDOWN, HTCAPTION, 0);
    } else if (type == "minimize") {
      ShowWindow(hwnd_, SW_MINIMIZE);
    } else if (type == "close") {
      if (!busy_) {
        if (!ok_ && exitCode_ == 0) exitCode_ = 2;  // cancelado por el usuario
        DestroyWindow(hwnd_);
      }
    } else if (type == "browse") {
      const std::wstring picked = pickFolder(hwnd_, toWide(m["dir"].asString("")));
      if (!picked.empty()) post(dirInfo(picked));
    } else if (type == "checkDir") {
      post(dirInfo(toWide(m["dir"].asString(""))));
    } else if (type == "install") {
      startWork(true, toWide(m["dir"].asString("")), m["desktop"].asBool(true), false);
    } else if (type == "uninstall") {
      startWork(false, uninstallTarget(args_), false, m["purge"].asBool(false));
    } else if (type == "finish") {
      if (!args_.preview && ok_ && !uninstall_ && m["launch"].asBool(false) && !installDir_.empty()) {
        launchUnelevated(installDir_ + L"\\" + kAppExe, L"", installDir_);
      }
      DestroyWindow(hwnd_);
    } else if (type == "openUrl") {
      const std::wstring url = toWide(m["url"].asString(""));
      if (url.rfind(L"https://vb-audio.com/", 0) == 0 || url.rfind(L"https://tryvoxora.live", 0) == 0 ||
          url.rfind(L"https://developer.microsoft.com/", 0) == 0) {
        openUrl(url);
      }
    } else if (type == "openLog") {
      launchUnelevated(L"notepad.exe", quote(logPath()), L"");
    }
  }

  const Args& args_;
  const Payload& payload_;
  bool uninstall_;
  std::string html_;
  HWND hwnd_ = nullptr;
  ComPtr<ICoreWebView2Controller> controller_;
  ComPtr<ICoreWebView2> webview_;
  std::thread worker_;
  std::atomic<bool> busy_{false};
  std::atomic<bool> ok_{false};
  std::atomic<int> exitCode_{0};
  std::wstring installDir_;
  bool captured_ = false;

 public:
  bool webFailed_ = false;
};

// ── UI mínima (TaskDialog) si falta WebView2 ───────────────────────────────────
struct TaskState {
  std::atomic<double> percent{0};
  std::atomic<bool> done{false};
  std::mutex mutex;
  std::wstring detail;
};

HRESULT CALLBACK progressCallback(HWND hwnd, UINT msg, WPARAM, LPARAM, LONG_PTR ref) {
  auto* st = reinterpret_cast<TaskState*>(ref);
  if (msg == TDN_CREATED) {
    SendMessageW(hwnd, TDM_SET_PROGRESS_BAR_RANGE, 0, MAKELPARAM(0, 1000));
    SendMessageW(hwnd, TDM_ENABLE_BUTTON, IDCANCEL, FALSE);
  } else if (msg == TDN_TIMER) {
    SendMessageW(hwnd, TDM_SET_PROGRESS_BAR_POS, static_cast<WPARAM>(st->percent.load() * 10), 0);
    std::wstring detail;
    {
      std::lock_guard<std::mutex> lock(st->mutex);
      detail = st->detail;
    }
    SendMessageW(hwnd, TDM_SET_ELEMENT_TEXT, TDE_CONTENT, reinterpret_cast<LPARAM>(detail.c_str()));
    if (st->done.load()) SendMessageW(hwnd, TDM_CLICK_BUTTON, IDOK, 0);
  }
  return S_OK;
}

HRESULT CALLBACK linkCallback(HWND, UINT msg, WPARAM, LPARAM lp, LONG_PTR) {
  if (msg == TDN_HYPERLINK_CLICKED) openUrl(reinterpret_cast<const wchar_t*>(lp));
  return S_OK;
}

OpResult runWithProgressDialog(const wchar_t* title, const std::function<OpResult(const Progress&)>& work) {
  TaskState st;
  OpResult result;
  std::thread worker([&] {
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    result = work([&](double pct, const std::string&, const std::wstring& detail) {
      if (pct >= 0) st.percent = pct;
      std::lock_guard<std::mutex> lock(st.mutex);
      st.detail = detail;
    });
    st.done = true;
    CoUninitialize();
  });
  TASKDIALOGCONFIG cfg{};
  cfg.cbSize = sizeof(cfg);
  cfg.hInstance = GetModuleHandleW(nullptr);
  cfg.dwFlags = TDF_SHOW_PROGRESS_BAR | TDF_CALLBACK_TIMER | TDF_USE_HICON_MAIN | TDF_POSITION_RELATIVE_TO_WINDOW;
  cfg.hMainIcon = LoadIconW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(IDI_SETUP));
  cfg.pszWindowTitle = L"VOXORA Meet";
  cfg.pszMainInstruction = title;
  cfg.pszContent = L"Preparando…";
  cfg.dwCommonButtons = TDCBF_CANCEL_BUTTON;
  cfg.pfCallback = progressCallback;
  cfg.lpCallbackData = reinterpret_cast<LONG_PTR>(&st);
  TaskDialogIndirect(&cfg, nullptr, nullptr, nullptr);
  worker.join();
  return result;
}

int fallbackUi(const Args& args, const Payload& payload, bool uninstallMode) {
  const HICON icon = LoadIconW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(IDI_SETUP));
  if (uninstallMode) {
    TASKDIALOGCONFIG cfg{};
    cfg.cbSize = sizeof(cfg);
    cfg.dwFlags = TDF_USE_HICON_MAIN;
    cfg.hMainIcon = icon;
    cfg.pszWindowTitle = L"VOXORA Meet";
    cfg.pszMainInstruction = L"¿Desinstalar VOXORA Meet?";
    cfg.pszContent = L"Se quitarán la aplicación, la cámara virtual y los accesos directos. Tus ajustes y voces grabadas se conservan salvo que marques la casilla.";
    cfg.pszVerificationText = L"Borrar también mis datos (ajustes, API keys cifradas, voces grabadas y registros)";
    const TASKDIALOG_BUTTON buttons[] = {{IDOK, L"Desinstalar"}};
    cfg.pButtons = buttons;
    cfg.cButtons = 1;
    cfg.dwCommonButtons = TDCBF_CANCEL_BUTTON;
    int button = 0;
    BOOL purge = FALSE;
    TaskDialogIndirect(&cfg, &button, nullptr, &purge);
    if (button != IDOK) return 2;
    if (args.preview) return 0;
    const std::wstring dir = uninstallTarget(args);
    const OpResult r = runWithProgressDialog(L"Desinstalando VOXORA Meet", [&](const Progress& p) { return runUninstall(dir, purge != FALSE, p); });
    TaskDialog(nullptr, nullptr, L"VOXORA Meet", r.ok ? L"VOXORA Meet se desinstaló" : L"No se pudo desinstalar",
               r.ok ? L"Gracias por usarlo." : r.error.c_str(), TDCBF_OK_BUTTON, r.ok ? TD_INFORMATION_ICON : TD_ERROR_ICON, nullptr);
    return r.ok ? 0 : 1;
  }

  const std::wstring dir = !args.installDir.empty() ? args.installDir : !installedDir().empty() ? installedDir() : defaultInstallDir();
  const std::wstring content = L"Se instalará en:\n" + dir + L"\n\nAl continuar aceptas la licencia de uso de VOXORA Meet. Tus API keys se guardan cifradas "
                               L"en este equipo; el audio solo se envía a Groq y ElevenLabs mientras doblas.";
  TASKDIALOGCONFIG cfg{};
  cfg.cbSize = sizeof(cfg);
  cfg.dwFlags = TDF_USE_HICON_MAIN;
  cfg.hMainIcon = icon;
  cfg.pszWindowTitle = L"VOXORA Meet";
  cfg.pszMainInstruction = L"Instalar VOXORA Meet " VOXORA_VERSION_WSTR;
  cfg.pszContent = content.c_str();
  cfg.pszVerificationText = L"Crear un acceso directo en el escritorio";
  cfg.dwFlags |= TDF_VERIFICATION_FLAG_CHECKED;
  const TASKDIALOG_BUTTON buttons[] = {{IDOK, L"Instalar"}};
  cfg.pButtons = buttons;
  cfg.cButtons = 1;
  cfg.dwCommonButtons = TDCBF_CANCEL_BUTTON;
  int button = 0;
  BOOL desktop = TRUE;
  TaskDialogIndirect(&cfg, &button, nullptr, &desktop);
  if (button != IDOK) return 2;
  if (args.preview) return 0;
  const OpResult r = runWithProgressDialog(L"Instalando VOXORA Meet", [&](const Progress& p) {
    return runInstall({dir, desktop != FALSE}, payload, p);
  });
  if (!r.ok) {
    TaskDialog(nullptr, nullptr, L"VOXORA Meet", L"No se pudo instalar VOXORA Meet", r.error.c_str(), TDCBF_OK_BUTTON, TD_ERROR_ICON, nullptr);
    return 1;
  }
  std::wstring done = r.cameraMessage;
  if (!r.virtualMic.present) {
    done += L"\n\nFalta el micrófono virtual: para que Meet escuche tu voz doblada instala VB-CABLE (gratis) y reinicia VOXORA Meet. "
            L"<a href=\"https://vb-audio.com/Cable/\">Cómo obtenerlo</a>";
  }
  TASKDIALOGCONFIG fin{};
  fin.cbSize = sizeof(fin);
  fin.dwFlags = TDF_USE_HICON_MAIN | TDF_ENABLE_HYPERLINKS | TDF_VERIFICATION_FLAG_CHECKED;
  fin.hMainIcon = icon;
  fin.pszWindowTitle = L"VOXORA Meet";
  fin.pszMainInstruction = L"VOXORA Meet está listo";
  fin.pszContent = done.c_str();
  fin.pszVerificationText = L"Abrir VOXORA Meet";
  fin.dwCommonButtons = TDCBF_OK_BUTTON;
  fin.pfCallback = linkCallback;
  BOOL launch = TRUE;
  TaskDialogIndirect(&fin, nullptr, nullptr, &launch);
  if (launch) launchUnelevated(normalizeDir(dir) + L"\\" + kAppExe, L"", normalizeDir(dir));
  return 0;
}

// Falta WebView2: ofrecer instalarlo (bootstrapper Evergreen de Microsoft) o seguir con la UI mínima.
bool offerWebView2() {
  TASKDIALOGCONFIG cfg{};
  cfg.cbSize = sizeof(cfg);
  cfg.dwFlags = TDF_USE_HICON_MAIN | TDF_USE_COMMAND_LINKS;
  cfg.hMainIcon = LoadIconW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(IDI_SETUP));
  cfg.pszWindowTitle = L"VOXORA Meet";
  cfg.pszMainInstruction = L"Falta Microsoft Edge WebView2";
  cfg.pszContent = L"VOXORA Meet y su instalador usan el componente WebView2 de Microsoft (ya viene con Windows 11). "
                   L"Se puede instalar ahora desde Microsoft (unos 2 MB, luego descarga el resto).";
  const TASKDIALOG_BUTTON buttons[] = {{100, L"Instalar WebView2 y continuar\nRecomendado"}, {101, L"Seguir con el instalador básico"}};
  cfg.pButtons = buttons;
  cfg.cButtons = 2;
  cfg.dwCommonButtons = TDCBF_CANCEL_BUTTON;
  int button = 0;
  TaskDialogIndirect(&cfg, &button, nullptr, nullptr);
  if (button != 100) return false;
  std::wstring error;
  const OpResult r = runWithProgressDialog(L"Instalando Microsoft Edge WebView2", [&](const Progress& p) {
    p(-1, "webview", L"Descargando e instalando desde Microsoft…");
    OpResult o;
    o.ok = installWebView2(o.error);
    return o;
  });
  if (!r.ok) {
    TaskDialog(nullptr, nullptr, L"VOXORA Meet", L"No se pudo instalar WebView2", (r.error + L"\n\nSe usará el instalador básico.").c_str(),
               TDCBF_OK_BUTTON, TD_WARNING_ICON, nullptr);
  }
  return r.ok;
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  const Args args = parseArgs();
  logInit(args.logFile);
  logLine(L"VoxoraMeetSetup " VOXORA_VERSION_WSTR L" · " + std::wstring(GetCommandLineW()));

  Payload payload;
  std::wstring payloadError;
  const bool hasPayload = loadPayload(payload, payloadError);
  if (!payloadError.empty()) logLine(L"Carga útil: " + payloadError);

  // /extract: solo la carga útil, sin tocar el sistema.
  if (!args.extractDir.empty()) {
    if (!hasPayload) return 4;
    wchar_t full[MAX_PATH * 2];
    GetFullPathNameW(args.extractDir.c_str(), static_cast<DWORD>(std::size(full)), full, nullptr);
    const OpResult r = extractOnly(payload, full, nullptr);
    logLine(r.ok ? L"Extraído en " + std::wstring(full) : L"Error al extraer: " + r.error);
    return r.ok ? 0 : 1;
  }

  const bool uninstallMode = args.uninstall || !hasPayload;
  if (!uninstallMode && !hasPayload) return 4;
  if (!args.preview && !isElevated()) {
    logLine(L"Sin elevación: se relanza con runas");
    return relaunchElevated();
  }
  if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return 1;

  HANDLE single = nullptr;
  if (!args.preview) {
    single = CreateMutexW(nullptr, TRUE, L"Global\\VoxoraMeetSetup");
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
      if (!args.silent) {
        MessageBoxW(nullptr, L"Ya hay un instalador de VOXORA Meet abierto.", L"VOXORA Meet", MB_ICONINFORMATION);
        return 5;
      }
      WaitForSingleObject(single, 120000);  // silencioso: espera a que termine el otro
    }
  }

  if (uninstallMode && !args.preview && !args.fromTemp) {
    const bool ok = continueFromTemp(args);
    logLine(ok ? L"Desinstalación: continúa desde la copia temporal" : L"No se pudo copiar el desinstalador a %TEMP%");
    if (single) CloseHandle(single);
    CoUninitialize();
    return ok ? 0 : 1;
  }

  int code = 0;
  if (args.silent && !args.preview) {
    if (uninstallMode) {
      const OpResult r = runUninstall(uninstallTarget(args), args.purge, nullptr);
      logLine(r.ok ? L"Desinstalación silenciosa completada" : L"Desinstalación silenciosa falló: " + r.error);
      code = r.ok ? 0 : 1;
    } else {
      const std::wstring existing = installedDir();
      const std::wstring dir = !args.installDir.empty() ? args.installDir : !existing.empty() ? existing : defaultInstallDir();
      const bool wasRunning = isAppRunning();
      DWORD desktop = 1, size = sizeof(desktop);
      RegGetValueW(HKEY_LOCAL_MACHINE, kProductKey, L"DesktopShortcut", RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY, nullptr, &desktop, &size);
      const OpResult r = runInstall({dir, desktop != 0}, payload, nullptr);
      logLine(r.ok ? L"Instalación silenciosa completada" : L"Instalación silenciosa falló: " + r.error);
      if (r.ok && (args.relaunch || wasRunning)) {
        const std::wstring d = normalizeDir(dir);
        launchUnelevated(d + L"\\" + kAppExe, L"", d);
      }
      code = r.ok ? 0 : 1;
    }
  } else {
    bool useWeb = !args.fallback;
    if (useWeb && webView2Version().empty()) useWeb = !args.preview && offerWebView2();
    if (useWeb) {
      WebUi ui(args, payload, uninstallMode);
      code = ui.run(instance);
      if (code == -1 || ui.webFailed_) code = fallbackUi(args, payload, uninstallMode);
    } else {
      code = fallbackUi(args, payload, uninstallMode);
    }
  }
  logLine(L"Fin (código " + std::to_wstring(code) + L")");
  if (uninstallMode && args.fromTemp) scheduleSelfDelete();
  if (single) CloseHandle(single);
  CoUninitialize();
  return code;
}
