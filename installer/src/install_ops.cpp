#include "install_ops.h"

#include <objbase.h>
#include <aclapi.h>
#include <exdisp.h>
#include <mmdeviceapi.h>
#include <propsys.h>
#include <sddl.h>
#include <shellapi.h>
#include <shldisp.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <softpub.h>
#include <tlhelp32.h>
#include <urlmon.h>
#include <wintrust.h>
#include <wrl/client.h>

#include <WebView2.h>

#include <algorithm>
#include <cstdio>
#include <cwctype>
#include <mutex>
#include <set>
#include <vector>

#include "voxora_version.h"

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "urlmon.lib")
#pragma comment(lib, "wintrust.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "version.lib")

using Microsoft::WRL::ComPtr;

namespace vxsetup {

// ── Utilidades comunes ────────────────────────────────────────────────────────
namespace {
std::mutex g_logMutex;
std::wstring g_logPath;
HANDLE g_logFile = INVALID_HANDLE_VALUE;
constexpr wchar_t kVCamClsidKey[] = L"SOFTWARE\\Classes\\CLSID\\{7A1E5C3B-0F4D-4B8A-9C2E-3D6F1B8E5A70}";
// PKEY_Device_FriendlyName (functiondiscoverykeys_devpkey.h) sin arrastrar esa cabecera.
const PROPERTYKEY kFriendlyName = {{0xa45c254e, 0xdf1c, 0x4efd, {0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0}}, 14};

std::wstring lowerCopy(std::wstring s) {
  std::transform(s.begin(), s.end(), s.begin(), [](wchar_t c) { return static_cast<wchar_t>(towlower(c)); });
  return s;
}

bool startsWithNoCase(const std::wstring& s, const std::wstring& prefix) {
  return s.size() >= prefix.size() && _wcsnicmp(s.c_str(), prefix.c_str(), prefix.size()) == 0;
}
}  // namespace

void logInit(const std::wstring& file) {
  std::lock_guard<std::mutex> lock(g_logMutex);
  g_logPath = file.empty() ? tempDir() + L"\\VoxoraMeetSetup.log" : file;
  SHCreateDirectoryExW(nullptr, dirOf(g_logPath).c_str(), nullptr);
  g_logFile = CreateFileW(g_logPath.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS,
                          FILE_ATTRIBUTE_NORMAL, nullptr);
}

void logLine(const std::wstring& line) {
  SYSTEMTIME st;
  GetLocalTime(&st);
  wchar_t ts[48];
  swprintf_s(ts, L"%04u-%02u-%02u %02u:%02u:%02u.%03u [setup %lu] ", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute,
             st.wSecond, st.wMilliseconds, GetCurrentProcessId());
  const std::string text = toUtf8(ts + line + L"\r\n");
  OutputDebugStringW((L"[setup] " + line + L"\n").c_str());
  std::lock_guard<std::mutex> lock(g_logMutex);
  if (g_logFile == INVALID_HANDLE_VALUE) return;
  DWORD written = 0;
  WriteFile(g_logFile, text.data(), static_cast<DWORD>(text.size()), &written, nullptr);
}

std::wstring logPath() { return g_logPath; }

std::wstring exePath() {
  wchar_t buf[MAX_PATH * 2];
  const DWORD n = GetModuleFileNameW(nullptr, buf, static_cast<DWORD>(std::size(buf)));
  return std::wstring(buf, n);
}

std::wstring dirOf(const std::wstring& path) {
  const size_t slash = path.find_last_of(L"\\/");
  return slash == std::wstring::npos ? L"." : path.substr(0, slash);
}

bool fileExists(const std::wstring& path) {
  const DWORD a = GetFileAttributesW(path.c_str());
  return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

bool dirExists(const std::wstring& path) {
  const DWORD a = GetFileAttributesW(path.c_str());
  return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY);
}

std::wstring knownFolder(const GUID& id) {
  PWSTR p = nullptr;
  std::wstring out;
  if (SUCCEEDED(SHGetKnownFolderPath(id, 0, nullptr, &p)) && p) out = p;
  CoTaskMemFree(p);
  return out;
}

std::wstring tempDir() {
  wchar_t buf[MAX_PATH + 1];
  const DWORD n = GetTempPathW(MAX_PATH + 1, buf);
  std::wstring t(buf, n);
  while (!t.empty() && (t.back() == L'\\' || t.back() == L'/')) t.pop_back();
  return t;
}

bool isElevated() {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  TOKEN_ELEVATION e{};
  DWORD size = sizeof(e);
  const bool ok = GetTokenInformation(token, TokenElevation, &e, size, &size) && e.TokenIsElevated;
  CloseHandle(token);
  return ok;
}

std::wstring formatBytes(uint64_t bytes) {
  wchar_t buf[32];
  if (bytes >= 1024ull * 1024 * 1024) swprintf_s(buf, L"%.1f GB", static_cast<double>(bytes) / (1024.0 * 1024 * 1024));
  else swprintf_s(buf, L"%.0f MB", static_cast<double>(bytes) / (1024.0 * 1024));
  return buf;
}

// ── Carga útil ────────────────────────────────────────────────────────────────
bool loadPayload(Payload& payload, std::wstring& error) {
  HRSRC res = FindResourceW(nullptr, L"PAYLOAD", MAKEINTRESOURCEW(10) /* RT_RCDATA */);
  if (!res) return false;  // desinstalador: sin carga útil
  HGLOBAL mem = LoadResource(nullptr, res);
  payload.data = static_cast<const uint8_t*>(LockResource(mem));
  payload.size = SizeofResource(nullptr, res);
  HRSRC shaRes = FindResourceW(nullptr, L"PAYLOAD_SHA256", MAKEINTRESOURCEW(10));
  if (shaRes) {
    const char* sha = static_cast<const char*>(LockResource(LoadResource(nullptr, shaRes)));
    payload.expectedSha256.assign(sha, std::min<DWORD>(SizeofResource(nullptr, shaRes), 64));
  }
  if (!payload.data || payload.expectedSha256.size() != 64) {
    error = L"El instalador está incompleto (falta la carga útil o su huella).";
    payload.data = nullptr;
    return false;
  }
  if (!parsePayload(payload.data, payload.size, payload.index, error)) {
    payload.data = nullptr;
    return false;
  }
  return true;
}

bool verifyPayloadHash(const Payload& payload, std::wstring& error) {
  const std::string actual = sha256Hex(payload.data, payload.size);
  if (actual != payload.expectedSha256) {
    error = L"El instalador está dañado: la huella SHA256 de su contenido no coincide. Descárgalo de nuevo.";
    logLine(L"SHA256 de la carga útil: esperado " + toWide(payload.expectedSha256) + L", obtenido " + toWide(actual));
    return false;
  }
  logLine(L"SHA256 de la carga útil verificado: " + toWide(actual));
  return true;
}

// ── Rutas ─────────────────────────────────────────────────────────────────────
std::wstring defaultInstallDir() {
  std::wstring pf = knownFolder(FOLDERID_ProgramFiles);
  if (pf.empty()) pf = L"C:\\Program Files";
  return pf + L"\\" + kProductName;
}

namespace {
std::wstring regString(HKEY root, const wchar_t* key, const wchar_t* name) {
  wchar_t buf[1024];
  DWORD size = sizeof(buf);
  if (RegGetValueW(root, key, name, RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY, nullptr, buf, &size) != ERROR_SUCCESS) return L"";
  return buf;
}
}  // namespace

std::wstring installedDir() { return regString(HKEY_LOCAL_MACHINE, kProductKey, L"InstallDir"); }
std::wstring installedVersion() { return regString(HKEY_LOCAL_MACHINE, kProductKey, L"Version"); }

std::wstring normalizeDir(const std::wstring& dir) {
  std::wstring d = dir;
  while (!d.empty() && (d.back() == L' ' || d.back() == L'\t')) d.pop_back();
  while (!d.empty() && (d.front() == L' ' || d.front() == L'"')) d.erase(d.begin());
  while (!d.empty() && d.back() == L'"') d.pop_back();
  if (d.size() < 3 || d[1] != L':' || (d[2] != L'\\' && d[2] != L'/')) return L"";
  wchar_t buf[MAX_PATH * 2];
  const DWORD n = GetFullPathNameW(d.c_str(), static_cast<DWORD>(std::size(buf)), buf, nullptr);
  if (n == 0 || n >= std::size(buf)) return L"";
  std::wstring full(buf, n);
  while (full.size() > 3 && (full.back() == L'\\' || full.back() == L'/')) full.pop_back();
  if (full.size() <= 3) return L"";  // nunca la raíz de una unidad
  if (full.find_first_of(L"<>|?*") != std::wstring::npos) return L"";
  // Carpetas del sistema: no.
  const std::wstring win = knownFolder(FOLDERID_Windows);
  if (!win.empty() && startsWithNoCase(full, win)) return L"";
  return full;
}

bool isProgramFilesPath(const std::wstring& dir) {
  const std::wstring pf = knownFolder(FOLDERID_ProgramFiles);
  return !pf.empty() && startsWithNoCase(dir + L"\\", pf + L"\\");
}

uint64_t freeSpaceFor(const std::wstring& dir) {
  std::wstring probe = dir;
  while (!probe.empty() && !dirExists(probe)) {
    const size_t slash = probe.find_last_of(L'\\');
    if (slash == std::wstring::npos || slash < 2) break;
    probe = probe.substr(0, slash);
  }
  if (probe.size() == 2) probe += L"\\";
  ULARGE_INTEGER freeBytes{};
  if (!GetDiskFreeSpaceExW(probe.c_str(), &freeBytes, nullptr, nullptr)) return 0;
  return freeBytes.QuadPart;
}

// ── Archivos ──────────────────────────────────────────────────────────────────
namespace {

bool g_rebootNeeded = false;

// Borra un archivo; si está en uso lo renombra y lo programa para borrarse al reiniciar.
bool removeFile(const std::wstring& path) {
  if (!fileExists(path)) return true;
  SetFileAttributesW(path.c_str(), FILE_ATTRIBUTE_NORMAL);
  if (DeleteFileW(path.c_str())) return true;
  const std::wstring old = path + L".vxold-" + std::to_wstring(GetTickCount64());
  if (MoveFileExW(path.c_str(), old.c_str(), MOVEFILE_REPLACE_EXISTING)) {
    if (!DeleteFileW(old.c_str())) {
      MoveFileExW(old.c_str(), nullptr, MOVEFILE_DELAY_UNTIL_REBOOT);
      g_rebootNeeded = true;
    }
    return true;
  }
  MoveFileExW(path.c_str(), nullptr, MOVEFILE_DELAY_UNTIL_REBOOT);
  g_rebootNeeded = true;
  logLine(L"En uso, se borrará al reiniciar: " + path);
  return false;
}

// Coloca `tmp` en `target`; si `target` está en uso (DLL cargada por el FrameServer), lo aparta.
bool replaceFile(const std::wstring& tmp, const std::wstring& target, std::wstring& error) {
  if (MoveFileExW(tmp.c_str(), target.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) return true;
  const DWORD err = GetLastError();
  if (fileExists(target)) {
    const std::wstring old = target + L".vxold-" + std::to_wstring(GetTickCount64());
    if (MoveFileExW(target.c_str(), old.c_str(), 0) && MoveFileExW(tmp.c_str(), target.c_str(), MOVEFILE_WRITE_THROUGH)) {
      if (!DeleteFileW(old.c_str())) {
        MoveFileExW(old.c_str(), nullptr, MOVEFILE_DELAY_UNTIL_REBOOT);
        g_rebootNeeded = true;
      }
      logLine(L"Reemplazado en uso: " + target);
      return true;
    }
  }
  error = L"No se pudo escribir " + target + L" (error " + std::to_wstring(err) + L").";
  return false;
}

void cleanupLeftovers(const std::wstring& dir) {
  WIN32_FIND_DATAW fd{};
  HANDLE find = FindFirstFileW((dir + L"\\*").c_str(), &fd);
  if (find == INVALID_HANDLE_VALUE) return;
  do {
    const std::wstring name = fd.cFileName;
    if (name == L"." || name == L"..") continue;
    const std::wstring full = dir + L"\\" + name;
    if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) cleanupLeftovers(full);
    else if (name.find(L".vxold-") != std::wstring::npos || (name.size() > 6 && name.substr(name.size() - 6) == L".vxnew")) DeleteFileW(full.c_str());
  } while (FindNextFileW(find, &fd));
  FindClose(find);
}

// Quita directorios vacíos de abajo hacia arriba (sin salir de `root`).
void removeEmptyDirs(const std::wstring& dir) {
  WIN32_FIND_DATAW fd{};
  HANDLE find = FindFirstFileW((dir + L"\\*").c_str(), &fd);
  if (find != INVALID_HANDLE_VALUE) {
    do {
      const std::wstring name = fd.cFileName;
      if (name != L"." && name != L".." && (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) removeEmptyDirs(dir + L"\\" + name);
    } while (FindNextFileW(find, &fd));
    FindClose(find);
  }
  RemoveDirectoryW(dir.c_str());
}

void deleteTree(const std::wstring& dir) {
  WIN32_FIND_DATAW fd{};
  HANDLE find = FindFirstFileW((dir + L"\\*").c_str(), &fd);
  if (find != INVALID_HANDLE_VALUE) {
    do {
      const std::wstring name = fd.cFileName;
      if (name == L"." || name == L"..") continue;
      const std::wstring full = dir + L"\\" + name;
      if ((fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) deleteTree(full);
      else if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) RemoveDirectoryW(full.c_str());  // unión: no se sigue
      else removeFile(full);
    } while (FindNextFileW(find, &fd));
    FindClose(find);
  }
  RemoveDirectoryW(dir.c_str());
}

std::vector<std::wstring> readManifest(const std::wstring& dir) {
  std::vector<std::wstring> out;
  HANDLE h = CreateFileW((dir + L"\\" + kManifestFile).c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
  if (h == INVALID_HANDLE_VALUE) return out;
  std::string text;
  char buf[8192];
  DWORD read = 0;
  while (ReadFile(h, buf, sizeof(buf), &read, nullptr) && read > 0 && text.size() < 4 * 1024 * 1024) text.append(buf, read);
  CloseHandle(h);
  size_t pos = 0;
  while (pos < text.size()) {
    size_t end = text.find('\n', pos);
    if (end == std::string::npos) end = text.size();
    std::string line = text.substr(pos, end - pos);
    pos = end + 1;
    while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
    if (line.empty() || line[0] == '#') continue;
    const std::wstring rel = toWide(line);
    if (rel.find(L"..") != std::wstring::npos || rel.find(L':') != std::wstring::npos || rel[0] == L'\\') continue;
    out.push_back(rel);
  }
  return out;
}

bool writeManifest(const std::wstring& dir, const std::vector<std::wstring>& files) {
  std::string text = "# VOXORA Meet " VOXORA_VERSION_STR " - archivos instalados (lo usa el desinstalador)\r\n";
  for (const auto& f : files) text += toUtf8(f) + "\r\n";
  HANDLE h = CreateFileW((dir + L"\\" + kManifestFile).c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return false;
  DWORD written = 0;
  const bool ok = WriteFile(h, text.data(), static_cast<DWORD>(text.size()), &written, nullptr) && written == text.size();
  CloseHandle(h);
  return ok;
}

// Extrae la carga útil en `dir` archivo por archivo (tmp + reemplazo atómico).
bool extractTo(const Payload& payload, const std::wstring& dir, const std::function<void(uint64_t, uint64_t, const std::wstring&)>& onProgress,
               std::wstring& error) {
  HANDLE current = INVALID_HANDLE_VALUE;
  std::wstring currentTmp, currentTarget;
  FileSink sink;
  sink.begin = [&](const PayloadEntry& e, std::wstring& err) {
    currentTarget = dir + L"\\" + e.path;
    currentTmp = currentTarget + L".vxnew";
    SHCreateDirectoryExW(nullptr, dirOf(currentTarget).c_str(), nullptr);
    current = CreateFileW(currentTmp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (current == INVALID_HANDLE_VALUE) {
      err = L"No se pudo crear " + currentTarget + L" (error " + std::to_wstring(GetLastError()) + L").";
      return false;
    }
    return true;
  };
  sink.write = [&](const uint8_t* bytes, size_t n, std::wstring& err) {
    size_t pos = 0;
    while (pos < n) {
      DWORD written = 0;
      const DWORD chunk = static_cast<DWORD>(std::min<size_t>(n - pos, 1u << 24));
      if (!WriteFile(current, bytes + pos, chunk, &written, nullptr) || written == 0) {
        err = GetLastError() == ERROR_DISK_FULL ? L"No hay espacio suficiente en el disco." : L"No se pudo escribir " + currentTarget + L".";
        return false;
      }
      pos += written;
    }
    return true;
  };
  sink.commit = [&](const PayloadEntry&, std::wstring& err) {
    FlushFileBuffers(current);
    CloseHandle(current);
    current = INVALID_HANDLE_VALUE;
    return replaceFile(currentTmp, currentTarget, err);
  };
  sink.abort = [&] {
    if (current != INVALID_HANDLE_VALUE) CloseHandle(current);
    current = INVALID_HANDLE_VALUE;
    DeleteFileW(currentTmp.c_str());
  };
  ULONGLONG last = 0;
  return extractPayload(payload.data, payload.size, payload.index, sink,
                        [&](uint64_t done, uint64_t total, const std::wstring& file) {
                          const ULONGLONG now = GetTickCount64();
                          if (onProgress && (now - last > 80 || done == total)) {
                            last = now;
                            onProgress(done, total, file);
                          }
                          return true;
                        },
                        error);
}

// ── Sistema ──────────────────────────────────────────────────────────────────
DWORD runHidden(const std::wstring& exe, const std::wstring& args, DWORD timeoutMs, std::string* output = nullptr) {
  std::wstring cmd = L"\"" + exe + L"\" " + args;
  std::vector<wchar_t> buf(cmd.begin(), cmd.end());
  buf.push_back(L'\0');
  SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
  HANDLE readPipe = nullptr, writePipe = nullptr;
  if (output) {
    CreatePipe(&readPipe, &writePipe, &sa, 0);
    SetHandleInformation(readPipe, HANDLE_FLAG_INHERIT, 0);
  }
  STARTUPINFOW si{};
  si.cb = sizeof(si);
  if (output) {
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdOutput = writePipe;
    si.hStdError = writePipe;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  }
  PROCESS_INFORMATION pi{};
  if (!CreateProcessW(nullptr, buf.data(), nullptr, nullptr, output ? TRUE : FALSE, CREATE_NO_WINDOW, nullptr,
                      dirOf(exe).c_str(), &si, &pi)) {
    const DWORD err = GetLastError();
    if (output) {
      CloseHandle(readPipe);
      CloseHandle(writePipe);
    }
    logLine(L"No se pudo lanzar " + exe + L" (error " + std::to_wstring(err) + L")");
    return static_cast<DWORD>(-1);
  }
  if (output) {
    CloseHandle(writePipe);
    char chunk[1024];
    DWORD read = 0;
    while (ReadFile(readPipe, chunk, sizeof(chunk), &read, nullptr) && read > 0 && output->size() < 64 * 1024) output->append(chunk, read);
    CloseHandle(readPipe);
  }
  DWORD code = static_cast<DWORD>(-2);
  if (WaitForSingleObject(pi.hProcess, timeoutMs) == WAIT_OBJECT_0) GetExitCodeProcess(pi.hProcess, &code);
  else TerminateProcess(pi.hProcess, 1);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return code;
}

// La DLL de la cámara la carga el FrameServer (svchost, LOCAL SERVICE): fuera de Program Files hay
// que darle lectura explícita a la carpeta.
void grantLocalServiceRead(const std::wstring& dir) {
  PSID sid = nullptr;
  if (!ConvertStringSidToSidW(L"S-1-5-19", &sid)) return;
  PACL oldAcl = nullptr, newAcl = nullptr;
  PSECURITY_DESCRIPTOR sd = nullptr;
  if (GetNamedSecurityInfoW(dir.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &oldAcl, nullptr, &sd) == ERROR_SUCCESS) {
    EXPLICIT_ACCESSW ea{};
    ea.grfAccessPermissions = GENERIC_READ | GENERIC_EXECUTE;
    ea.grfAccessMode = GRANT_ACCESS;
    ea.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
    ea.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    ea.Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
    ea.Trustee.ptstrName = static_cast<LPWSTR>(sid);
    if (SetEntriesInAclW(1, &ea, oldAcl, &newAcl) == ERROR_SUCCESS) {
      const DWORD r = SetNamedSecurityInfoW(const_cast<LPWSTR>(dir.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr,
                                            nullptr, newAcl, nullptr);
      logLine(L"Permiso de lectura para LOCAL SERVICE en " + dir + (r == ERROR_SUCCESS ? L": OK" : L": error " + std::to_wstring(r)));
      LocalFree(newAcl);
    }
    LocalFree(sd);
  }
  LocalFree(sid);
}

bool createShortcut(const std::wstring& linkPath, const std::wstring& target, const std::wstring& workDir, const std::wstring& description) {
  ComPtr<IShellLinkW> link;
  if (FAILED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link)))) return false;
  link->SetPath(target.c_str());
  link->SetWorkingDirectory(workDir.c_str());
  link->SetIconLocation(target.c_str(), 0);
  link->SetDescription(description.c_str());
  ComPtr<IPersistFile> file;
  if (FAILED(link.As(&file))) return false;
  SHCreateDirectoryExW(nullptr, dirOf(linkPath).c_str(), nullptr);
  return SUCCEEDED(file->Save(linkPath.c_str(), TRUE));
}

std::wstring startMenuShortcut() { return knownFolder(FOLDERID_CommonPrograms) + L"\\" + kShortcutName; }
std::wstring desktopShortcut() { return knownFolder(FOLDERID_PublicDesktop) + L"\\" + kShortcutName; }

bool setString(HKEY key, const wchar_t* name, const std::wstring& value) {
  return RegSetValueExW(key, name, 0, REG_SZ, reinterpret_cast<const BYTE*>(value.c_str()),
                        static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t))) == ERROR_SUCCESS;
}

bool setDword(HKEY key, const wchar_t* name, DWORD value) {
  return RegSetValueExW(key, name, 0, REG_DWORD, reinterpret_cast<const BYTE*>(&value), sizeof(value)) == ERROR_SUCCESS;
}

bool writeRegistry(const std::wstring& dir, uint64_t totalBytes, bool desktop) {
  HKEY key = nullptr;
  if (RegCreateKeyExW(HKEY_LOCAL_MACHINE, kUninstallKey, 0, nullptr, 0, KEY_WRITE | KEY_WOW64_64KEY, nullptr, &key, nullptr) != ERROR_SUCCESS) return false;
  SYSTEMTIME st;
  GetLocalTime(&st);
  wchar_t date[16];
  swprintf_s(date, L"%04u%02u%02u", st.wYear, st.wMonth, st.wDay);
  const std::wstring uninstaller = L"\"" + dir + L"\\" + kUninstallerExe + L"\"";
  bool ok = setString(key, L"DisplayName", kProductName) && setString(key, L"DisplayVersion", VOXORA_VERSION_WSTR) &&
            setString(key, L"Publisher", kPublisher) && setString(key, L"DisplayIcon", dir + L"\\" + kAppExe + L",0") &&
            setString(key, L"InstallLocation", dir) && setString(key, L"UninstallString", uninstaller + L" /uninstall") &&
            setString(key, L"QuietUninstallString", uninstaller + L" /uninstall /S") && setString(key, L"InstallDate", date) &&
            setString(key, L"URLInfoAbout", kWebsite) && setString(key, L"Comments", L"Doblaje con tu propia voz para Google Meet") &&
            setDword(key, L"EstimatedSize", static_cast<DWORD>(totalBytes / 1024)) && setDword(key, L"NoModify", 1) &&
            setDword(key, L"NoRepair", 1) && setDword(key, L"VersionMajor", VOXORA_VERSION_MAJOR) &&
            setDword(key, L"VersionMinor", VOXORA_VERSION_MINOR);
  RegCloseKey(key);
  if (RegCreateKeyExW(HKEY_LOCAL_MACHINE, kProductKey, 0, nullptr, 0, KEY_WRITE | KEY_WOW64_64KEY, nullptr, &key, nullptr) != ERROR_SUCCESS) return false;
  ok = setString(key, L"InstallDir", dir) && setString(key, L"Version", VOXORA_VERSION_WSTR) && setDword(key, L"DesktopShortcut", desktop ? 1 : 0) && ok;
  RegCloseKey(key);
  return ok;
}

void deleteRegistry() {
  RegDeleteKeyExW(HKEY_LOCAL_MACHINE, kUninstallKey, KEY_WOW64_64KEY, 0);
  RegDeleteKeyExW(HKEY_LOCAL_MACHINE, kProductKey, KEY_WOW64_64KEY, 0);
  RegDeleteKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\VOXORA", KEY_WOW64_64KEY, 0);  // solo si quedó vacía
}

std::wstring hostFailure(DWORD code) {
  switch (code) {
    case 3: return L"hace falta permiso de administrador";
    case 7: return L"Windows rechazó el registro de la DLL";
    case 8: return L"no se pudo cargar VoxoraMeetVCam.dll";
    default: return L"código " + std::to_wstring(code);
  }
}

bool processImagePath(DWORD pid, std::wstring& path) {
  HANDLE p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!p) return false;
  wchar_t buf[MAX_PATH * 2];
  DWORD size = static_cast<DWORD>(std::size(buf));
  const bool ok = QueryFullProcessImageNameW(p, 0, buf, &size) != FALSE;
  CloseHandle(p);
  if (ok) path.assign(buf, size);
  return ok;
}

// Termina los procesos cuya imagen esté dentro de `dir` (motor node.exe, helpers, host de la cámara).
int killProcessesUnder(const std::wstring& dir, DWORD graceMs) {
  const std::wstring prefix = dir + L"\\";
  int killed = 0;
  const ULONGLONG deadline = GetTickCount64() + graceMs;
  for (;;) {
    std::vector<DWORD> pids;
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return killed;
    PROCESSENTRY32W pe{};
    pe.dwSize = sizeof(pe);
    for (BOOL more = Process32FirstW(snap, &pe); more; more = Process32NextW(snap, &pe)) {
      if (pe.th32ProcessID == GetCurrentProcessId()) continue;
      std::wstring image;
      if (processImagePath(pe.th32ProcessID, image) && startsWithNoCase(image, prefix)) pids.push_back(pe.th32ProcessID);
    }
    CloseHandle(snap);
    if (pids.empty()) return killed;
    if (GetTickCount64() < deadline) {
      Sleep(250);
      continue;
    }
    for (DWORD pid : pids) {
      HANDLE p = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, FALSE, pid);
      if (!p) continue;
      std::wstring image;
      processImagePath(pid, image);
      logLine(L"Terminando proceso " + std::to_wstring(pid) + L" " + image);
      TerminateProcess(p, 1);
      WaitForSingleObject(p, 5000);
      CloseHandle(p);
      ++killed;
    }
    return killed;
  }
}

// Carpetas de datos del usuario del escritorio (no del administrador que elevó, si es otro).
HANDLE desktopUserToken() {
  HWND shell = GetShellWindow();
  DWORD pid = 0;
  if (!shell || !GetWindowThreadProcessId(shell, &pid) || !pid) return nullptr;
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return nullptr;
  HANDLE token = nullptr;
  OpenProcessToken(process, TOKEN_QUERY | TOKEN_IMPERSONATE | TOKEN_DUPLICATE, &token);
  CloseHandle(process);
  return token;
}

std::wstring userFolder(const GUID& id) {
  HANDLE token = desktopUserToken();
  PWSTR p = nullptr;
  std::wstring out;
  if (SUCCEEDED(SHGetKnownFolderPath(id, 0, token, &p)) && p) out = p;
  CoTaskMemFree(p);
  if (token) CloseHandle(token);
  return out.empty() ? knownFolder(id) : out;
}

}  // namespace

bool isAppRunning() {
  if (FindWindowW(kAppWindowClass, nullptr)) return true;
  HANDLE m = OpenMutexW(SYNCHRONIZE, FALSE, kAppMutex);
  if (m) {
    CloseHandle(m);
    return true;
  }
  return false;
}

bool closeRunningApp(const std::wstring& installDir, const Progress& progress) {
  bool wasRunning = false;
  HWND w = FindWindowW(kAppWindowClass, nullptr);
  if (w) {
    wasRunning = true;
    if (progress) progress(-1, "close", L"Cerrando VOXORA Meet…");
    DWORD pid = 0;
    GetWindowThreadProcessId(w, &pid);
    HANDLE p = OpenProcess(SYNCHRONIZE | PROCESS_TERMINATE, FALSE, pid);
    // Salida limpia: el shell detiene el motor, la cámara virtual y la bandeja.
    PostMessageW(w, WM_COMMAND, kAppQuitCommand, 0);
    if (p) {
      if (WaitForSingleObject(p, 15000) != WAIT_OBJECT_0) {
        logLine(L"VOXORA Meet no se cerró a tiempo; se termina");
        TerminateProcess(p, 1);
        WaitForSingleObject(p, 5000);
      }
      CloseHandle(p);
    }
  }
  // Instancia sin ventana todavía (o recién cerrada): se espera a que libere el mutex.
  for (int i = 0; i < 40; ++i) {
    HANDLE m = OpenMutexW(SYNCHRONIZE, FALSE, kAppMutex);
    if (!m) break;
    wasRunning = true;
    CloseHandle(m);
    Sleep(250);
  }
  if (!installDir.empty() && dirExists(installDir)) {
    const int killed = killProcessesUnder(installDir, wasRunning ? 4000 : 0);
    if (killed) logLine(L"Procesos terminados en " + installDir + L": " + std::to_wstring(killed));
  }
  return wasRunning;
}

bool launchUnelevated(const std::wstring& file, const std::wstring& args, const std::wstring& workDir) {
  // Técnica documentada por Raymond Chen: pedirle al Explorador (proceso del usuario, sin elevar) que
  // ejecute el programa con IShellDispatch2::ShellExecute.
  bool ok = false;
  do {
    ComPtr<IShellWindows> windows;
    if (FAILED(CoCreateInstance(CLSID_ShellWindows, nullptr, CLSCTX_LOCAL_SERVER, IID_PPV_ARGS(&windows)))) break;
    VARIANT loc{}, empty{};
    VariantInit(&loc);
    VariantInit(&empty);
    loc.vt = VT_I4;
    loc.lVal = CSIDL_DESKTOP;
    long hwnd = 0;
    ComPtr<IDispatch> disp;
    if (FAILED(windows->FindWindowSW(&loc, &empty, SWC_DESKTOP, &hwnd, SWFO_NEEDDISPATCH, &disp)) || !disp) break;
    ComPtr<IServiceProvider> sp;
    ComPtr<IShellBrowser> browser;
    ComPtr<IShellView> view;
    ComPtr<IDispatch> background;
    ComPtr<IShellFolderViewDual> folderView;
    ComPtr<IDispatch> app;
    ComPtr<IShellDispatch2> shell;
    if (FAILED(disp.As(&sp)) || FAILED(sp->QueryService(SID_STopLevelBrowser, IID_PPV_ARGS(&browser))) ||
        FAILED(browser->QueryActiveShellView(&view)) || FAILED(view->GetItemObject(SVGIO_BACKGROUND, IID_PPV_ARGS(&background))) ||
        FAILED(background.As(&folderView)) || FAILED(folderView->get_Application(&app)) || FAILED(app.As(&shell))) {
      break;
    }
    BSTR bFile = SysAllocString(file.c_str());
    VARIANT vArgs{}, vDir{}, vOp{}, vShow{};
    vArgs.vt = VT_BSTR;
    vArgs.bstrVal = SysAllocString(args.c_str());
    vDir.vt = VT_BSTR;
    vDir.bstrVal = SysAllocString(workDir.c_str());
    vOp.vt = VT_BSTR;
    vOp.bstrVal = SysAllocString(L"open");
    vShow.vt = VT_I4;
    vShow.lVal = SW_SHOWNORMAL;
    ok = SUCCEEDED(shell->ShellExecute(bFile, vArgs, vDir, vOp, vShow));
    SysFreeString(bFile);
    VariantClear(&vArgs);
    VariantClear(&vDir);
    VariantClear(&vOp);
  } while (false);
  if (!ok && !isElevated()) {
    // Sin elevar ya: basta con ShellExecute normal.
    ok = reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr, L"open", file.c_str(), args.empty() ? nullptr : args.c_str(),
                                                 workDir.empty() ? nullptr : workDir.c_str(), SW_SHOWNORMAL)) > 32;
  }
  logLine(std::wstring(ok ? L"Lanzado sin elevación: " : L"No se pudo lanzar sin elevación: ") + file);
  return ok;
}

bool openUrl(const std::wstring& url) {
  if (url.rfind(L"https://", 0) != 0) return false;
  // Nunca un navegador elevado: se abre a través del Explorador del usuario.
  return launchUnelevated(url, L"", L"");
}

VirtualMicInfo detectVirtualMic() {
  VirtualMicInfo info;
  ComPtr<IMMDeviceEnumerator> enumerator;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)))) return info;
  ComPtr<IMMDeviceCollection> devices;
  if (FAILED(enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices))) return info;
  UINT count = 0;
  devices->GetCount(&count);
  for (UINT i = 0; i < count; ++i) {
    ComPtr<IMMDevice> device;
    ComPtr<IPropertyStore> props;
    if (FAILED(devices->Item(i, &device)) || FAILED(device->OpenPropertyStore(STGM_READ, &props))) continue;
    PROPVARIANT name;
    PropVariantInit(&name);
    if (SUCCEEDED(props->GetValue(kFriendlyName, &name)) && name.vt == VT_LPWSTR && name.pwszVal) {
      const std::wstring n = name.pwszVal;
      const std::wstring low = lowerCopy(n);
      if (low.find(L"voxora meet speaker") != std::wstring::npos) {
        info = {true, true, n};
      } else if (!info.present && low.find(L"cable input") != std::wstring::npos) {
        info = {true, false, n};
      }
    }
    PropVariantClear(&name);
  }
  return info;
}

std::wstring pickFolder(HWND owner, const std::wstring& initial) {
  ComPtr<IFileOpenDialog> dialog;
  if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog)))) return L"";
  DWORD options = 0;
  dialog->GetOptions(&options);
  dialog->SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
  dialog->SetTitle(L"Elige dónde instalar VOXORA Meet");
  std::wstring start = initial;
  while (!start.empty() && !dirExists(start)) start = dirOf(start) == start ? L"" : dirOf(start);
  ComPtr<IShellItem> folder;
  if (!start.empty() && SUCCEEDED(SHCreateItemFromParsingName(start.c_str(), nullptr, IID_PPV_ARGS(&folder)))) dialog->SetFolder(folder.Get());
  if (FAILED(dialog->Show(owner))) return L"";
  ComPtr<IShellItem> result;
  if (FAILED(dialog->GetResult(&result))) return L"";
  PWSTR path = nullptr;
  std::wstring out;
  if (SUCCEEDED(result->GetDisplayName(SIGDN_FILESYSPATH, &path)) && path) out = path;
  CoTaskMemFree(path);
  // Si eligió una carpeta cualquiera, se instala en una subcarpeta propia.
  if (!out.empty() && lowerCopy(out).find(L"voxora meet") == std::wstring::npos) out += std::wstring(L"\\") + kProductName;
  return out;
}

std::wstring webView2Version() {
  LPWSTR version = nullptr;
  if (FAILED(GetAvailableCoreWebView2BrowserVersionString(nullptr, &version)) || !version) return L"";
  std::wstring v = version;
  CoTaskMemFree(version);
  return v;
}

bool installWebView2(std::wstring& error) {
  const std::wstring file = tempDir() + L"\\MicrosoftEdgeWebview2Setup-" + std::to_wstring(GetCurrentProcessId()) + L".exe";
  logLine(L"Descargando el bootstrapper de WebView2");
  if (FAILED(URLDownloadToFileW(nullptr, kWebView2Bootstrapper, file.c_str(), 0, nullptr))) {
    error = L"No se pudo descargar Microsoft Edge WebView2 (¿sin conexión?).";
    return false;
  }
  // Solo se ejecuta si lo firmó Microsoft.
  WINTRUST_FILE_INFO fi{};
  fi.cbStruct = sizeof(fi);
  fi.pcwszFilePath = file.c_str();
  WINTRUST_DATA wd{};
  wd.cbStruct = sizeof(wd);
  wd.dwUIChoice = WTD_UI_NONE;
  wd.fdwRevocationChecks = WTD_REVOKE_NONE;
  wd.dwUnionChoice = WTD_CHOICE_FILE;
  wd.pFile = &fi;
  wd.dwStateAction = WTD_STATEACTION_VERIFY;
  GUID action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
  bool trusted = WinVerifyTrust(static_cast<HWND>(INVALID_HANDLE_VALUE), &action, &wd) == ERROR_SUCCESS;
  if (trusted) {
    CRYPT_PROVIDER_DATA* pd = WTHelperProvDataFromStateData(wd.hWVTStateData);
    CRYPT_PROVIDER_SGNR* sg = pd ? WTHelperGetProvSignerFromChain(pd, 0, FALSE, 0) : nullptr;
    CRYPT_PROVIDER_CERT* cert = sg ? WTHelperGetProvCertFromChain(sg, 0) : nullptr;
    wchar_t name[256] = L"";
    if (cert && cert->pCert) CertGetNameStringW(cert->pCert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, nullptr, name, 256);
    trusted = std::wstring(name) == L"Microsoft Corporation";
  }
  wd.dwStateAction = WTD_STATEACTION_CLOSE;
  WinVerifyTrust(static_cast<HWND>(INVALID_HANDLE_VALUE), &action, &wd);
  if (!trusted) {
    DeleteFileW(file.c_str());
    error = L"El instalador de WebView2 descargado no está firmado por Microsoft; se descartó.";
    return false;
  }
  const DWORD code = runHidden(file, L"/silent /install", 10 * 60 * 1000);
  DeleteFileW(file.c_str());
  logLine(L"Bootstrapper de WebView2 terminó con código " + std::to_wstring(code));
  if (webView2Version().empty()) {
    error = L"No se pudo instalar Microsoft Edge WebView2 (código " + std::to_wstring(code) + L").";
    return false;
  }
  return true;
}

// ── Instalar / desinstalar ───────────────────────────────────────────────────
OpResult extractOnly(const Payload& payload, const std::wstring& dir, const Progress& progress) {
  OpResult r;
  if (!verifyPayloadHash(payload, r.error)) return r;
  SHCreateDirectoryExW(nullptr, dir.c_str(), nullptr);
  if (!dirExists(dir)) {
    r.error = L"No se pudo crear " + dir;
    return r;
  }
  r.ok = extractTo(payload, dir,
                   [&](uint64_t done, uint64_t total, const std::wstring&) {
                     if (progress) progress(100.0 * static_cast<double>(done) / static_cast<double>(total ? total : 1), "files", L"Extrayendo…");
                   },
                   r.error);
  return r;
}

OpResult runInstall(const InstallOptions& options, const Payload& payload, const Progress& progress) {
  OpResult r;
  g_rebootNeeded = false;
  auto step = [&](double pct, const char* id, const std::wstring& text) {
    if (progress) progress(pct, id, text);
    logLine(L"[" + std::to_wstring(static_cast<int>(pct)) + L"%] " + text);
  };
  const std::wstring dir = normalizeDir(options.dir);
  if (dir.empty()) {
    r.error = L"La carpeta de instalación no es válida.";
    return r;
  }
  logLine(L"Instalando VOXORA Meet " VOXORA_VERSION_WSTR L" en " + dir);
  step(1, "verify", L"Verificando el paquete…");
  if (!verifyPayloadHash(payload, r.error)) return r;
  if (freeSpaceFor(dir) < payload.index.totalBytes + 16 * 1024 * 1024) {
    r.error = L"No hay espacio suficiente en el disco (hacen falta " + formatBytes(payload.index.totalBytes) + L").";
    return r;
  }

  step(4, "close", L"Preparando la instalación…");
  const std::wstring oldDir = normalizeDir(installedDir());
  closeRunningApp(dir, progress);
  if (!oldDir.empty() && _wcsicmp(oldDir.c_str(), dir.c_str()) != 0) closeRunningApp(oldDir, nullptr);

  SHCreateDirectoryExW(nullptr, dir.c_str(), nullptr);
  if (!dirExists(dir)) {
    r.error = L"No se pudo crear la carpeta " + dir + L".";
    return r;
  }
  cleanupLeftovers(dir);
  const std::vector<std::wstring> previous = readManifest(dir);

  step(6, "files", L"Copiando archivos…");
  if (!extractTo(payload, dir,
                 [&](uint64_t done, uint64_t total, const std::wstring& file) {
                   const double f = static_cast<double>(done) / static_cast<double>(total ? total : 1);
                   if (progress) progress(6 + 80 * f, "files", L"Copiando " + file);
                 },
                 r.error)) {
    logLine(L"Error al extraer: " + r.error);
    return r;
  }

  step(87, "cleanup", L"Quitando restos de la versión anterior…");
  std::set<std::wstring> current;
  std::vector<std::wstring> files;
  for (const auto& e : payload.index.files) {
    current.insert(lowerCopy(e.path));
    files.push_back(e.path);
  }
  for (const auto& rel : previous) {
    if (!current.count(lowerCopy(rel))) removeFile(dir + L"\\" + rel);
  }
  removeEmptyDirs(dir + L"\\engine");
  removeEmptyDirs(dir + L"\\ui");
  if (!writeManifest(dir, files)) logLine(L"No se pudo escribir " + std::wstring(kManifestFile));
  if (!oldDir.empty() && _wcsicmp(oldDir.c_str(), dir.c_str()) != 0 && dirExists(oldDir)) {
    // Se cambió de carpeta: la instalación anterior se retira (sin tocar los datos del usuario).
    for (const auto& rel : readManifest(oldDir)) removeFile(oldDir + L"\\" + rel);
    removeFile(oldDir + L"\\" + kManifestFile);
    removeEmptyDirs(oldDir);
  }
  if (!isProgramFilesPath(dir)) grantLocalServiceRead(dir);

  step(90, "camera", L"Registrando la cámara virtual…");
  const std::wstring host = dir + L"\\" + kVCamHostExe;
  const std::wstring dll = dir + L"\\" + kVCamDll;
  if (fileExists(host) && fileExists(dll)) {
    std::string out;
    const DWORD code = runHidden(host, L"--register-dll \"" + dll + L"\"", 60000, &out);
    r.cameraRegistered = code == 0;
    r.cameraMessage = code == 0 ? L"Cámara virtual «VOXORA Meet Camera» registrada."
                                : L"No se pudo registrar la cámara virtual (" + hostFailure(code) + L").";
    logLine(L"--register-dll → " + std::to_wstring(code) + L" " + toWide(out));
  } else {
    r.cameraMessage = L"Este paquete no incluye la cámara virtual.";
  }

  step(94, "shortcuts", L"Creando accesos directos…");
  const std::wstring app = dir + L"\\" + kAppExe;
  if (!createShortcut(startMenuShortcut(), app, dir, L"Doblaje con tu propia voz para Google Meet")) logLine(L"No se pudo crear el acceso del menú Inicio");
  if (options.desktopShortcut) {
    if (!createShortcut(desktopShortcut(), app, dir, L"Doblaje con tu propia voz para Google Meet")) logLine(L"No se pudo crear el acceso del escritorio");
  } else {
    DeleteFileW(desktopShortcut().c_str());
  }
  SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, nullptr, nullptr);

  step(97, "registry", L"Registrando VOXORA Meet en Windows…");
  if (!writeRegistry(dir, payload.index.totalBytes, options.desktopShortcut)) logLine(L"No se pudo escribir el registro de desinstalación");

  r.virtualMic = detectVirtualMic();
  r.rebootNeeded = g_rebootNeeded;
  step(100, "done", L"VOXORA Meet está instalado.");
  r.ok = true;
  return r;
}

OpResult runUninstall(const std::wstring& dirIn, bool purgeUserData, const Progress& progress) {
  OpResult r;
  g_rebootNeeded = false;
  auto step = [&](double pct, const char* id, const std::wstring& text) {
    if (progress) progress(pct, id, text);
    logLine(L"[" + std::to_wstring(static_cast<int>(pct)) + L"%] " + text);
  };
  const std::wstring dir = normalizeDir(dirIn);
  if (dir.empty() || !dirExists(dir)) {
    r.error = L"No se encontró la carpeta de VOXORA Meet.";
    deleteRegistry();
    return r;
  }
  logLine(L"Desinstalando VOXORA Meet de " + dir + (purgeUserData ? L" (borrando datos del usuario)" : L""));
  step(3, "close", L"Cerrando VOXORA Meet…");
  closeRunningApp(dir, progress);

  step(15, "camera", L"Quitando la cámara virtual…");
  const std::wstring host = dir + L"\\" + kVCamHostExe;
  const std::wstring dll = dir + L"\\" + kVCamDll;
  if (fileExists(host) && fileExists(dll)) {
    const DWORD code = runHidden(host, L"--unregister-dll \"" + dll + L"\"", 60000);
    logLine(L"--unregister-dll → " + std::to_wstring(code));
  }
  // Si la DLL faltaba, se borra el registro del CLSID solo si apunta a esta instalación.
  wchar_t server[MAX_PATH * 2];
  DWORD size = sizeof(server);
  const std::wstring inproc = std::wstring(kVCamClsidKey) + L"\\InprocServer32";
  if (RegGetValueW(HKEY_LOCAL_MACHINE, inproc.c_str(), nullptr, RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY, nullptr, server, &size) == ERROR_SUCCESS &&
      startsWithNoCase(server, dir + L"\\")) {
    RegDeleteTreeW(HKEY_LOCAL_MACHINE, kVCamClsidKey);
  }

  step(30, "shortcuts", L"Quitando accesos directos…");
  DeleteFileW(startMenuShortcut().c_str());
  DeleteFileW(desktopShortcut().c_str());

  step(40, "files", L"Borrando archivos…");
  std::vector<std::wstring> files = readManifest(dir);
  if (files.empty() && fileExists(dir + L"\\" + kAppExe)) {
    // Sin manifiesto: solo lo que instala VOXORA Meet.
    for (const wchar_t* f : {kAppExe, kUninstallerExe, kVCamHostExe, kVCamDll, L"VoxoraMeetFrameWriter.exe", L"wasapi-capture.exe", L"wasapi-render.exe"}) files.push_back(f);
    for (const wchar_t* sub : {L"engine", L"ui", L"node"}) deleteTree(dir + L"\\" + sub);
  }
  const std::wstring self = lowerCopy(exePath());
  for (size_t i = 0; i < files.size(); ++i) {
    const std::wstring full = dir + L"\\" + files[i];
    if (lowerCopy(full) != self) removeFile(full);
    if (progress && (i % 20 == 0)) progress(40 + 45.0 * static_cast<double>(i) / static_cast<double>(files.size()), "files", L"Borrando " + files[i]);
  }
  removeFile(dir + L"\\" + kManifestFile);
  cleanupLeftovers(dir);
  removeEmptyDirs(dir);
  if (dirExists(dir)) {
    MoveFileExW(dir.c_str(), nullptr, MOVEFILE_DELAY_UNTIL_REBOOT);  // se borra al reiniciar si queda vacía
    logLine(L"La carpeta no quedó vacía o está en uso: " + dir);
  }

  step(88, "registry", L"Quitando VOXORA Meet de Windows…");
  deleteRegistry();

  if (purgeUserData) {
    step(94, "data", L"Borrando tus datos…");
    for (const GUID* id : {&FOLDERID_RoamingAppData, &FOLDERID_LocalAppData}) {
      const std::wstring base = userFolder(*id);
      if (!base.empty()) {
        const std::wstring data = base + L"\\" + kProductName;
        if (dirExists(data)) {
          logLine(L"Borrando " + data);
          deleteTree(data);
        }
      }
    }
  }
  r.rebootNeeded = g_rebootNeeded;
  step(100, "done", L"VOXORA Meet se desinstaló.");
  r.ok = true;
  return r;
}

}  // namespace vxsetup
