// Constantes y utilidades del instalador de VOXORA Meet (VoxoraMeetSetup.exe / VoxoraMeetUninstall.exe).
#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <cstdint>
#include <string>

namespace vxsetup {

inline constexpr wchar_t kProductName[] = L"VOXORA Meet";
inline constexpr wchar_t kPublisher[] = L"VOXORA";
inline constexpr wchar_t kWebsite[] = L"https://tryvoxora.live";
inline constexpr wchar_t kUninstallKey[] = L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\VOXORA Meet";
inline constexpr wchar_t kProductKey[] = L"SOFTWARE\\VOXORA\\VOXORA Meet";
inline constexpr wchar_t kAppExe[] = L"VoxoraMeet.exe";
inline constexpr wchar_t kUninstallerExe[] = L"VoxoraMeetUninstall.exe";
inline constexpr wchar_t kVCamHostExe[] = L"VoxoraMeetVCamHost.exe";
inline constexpr wchar_t kVCamDll[] = L"VoxoraMeetVCam.dll";
inline constexpr wchar_t kManifestFile[] = L"install-manifest.txt";
inline constexpr wchar_t kAppWindowClass[] = L"VoxoraMeetMain";
inline constexpr wchar_t kAppMutex[] = L"Local\\VoxoraMeetShellSingleInstance";
inline constexpr UINT kAppQuitCommand = 1003;  // IDM_TRAY_QUIT del shell (app/native-shell/src/main.cpp)
inline constexpr wchar_t kShortcutName[] = L"VOXORA Meet.lnk";
inline constexpr wchar_t kVbCableUrl[] = L"https://vb-audio.com/Cable/";
inline constexpr wchar_t kWebView2Bootstrapper[] = L"https://go.microsoft.com/fwlink/p/?LinkId=2124703";

// Registro del instalador: /log=<archivo> o %TEMP%\VoxoraMeetSetup.log.
void logInit(const std::wstring& file);
void logLine(const std::wstring& line);
std::wstring logPath();

std::wstring exePath();
std::wstring dirOf(const std::wstring& path);
bool fileExists(const std::wstring& path);
bool dirExists(const std::wstring& path);
std::wstring knownFolder(const GUID& id);
std::wstring tempDir();
bool isElevated();
std::wstring formatBytes(uint64_t bytes);

}  // namespace vxsetup
