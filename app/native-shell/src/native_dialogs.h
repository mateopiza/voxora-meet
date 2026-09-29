// Utilidades nativas que expone el puente de la UI: diálogo de selección de
// archivos de audio, duración de archivos (Media Foundation) y apertura de
// enlaces externos con lista blanca de esquemas.
#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <cstdint>
#include <string>
#include <vector>

namespace voxora {

// IFileOpenDialog multi-selección (wav/mp3/m4a/ogg/flac). Vacío si se cancela.
std::vector<std::wstring> pickAudioFiles(HWND owner);

// Duración en ms (-1 si no se puede medir). WAV se lee de la cabecera; el resto
// con IMFSourceReader (MF_PD_DURATION). Llamar desde un hilo con COM inicializado.
int64_t audioDurationMs(const std::wstring& path);

uint64_t fileSizeBytes(const std::wstring& path);

// Abre `url` con el navegador/app por defecto si el esquema es https:, http: o
// ms-settings:. Devuelve false si se rechaza.
bool openExternalUrl(const std::wstring& url);

}  // namespace voxora
