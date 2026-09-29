// Actualizaciones automáticas de VOXORA Meet (S3 de MEGA, lectura pública por HTTPS).
//
// Canal: `latest.json` en https://s3.g.megas4.com/voixa/voxora-meet-updates/ con
//   { version, url, sha256, size, releaseNotes, minSupportedVersion, publishedAt }
// (`url` absoluta o relativa al manifiesto). Lo genera y sube scripts/publish.mjs.
//
// Flujo: 30 s después de arrancar y luego cada 6 h se descarga el manifiesto; si hay una versión
// mayor se baja el instalador en segundo plano a %LOCALAPPDATA%\VOXORA Meet\updates, se verifica
// tamaño + SHA256 + firma Authenticode (WinVerifyTrust y firmante = thumbprint de docs/SIGNING.md)
// y se avisa a la UI (evento nativo `update`). La UI pregunta «Reiniciar ahora / Más tarde» y nunca
// durante una sesión de doblaje; al aceptar se vuelve a verificar el archivo, se lanza elevado con
// `/S /relaunch` y la app sale (el instalador la reabre al terminar).
//
// Variables de entorno (desarrollo y pruebas):
//   VOXORA_UPDATE_FEED=<url de latest.json>   otro canal (http solo para 127.0.0.1/localhost)
//   VOXORA_UPDATE_ALLOW_UNSIGNED=1            acepta instaladores sin firma (builds de desarrollo)
//   VOXORA_UPDATE_DISABLE=1                   no busca actualizaciones
//   VOXORA_UPDATE_DELAY_MS / _INTERVAL_MS     primera comprobación / periodo (30 s / 6 h)
//   VOXORA_UPDATE_TEST_NO_ELEVATE=1           lanza el instalador sin «runas» (solo pruebas)
//   VOXORA_UPDATE_DIR=<carpeta>               carpeta de descargas (pruebas)
#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <cstdint>
#include <functional>
#include <string>

#include "json.h"

namespace voxora::updater {

struct Hooks {
  // Ejecuta en el hilo de UI (en el shell: runOnUi). Obligatorio.
  std::function<void(std::function<void()>)> runOnUi;
  // Estado nuevo (hilo de UI): el shell lo reenvía como evento nativo `update`.
  std::function<void(const json::Value& status)> onStatus;
  // ¿Hay una sesión de doblaje en curso? (hilo de UI). Nunca se instala durante una.
  std::function<bool()> sessionRunning;
  // Cierra la app limpiamente (hilo de UI) tras lanzar el instalador.
  std::function<void()> quitApp;
  // Ventana dueña del aviso de UAC (opcional).
  HWND owner = nullptr;
};

struct Manifest {
  std::string version;
  std::string url;
  std::string sha256;  // hex en minúsculas
  uint64_t size = 0;
  std::string releaseNotes;
  std::string minSupportedVersion;
  std::string publishedAt;
};

// -1 / 0 / 1 según semver 2.0 (el prerelease precede a la final). Versión inválida → -2.
int compareVersions(const std::string& a, const std::string& b);
bool isValidVersion(const std::string& v);
bool parseManifest(const std::string& body, Manifest& out, std::string& error);
// Resuelve `ref` (absoluta o relativa) contra la URL del manifiesto.
std::wstring resolveUrl(const std::wstring& base, const std::wstring& ref);
// https siempre; http solo hacia 127.0.0.1 / localhost (servidor de pruebas).
bool isAllowedUrl(const std::wstring& url);

struct SignatureInfo {
  bool signedValid = false;   // WinVerifyTrust aceptó la firma
  bool trustedSigner = false; // y el firmante es uno de los thumbprints de VOXORA
  std::wstring thumbprint;    // SHA1 del certificado firmante (hex mayúsculas)
  std::wstring subject;
  std::wstring error;
};
SignatureInfo verifySignature(const std::wstring& file);
bool sha256File(const std::wstring& file, std::string& hexOut);

std::wstring updatesDir();
const char* currentVersion();

void start(Hooks hooks);
void stop();
json::Value status();

// native.update.status | native.update.check | native.update.apply | native.update.dismiss |
// native.logs.open. Devuelve false si `cmd` no es suyo. `reply` puede llamarse más tarde (hilo de UI).
bool handleNative(const std::string& cmd, const json::Value& params, std::function<void(bool, const json::Value&)> reply);

}  // namespace voxora::updater
