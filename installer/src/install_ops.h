// Operaciones del instalador: extraer la carga útil, registrar la cámara virtual, accesos directos,
// entrada en «Aplicaciones instaladas», desinstalación, cierre de la app y relanzamiento sin elevación.
#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "common.h"
#include "payload.h"

namespace vxsetup {

struct Payload {
  const uint8_t* data = nullptr;
  size_t size = 0;
  std::string expectedSha256;  // recurso PAYLOAD_SHA256
  PayloadIndex index;
  bool present() const { return data != nullptr; }
};

// Lee los recursos PAYLOAD / PAYLOAD_SHA256 del propio exe (el desinstalador no los tiene).
bool loadPayload(Payload& payload, std::wstring& error);
bool verifyPayloadHash(const Payload& payload, std::wstring& error);

// percent 0–100, step = identificador de fase (verify|close|files|cleanup|camera|shortcuts|registry|done),
// detail = texto para la UI.
using Progress = std::function<void(double percent, const std::string& step, const std::wstring& detail)>;

struct InstallOptions {
  std::wstring dir;
  bool desktopShortcut = true;
};

struct VirtualMicInfo {
  bool present = false;
  bool ownDriver = false;  // «VOXORA Meet Speaker»
  std::wstring name;
};

struct OpResult {
  bool ok = false;
  std::wstring error;
  bool cameraRegistered = false;
  std::wstring cameraMessage;
  bool rebootNeeded = false;  // quedó algún archivo en uso para borrar al reiniciar
  VirtualMicInfo virtualMic;
};

OpResult runInstall(const InstallOptions& options, const Payload& payload, const Progress& progress);
OpResult runUninstall(const std::wstring& dir, bool purgeUserData, const Progress& progress);
// Solo extrae (sin registro, accesos ni cámara): /extract <dir>.
OpResult extractOnly(const Payload& payload, const std::wstring& dir, const Progress& progress);

std::wstring defaultInstallDir();
std::wstring installedDir();      // del registro ('' si no hay)
std::wstring installedVersion();  // del registro
uint64_t freeSpaceFor(const std::wstring& dir);
bool isProgramFilesPath(const std::wstring& dir);
std::wstring normalizeDir(const std::wstring& dir);  // ruta absoluta sin barra final; '' si no es válida

// Cierra VOXORA Meet si está abierto (pide salir; si no responde, lo termina) y los procesos que
// sigan corriendo desde `installDir`. Devuelve si estaba abierto.
bool closeRunningApp(const std::wstring& installDir, const Progress& progress);
bool isAppRunning();

// Lanza con el token del usuario del escritorio (no elevado) a través del Explorador.
bool launchUnelevated(const std::wstring& file, const std::wstring& args, const std::wstring& workDir);
bool openUrl(const std::wstring& url);

VirtualMicInfo detectVirtualMic();

// Diálogo de carpeta (IFileOpenDialog con FOS_PICKFOLDERS).
std::wstring pickFolder(HWND owner, const std::wstring& initial);

// Runtime de WebView2: versión instalada ('' si falta) y bootstrapper Evergreen (descarga + /silent /install).
std::wstring webView2Version();
bool installWebView2(std::wstring& error);

}  // namespace vxsetup
