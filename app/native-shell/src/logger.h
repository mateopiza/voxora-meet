// Registro a archivo del shell y volcado de memoria (minidump) si el proceso cae.
//
//   %LOCALAPPDATA%\VOXORA Meet\logs\shell.log      (rota a 2 MiB; conserva shell.1.log … shell.4.log)
//   %LOCALAPPDATA%\VOXORA Meet\logs\engine.log     (lo escribe el propio motor Node)
//   %LOCALAPPDATA%\VOXORA Meet\logs\crash-shell-<fecha>-<pid>.dmp   (se conservan los 5 más recientes)
//
// Todo lo escrito se refleja también en OutputDebugString. Seguro para usar desde cualquier hilo.
#pragma once

#include <string>

namespace voxora::logging {

// Carpeta de registros (se crea si falta). Válida aun antes de init().
std::wstring logsDir();

// Abre `<logsDir>\<baseName>.log`. Idempotente.
void init(const std::wstring& baseName = L"shell");
void shutdown();

void write(const char* level, const std::string& utf8Message);
inline void info(const std::string& m) { write("INFO", m); }
inline void warn(const std::string& m) { write("WARN", m); }
inline void error(const std::string& m) { write("ERROR", m); }
void infoW(const std::wstring& m);
void warnW(const std::wstring& m);
void errorW(const std::wstring& m);

// SetUnhandledExceptionFilter + manejadores del CRT (parámetro inválido, llamada virtual pura,
// abort, terminate): escriben un minidump en logsDir() y una línea en el registro antes de salir.
void installCrashHandler(const wchar_t* dumpPrefix = L"crash-shell");

// Copia al registro las líneas de OutputDebugString con prefijo "[módulo] …" (las que usa el shell
// para sus diagnósticos), sin depender de un depurador adjunto.
void captureDebugOutput();

// init(baseName) + installCrashHandler(L"crash-<baseName>") + captureDebugOutput() + línea inicial.
void startForProcess(const std::wstring& baseName, const std::string& banner);

// Abre la carpeta de registros en el Explorador.
bool openLogsFolder();

}  // namespace voxora::logging
