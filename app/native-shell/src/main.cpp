// VoxoraMeet.exe — shell nativo de VOXORA Meet: ventana Win32 + UI local HTML (WebView2).
//
// Responsabilidades del shell (C++):
//   - Ventana (barra de título oscura + Mica en Windows 11), bandeja e instancia única.
//   - Hospedar la UI de app/ui en WebView2 (https://app.voxora-meet/) y hacer de puente:
//       UI → {type:'engine', id, cmd, params}   → motor Node (JSON-lines por stdio)
//       UI ← {type:'engine-reply', id, ok, result|error} / {type:'engine-event', event, data}
//       UI → {type:'native', id, cmd, params}   → comandos nativos (native.*)
//       UI ← {type:'native-reply', id, ok, result|error} / {type:'native-event', event, data}
//       UI ← {type:'devices', …} (al arrancar, al cambiar dispositivos y a petición)
//       UI ← {type:'engine-state', state, message}
//   - Captura de webcam (Media Foundation) con ring de `delayMs` y publicación en la memoria
//     compartida de la cámara virtual (docs/VIDEO-SYNC.md). Si la webcam desaparece, la cámara
//     virtual pasa a su imagen de espera y se reabre sola al volver.
//   - Detección en caliente de cámaras/micrófonos/salidas (WM_DEVICECHANGE + IMMNotificationClient)
//     con debounce, re-enumeración y reenvío de `devices.list`.
//   - Grabación WASAPI de tomas para clonar la voz y diálogo de importación de audio.
//
// El audio (mic → pipeline → SyncBuffer → mic virtual) vive íntegro en el motor.

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <dwmapi.h>
#include <objbase.h>
#include <shellapi.h>
#include <shlobj.h>

#include <algorithm>
#include <atomic>
#include <cwctype>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "audio_capture.h"
#include "camera_capture.h"
#include "device_watcher.h"
#include "engine_client.h"
#include "json.h"
#include "native_dialogs.h"
#include "serial_worker.h"
#include "settings.h"
#include "test_recording.h"  // «Grabar prueba» (MP4 con lo que recibe Meet)
#include "vcam_host.h"
#include "webview_host.h"
#include "logger.h"          // registro a archivo + minidump (docs/RELEASE.md)
#include "updater.h"         // actualizaciones desde S3 de MEGA
#include "voxora_version.h"  // versión única (package.json raíz)

#pragma comment(linker, "\"/manifestdependency:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'\"")

using namespace voxora;

namespace {

// ── Constantes ──────────────────────────────────────────────────────────────
constexpr wchar_t kAppVersion[] = VOXORA_VERSION_WSTR;
constexpr wchar_t kWindowClass[] = L"VoxoraMeetMain";
constexpr wchar_t kWebView2Download[] = L"https://developer.microsoft.com/microsoft-edge/webview2/";
constexpr int IDI_APP = 101;

constexpr UINT WM_APP_TASK = WM_APP + 1;
constexpr UINT WM_APP_TRAY = WM_APP + 2;
constexpr UINT WM_APP_AUDIO_ENDPOINTS = WM_APP + 3;
constexpr UINT_PTR TIMER_DEVICES = 1;       // debounce de cambios de dispositivos
constexpr UINT_PTR TIMER_RECORDER = 2;      // nivel en vivo de la grabación de voz
constexpr UINT_PTR TIMER_CAMERA = 3;        // cámara virtual: host, consumidores y estado (cada 500 ms)
constexpr UINT_PTR TIMER_ENGINE_RESTART = 41;  // relanzamiento automático del motor tras una caída
constexpr UINT kCameraTickMs = 500;
constexpr UINT kDeviceDebounceMs = 600;
constexpr int TRAY_ICON_ID = 1;
constexpr int IDM_TRAY_SHOW = 1001;
constexpr int IDM_TRAY_SESSION = 1002;
constexpr int IDM_TRAY_QUIT = 1003;
constexpr int kMaxTakeSeconds = 100;        // máximo por toma (≤10 MiB en WAV 48 kHz; total recomendado 2–3 min)
constexpr int kMinClientW = 960, kMinClientH = 640;
constexpr int kInitClientW = 1200, kInitClientH = 780;
const COLORREF kCanvas = RGB(247, 245, 255);  // --canvas del design system VØXORA (#F7F5FF)
const COLORREF kInk = RGB(13, 8, 22);          // --ink-black (#0D0816)

// ── Estado global (solo hilo de UI salvo lo indicado) ───────────────────────
struct UiTask { std::function<void()> fn; };

enum class CamState { Off, Starting, Live, Lost, Error };
enum class RecState { Idle, Starting, Recording };

HWND g_hwnd = nullptr;
HINSTANCE g_instance = nullptr;
HICON g_iconBig = nullptr, g_iconSmall = nullptr;
EngineClient g_engine;
CameraCapture g_camera;       // se opera solo desde g_cameraWorker (stats/setDelayMs/activeLink son seguros)
VcamHost g_vcamHost;          // ídem (alive/ready/exitCode son seguros desde la UI)
VoiceRecorder g_recorder;
Settings g_settings;
WebViewHost g_web;
DeviceWatcher g_watcher;
SerialWorker g_cameraWorker;  // abrir/cerrar webcam (puede tardar segundos)
SerialWorker g_enumWorker;    // enumeración de dispositivos
SerialWorker g_audioWorker;   // arranque de grabación y medición de archivos
std::wstring g_exeDir, g_engineScript, g_vcamHostPath, g_uiDir, g_webDataDir;
std::string g_engineState = "stopped";  // starting | ready | exited | failed
std::string g_engineMessage;
bool g_sessionRunning = false;
bool g_quitting = false;
bool g_trayHintShown = false;
bool g_webRecreated = false;
// Instante (ms QPC) en que se lanzó node: aproxima el origen de performance.now() del motor para
// convertir la llegada de cada evento a su reloj (latencia por turno en la UI). Hilo lector + UI.
std::atomic<double> g_engineLaunchMs{0};
double g_engineReadySinceMs = 0;  // instante (QPC) del último `ready` del motor (0 = no está listo)

std::vector<CameraDevice> g_cams;
std::vector<AudioDevice> g_mics, g_renders;
bool g_devicesKnown = false;
bool g_devicesInFlight = false;
bool g_devicesPending = false;
std::string g_devicesPendingReason;

CamState g_camState = CamState::Off;
std::wstring g_camName;
std::wstring g_camMessage;        // último mensaje enviado con el estado de la cámara
bool g_hostActive = false;        // se pidió que el host de la cámara virtual esté vivo
bool g_hostUp = false;            // último estado visto: host vivo y READY ("VOXORA Meet Camera" existe)
std::atomic<bool> g_hostStarting{false};  // start() del host encolado o en curso en g_cameraWorker
double g_hostUpSinceMs = 0;
double g_hostRetryAtMs = 0;       // relanzar el host a partir de este instante (0 = no programado)
int g_hostFailures = 0;
std::wstring g_hostMessage;       // por qué no está la cámara virtual (vacío si está bien)
bool g_captureActive = false;     // la captura de webcam está pedida (start encolado y sin stop)
// Retraso de video vigente: el hilo de la cámara lo relee tras start().
std::atomic<int> g_videoDelayMs{0};
bool g_micLost = false;
// Imagen de la cámara: instante (ms QPC) del último `native.camera.effects`. Mientras la UI arrastra un
// control, las respuestas de settings.set (con debounce, ya viejas) no pisan lo aplicado en vivo.
double g_cameraFxLiveAtMs = 0;
TestRecordingController g_testRecording;
std::wstring g_virtualMicCapture;  // captureName del mic virtual (último devices)

RecState g_recState = RecState::Idle;
std::wstring g_recPath;

void refreshDevices(const std::string& reason);

// ── Utilidades ──────────────────────────────────────────────────────────────
void runOnUi(std::function<void()> fn) {
  if (!g_hwnd) return;
  auto* task = new UiTask{std::move(fn)};
  if (!PostMessageW(g_hwnd, WM_APP_TASK, 0, reinterpret_cast<LPARAM>(task))) delete task;
}

void engineCall(const std::string& cmd, const json::Value& params, std::function<void(bool, const json::Value&)> cb) {
  g_engine.call(cmd, params, [cb = std::move(cb)](bool ok, const json::Value& v) {
    if (cb) runOnUi([cb, ok, v] { cb(ok, v); });
  });
}

json::Value obj() { return json::Value(json::Object{}); }
json::Value arr() { return json::Value(json::Array{}); }

json::Value errorValue(const std::string& code, const std::string& message) {
  json::Value e;
  e.set("code", code).set("message", message);
  return e;
}

void postToUi(const json::Value& msg) {
  if (g_web.ready()) g_web.postJson(utf8ToWide(msg.dump()));
}

void sendEvent(const std::string& event, const json::Value& data) {
  json::Value msg;
  msg.set("type", "native-event").set("event", event).set("data", data);
  postToUi(msg);
}

void replyNative(const json::Value& id, bool ok, const json::Value& payload) {
  json::Value msg;
  msg.set("type", "native-reply").set("id", id).set("ok", ok).set(ok ? "result" : "error", payload);
  postToUi(msg);
}

std::wstring exeDirectory() {
  wchar_t buf[MAX_PATH];
  GetModuleFileNameW(nullptr, buf, MAX_PATH);
  std::wstring path = buf;
  size_t slash = path.find_last_of(L"\\/");
  return slash == std::wstring::npos ? L"." : path.substr(0, slash);
}

std::wstring fullPath(const std::wstring& path) {
  wchar_t buf[MAX_PATH * 2];
  DWORD n = GetFullPathNameW(path.c_str(), static_cast<DWORD>(std::size(buf)), buf, nullptr);
  return n > 0 && n < std::size(buf) ? std::wstring(buf) : path;
}

bool fileExists(const std::wstring& path) {
  DWORD attrs = GetFileAttributesW(path.c_str());
  return attrs != INVALID_FILE_ATTRIBUTES && !(attrs & FILE_ATTRIBUTE_DIRECTORY);
}

std::wstring firstExisting(const std::vector<std::wstring>& candidates) {
  for (const auto& c : candidates) if (!c.empty() && fileExists(c)) return fullPath(c);
  return L"";
}

std::wstring localAppDataDir() {
  PWSTR base = nullptr;
  std::wstring dir;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &base)) && base) {
    dir = base;
    CoTaskMemFree(base);
  } else {
    wchar_t buf[MAX_PATH];
    dir = GetEnvironmentVariableW(L"LOCALAPPDATA", buf, MAX_PATH) ? buf : L".";
  }
  dir += L"\\VOXORA Meet";
  CreateDirectoryW(dir.c_str(), nullptr);
  return dir;
}

std::wstring findNode() {
  std::wstring found = firstExisting({
      utf8ToWide(g_settings.nodePath),
      g_exeDir + L"\\node\\node.exe",  // node portable empaquetado junto al exe
      g_exeDir + L"\\node.exe",
  });
  if (!found.empty()) return found;
  wchar_t buf[MAX_PATH];
  wchar_t* file = nullptr;
  if (SearchPathW(nullptr, L"node.exe", nullptr, MAX_PATH, buf, &file) > 0) return buf;
  return L"";
}

bool containsNoCase(const std::wstring& haystack, const std::wstring& needle) {
  if (needle.empty()) return false;
  auto it = std::search(haystack.begin(), haystack.end(), needle.begin(), needle.end(),
                        [](wchar_t a, wchar_t b) { return towlower(a) == towlower(b); });
  return it != haystack.end();
}

std::wstring cameraName(const std::wstring& link) {
  for (const auto& c : g_cams) if (c.symbolicLink == link) return c.name;
  return L"";
}

double qpcNowMs() {
  static const double freq = [] {
    LARGE_INTEGER f;
    QueryPerformanceFrequency(&f);
    return static_cast<double>(f.QuadPart);
  }();
  LARGE_INTEGER now;
  QueryPerformanceCounter(&now);
  return static_cast<double>(now.QuadPart) * 1000.0 / freq;
}

UINT windowDpi() { return g_hwnd ? GetDpiForWindow(g_hwnd) : GetDpiForSystem(); }
int scaled(int px, UINT dpi) { return MulDiv(px, static_cast<int>(dpi), 96); }

// ── Estado del motor ────────────────────────────────────────────────────────
void setEngineState(const std::string& state, const std::string& message = "") {
  g_engineState = state;
  g_engineMessage = message;
  json::Value msg;
  msg.set("type", "engine-state").set("state", state).set("message", message);
  postToUi(msg);
}

// ── Cámara virtual ──────────────────────────────────────────────────────────
// Con `cameraAlwaysOn` (por defecto), mientras la app esté abierta el host de la cámara virtual vive
// («VOXORA Meet Camera» existe siempre para Meet) y la webcam configurada se publica en vivo, sin
// retraso. Al iniciar la sesión de doblaje el video pasa a `delayMs` (el mismo que el audio) sin cortar
// la cámara, y al detenerla vuelve a 0. Sin `cameraAlwaysOn`: host + captura solo durante la sesión
// (comportamiento anterior). Se mantienen la detección en caliente, la imagen de espera si se pierde la
// webcam y los reintentos (webcam cada 10 s; host con espera creciente).
//
// Nota: no se puede encender la webcam "solo cuando Meet mira": la DLL crea (y retiene) la memoria
// compartida en cuanto el FrameServer instancia la fuente al arrancar el host, haya o no consumidores.
const char* camStateName(CamState s) {
  switch (s) {
    case CamState::Starting: return "starting";
    case CamState::Live: return "live";
    case CamState::Lost: return "lost";
    case CamState::Error: return "error";
    default: return "off";
  }
}

int videoDelayMs() { return g_sessionRunning ? g_settings.delayMs : 0; }

// Estado que ve Meet: el del host mientras la cámara virtual no existe (arrancando o caída) y, si
// existe, el de la webcam (g_camState).
CamState reportedCamState() {
  if (!g_hostActive && !g_captureActive) return CamState::Off;
  if (g_hostActive && !g_hostUp) return g_hostMessage.empty() ? CamState::Starting : CamState::Error;
  return g_captureActive ? g_camState : CamState::Off;
}

std::wstring reportedCamMessage() {
  if (g_hostActive && !g_hostUp && !g_hostMessage.empty()) return g_hostMessage;
  return g_camMessage;
}

const char* camModeName() {
  if (reportedCamState() == CamState::Off) return "off";
  return g_sessionRunning && g_captureActive ? "dubbing" : "live";
}

json::Value cameraJson() {
  json::Value data;
  data.set("state", camStateName(reportedCamState())).set("name", wideToUtf8(g_camName))
      .set("message", wideToUtf8(reportedCamMessage())).set("mode", camModeName())
      .set("delayMs", g_captureActive ? videoDelayMs() : 0).set("alwaysOn", g_settings.cameraAlwaysOn)
      .set("hostRunning", g_hostUp);
  return data;
}

std::string g_camSignature;  // último estado enviado (para no repetir eventos idénticos)

void sendCameraState(const std::wstring& message = L"") {
  g_camMessage = message;
  const json::Value data = cameraJson();
  g_camSignature = data.dump();
  sendEvent("camera", data);
}

// Reenvía el estado si cambió algo derivado (modo, retraso, host) sin cambiar el mensaje.
void notifyCameraIfChanged() {
  if (cameraJson().dump() != g_camSignature) sendCameraState(g_camMessage);
}

// Retraso vigente del video (0 fuera de sesión). El hilo de la cámara lo relee tras abrir la webcam:
// el último valor que fije la UI manda.
void applyVideoMode() {
  g_videoDelayMs.store(videoDelayMs());
  g_camera.setDelayMs(g_videoDelayMs.load());
}

bool desiredHost() {
  return !g_quitting && !g_vcamHostPath.empty() && (g_sessionRunning || g_settings.cameraAlwaysOn);
}

void startHostAsync() {
  g_hostActive = true;
  g_hostRetryAtMs = 0;
  g_hostStarting.store(true);
  g_cameraWorker.post([] {
    std::wstring error;
    if (!g_vcamHost.start(g_vcamHostPath, error)) OutputDebugStringW((L"[vcam-host] " + error + L"\n").c_str());
    g_hostStarting.store(false);
  });
}

void stopHostAsync() {
  g_hostActive = false;
  g_hostUp = false;
  g_hostRetryAtMs = 0;
  g_hostMessage.clear();
  g_cameraWorker.post([] { g_vcamHost.stop(); });
}

// Cada apertura/parada de la captura incrementa la generación: el resultado de una apertura que ya
// quedó obsoleta (se paró o se volvió a abrir entretanto) no toca el estado.
unsigned g_captureGen = 0;

void stopCaptureAsync() {
  if (!g_captureActive) return;
  g_captureActive = false;
  ++g_captureGen;
  g_cameraWorker.post([] { g_camera.stop(); });
}

// Abre (o reabre) la webcam configurada. Si la captura ya está en marcha solo se reabre la fuente (la
// cámara virtual no se corta). `silent`: reintento periódico en segundo plano; solo avisa si vuelve.
bool g_cameraRetryInFlight = false;
int g_cameraTicks = 0;

void openCameraAsync(bool restoring, bool silent = false) {
  const std::wstring link = utf8ToWide(g_settings.cameraDeviceId);
  const CamState before = g_camState;
  const unsigned gen = ++g_captureGen;
  g_captureActive = true;
  applyVideoMode();
  if (silent) {
    g_cameraRetryInFlight = true;
  } else {
    g_camState = CamState::Starting;
    sendCameraState();
  }
  g_cameraWorker.post([link, restoring, silent, before, gen] {
    std::wstring error;
    const bool ok = g_camera.running() ? g_camera.restartSource(link, error)
                                       : g_camera.start(link, g_videoDelayMs.load(), error);
    g_camera.setDelayMs(g_videoDelayMs.load());
    const std::wstring active = g_camera.activeLink();
    runOnUi([ok, error, active, restoring, silent, before, gen] {
      if (silent) g_cameraRetryInFlight = false;
      if (!g_captureActive || gen != g_captureGen) return;  // se paró o se reabrió mientras tanto
      if (silent && g_camState != before) return;  // otro flujo tomó el control entretanto
      if (ok) {
        g_camName = cameraName(active);
        g_camState = CamState::Live;
        sendCameraState(restoring ? L"La cámara volvió; Meet vuelve a recibir tu video." : L"");
      } else if (!silent) {
        g_camName = cameraName(active);
        g_camState = CamState::Error;
        sendCameraState(error + L". Mientras tanto Meet verá la imagen de espera de VOXORA.");
      }
    });
  });
}

// Lleva host y captura al estado deseado según sesión y ajuste. Idempotente: se llama al cambiar la
// sesión o los ajustes y en cada tick de la cámara.
void reconcileCamera() {
  if (!g_hwnd) return;
  applyVideoMode();
  g_camera.setEffects(g_settings.cameraEffects());  // en caliente; no hace nada si no cambió
  const bool want = desiredHost();  // host y captura van juntos
  if (want && !g_hostActive) startHostAsync();
  else if (!want && g_hostActive) stopHostAsync();
  if (want && !g_captureActive) {
    openCameraAsync(false);
  } else if (!want && g_captureActive) {
    stopCaptureAsync();
    g_camState = CamState::Off;
    g_camName.clear();
    g_camMessage.clear();
  }
  if (g_hostActive || g_captureActive) SetTimer(g_hwnd, TIMER_CAMERA, kCameraTickMs, nullptr);
  else KillTimer(g_hwnd, TIMER_CAMERA);
  notifyCameraIfChanged();
}

std::wstring hostFailureMessage(DWORD code) {
  switch (code) {
    case 4: return L"Este Windows no admite cámaras virtuales (hace falta Windows 10 2004 o superior).";
    case 5: return L"Windows no pudo crear la cámara virtual: VOXORA Meet Camera no está registrada o su DLL no es "
                   L"accesible. Reinstala VOXORA Meet.";
    case 6: return L"La cámara virtual no pudo arrancar. Revisa que el servicio «Windows Camera Frame Server» no "
                   L"esté deshabilitado.";
    case STILL_ACTIVE: return L"No se pudo lanzar la cámara virtual (VoxoraMeetVCamHost.exe). Reintentando…";
    default: return L"La cámara virtual se cerró inesperadamente (código " + std::to_wstring(code) + L"). Reintentando…";
  }
}

// Host vivo/READY; si murió se relanza con espera creciente (2, 5, 10, 30 s).
void superviseHost() {
  if (!g_hostActive) return;
  const double now = qpcNowMs();
  const bool alive = g_vcamHost.alive();
  const bool up = alive && g_vcamHost.ready();
  if (up && !g_hostUp) {
    g_hostUpSinceMs = now;
    g_hostMessage.clear();
  }
  if (up) g_hostRetryAtMs = 0;
  if (up && g_hostFailures && now - g_hostUpSinceMs > 30000) g_hostFailures = 0;
  g_hostUp = up;
  if (alive || g_hostStarting.load()) return;
  if (g_hostRetryAtMs == 0) {
    const DWORD code = g_vcamHost.exitCode();
    g_hostMessage = hostFailureMessage(code);
    const std::string detail = g_vcamHost.lastErrorLine();
    OutputDebugStringA(("[vcam-host] terminó con código " + std::to_string(code) + (detail.empty() ? "" : ": " + detail) + "\n").c_str());
    if (code == 4) {
      g_hostRetryAtMs = -1;  // no soportado: no tiene sentido reintentar
    } else {
      static const double kBackoffMs[] = {2000, 5000, 10000, 30000};
      g_hostRetryAtMs = now + kBackoffMs[std::min(g_hostFailures, 3)];
      g_hostFailures++;
    }
  } else if (g_hostRetryAtMs > 0 && now >= g_hostRetryAtMs) {
    startHostAsync();
  }
}

void sendCameraStats(const CameraCapture::Stats& s) {
  json::Value data;
  data.set("width", s.width).set("height", s.height).set("fps", s.captureFps).set("queuedFrames", s.queuedFrames)
      .set("presentationErrorMs", s.presentationErrorMs).set("presentationMisses", static_cast<double>(s.presentationMisses))
      .set("delayMs", g_captureActive ? s.delayMs : 0).set("published", static_cast<double>(s.published))
      .set("sourceLost", s.sourceLost).set("vcamHostRunning", g_hostUp).set("sharedMemoryOk", s.sharedMemoryOk)
      .set("state", camStateName(reportedCamState())).set("mode", camModeName())
      .set("outputWidth", s.outputWidth).set("outputHeight", s.outputHeight)
      .set("effectsMs", std::round(s.effectsMs * 100) / 100).set("effectsPeakMs", std::round(s.effectsPeakMs * 100) / 100)
      .set("recording", g_testRecording.recording());
  sendEvent("camera.stats", data);
}

void onCameraTick() {
  if (!g_hostActive && !g_captureActive) {
    KillTimer(g_hwnd, TIMER_CAMERA);
    return;
  }
  ++g_cameraTicks;
  superviseHost();

  if (g_captureActive) {
    const CameraCapture::Stats s = g_camera.stats();
    if (g_camState == CamState::Live && s.sourceLost) {
      g_camState = CamState::Lost;
      sendCameraState(L"Se perdió la señal de " + (g_camName.empty() ? std::wstring(L"la cámara") : g_camName) +
                      L". Meet verá la imagen de espera hasta que vuelva.");
    } else if ((g_camState == CamState::Lost || g_camState == CamState::Error) && !s.sourceLost && s.width > 0) {
      // La webcam terminó de abrir tarde (p. ej. tras un «tardó demasiado»): ya entrega frames.
      g_camState = CamState::Live;
      sendCameraState(L"La cámara volvió; Meet vuelve a recibir tu video.");
    } else if ((g_camState == CamState::Lost || g_camState == CamState::Error) && !g_cameraRetryInFlight &&
               g_cameraTicks % 20 == 0) {
      // Cámara ocupada por otra app o fallo transitorio sin evento de dispositivo: reintento cada 10 s.
      const std::wstring wanted = utf8ToWide(g_settings.cameraDeviceId);
      if (wanted.empty() ? !g_cams.empty() : !cameraName(wanted).empty()) openCameraAsync(true, true);
    }
  }
  reconcileCamera();
  if (g_cameraTicks % 2 == 0) sendCameraStats(g_camera.stats());
}

// ── Dispositivos ────────────────────────────────────────────────────────────
void reconcileSessionDevices() {
  // Cámara (en sesión o en vivo fuera de ella): ¿desapareció la que está en uso? ¿volvió la perdida?
  if (g_captureActive) {
    const std::wstring wanted = utf8ToWide(g_settings.cameraDeviceId);
    const bool wantedPresent = wanted.empty() ? !g_cams.empty() : !cameraName(wanted).empty();
    if (g_camState == CamState::Live) {
      const std::wstring active = g_camera.activeLink();
      const bool activePresent = active.empty() || !cameraName(active).empty();
      if (!activePresent) {
        g_camState = CamState::Lost;
        sendCameraState(L"Se desconectó " + (g_camName.empty() ? std::wstring(L"la cámara") : g_camName) +
                        L". Meet verá la imagen de espera hasta que vuelva a conectarse.");
        g_cameraWorker.post([] { g_camera.markSourceLost(); });
      }
    } else if ((g_camState == CamState::Lost || g_camState == CamState::Error) && wantedPresent) {
      openCameraAsync(true);
    }
  }
  if (!g_sessionRunning) return;
  // Micrófono: lo gestiona el motor; aquí solo se avisa.
  if (!g_settings.micDeviceId.empty()) {
    const std::wstring micId = utf8ToWide(g_settings.micDeviceId);
    const bool present = std::any_of(g_mics.begin(), g_mics.end(), [&](const AudioDevice& d) { return d.id == micId; });
    if (!present && !g_micLost) {
      g_micLost = true;
      json::Value data;
      data.set("kind", "mic");
      sendEvent("device-lost", data);
    } else if (present && g_micLost) {
      g_micLost = false;
      json::Value data;
      data.set("kind", "mic");
      sendEvent("device-restored", data);
    }
  }
}

// Candidato a salida del doblaje cuando el motor no lo resolvió (motor sin protocolo v2).
json::Value fallbackVirtualMic() {
  json::Value vm;
  std::wstring resolved, capture;
  for (const wchar_t* candidate : {L"VOXORA Meet Speaker", L"CABLE Input"}) {
    for (const auto& r : g_renders) {
      if (containsNoCase(r.name, candidate)) {
        resolved = r.name;
        capture = wcscmp(candidate, L"CABLE Input") == 0 ? L"CABLE Output" : L"VOXORA Meet Microphone";
        break;
      }
    }
    if (!resolved.empty()) break;
  }
  json::Value candidates = arr();
  candidates.push("VOXORA Meet Speaker").push("CABLE Input");
  vm.set("installed", !resolved.empty()).set("device", g_settings.virtualMicDevice)
      .set("resolvedDevice", resolved.empty() ? json::Value() : json::Value(wideToUtf8(resolved)))
      .set("captureName", capture.empty() ? json::Value() : json::Value(wideToUtf8(capture)))
      .set("candidates", candidates);
  return vm;
}

void finishDevices(const std::string& reason, const json::Value* engine) {
  json::Value msg;
  msg.set("type", "devices").set("reason", reason).set("engine", engine != nullptr);

  json::Value cams = arr();
  for (const auto& c : g_cams) {
    json::Value v;
    v.set("id", wideToUtf8(c.symbolicLink)).set("name", wideToUtf8(c.name));
    cams.push(v);
  }
  msg.set("cameras", cams);

  json::Value mics = arr();
  for (const auto& m : g_mics) {
    json::Value v;
    v.set("id", wideToUtf8(m.id)).set("name", wideToUtf8(m.name)).set("default", m.isDefault);
    mics.push(v);
  }
  if (mics.asArray().empty() && engine) {
    for (const auto& m : (*engine)["capture"]["mics"].asArray()) {
      const std::string& name = m["name"].asString();
      if (name.find("VOXORA Meet") != std::string::npos || name.rfind("CABLE Output", 0) == 0) continue;
      mics.push(m);
    }
  }
  msg.set("mics", mics);

  json::Value renders = arr();
  if (engine && !(*engine)["renderEndpoints"].asArray().empty()) {
    renders = (*engine)["renderEndpoints"];
  } else {
    for (const auto& r : g_renders) {
      json::Value v;
      v.set("id", wideToUtf8(r.id)).set("name", wideToUtf8(r.name)).set("isDefault", r.isDefault);
      renders.push(v);
    }
  }
  msg.set("renderEndpoints", renders);

  json::Value vmic = fallbackVirtualMic();
  if (engine && (*engine)["virtualMic"].isObject()) {
    // Lo que diga el motor manda; se completan solo los campos que falten.
    json::Value merged = (*engine)["virtualMic"];
    for (const auto& [k, v] : vmic.asObject()) if (!merged.has(k)) merged.set(k, v);
    vmic = merged;
  }
  msg.set("virtualMic", vmic);
  g_virtualMicCapture = utf8ToWide(vmic["captureName"].asString(""));  // lo que graba «Grabar prueba»

  json::Value vcam;
  const bool vcamInstalled = (engine && (*engine)["virtualCamera"]["installed"].asBool()) || fileExists(g_vcamHostPath);
  vcam.set("installed", vcamInstalled);
  msg.set("virtualCamera", vcam);
  if (engine) {
    msg.set("capture", (*engine)["capture"].isObject() ? (*engine)["capture"] : obj());
    msg.set("pipeline", (*engine)["pipeline"].isObject() ? (*engine)["pipeline"] : obj());
  }
  postToUi(msg);
  reconcileSessionDevices();

  g_devicesInFlight = false;
  if (g_devicesPending) {
    g_devicesPending = false;
    const std::string next = g_devicesPendingReason;
    runOnUi([next] { refreshDevices(next); });
  }
}

// Re-enumera cámaras (MF), micrófonos y salidas (MMDevice) fuera del hilo de UI y, si el motor está
// listo, pide `devices.list` para completar el estado del mic virtual. Coalesce peticiones.
void refreshDevices(const std::string& reason) {
  if (g_devicesInFlight) {
    g_devicesPending = true;
    g_devicesPendingReason = reason;
    return;
  }
  g_devicesInFlight = true;
  g_enumWorker.post([reason] {
    auto cams = enumerateCameras();
    auto mics = enumerateMicrophones();
    auto renders = enumerateRenderEndpoints();
    runOnUi([reason, cams = std::move(cams), mics = std::move(mics), renders = std::move(renders)]() mutable {
      g_cams = std::move(cams);
      g_mics = std::move(mics);
      g_renders = std::move(renders);
      g_devicesKnown = true;
      if (g_engineState == "ready" && g_engine.running()) {
        engineCall("devices.list", json::Value(), [reason](bool ok, const json::Value& r) { finishDevices(reason, ok ? &r : nullptr); });
      } else {
        finishDevices(reason, nullptr);
      }
    });
  });
}

void scheduleDeviceRefresh() {
  if (g_hwnd) SetTimer(g_hwnd, TIMER_DEVICES, kDeviceDebounceMs, nullptr);
}

// ── Motor ───────────────────────────────────────────────────────────────────
void onEngineEvent(const std::string& event, const json::Value& data, double engineNowMs) {
  if (event == "presentation" && g_sessionRunning) {
    const double rate = data["sourceRate"].asNumber(1);
    const double transit = std::max(0.0, qpcNowMs() - g_engineLaunchMs.load() - engineNowMs);
    g_camera.setAudioPresentation(data["sourceAgeMs"].asNumber() + transit * (1 - rate), rate,
        std::max(1.0, data["validForMs"].asNumber(300) - transit));
    return;
  }
  if (event == "log") {
    OutputDebugStringA(("[engine] " + data.dump() + "\n").c_str());
    return;
  }
  if (event == "ready") {
    g_engineReadySinceMs = qpcNowMs();  // estable tras 60 s → se reinicia la cuenta de caídas
    setEngineState("ready");
    // Copia local de los ajustes (cámara, delay, mic) y primera lista de dispositivos.
    engineCall("settings.get", json::Value(), [](bool ok, const json::Value& r) {
      if (ok) g_settings = Settings::fromJson(r["settings"]);
      reconcileCamera();
      refreshDevices("startup");
    });
  } else if (event == "status") {
    const std::string state = data["state"].asString();
    if (state == "running" && !g_sessionRunning) {
      g_sessionRunning = true;
      reconcileCamera();
    }
    if (state == "idle" && g_sessionRunning) {
      g_sessionRunning = false;
      reconcileCamera();  // el video vuelve a 0 (o se apaga si la cámara no debe quedar activa)
    }
  }
  json::Value msg;
  msg.set("type", "engine-event").set("event", event).set("data", data).set("engineNowMs", engineNowMs);
  postToUi(msg);
}

// Relanzamiento automático: si el motor muere sin que el shell lo pida, se relanza con espera
// creciente (1, 3, 10, 30, 60 s) y se avisa a la UI (engine-state + evento nativo `engine.restarting`).
// Tras 5 caídas seguidas (sin 60 s estables entre medias) se deja de insistir y queda el botón manual.
int g_engineCrashes = 0;
void startEngine();

void onEngineCrashed(DWORD code) {
  logging::error("[engine] el motor terminó inesperadamente (código " + std::to_string(code) + ")");
  if (g_sessionRunning) {
    g_sessionRunning = false;
    reconcileCamera();
  }
  if (g_quitting || !g_hwnd) return;
  if (g_engineReadySinceMs > 0 && qpcNowMs() - g_engineReadySinceMs > 60000) g_engineCrashes = 0;
  g_engineReadySinceMs = 0;
  static const UINT kBackoffMs[] = {1000, 3000, 10000, 30000, 60000};
  if (g_engineCrashes >= static_cast<int>(std::size(kBackoffMs))) {
    setEngineState("exited", "El motor de doblaje se detuvo varias veces seguidas (código " + std::to_string(code) +
                                 "). Pulsa «Reiniciar motor» para volver a intentarlo; el detalle queda en la carpeta de registros.");
    return;
  }
  const UINT delay = kBackoffMs[g_engineCrashes++];
  setEngineState("exited", "El motor de doblaje se detuvo inesperadamente (código " + std::to_string(code) +
                               "). Se reinicia solo en " + std::to_string(delay / 1000) + " s…");
  json::Value data;
  data.set("attempt", g_engineCrashes).set("delayMs", static_cast<int>(delay)).set("code", static_cast<double>(code));
  sendEvent("engine.restarting", data);
  SetTimer(g_hwnd, TIMER_ENGINE_RESTART, delay, nullptr);
}

void startEngine() {
  g_engine.onEvent([](const std::string& event, const json::Value& data) {
    const double engineNowMs = qpcNowMs() - g_engineLaunchMs.load();  // sellado en el hilo lector
    runOnUi([event, data, engineNowMs] { onEngineEvent(event, data, engineNowMs); });
  });
  g_engine.onLog([](const std::string& line) { OutputDebugStringA((line + "\n").c_str()); });
  g_engine.onExit([](DWORD code) { runOnUi([code] { onEngineCrashed(code); }); });
  const std::wstring node = findNode();
  if (node.empty()) {
    setEngineState("failed", "No se encontró Node.js. Copia node.exe en " + wideToUtf8(g_exeDir) +
                                 "\\node\\ o instala Node 22 o superior.");
    return;
  }
  if (g_engineScript.empty()) {
    setEngineState("failed", "No se encontró el motor (engine\\engine.mjs) junto a la aplicación. Reinstala VOXORA Meet.");
    return;
  }
  setEngineState("starting");
  g_engineLaunchMs.store(qpcNowMs());
  std::wstring error;
  if (!g_engine.start(node, g_engineScript, dataDir(), error)) {
    OutputDebugStringW((L"[engine] " + error + L"\n").c_str());
    setEngineState("failed", "No se pudo iniciar el motor de doblaje. Comprueba que Node.js funciona en este equipo.");
  }
}

void restartEngine() {
  g_engineCrashes = 0;  // reinicio manual: vuelve a haber reintentos automáticos
  if (g_hwnd) KillTimer(g_hwnd, TIMER_ENGINE_RESTART);
  if (g_sessionRunning) {
    g_sessionRunning = false;
    reconcileCamera();
  }
  g_engine.stop();
  startEngine();
}

// Efectos del shell sobre las respuestas del motor que atraviesan el puente.
void afterEngineReply(const std::string& cmd, const json::Value& params, bool ok, const json::Value& result) {
  if (!ok) return;
  if (cmd == "settings.get" || cmd == "settings.set") {
    if (result["settings"].isObject()) {
      const std::string previousCamera = g_settings.cameraDeviceId;
      const json::Value liveFx = g_settings.cameraEffectsJson();
      g_settings = Settings::fromJson(result["settings"]);
      // Imagen de la cámara en vivo desde la UI (native.camera.effects): manda sobre la respuesta vieja.
      if (qpcNowMs() - g_cameraFxLiveAtMs < 1500) g_settings.mergeCameraEffects(liveFx);
      // Cambio de webcam con la captura en marcha: se cambia la fuente sin cortar la cámara virtual.
      if (g_captureActive && g_settings.cameraDeviceId != previousCamera) openCameraAsync(false);
      reconcileCamera();  // retraso vigente y `cameraAlwaysOn` (encender/apagar la cámara virtual)
    }
  } else if (cmd == "delay.set") {
    g_settings.delayMs = std::clamp(result["delayMs"].asInt(g_settings.delayMs), 2000, 6000);
    applyVideoMode();
    notifyCameraIfChanged();
  } else if (cmd == "session.start") {
    const json::Value& overrides = params["settings"];
    const std::string previousCamera = g_settings.cameraDeviceId;
    if (overrides["cameraDeviceId"].isString()) g_settings.cameraDeviceId = overrides["cameraDeviceId"].asString();
    if (overrides["delayMs"].isNumber()) g_settings.delayMs = std::clamp(overrides["delayMs"].asInt(), 2000, 6000);
    g_sessionRunning = true;
    g_micLost = false;
    if (g_captureActive && g_settings.cameraDeviceId != previousCamera) openCameraAsync(false);
    // Si la cámara ya estaba en vivo (fuera de sesión) no se corta: solo pasa a `delayMs`.
    reconcileCamera();
  } else if (cmd == "voice.set" || cmd == "voice.clone") {
    g_settings.voiceId = result["voiceId"].asString(g_settings.voiceId);
    g_settings.voiceName = result["name"].asString(g_settings.voiceName);
  }
}

void handleEngineRequest(const json::Value& id, const std::string& cmd, const json::Value& params) {
  auto reply = [id](bool ok, const json::Value& payload) {
    json::Value msg;
    msg.set("type", "engine-reply").set("id", id).set("ok", ok).set(ok ? "result" : "error", payload);
    postToUi(msg);
  };
  if (cmd.empty() || cmd.size() > 64 || cmd.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.") != std::string::npos) {
    reply(false, errorValue("bad_request", "Comando no válido."));
    return;
  }
  if (g_engineState != "ready" || !g_engine.running()) {
    const std::string message = g_engineState == "starting" ? "El motor se está iniciando. Espera unos segundos."
                                : g_engineMessage.empty()    ? "El motor de doblaje no está en marcha."
                                                             : g_engineMessage;
    reply(false, errorValue("engine_unavailable", message));
    return;
  }
  if (cmd == "session.stop") {
    g_sessionRunning = false;
    reconcileCamera();  // el video vuelve a 0 sin cortar la cámara (o se apaga sin `cameraAlwaysOn`)
  } else if (cmd == "delay.set" && params["delayMs"].isNumber()) {
    // El video cambia a la vez que el audio (solo se aplica al video durante la sesión).
    g_settings.delayMs = std::clamp(params["delayMs"].asInt(), 2000, 6000);
    applyVideoMode();
  }
  engineCall(cmd, params, [reply, cmd, params](bool ok, const json::Value& v) {
    afterEngineReply(cmd, params, ok, v);
    reply(ok, v);
  });
}

// ── Grabación de voz ────────────────────────────────────────────────────────
std::wstring samplesDir() {
  const std::wstring dir = dataDir() + L"\\voice-samples";
  CreateDirectoryW(dir.c_str(), nullptr);
  return dir;
}

json::Value finishRecording(const std::string& reason) {
  KillTimer(g_hwnd, TIMER_RECORDER);
  double seconds = 0;
  const bool ok = g_recorder.stop(seconds);
  g_recState = RecState::Idle;
  json::Value r;
  const size_t slash = g_recPath.find_last_of(L"\\/");
  const std::wstring file = slash == std::wstring::npos ? g_recPath : g_recPath.substr(slash + 1);
  r.set("path", wideToUtf8(g_recPath)).set("url", "https://samples.voxora-meet/" + wideToUtf8(file)).set("seconds", seconds).set("durationMs", static_cast<int>(seconds * 1000))
      .set("ok", ok).set("reason", reason);
  if (!ok) r.set("message", "No se pudo guardar la toma: no llegó audio del micrófono.");
  return r;
}

void onRecorderTick() {
  if (g_recState != RecState::Recording) {
    KillTimer(g_hwnd, TIMER_RECORDER);
    return;
  }
  if (!g_recorder.recording()) {  // se alcanzó el máximo por toma
    sendEvent("record.stopped", finishRecording("max"));
    return;
  }
  json::Value data;
  data.set("seconds", g_recorder.seconds()).set("levelDb", g_recorder.levelDb()).set("maxSeconds", g_recorder.maxSecondsEffective());
  sendEvent("record.level", data);
}

bool isOwnSample(const std::wstring& path) {
  const std::wstring dir = fullPath(samplesDir()) + L"\\";
  const std::wstring full = fullPath(path);
  return full.size() > dir.size() && _wcsnicmp(full.c_str(), dir.c_str(), dir.size()) == 0 &&
         full.find(L"..") == std::wstring::npos && full.find(L'\\', dir.size()) == std::wstring::npos;
}

// ── Ventana ─────────────────────────────────────────────────────────────────
void showMainWindow() {
  if (!g_hwnd) return;
  if (IsIconic(g_hwnd)) ShowWindow(g_hwnd, SW_RESTORE);
  else ShowWindow(g_hwnd, SW_SHOW);
  SetForegroundWindow(g_hwnd);
  g_web.focus();
}

void trayAdd() {
  NOTIFYICONDATAW nid{};
  nid.cbSize = sizeof(nid);
  nid.hWnd = g_hwnd;
  nid.uID = TRAY_ICON_ID;
  nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
  nid.uCallbackMessage = WM_APP_TRAY;
  nid.hIcon = g_iconSmall ? g_iconSmall : LoadIconW(nullptr, IDI_APPLICATION);
  wcscpy_s(nid.szTip, L"VOXORA Meet");
  Shell_NotifyIconW(NIM_ADD, &nid);
}

// Tras un cambio de DPI el icono pequeño se recarga a su nuevo tamaño exacto (16/20/24/32/40 px).
void trayUpdateIcon() {
  NOTIFYICONDATAW nid{};
  nid.cbSize = sizeof(nid);
  nid.hWnd = g_hwnd;
  nid.uID = TRAY_ICON_ID;
  nid.uFlags = NIF_ICON;
  nid.hIcon = g_iconSmall ? g_iconSmall : LoadIconW(nullptr, IDI_APPLICATION);
  Shell_NotifyIconW(NIM_MODIFY, &nid);
}

void trayBalloon(const wchar_t* title, const wchar_t* text) {
  NOTIFYICONDATAW nid{};
  nid.cbSize = sizeof(nid);
  nid.hWnd = g_hwnd;
  nid.uID = TRAY_ICON_ID;
  nid.uFlags = NIF_INFO;
  nid.dwInfoFlags = NIIF_USER | NIIF_LARGE_ICON;
  nid.hBalloonIcon = g_iconBig;
  wcscpy_s(nid.szInfoTitle, title);
  wcscpy_s(nid.szInfo, text);
  Shell_NotifyIconW(NIM_MODIFY, &nid);
}

void trayRemove() {
  NOTIFYICONDATAW nid{};
  nid.cbSize = sizeof(nid);
  nid.hWnd = g_hwnd;
  nid.uID = TRAY_ICON_ID;
  Shell_NotifyIconW(NIM_DELETE, &nid);
}

void trayMenu() {
  HMENU menu = CreatePopupMenu();
  AppendMenuW(menu, MF_STRING, IDM_TRAY_SHOW, L"Mostrar VOXORA Meet");
  AppendMenuW(menu, MF_STRING | (g_engineState == "ready" ? 0 : MF_GRAYED), IDM_TRAY_SESSION,
              g_sessionRunning ? L"Detener doblaje" : L"Iniciar doblaje");
  AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(menu, MF_STRING, IDM_TRAY_QUIT, L"Salir");
  SetMenuDefaultItem(menu, IDM_TRAY_SHOW, FALSE);
  POINT pt;
  GetCursorPos(&pt);
  SetForegroundWindow(g_hwnd);
  TrackPopupMenu(menu, TPM_RIGHTBUTTON | TPM_BOTTOMALIGN, pt.x, pt.y, 0, g_hwnd, nullptr);
  PostMessageW(g_hwnd, WM_NULL, 0, 0);
  DestroyMenu(menu);
}

void hideToTray() {
  ShowWindow(g_hwnd, SW_HIDE);
  if (!g_trayHintShown) {
    g_trayHintShown = true;
    trayBalloon(L"VOXORA Meet sigue activo",
                g_sessionRunning ? L"El doblaje continúa en segundo plano. Ábrelo o sal desde el icono de la bandeja."
                : g_captureActive ? L"Sigue en la bandeja y Meet puede seguir viendo tu cámara. Para cerrarlo del todo, usa «Salir» en su menú."
                                  : L"Sigue disponible en la bandeja. Para cerrarlo del todo, usa «Salir» en su menú.");
  }
}

void quitApp() {
  g_quitting = true;
  DestroyWindow(g_hwnd);
}

// ── Comandos nativos ────────────────────────────────────────────────────────
json::Value appInfo() {
  json::Value info;
  info.set("version", wideToUtf8(kAppVersion)).set("dataDir", wideToUtf8(dataDir()))
#ifdef _DEBUG
      .set("debug", true)
#else
      .set("debug", false)
#endif
      .set("webviewVersion", wideToUtf8(WebViewHost::runtimeVersion()));
  return info;
}

void handleNative(const json::Value& id, const std::string& cmd, const json::Value& params) {
  // native.update.* y native.logs.open (src/updater.cpp).
  if (updater::handleNative(cmd, params, [id](bool ok, const json::Value& v) { replyNative(id, ok, v); })) return;
  // native.recording.* (src/test_recording.cpp).
  if (g_testRecording.handle(id, cmd, params)) return;
  if (cmd == "native.camera.effects") {
    // Imagen de la cámara en vivo (sliders de la UI): se aplica al siguiente frame; el motor la persiste
    // aparte con settings.set. Acepta cualquier subconjunto de las claves cam*.
    g_cameraFxLiveAtMs = qpcNowMs();
    g_settings.mergeCameraEffects(params);
    g_camera.setEffects(g_settings.cameraEffects());
    replyNative(id, true, g_settings.cameraEffectsJson());
    return;
  }
  if (cmd == "native.hello") {
    json::Value r;
    json::Value engine;
    engine.set("state", g_engineState).set("message", g_engineMessage);
    json::Value session;
    session.set("running", g_sessionRunning).set("camera", camStateName(g_camState)).set("cameraName", wideToUtf8(g_camName));
    json::Value recorder;
    recorder.set("recording", g_recState == RecState::Recording).set("path", wideToUtf8(g_recPath));
    r.set("app", appInfo()).set("engine", engine).set("session", session).set("recorder", recorder).set("camera", cameraJson());
    replyNative(id, true, r);
    refreshDevices("hello");
    return;
  }
  if (cmd == "native.app.info") { replyNative(id, true, appInfo()); return; }
  if (cmd == "native.devices.refresh") {
    refreshDevices("manual");
    replyNative(id, true, obj());
    return;
  }
  if (cmd == "native.cameras.list") {
    g_enumWorker.post([id] {
      auto cams = enumerateCameras();
      runOnUi([id, cams = std::move(cams)] {
        json::Value list = arr();
        for (const auto& c : cams) {
          json::Value v;
          v.set("id", wideToUtf8(c.symbolicLink)).set("name", wideToUtf8(c.name));
          list.push(v);
        }
        json::Value r;
        r.set("cameras", list);
        replyNative(id, true, r);
      });
    });
    return;
  }
  if (cmd == "native.engine.restart") {
    restartEngine();
    replyNative(id, true, obj());
    return;
  }
  if (cmd == "native.voice.record.start") {
    if (g_recState != RecState::Idle) {
      replyNative(id, false, errorValue("busy", "Ya hay una grabación en curso."));
      return;
    }
    const std::wstring deviceId = utf8ToWide(params["deviceId"].isString() ? params["deviceId"].asString() : g_settings.micDeviceId);
    SYSTEMTIME st;
    GetLocalTime(&st);
    wchar_t name[64];
    swprintf_s(name, L"\\take-%04d%02d%02d-%02d%02d%02d-%03d.wav", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
    const std::wstring path = samplesDir() + name;
    g_recState = RecState::Starting;
    g_audioWorker.post([id, deviceId, path] {
      std::wstring error;
      const bool ok = g_recorder.start(deviceId, path, kMaxTakeSeconds, error);
      runOnUi([id, ok, error, path] {
        if (!ok) {
          g_recState = RecState::Idle;
          OutputDebugStringW((L"[recorder] " + error + L"\n").c_str());
          replyNative(id, false, errorValue("record_failed",
                                            "No se pudo grabar con ese micrófono. Revisa que esté conectado y que Windows "
                                            "permita el acceso al micrófono (Configuración › Privacidad › Micrófono)."));
          return;
        }
        g_recState = RecState::Recording;
        g_recPath = path;
        SetTimer(g_hwnd, TIMER_RECORDER, 100, nullptr);
        json::Value r;
        r.set("path", wideToUtf8(path)).set("maxSeconds", kMaxTakeSeconds);
        replyNative(id, true, r);
      });
    });
    return;
  }
  if (cmd == "native.voice.record.stop") {
    if (g_recState != RecState::Recording) {
      replyNative(id, false, errorValue("not_recording", "No hay ninguna grabación en curso."));
      return;
    }
    const json::Value r = finishRecording("user");
    replyNative(id, r["ok"].asBool(), r["ok"].asBool() ? r : errorValue("record_failed", r["message"].asString()));
    return;
  }
  if (cmd == "native.voice.record.discard") {
    const std::wstring path = utf8ToWide(params["path"].asString());
    if (!isOwnSample(path)) {
      replyNative(id, false, errorValue("bad_request", "Solo se pueden borrar tomas grabadas por la app."));
      return;
    }
    DeleteFileW(path.c_str());
    replyNative(id, true, obj());
    return;
  }
  if (cmd == "native.pickAudioFiles") {
    const std::vector<std::wstring> files = pickAudioFiles(g_hwnd);
    g_audioWorker.post([id, files] {
      json::Value list = arr();
      for (const auto& f : files) {
        const size_t slash = f.find_last_of(L"\\/");
        const int64_t ms = audioDurationMs(f);
        json::Value v;
        v.set("path", wideToUtf8(f)).set("name", wideToUtf8(slash == std::wstring::npos ? f : f.substr(slash + 1)))
            .set("sizeBytes", static_cast<double>(fileSizeBytes(f)))
            .set("durationMs", ms >= 0 ? json::Value(static_cast<double>(ms)) : json::Value());
        list.push(v);
      }
      runOnUi([id, list] {
        json::Value r;
        r.set("files", list);
        replyNative(id, true, r);
      });
    });
    return;
  }
  if (cmd == "native.openExternal") {
    const bool ok = openExternalUrl(utf8ToWide(params["url"].asString()));
    replyNative(id, ok, ok ? obj() : errorValue("bad_request", "No se pudo abrir el enlace."));
    return;
  }
  if (cmd == "native.window.minimize") { ShowWindow(g_hwnd, SW_MINIMIZE); replyNative(id, true, obj()); return; }
  if (cmd == "native.window.hide") { replyNative(id, true, obj()); hideToTray(); return; }
  if (cmd == "native.window.show") { showMainWindow(); replyNative(id, true, obj()); return; }
  if (cmd == "native.window.quit") { replyNative(id, true, obj()); PostMessageW(g_hwnd, WM_COMMAND, IDM_TRAY_QUIT, 0); return; }
  replyNative(id, false, errorValue("unknown_command", "Comando nativo desconocido."));
}

void onWebMessage(const std::wstring& raw) {
  json::Value msg;
  try {
    msg = json::parse(wideToUtf8(raw));
  } catch (...) {
    return;
  }
  const std::string& type = msg["type"].asString();
  if (type == "engine") handleEngineRequest(msg["id"], msg["cmd"].asString(), msg["params"]);
  else if (type == "native") handleNative(msg["id"], msg["cmd"].asString(), msg["params"]);
}

// ── WebView2 ────────────────────────────────────────────────────────────────
void createWebView() {
  WebViewHost::Options options;
  options.userDataDir = g_webDataDir;
  options.uiFolder = g_uiDir;
#ifdef _DEBUG
  options.devTools = true;
#endif
  options.background = kCanvas;
  // Las tomas grabadas se sirven en https://samples.voxora-meet/<archivo>.wav para poder escucharlas.
  options.extraMappings.push_back({L"samples.voxora-meet", samplesDir()});
  // Las pruebas grabadas («Grabar prueba») en https://recordings.voxora-meet/<archivo>.mp4.
  options.extraMappings.push_back({TestRecordingController::kHost, TestRecordingController::directory()});
  g_web.create(
      g_hwnd, options, onWebMessage,
      [](bool ok, const std::wstring& error) {
        if (ok) {
          g_web.focus();
          return;
        }
        const std::wstring text = error + L"\n\n¿Quieres abrir la página de descarga de WebView2 Runtime?";
        if (MessageBoxW(g_hwnd, text.c_str(), L"VOXORA Meet", MB_ICONERROR | MB_YESNO) == IDYES) openExternalUrl(kWebView2Download);
        quitApp();
      },
      [](bool browserGone) {
        // El proceso del navegador murió: se recrea una vez; si vuelve a caer, se recarga.
        runOnUi([browserGone] {
          if (browserGone && !g_webRecreated) {
            g_webRecreated = true;
            createWebView();
          } else {
            g_web.reload();
          }
        });
      });
}

// Barra de título oscura y, en Windows 11, material Mica.
DWORD windowsBuild() {
  using RtlGetVersionFn = LONG(WINAPI*)(OSVERSIONINFOW*);
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  auto fn = ntdll ? reinterpret_cast<RtlGetVersionFn>(reinterpret_cast<void*>(GetProcAddress(ntdll, "RtlGetVersion"))) : nullptr;
  OSVERSIONINFOW info{};
  info.dwOSVersionInfoSize = sizeof(info);
  return fn && fn(&info) == 0 ? info.dwBuildNumber : 0;
}

void applyWindowChrome(HWND hwnd) {
  // La UI sigue el design system VØXORA («Vocal Glass»): lienzo lavanda claro, nunca modo oscuro.
  const BOOL dark = FALSE;
  if (FAILED(DwmSetWindowAttribute(hwnd, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, &dark, sizeof(dark)))) {
    DwmSetWindowAttribute(hwnd, 19 /* valor previo a 20H1 */, &dark, sizeof(dark));
  }
  const DWORD build = windowsBuild();
  if (build >= 22621) {
    const int backdrop = 2;  // DWMSBT_MAINWINDOW (Mica)
    DwmSetWindowAttribute(hwnd, 38 /* DWMWA_SYSTEMBACKDROP_TYPE */, &backdrop, sizeof(backdrop));
  } else if (build >= 22000) {
    const BOOL mica = TRUE;
    DwmSetWindowAttribute(hwnd, 1029 /* DWMWA_MICA_EFFECT (21H2) */, &mica, sizeof(mica));
  }
  if (build >= 22000) {
    // Barra de título del mismo lavanda que el lienzo, con tinta de marca: la ventana se ve de una
    // pieza y además no la tapa el color de énfasis («Mostrar color de énfasis en barras de título»).
    DwmSetWindowAttribute(hwnd, 35 /* DWMWA_CAPTION_COLOR */, &kCanvas, sizeof(kCanvas));
    DwmSetWindowAttribute(hwnd, 36 /* DWMWA_TEXT_COLOR */, &kInk, sizeof(kInk));
  }
}

void loadIcons(UINT dpi) {
  if (g_iconBig) DestroyIcon(g_iconBig);
  if (g_iconSmall) DestroyIcon(g_iconSmall);
  g_iconBig = static_cast<HICON>(LoadImageW(g_instance, MAKEINTRESOURCEW(IDI_APP), IMAGE_ICON,
                                            GetSystemMetricsForDpi(SM_CXICON, dpi), GetSystemMetricsForDpi(SM_CYICON, dpi), 0));
  g_iconSmall = static_cast<HICON>(LoadImageW(g_instance, MAKEINTRESOURCEW(IDI_APP), IMAGE_ICON,
                                              GetSystemMetricsForDpi(SM_CXSMICON, dpi), GetSystemMetricsForDpi(SM_CYSMICON, dpi), 0));
}

LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
  switch (msg) {
    case WM_CREATE: {
      g_hwnd = hwnd;
      applyWindowChrome(hwnd);
      loadIcons(GetDpiForWindow(hwnd));
      SendMessageW(hwnd, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(g_iconBig));
      SendMessageW(hwnd, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(g_iconSmall));
      trayAdd();
      g_watcher.start(hwnd, WM_APP_AUDIO_ENDPOINTS);
      g_testRecording.init(
          {[](const json::Value& id, bool ok, const json::Value& v) { replyNative(id, ok, v); }, sendEvent, runOnUi},
          {[](CameraCapture::FrameTap tap) { g_camera.setFrameTap(std::move(tap)); },
           [] { return g_captureActive && g_camState == CamState::Live; }, [] { return g_virtualMicCapture; }});
      createWebView();
      startEngine();
      reconcileCamera();  // con `cameraAlwaysOn` la cámara virtual existe desde que se abre la app
      return 0;
    }
    case WM_APP_TASK: {
      std::unique_ptr<UiTask> task(reinterpret_cast<UiTask*>(lParam));
      if (task && task->fn) task->fn();
      return 0;
    }
    case WM_APP_TRAY:
      if (LOWORD(lParam) == WM_LBUTTONUP || LOWORD(lParam) == WM_LBUTTONDBLCLK) showMainWindow();
      else if (LOWORD(lParam) == WM_RBUTTONUP || LOWORD(lParam) == WM_CONTEXTMENU) trayMenu();
      return 0;
    case WM_APP_AUDIO_ENDPOINTS:
      scheduleDeviceRefresh();
      return 0;
    case WM_DEVICECHANGE:
      if (DeviceWatcher::isRelevantDeviceChange(wParam, lParam)) scheduleDeviceRefresh();
      return TRUE;
    case WM_COMMAND:
      switch (LOWORD(wParam)) {
        case IDM_TRAY_SHOW: showMainWindow(); return 0;
        case IDM_TRAY_SESSION: {
          showMainWindow();
          sendEvent("tray.toggleSession", obj());  // la UI hace su flujo normal de iniciar/detener
          return 0;
        }
        case IDM_TRAY_QUIT: quitApp(); return 0;
      }
      break;
    case WM_TIMER:
      if (wParam == TIMER_DEVICES) {
        KillTimer(hwnd, TIMER_DEVICES);
        refreshDevices("change");
      } else if (wParam == TIMER_RECORDER) {
        onRecorderTick();
      } else if (wParam == TIMER_ENGINE_RESTART) {
        KillTimer(hwnd, TIMER_ENGINE_RESTART);
        if (!g_quitting && !g_engine.running()) startEngine();
      } else if (wParam == TIMER_CAMERA) {
        onCameraTick();
      }
      return 0;
    case WM_SIZE:
      g_web.setVisible(wParam != SIZE_MINIMIZED);
      g_web.resize();
      return 0;
    case WM_MOVE:
    case WM_MOVING:
      g_web.notifyParentMoved();
      break;
    case WM_SETFOCUS:
      g_web.focus();
      return 0;
    case WM_SETTINGCHANGE:
      // El usuario cambió tema / color de énfasis: se reaplica la barra de título.
      if (lParam && wcscmp(reinterpret_cast<const wchar_t*>(lParam), L"ImmersiveColorSet") == 0) applyWindowChrome(hwnd);
      break;
    case WM_GETMINMAXINFO: {
      auto* mmi = reinterpret_cast<MINMAXINFO*>(lParam);
      const UINT dpi = windowDpi();
      RECT rc{0, 0, scaled(kMinClientW, dpi), scaled(kMinClientH, dpi)};
      AdjustWindowRectExForDpi(&rc, WS_OVERLAPPEDWINDOW, FALSE, 0, dpi);
      mmi->ptMinTrackSize.x = rc.right - rc.left;
      mmi->ptMinTrackSize.y = rc.bottom - rc.top;
      return 0;
    }
    case WM_DPICHANGED: {
      const auto* suggested = reinterpret_cast<const RECT*>(lParam);
      SetWindowPos(hwnd, nullptr, suggested->left, suggested->top, suggested->right - suggested->left,
                   suggested->bottom - suggested->top, SWP_NOZORDER | SWP_NOACTIVATE);
      loadIcons(HIWORD(wParam));
      SendMessageW(hwnd, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(g_iconBig));
      SendMessageW(hwnd, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(g_iconSmall));
      trayUpdateIcon();
      return 0;
    }
    case WM_ERASEBKGND: {
      RECT rc;
      GetClientRect(hwnd, &rc);
      HBRUSH brush = CreateSolidBrush(kCanvas);
      FillRect(reinterpret_cast<HDC>(wParam), &rc, brush);
      DeleteObject(brush);
      return 1;
    }
    case WM_CLOSE:
      if (!g_quitting) {
        hideToTray();  // sigue viva en la bandeja: la reunión no se corta
        return 0;
      }
      DestroyWindow(hwnd);
      return 0;
    case WM_DESTROY:
      KillTimer(hwnd, TIMER_DEVICES);
      KillTimer(hwnd, TIMER_RECORDER);
      KillTimer(hwnd, TIMER_CAMERA);
      g_watcher.stop();
      if (g_recorder.recording()) {
        double s = 0;
        g_recorder.stop(s);
      }
      g_web.close();
      g_testRecording.shutdown();  // cierra el MP4 en curso (queda válido)
      // Captura primero (la cámara virtual pasa a la imagen de espera) y luego el host: `stop` + EOF por
      // su stdin retiran «VOXORA Meet Camera». Si el shell muriera sin llegar aquí, el EOF llega igual.
      g_cameraWorker.post([] {
        g_camera.stop();
        g_vcamHost.stop();
      });
      g_cameraWorker.shutdown();
      g_enumWorker.shutdown();
      g_audioWorker.shutdown();
      g_engine.stop();
      trayRemove();
      g_hwnd = nullptr;
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(hwnd, msg, wParam, lParam);
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int showCmd) {
  g_instance = instance;
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

  // Una sola instancia: los dispositivos virtuales son recursos exclusivos.
  HANDLE mutex = CreateMutexW(nullptr, TRUE, L"Local\\VoxoraMeetShellSingleInstance");
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    HWND existing = FindWindowW(kWindowClass, nullptr);
    if (existing) {
      if (IsIconic(existing)) ShowWindow(existing, SW_RESTORE);
      else ShowWindow(existing, SW_SHOW);
      SetForegroundWindow(existing);
    }
    if (mutex) CloseHandle(mutex);
    return 0;
  }

  // Registro en %LOCALAPPDATA%\VOXORA Meet\logs\shell.log (rotado) y minidump si el shell cae.
  logging::startForProcess(L"shell", std::string("VOXORA Meet ") + VOXORA_VERSION_STR + " iniciando (pid " +
                                         std::to_string(GetCurrentProcessId()) + ")");

  if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return 1;

  // Sin runtime de WebView2 no hay UI: se explica y se ofrece la descarga.
  if (WebViewHost::runtimeVersion().empty()) {
    if (MessageBoxW(nullptr,
                    L"VOXORA Meet necesita Microsoft Edge WebView2 Runtime, que no está instalado en este equipo.\n\n"
                    L"¿Quieres abrir la página de descarga? Instala el «Evergreen Bootstrapper» y vuelve a abrir la app.",
                    L"VOXORA Meet", MB_ICONWARNING | MB_YESNO) == IDYES) {
      openExternalUrl(kWebView2Download);
    }
    CoUninitialize();
    return 1;
  }

  g_exeDir = exeDirectory();
  g_settings = loadSettings();
  g_engineScript = firstExisting({
      g_exeDir + L"\\engine\\engine.mjs",          // empaquetado
      g_exeDir + L"\\..\\..\\engine\\engine.mjs",  // native-shell\bin → app\engine
      g_exeDir + L"\\..\\engine\\engine.mjs",
  });
  g_vcamHostPath = firstExisting({
      g_exeDir + L"\\VoxoraMeetVCamHost.exe",
      g_exeDir + L"\\..\\..\\..\\windows-camera\\native\\bin\\VoxoraMeetVCamHost.exe",
  });
  const std::wstring indexHtml = firstExisting({
      g_exeDir + L"\\ui\\index.html",          // empaquetado
      g_exeDir + L"\\..\\..\\ui\\index.html",  // native-shell\bin → app\ui
      g_exeDir + L"\\..\\ui\\index.html",
  });
  if (indexHtml.empty()) {
    MessageBoxW(nullptr, L"No se encontró la interfaz (ui\\index.html) junto a la aplicación. Reinstala VOXORA Meet.",
                L"VOXORA Meet", MB_ICONERROR);
    CoUninitialize();
    return 1;
  }
  g_uiDir = indexHtml.substr(0, indexHtml.find_last_of(L'\\'));
  g_webDataDir = localAppDataDir() + L"\\WebView2";
  CreateDirectoryW(g_webDataDir.c_str(), nullptr);

  g_cameraWorker.start();
  g_enumWorker.start();
  g_audioWorker.start();

  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.style = CS_HREDRAW | CS_VREDRAW;
  wc.lpfnWndProc = WndProc;
  wc.hInstance = instance;
  wc.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(IDI_APP));
  wc.hIconSm = static_cast<HICON>(LoadImageW(instance, MAKEINTRESOURCEW(IDI_APP), IMAGE_ICON, GetSystemMetrics(SM_CXSMICON),
                                             GetSystemMetrics(SM_CYSMICON), 0));
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hbrBackground = nullptr;  // WM_ERASEBKGND pinta el lienzo de marca
  wc.lpszClassName = kWindowClass;
  RegisterClassExW(&wc);

  // Tamaño inicial 1200x780 (área cliente, escalado a los DPI del monitor principal), centrado.
  const UINT dpi = GetDpiForSystem();
  RECT rc{0, 0, scaled(kInitClientW, dpi), scaled(kInitClientH, dpi)};
  AdjustWindowRectExForDpi(&rc, WS_OVERLAPPEDWINDOW, FALSE, 0, dpi);
  int w = rc.right - rc.left, h = rc.bottom - rc.top;
  RECT work{};
  SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
  w = std::min<int>(w, work.right - work.left);
  h = std::min<int>(h, work.bottom - work.top);
  const int x = work.left + ((work.right - work.left) - w) / 2;
  const int y = work.top + ((work.bottom - work.top) - h) / 2;
  HWND hwnd = CreateWindowExW(0, kWindowClass, L"VOXORA Meet", WS_OVERLAPPEDWINDOW, x, y, w, h, nullptr, nullptr, instance, nullptr);
  if (!hwnd) return 1;
  ShowWindow(hwnd, showCmd == SW_SHOWMINNOACTIVE || showCmd == SW_MINIMIZE ? showCmd : SW_SHOWNORMAL);
  UpdateWindow(hwnd);

  // Actualizaciones: primera comprobación a los 30 s y luego cada 6 h (src/updater.h). La UI recibe
  // el evento nativo `update` y nunca propone reiniciar durante una sesión de doblaje.
  updater::Hooks updateHooks;
  updateHooks.runOnUi = runOnUi;
  updateHooks.onStatus = [](const json::Value& status) { sendEvent("update", status); };
  updateHooks.sessionRunning = [] { return g_sessionRunning; };
  updateHooks.quitApp = [] { quitApp(); };
  updateHooks.owner = hwnd;
  updater::start(std::move(updateHooks));

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  updater::stop();
  logging::info("VOXORA Meet cerrado");
  if (g_iconBig) DestroyIcon(g_iconBig);
  if (g_iconSmall) DestroyIcon(g_iconSmall);
  CloseHandle(mutex);
  CoUninitialize();
  return static_cast<int>(msg.wParam);
}
