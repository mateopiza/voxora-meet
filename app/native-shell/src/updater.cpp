#include "updater.h"

#include <bcrypt.h>
#include <shellapi.h>
#include <shlobj.h>
#include <softpub.h>
#include <wincrypt.h>
#include <winhttp.h>
#include <wintrust.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <mutex>
#include <thread>
#include <vector>

#include "logger.h"
#include "voxora_version.h"

#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "wintrust.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "bcrypt.lib")

namespace voxora::updater {
namespace {

// Canal público de producción (lectura anónima por policy limitada al prefijo; ver docs/RELEASE.md).
// Debe coincidir con `config.updateFeed` del package.json (lo comprueba scripts/verify-release.mjs).
constexpr wchar_t kDefaultFeed[] = L"https://s3.g.megas4.com/voxora-meet/voxora-meet-updates/latest.json";
// Certificados de firma aceptados (SHA1 del firmante). Al renovar el certificado, publicar ANTES una
// versión firmada con el actual que ya incluya el thumbprint nuevo (docs/RELEASE.md).
const wchar_t* const kTrustedThumbprints[] = {
    L"F105226E95107920D137D7E761C605F0EF30933B",  // SSL.com eSigner, CN=Mateo Piza Ruiz (hasta 2027-09-09)
};
constexpr DWORD kDefaultDelayMs = 30'000;
constexpr DWORD kDefaultIntervalMs = 6u * 60u * 60u * 1000u;
constexpr size_t kMaxManifestBytes = 256 * 1024;
constexpr uint64_t kMaxInstallerBytes = 2ull * 1024 * 1024 * 1024;

std::string toUtf8(const std::wstring& text) {
  if (text.empty()) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  std::string out(static_cast<size_t>(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), out.data(), n, nullptr, nullptr);
  return out;
}

std::wstring toWide(const std::string& text) {
  if (text.empty()) return {};
  const int n = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), nullptr, 0);
  std::wstring out(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), out.data(), n);
  return out;
}

std::wstring envVar(const wchar_t* name) {
  wchar_t buf[2048];
  const DWORD n = GetEnvironmentVariableW(name, buf, static_cast<DWORD>(std::size(buf)));
  return n > 0 && n < std::size(buf) ? std::wstring(buf, n) : std::wstring();
}

bool envFlag(const wchar_t* name) { return envVar(name) == L"1"; }

DWORD envMs(const wchar_t* name, DWORD fallback) {
  const std::wstring v = envVar(name);
  if (v.empty()) return fallback;
  wchar_t* end = nullptr;
  const unsigned long n = wcstoul(v.c_str(), &end, 10);
  return end && *end == L'\0' ? static_cast<DWORD>(n) : fallback;
}

double epochMs() {
  FILETIME ft;
  GetSystemTimeAsFileTime(&ft);
  const ULONGLONG t = (static_cast<ULONGLONG>(ft.dwHighDateTime) << 32) | ft.dwLowDateTime;
  return static_cast<double>((t - 116444736000000000ull) / 10000ull);
}

std::wstring exeDir() {
  wchar_t buf[MAX_PATH * 2];
  const DWORD n = GetModuleFileNameW(nullptr, buf, static_cast<DWORD>(std::size(buf)));
  std::wstring path(buf, n);
  const size_t slash = path.find_last_of(L"\\/");
  return slash == std::wstring::npos ? L"." : path.substr(0, slash);
}

bool fileExists(const std::wstring& path) {
  const DWORD attrs = GetFileAttributesW(path.c_str());
  return attrs != INVALID_FILE_ATTRIBUTES && !(attrs & FILE_ATTRIBUTE_DIRECTORY);
}

std::string lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(tolower(c)); });
  return s;
}

// ── Semver ────────────────────────────────────────────────────────────────────
struct SemVer {
  unsigned long long major = 0, minor = 0, patch = 0;
  std::vector<std::string> pre;
};

bool parseSemVer(const std::string& text, SemVer& v) {
  std::string s = text;
  const size_t plus = s.find('+');
  if (plus != std::string::npos) s = s.substr(0, plus);
  std::string pre;
  const size_t dash = s.find('-');
  if (dash != std::string::npos) {
    pre = s.substr(dash + 1);
    s = s.substr(0, dash);
    if (pre.empty()) return false;
  }
  unsigned long long parts[3];
  size_t pos = 0;
  for (int i = 0; i < 3; ++i) {
    const size_t end = i < 2 ? s.find('.', pos) : s.size();
    if (end == std::string::npos || end == pos || end - pos > 9) return false;
    const std::string num = s.substr(pos, end - pos);
    if (num.find_first_not_of("0123456789") != std::string::npos) return false;
    parts[i] = std::stoull(num);
    pos = end + 1;
  }
  if (pos - 1 != s.size()) return false;
  v.major = parts[0];
  v.minor = parts[1];
  v.patch = parts[2];
  v.pre.clear();
  size_t start = 0;
  while (!pre.empty() && start <= pre.size()) {
    const size_t dot = pre.find('.', start);
    const std::string id = pre.substr(start, dot == std::string::npos ? std::string::npos : dot - start);
    if (id.empty() || id.find_first_not_of("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-") != std::string::npos) return false;
    v.pre.push_back(id);
    if (dot == std::string::npos) break;
    start = dot + 1;
  }
  return true;
}

// ── HTTP (WinHTTP) ────────────────────────────────────────────────────────────
struct Url {
  bool secure = true;
  std::wstring host;
  INTERNET_PORT port = 0;
  std::wstring pathAndQuery;
};

bool crackUrl(const std::wstring& url, Url& out) {
  URL_COMPONENTS uc{};
  uc.dwStructSize = sizeof(uc);
  wchar_t host[256], path[4096], extra[2048];
  uc.lpszHostName = host;
  uc.dwHostNameLength = static_cast<DWORD>(std::size(host));
  uc.lpszUrlPath = path;
  uc.dwUrlPathLength = static_cast<DWORD>(std::size(path));
  uc.lpszExtraInfo = extra;
  uc.dwExtraInfoLength = static_cast<DWORD>(std::size(extra));
  if (!WinHttpCrackUrl(url.c_str(), 0, 0, &uc)) return false;
  if (uc.nScheme != INTERNET_SCHEME_HTTPS && uc.nScheme != INTERNET_SCHEME_HTTP) return false;
  out.secure = uc.nScheme == INTERNET_SCHEME_HTTPS;
  out.host.assign(host, uc.dwHostNameLength);
  out.port = uc.nPort;
  out.pathAndQuery.assign(path, uc.dwUrlPathLength);
  out.pathAndQuery.append(extra, uc.dwExtraInfoLength);
  if (out.pathAndQuery.empty()) out.pathAndQuery = L"/";
  return !out.host.empty();
}

struct HInternet {
  HINTERNET h = nullptr;
  HInternet() = default;
  explicit HInternet(HINTERNET v) : h(v) {}
  ~HInternet() { if (h) WinHttpCloseHandle(h); }
  HInternet(const HInternet&) = delete;
  HInternet& operator=(const HInternet&) = delete;
};

// GET con timeouts; entrega el cuerpo por trozos. `onData` devuelve false para abortar.
bool httpGet(const std::wstring& url, const std::function<void(uint64_t)>& onLength,
             const std::function<bool(const char*, DWORD)>& onData, std::wstring& error) {
  Url u;
  if (!crackUrl(url, u)) {
    error = L"URL no válida";
    return false;
  }
  const std::wstring agent = std::wstring(L"VOXORA-Meet/") + VOXORA_VERSION_WSTR + L" (Windows; updater)";
  HInternet session(WinHttpOpen(agent.c_str(), WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
  if (!session.h) session.h = WinHttpOpen(agent.c_str(), WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!session.h) {
    error = L"WinHttpOpen falló (" + std::to_wstring(GetLastError()) + L")";
    return false;
  }
  DWORD protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2;
#ifdef WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3
  protocols |= WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3;
#endif
  if (!WinHttpSetOption(session.h, WINHTTP_OPTION_SECURE_PROTOCOLS, &protocols, sizeof(protocols))) {
    protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2;
    WinHttpSetOption(session.h, WINHTTP_OPTION_SECURE_PROTOCOLS, &protocols, sizeof(protocols));
  }
  WinHttpSetTimeouts(session.h, 15000, 15000, 30000, 60000);
  HInternet connect(WinHttpConnect(session.h, u.host.c_str(), u.port, 0));
  if (!connect.h) {
    error = L"No se pudo conectar con " + u.host;
    return false;
  }
  HInternet request(WinHttpOpenRequest(connect.h, L"GET", u.pathAndQuery.c_str(), nullptr, WINHTTP_NO_REFERER,
                                       WINHTTP_DEFAULT_ACCEPT_TYPES, u.secure ? WINHTTP_FLAG_SECURE : 0));
  if (!request.h) {
    error = L"WinHttpOpenRequest falló";
    return false;
  }
  const wchar_t* headers = L"Cache-Control: no-cache\r\nPragma: no-cache\r\n";
  if (!WinHttpSendRequest(request.h, headers, static_cast<DWORD>(-1L), WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
      !WinHttpReceiveResponse(request.h, nullptr)) {
    error = L"Sin respuesta del servidor (error " + std::to_wstring(GetLastError()) + L")";
    return false;
  }
  DWORD status = 0, size = sizeof(status);
  WinHttpQueryHeaders(request.h, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX,
                      &status, &size, WINHTTP_NO_HEADER_INDEX);
  if (status != 200) {
    error = L"HTTP " + std::to_wstring(status);
    return false;
  }
  wchar_t lenBuf[32];
  DWORD lenSize = sizeof(lenBuf);
  if (onLength && WinHttpQueryHeaders(request.h, WINHTTP_QUERY_CONTENT_LENGTH, WINHTTP_HEADER_NAME_BY_INDEX, lenBuf,
                                      &lenSize, WINHTTP_NO_HEADER_INDEX)) {
    onLength(_wcstoui64(lenBuf, nullptr, 10));
  }
  std::vector<char> buf(256 * 1024);
  for (;;) {
    DWORD read = 0;
    if (!WinHttpReadData(request.h, buf.data(), static_cast<DWORD>(buf.size()), &read)) {
      error = L"Se cortó la descarga (error " + std::to_wstring(GetLastError()) + L")";
      return false;
    }
    if (read == 0) break;
    if (!onData(buf.data(), read)) {
      if (error.empty()) error = L"descarga cancelada";
      return false;
    }
  }
  return true;
}

// ── SHA256 (CNG) ──────────────────────────────────────────────────────────────
class Sha256 {
 public:
  Sha256() {
    if (BCryptOpenAlgorithmProvider(&alg_, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0) BCryptCreateHash(alg_, &hash_, nullptr, 0, nullptr, 0, 0);
  }
  ~Sha256() {
    if (hash_) BCryptDestroyHash(hash_);
    if (alg_) BCryptCloseAlgorithmProvider(alg_, 0);
  }
  Sha256(const Sha256&) = delete;
  Sha256& operator=(const Sha256&) = delete;
  bool ok() const { return hash_ != nullptr; }
  void update(const void* data, DWORD size) {
    if (hash_) BCryptHashData(hash_, static_cast<PUCHAR>(const_cast<void*>(data)), size, 0);
  }
  std::string hex() {
    unsigned char digest[32];
    if (!hash_ || BCryptFinishHash(hash_, digest, sizeof(digest), 0) != 0) return {};
    static const char* digits = "0123456789abcdef";
    std::string out;
    for (unsigned char b : digest) {
      out += digits[b >> 4];
      out += digits[b & 15];
    }
    return out;
  }

 private:
  BCRYPT_ALG_HANDLE alg_ = nullptr;
  BCRYPT_HASH_HANDLE hash_ = nullptr;
};

// ── Estado ────────────────────────────────────────────────────────────────────
struct State {
  std::string state = "idle";  // disabled | idle | checking | uptodate | downloading | ready | error
  std::string reason;          // por qué está deshabilitado
  std::string errorCode, errorMessage;
  bool hasAvailable = false;
  Manifest available;
  bool mandatory = false;
  uint64_t received = 0, total = 0;
  double lastCheckAt = 0;
  std::wstring installerPath;
  std::string signature;  // trusted | unsigned-allowed
  bool dismissed = false;
  bool applying = false;
};

// Estado compartido con el hilo del actualizador. Se reserva en el heap y nunca se libera: si al salir
// el hilo sigue bloqueado en WinHTTP (timeouts de red) se desengancha, y no debe tocar objetos que los
// destructores estáticos ya hayan destruido.
std::mutex& g_mutex = *new std::mutex;
State& g_state = *new State;
Hooks& g_hooks = *new Hooks;
std::wstring& g_feed = *new std::wstring;
bool g_allowUnsigned = false;
bool g_started = false;
HANDLE g_wake = nullptr;
HANDLE g_stop = nullptr;
std::thread g_thread;
std::atomic<bool> g_running{false};

json::Value statusLocked() {
  json::Value s;
  s.set("state", g_state.state).set("currentVersion", VOXORA_VERSION_STR).set("enabled", g_state.state != "disabled")
      .set("feed", toUtf8(g_feed)).set("lastCheckAt", g_state.lastCheckAt).set("dismissed", g_state.dismissed)
      .set("mandatory", g_state.mandatory).set("applying", g_state.applying);
  if (!g_state.reason.empty()) s.set("reason", g_state.reason);
  if (!g_state.errorMessage.empty()) {
    json::Value e;
    e.set("code", g_state.errorCode).set("message", g_state.errorMessage);
    s.set("error", e);
  }
  if (g_state.hasAvailable) {
    json::Value a;
    a.set("version", g_state.available.version).set("releaseNotes", g_state.available.releaseNotes)
        .set("publishedAt", g_state.available.publishedAt).set("size", static_cast<double>(g_state.available.size))
        .set("minSupportedVersion", g_state.available.minSupportedVersion);
    s.set("available", a);
  } else {
    s.set("available", json::Value());
  }
  json::Value p;
  const double pct = g_state.total ? 100.0 * static_cast<double>(g_state.received) / static_cast<double>(g_state.total) : 0.0;
  p.set("received", static_cast<double>(g_state.received)).set("total", static_cast<double>(g_state.total))
      .set("percent", std::min(100.0, std::floor(pct * 10) / 10));
  s.set("progress", p);
  if (!g_state.signature.empty()) s.set("signature", g_state.signature);
  return s;
}

void notify() {
  json::Value s;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    s = statusLocked();
  }
  if (g_hooks.runOnUi && g_hooks.onStatus) {
    auto cb = g_hooks.onStatus;
    g_hooks.runOnUi([cb, s] { cb(s); });
  }
}

void setError(const std::string& code, const std::string& message) {
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_state.errorCode = code;
    g_state.errorMessage = message;
    // Si ya había una actualización lista (verificada), un fallo de red posterior no la invalida.
    if (g_state.state != "ready") g_state.state = "error";
  }
  logging::warn("[updater] " + code + ": " + message);
  notify();
}

bool isTrustedThumbprint(const std::wstring& thumb) {
  for (const wchar_t* t : kTrustedThumbprints) {
    if (_wcsicmp(t, thumb.c_str()) == 0) return true;
  }
  return false;
}

std::wstring installerPathFor(const std::string& version) {
  return updatesDir() + L"\\VOXORA-Meet-Setup-" + toWide(version) + L".exe";
}

// Borra instaladores y descargas parciales que no sean `keep`.
void cleanupUpdates(const std::wstring& keep) {
  WIN32_FIND_DATAW fd{};
  HANDLE find = FindFirstFileW((updatesDir() + L"\\*").c_str(), &fd);
  if (find == INVALID_HANDLE_VALUE) return;
  do {
    if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
    const std::wstring path = updatesDir() + L"\\" + fd.cFileName;
    if (!keep.empty() && _wcsicmp(path.c_str(), keep.c_str()) == 0) continue;
    DeleteFileW(path.c_str());
  } while (FindNextFileW(find, &fd));
  FindClose(find);
}

// Tamaño + SHA256 + firma. Rellena `signature` con trusted | unsigned-allowed.
bool verifyInstaller(const std::wstring& path, const Manifest& m, std::string& signature, std::string& code, std::string& message) {
  WIN32_FILE_ATTRIBUTE_DATA attrs{};
  if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &attrs)) {
    code = "missing";
    message = "El instalador descargado ya no está.";
    return false;
  }
  const uint64_t size = (static_cast<uint64_t>(attrs.nFileSizeHigh) << 32) | attrs.nFileSizeLow;
  if (m.size && size != m.size) {
    code = "size_mismatch";
    message = "El instalador descargado no tiene el tamaño esperado.";
    return false;
  }
  std::string hex;
  if (!sha256File(path, hex) || hex != m.sha256) {
    code = "hash_mismatch";
    message = "El instalador descargado no coincide con su huella SHA256; se descartó.";
    return false;
  }
  const SignatureInfo sig = verifySignature(path);
  if (sig.signedValid && sig.trustedSigner) {
    signature = "trusted";
    return true;
  }
  if (g_allowUnsigned) {
    logging::warn("[updater] instalador sin firma de VOXORA aceptado por VOXORA_UPDATE_ALLOW_UNSIGNED=1 (" + toUtf8(sig.error) + ")");
    signature = "unsigned-allowed";
    return true;
  }
  code = "bad_signature";
  message = sig.signedValid ? "El instalador está firmado por otro emisor (" + toUtf8(sig.subject) + "); se descartó."
                            : "El instalador no tiene una firma digital válida de VOXORA; se descartó.";
  logging::warn("[updater] firma rechazada: " + toUtf8(sig.error.empty() ? sig.thumbprint : sig.error));
  return false;
}

bool download(const std::wstring& url, const Manifest& m, const std::wstring& target, std::string& code, std::string& message) {
  const std::wstring partial = target + L".partial";
  HANDLE file = CreateFileW(partial.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    code = "io";
    message = "No se pudo escribir en la carpeta de actualizaciones.";
    return false;
  }
  Sha256 hash;
  uint64_t received = 0;
  ULONGLONG lastNotify = 0;
  bool writeFailed = false;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_state.state = "downloading";
    g_state.received = 0;
    g_state.total = m.size;
  }
  notify();
  std::wstring error;
  const bool ok = httpGet(
      url, [](uint64_t) {},
      [&](const char* data, DWORD n) {
        if (WaitForSingleObject(g_stop, 0) == WAIT_OBJECT_0) return false;
        received += n;
        if (received > (m.size ? m.size : kMaxInstallerBytes)) {
          error = L"el archivo es más grande de lo anunciado";
          return false;
        }
        DWORD written = 0;
        if (!WriteFile(file, data, n, &written, nullptr) || written != n) {
          writeFailed = true;
          return false;
        }
        hash.update(data, n);
        const ULONGLONG now = GetTickCount64();
        if (now - lastNotify > 300) {
          lastNotify = now;
          {
            std::lock_guard<std::mutex> lock(g_mutex);
            g_state.received = received;
          }
          notify();
        }
        return true;
      },
      error);
  CloseHandle(file);
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_state.received = received;
  }
  if (!ok || writeFailed) {
    DeleteFileW(partial.c_str());
    code = writeFailed ? "io" : "network";
    message = writeFailed ? "No hay espacio o permiso para guardar la actualización."
                          : "No se pudo descargar la actualización (" + toUtf8(error) + "). Se reintentará más tarde.";
    return false;
  }
  if (m.size && received != m.size) {
    DeleteFileW(partial.c_str());
    code = "size_mismatch";
    message = "La descarga llegó incompleta. Se reintentará más tarde.";
    return false;
  }
  if (hash.hex() != m.sha256) {
    DeleteFileW(partial.c_str());
    code = "hash_mismatch";
    message = "La actualización descargada no coincide con su huella SHA256; se descartó.";
    return false;
  }
  if (!MoveFileExW(partial.c_str(), target.c_str(), MOVEFILE_REPLACE_EXISTING)) {
    DeleteFileW(partial.c_str());
    code = "io";
    message = "No se pudo guardar la actualización.";
    return false;
  }
  return true;
}

void runCheck() {
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_state.state == "downloading" || g_state.state == "checking" || g_state.applying) return;
    if (g_state.state != "ready") g_state.state = "checking";
    g_state.errorCode.clear();
    g_state.errorMessage.clear();
  }
  notify();
  logging::info("[updater] comprobando " + toUtf8(g_feed));

  std::string body;
  std::wstring error;
  const bool ok = httpGet(
      g_feed, [](uint64_t) {},
      [&](const char* data, DWORD n) {
        if (body.size() + n > kMaxManifestBytes) {
          error = L"manifiesto demasiado grande";
          return false;
        }
        body.append(data, n);
        return true;
      },
      error);
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_state.lastCheckAt = epochMs();
  }
  if (!ok) {
    setError(error.rfind(L"HTTP 404", 0) == 0 ? "no_release" : "network",
             error.rfind(L"HTTP 404", 0) == 0 ? "Todavía no hay versiones publicadas en el canal de actualizaciones."
                                              : "No se pudo comprobar si hay actualizaciones (" + toUtf8(error) + ").");
    return;
  }
  Manifest m;
  std::string parseError;
  if (!parseManifest(body, m, parseError)) {
    setError("bad_manifest", "El canal de actualizaciones devolvió un manifiesto no válido: " + parseError);
    return;
  }
  const std::wstring installerUrl = resolveUrl(g_feed, toWide(m.url));
  if (!isAllowedUrl(installerUrl)) {
    setError("bad_manifest", "La URL del instalador no es HTTPS; se ignoró la actualización.");
    return;
  }
  if (compareVersions(m.version, VOXORA_VERSION_STR) <= 0) {
    {
      std::lock_guard<std::mutex> lock(g_mutex);
      g_state.state = "uptodate";
      g_state.hasAvailable = false;
      g_state.mandatory = false;
      g_state.installerPath.clear();
    }
    cleanupUpdates(L"");
    logging::info("[updater] al día (" + std::string(VOXORA_VERSION_STR) + "; canal " + m.version + ")");
    notify();
    return;
  }
  const bool mandatory = !m.minSupportedVersion.empty() && compareVersions(VOXORA_VERSION_STR, m.minSupportedVersion) < 0;
  const std::wstring target = installerPathFor(m.version);
  bool alreadyReady = false;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    alreadyReady = g_state.state == "ready" && g_state.hasAvailable && g_state.available.version == m.version &&
                   g_state.available.sha256 == m.sha256 && fileExists(g_state.installerPath);
    if (alreadyReady) g_state.mandatory = mandatory;
  }
  if (alreadyReady) {  // ya está descargada y verificada
    notify();
    return;
  }
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_state.hasAvailable = true;
    g_state.available = m;
    g_state.mandatory = mandatory;
    g_state.dismissed = false;
  }
  logging::info("[updater] versión " + m.version + " disponible (" + std::to_string(m.size) + " bytes)");
  std::string signature, code, message;
  bool ready = fileExists(target) && verifyInstaller(target, m, signature, code, message);
  if (!ready) {
    DeleteFileW(target.c_str());
    if (!download(installerUrl, m, target, code, message) || !verifyInstaller(target, m, signature, code, message)) {
      DeleteFileW(target.c_str());
      {
        std::lock_guard<std::mutex> lock(g_mutex);
        if (g_state.state == "downloading") g_state.state = "error";
      }
      setError(code, message);
      return;
    }
  }
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_state.state = "ready";
    g_state.installerPath = target;
    g_state.signature = signature;
    g_state.received = g_state.total = m.size;
  }
  cleanupUpdates(target);
  logging::info("[updater] actualización " + m.version + " lista (" + signature + ")");
  notify();
}

void threadMain(DWORD firstDelayMs, DWORD intervalMs) {
  HANDLE events[2] = {g_stop, g_wake};
  DWORD wait = firstDelayMs;
  for (;;) {
    const DWORD r = WaitForMultipleObjects(2, events, FALSE, wait);
    if (r == WAIT_OBJECT_0 || r == WAIT_FAILED) break;
    try {
      runCheck();
    } catch (const std::exception& e) {
      setError("internal", std::string("Error interno del actualizador: ") + e.what());
    }
    wait = intervalMs;
  }
}

void applyUpdate(const std::function<void(bool, const json::Value&)>& reply) {
  auto fail = [&](const std::string& code, const std::string& message) {
    json::Value e;
    e.set("code", code).set("message", message);
    reply(false, e);
  };
  if (g_hooks.sessionRunning && g_hooks.sessionRunning()) {
    fail("session_running", "Termina el doblaje antes de instalar la actualización.");
    return;
  }
  Manifest m;
  std::wstring path;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_state.state != "ready" || g_state.installerPath.empty()) {
      fail("not_ready", "No hay ninguna actualización lista para instalar.");
      return;
    }
    m = g_state.available;
    path = g_state.installerPath;
  }
  // Mientras se vuelve a verificar y se lanza, nadie puede modificar ni borrar el archivo.
  HANDLE guard = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (guard == INVALID_HANDLE_VALUE) {
    fail("missing", "El instalador descargado ya no está; se volverá a descargar.");
    SetEvent(g_wake);
    return;
  }
  std::string signature, code, message;
  if (!verifyInstaller(path, m, signature, code, message)) {
    CloseHandle(guard);
    {
      std::lock_guard<std::mutex> lock(g_mutex);
      g_state.state = "error";
      g_state.installerPath.clear();
    }
    DeleteFileW(path.c_str());
    setError(code, message);
    fail(code, message);
    return;
  }
  const std::wstring logFile = logging::logsDir() + L"\\installer.log";
  const std::wstring params = L"/S /relaunch /log=\"" + logFile + L"\"";
  SHELLEXECUTEINFOW sei{};
  sei.cbSize = sizeof(sei);
  sei.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI | SEE_MASK_NOASYNC;
  sei.hwnd = g_hooks.owner;
  sei.lpVerb = envFlag(L"VOXORA_UPDATE_TEST_NO_ELEVATE") ? L"open" : L"runas";
  sei.lpFile = path.c_str();
  sei.lpParameters = params.c_str();
  sei.nShow = SW_SHOWNORMAL;
  const BOOL launched = ShellExecuteExW(&sei);
  const DWORD err = GetLastError();
  CloseHandle(guard);
  if (!launched) {
    if (err == ERROR_CANCELLED) {
      fail("elevation_cancelled", "Se canceló el permiso de administrador. La actualización queda lista para cuando quieras.");
    } else {
      fail("launch_failed", "No se pudo abrir el instalador (error " + std::to_string(err) + ").");
    }
    logging::warn("[updater] no se lanzó el instalador: " + std::to_string(err));
    return;
  }
  if (sei.hProcess) CloseHandle(sei.hProcess);
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_state.applying = true;
  }
  logging::info("[updater] instalador " + m.version + " lanzado; la app se cierra para actualizarse");
  json::Value r;
  r.set("version", m.version).set("launched", true);
  reply(true, r);
  if (g_hooks.quitApp && g_hooks.runOnUi) g_hooks.runOnUi(g_hooks.quitApp);
}

}  // namespace

// ── API pública ───────────────────────────────────────────────────────────────
int compareVersions(const std::string& a, const std::string& b) {
  SemVer va, vb;
  if (!parseSemVer(a, va) || !parseSemVer(b, vb)) return -2;
  if (va.major != vb.major) return va.major < vb.major ? -1 : 1;
  if (va.minor != vb.minor) return va.minor < vb.minor ? -1 : 1;
  if (va.patch != vb.patch) return va.patch < vb.patch ? -1 : 1;
  if (va.pre.empty() || vb.pre.empty()) return va.pre.empty() == vb.pre.empty() ? 0 : (va.pre.empty() ? 1 : -1);
  for (size_t i = 0; i < std::max(va.pre.size(), vb.pre.size()); ++i) {
    if (i >= va.pre.size()) return -1;
    if (i >= vb.pre.size()) return 1;
    const std::string& x = va.pre[i];
    const std::string& y = vb.pre[i];
    const bool nx = x.find_first_not_of("0123456789") == std::string::npos;
    const bool ny = y.find_first_not_of("0123456789") == std::string::npos;
    if (nx && ny) {
      const unsigned long long ix = std::stoull(x), iy = std::stoull(y);
      if (ix != iy) return ix < iy ? -1 : 1;
    } else if (nx != ny) {
      return nx ? -1 : 1;
    } else if (x != y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

bool isValidVersion(const std::string& v) {
  SemVer s;
  return parseSemVer(v, s);
}

bool parseManifest(const std::string& body, Manifest& out, std::string& error) {
  json::Value v;
  try {
    v = json::parse(body);
  } catch (const std::exception& e) {
    error = std::string("JSON inválido (") + e.what() + ")";
    return false;
  }
  if (!v.isObject()) {
    error = "se esperaba un objeto";
    return false;
  }
  out.version = v["version"].asString("");
  out.url = v["url"].asString("");
  out.sha256 = lower(v["sha256"].asString(""));
  out.size = v["size"].isNumber() ? static_cast<uint64_t>(v["size"].asNumber()) : 0;
  out.releaseNotes = v["releaseNotes"].asString("");
  out.minSupportedVersion = v["minSupportedVersion"].asString("");
  out.publishedAt = v["publishedAt"].asString("");
  if (!isValidVersion(out.version)) error = "versión no válida";
  else if (out.url.empty()) error = "falta url";
  else if (out.sha256.size() != 64 || out.sha256.find_first_not_of("0123456789abcdef") != std::string::npos) error = "sha256 no válido";
  else if (out.size == 0 || out.size > kMaxInstallerBytes) error = "tamaño no válido";
  else if (!out.minSupportedVersion.empty() && !isValidVersion(out.minSupportedVersion)) error = "minSupportedVersion no válida";
  if (out.releaseNotes.size() > 4000) out.releaseNotes = out.releaseNotes.substr(0, 4000);
  return error.empty();
}

std::wstring resolveUrl(const std::wstring& base, const std::wstring& ref) {
  if (ref.rfind(L"https://", 0) == 0 || ref.rfind(L"http://", 0) == 0) return ref;
  const size_t schemeEnd = base.find(L"://");
  if (schemeEnd == std::wstring::npos) return ref;
  if (!ref.empty() && ref[0] == L'/') {
    const size_t hostEnd = base.find(L'/', schemeEnd + 3);
    return (hostEnd == std::wstring::npos ? base : base.substr(0, hostEnd)) + ref;
  }
  std::wstring dir = base.substr(0, base.find_first_of(L"?#"));
  dir = dir.substr(0, dir.find_last_of(L'/') + 1);
  return dir + ref;
}

bool isAllowedUrl(const std::wstring& url) {
  Url u;
  if (!crackUrl(url, u)) return false;
  if (u.secure) return true;
  return _wcsicmp(u.host.c_str(), L"127.0.0.1") == 0 || _wcsicmp(u.host.c_str(), L"localhost") == 0;
}

bool sha256File(const std::wstring& file, std::string& hexOut) {
  HANDLE h = CreateFileW(file.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  if (h == INVALID_HANDLE_VALUE) return false;
  Sha256 hash;
  std::vector<char> buf(1024 * 1024);
  DWORD read = 0;
  bool ok = hash.ok();
  while (ok && ReadFile(h, buf.data(), static_cast<DWORD>(buf.size()), &read, nullptr) && read > 0) hash.update(buf.data(), read);
  CloseHandle(h);
  if (!ok) return false;
  hexOut = hash.hex();
  return !hexOut.empty();
}

SignatureInfo verifySignature(const std::wstring& file) {
  SignatureInfo info;
  WINTRUST_FILE_INFO fileInfo{};
  fileInfo.cbStruct = sizeof(fileInfo);
  fileInfo.pcwszFilePath = file.c_str();
  WINTRUST_DATA data{};
  data.cbStruct = sizeof(data);
  data.dwUIChoice = WTD_UI_NONE;
  data.fdwRevocationChecks = WTD_REVOKE_NONE;  // sin red: el firmante se fija por thumbprint
  data.dwUnionChoice = WTD_CHOICE_FILE;
  data.pFile = &fileInfo;
  data.dwStateAction = WTD_STATEACTION_VERIFY;
  data.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL;
  GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  const LONG status = WinVerifyTrust(static_cast<HWND>(INVALID_HANDLE_VALUE), &action, &data);
  if (status == ERROR_SUCCESS) {
    info.signedValid = true;
    CRYPT_PROVIDER_DATA* provider = WTHelperProvDataFromStateData(data.hWVTStateData);
    CRYPT_PROVIDER_SGNR* signer = provider ? WTHelperGetProvSignerFromChain(provider, 0, FALSE, 0) : nullptr;
    CRYPT_PROVIDER_CERT* cert = signer ? WTHelperGetProvCertFromChain(signer, 0) : nullptr;
    if (cert && cert->pCert) {
      BYTE sha1[20];
      DWORD size = sizeof(sha1);
      if (CertGetCertificateContextProperty(cert->pCert, CERT_SHA1_HASH_PROP_ID, sha1, &size)) {
        wchar_t hex[3];
        for (DWORD i = 0; i < size; ++i) {
          swprintf_s(hex, L"%02X", sha1[i]);
          info.thumbprint += hex;
        }
      }
      wchar_t name[256];
      if (CertGetNameStringW(cert->pCert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, nullptr, name, static_cast<DWORD>(std::size(name))) > 1) {
        info.subject = name;
      }
    }
    info.trustedSigner = isTrustedThumbprint(info.thumbprint);
    if (!info.trustedSigner) info.error = L"firmante no reconocido: " + info.thumbprint;
  } else {
    wchar_t buf[64];
    swprintf_s(buf, L"WinVerifyTrust 0x%08lX", static_cast<unsigned long>(status));
    info.error = status == TRUST_E_NOSIGNATURE ? std::wstring(L"sin firma") : std::wstring(buf);
  }
  data.dwStateAction = WTD_STATEACTION_CLOSE;
  WinVerifyTrust(static_cast<HWND>(INVALID_HANDLE_VALUE), &action, &data);
  return info;
}

std::wstring updatesDir() {
  static const std::wstring dir = [] {
    std::wstring d = envVar(L"VOXORA_UPDATE_DIR");
    if (d.empty()) {
      const std::wstring logs = logging::logsDir();  // …\VOXORA Meet\logs
      d = logs.substr(0, logs.find_last_of(L'\\')) + L"\\updates";
    }
    SHCreateDirectoryExW(nullptr, d.c_str(), nullptr);
    return d;
  }();
  return dir;
}

const char* currentVersion() { return VOXORA_VERSION_STR; }

void start(Hooks hooks) {
  if (g_started) return;
  g_started = true;
  g_hooks = std::move(hooks);
  const std::wstring feedOverride = envVar(L"VOXORA_UPDATE_FEED");
  g_feed = feedOverride.empty() ? std::wstring(kDefaultFeed) : feedOverride;
  g_allowUnsigned = envFlag(L"VOXORA_UPDATE_ALLOW_UNSIGNED");
  // Solo la app instalada se actualiza sola (el árbol de desarrollo no tiene desinstalador al lado).
  const bool installed = fileExists(exeDir() + L"\\VoxoraMeetUninstall.exe");
  std::string reason;
  if (envFlag(L"VOXORA_UPDATE_DISABLE")) reason = "Las actualizaciones automáticas están desactivadas (VOXORA_UPDATE_DISABLE).";
  else if (!installed && feedOverride.empty()) reason = "Las actualizaciones automáticas solo funcionan en la app instalada.";
  else if (!isAllowedUrl(g_feed)) reason = "El canal de actualizaciones configurado no es HTTPS.";
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_state.state = reason.empty() ? "idle" : "disabled";
    g_state.reason = reason;
  }
  if (!reason.empty()) {
    logging::info("[updater] " + reason);
    return;
  }
  if (g_allowUnsigned) logging::warn("[updater] VOXORA_UPDATE_ALLOW_UNSIGNED=1: se aceptan instaladores sin firma");
  logging::info("[updater] canal " + toUtf8(g_feed));
  g_stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  g_wake = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  const DWORD delay = envMs(L"VOXORA_UPDATE_DELAY_MS", kDefaultDelayMs);
  const DWORD interval = std::max<DWORD>(60'000, envMs(L"VOXORA_UPDATE_INTERVAL_MS", kDefaultIntervalMs));
  g_running = true;
  g_thread = std::thread([delay, interval] { threadMain(delay, interval); });
}

void stop() {
  if (!g_running.exchange(false)) return;
  SetEvent(g_stop);
  if (!g_thread.joinable()) return;
  // Una descarga en curso se corta en el siguiente bloque; una conexión colgada puede tardar hasta el
  // timeout de WinHTTP: no se retiene la salida de la app por eso (el hilo solo toca estado del heap).
  if (WaitForSingleObject(static_cast<HANDLE>(g_thread.native_handle()), 3000) == WAIT_OBJECT_0) {
    g_thread.join();
    CloseHandle(g_stop);
    CloseHandle(g_wake);
    g_stop = g_wake = nullptr;
  } else {
    logging::warn("[updater] el hilo sigue ocupado en la red; se desengancha al salir");
    g_thread.detach();
  }
}

json::Value status() {
  std::lock_guard<std::mutex> lock(g_mutex);
  return statusLocked();
}

bool handleNative(const std::string& cmd, const json::Value& params, std::function<void(bool, const json::Value&)> reply) {
  (void)params;
  if (cmd == "native.logs.open") {
    const bool ok = logging::openLogsFolder();
    json::Value r;
    r.set("path", toUtf8(logging::logsDir()));
    if (ok) {
      reply(true, r);
    } else {
      json::Value e;
      e.set("code", "open_failed").set("message", "No se pudo abrir la carpeta de registros.");
      reply(false, e);
    }
    return true;
  }
  if (cmd == "native.update.status") {
    json::Value s = status();
    s.set("logsDir", toUtf8(logging::logsDir()));
    reply(true, s);
    return true;
  }
  if (cmd == "native.update.check") {
    if (g_running) {
      SetEvent(g_wake);
      std::lock_guard<std::mutex> lock(g_mutex);
      if (g_state.state != "ready" && g_state.state != "downloading") g_state.state = "checking";
    }
    reply(true, status());
    return true;
  }
  if (cmd == "native.update.dismiss") {
    {
      std::lock_guard<std::mutex> lock(g_mutex);
      g_state.dismissed = true;
    }
    reply(true, status());
    notify();
    return true;
  }
  if (cmd == "native.update.apply") {
    applyUpdate(reply);
    return true;
  }
  return false;
}

}  // namespace voxora::updater
