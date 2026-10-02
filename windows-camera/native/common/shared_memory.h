// Utilidades header-only para abrir/crear el mapping y el evento compartidos con la DACL del contrato.
// Se usa tanto desde la DLL (dentro del FrameServer) como desde el FrameWriter (sesión de usuario).
#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <sddl.h>

#include "vcam_shared.h"

namespace voxora::vcam {

// Atributos de seguridad construidos a partir del SDDL del contrato. Mantiene vivo el descriptor.
class SharedSecurity {
 public:
  SharedSecurity() {
    if (ConvertStringSecurityDescriptorToSecurityDescriptorW(kSharedObjectsSddl, SDDL_REVISION_1,
                                                             &descriptor_, nullptr)) {
      attributes_.nLength = sizeof(attributes_);
      attributes_.lpSecurityDescriptor = descriptor_;
      attributes_.bInheritHandle = FALSE;
    }
  }
  ~SharedSecurity() {
    if (descriptor_) LocalFree(descriptor_);
  }
  SharedSecurity(const SharedSecurity&) = delete;
  SharedSecurity& operator=(const SharedSecurity&) = delete;

  // nullptr si el SDDL no se pudo convertir (no debería ocurrir; se degrada a la DACL por defecto).
  SECURITY_ATTRIBUTES* get() { return descriptor_ ? &attributes_ : nullptr; }

 private:
  PSECURITY_DESCRIPTOR descriptor_ = nullptr;
  SECURITY_ATTRIBUTES attributes_{};
};

// Mapping de frames: intenta crearlo (quien tenga privilegio) y si no, abrirlo. `created` indica si
// este proceso lo creó (y por tanto debe inicializar la cabecera).
struct FramesMapping {
  HANDLE handle = nullptr;
  void* view = nullptr;
  bool created = false;

  bool valid() const { return view != nullptr; }

  void close() {
    if (view) UnmapViewOfFile(view);
    if (handle) CloseHandle(handle);
    view = nullptr;
    handle = nullptr;
    created = false;
  }

  SharedHeader* header() const { return static_cast<SharedHeader*>(view); }
};

// `allowCreate = false` solo abre un mapping existente (nunca lo crea): lo usan los productores
// (frame_producer.h), así el único creador es la DLL aunque el productor corra elevado.
inline bool openOrCreateFramesMapping(FramesMapping& out, DWORD* lastError = nullptr, bool allowCreate = true) {
  out.close();
  SharedSecurity security;
  const DWORD sizeHigh = static_cast<DWORD>(kMappingSize >> 32);
  const DWORD sizeLow = static_cast<DWORD>(kMappingSize & 0xFFFFFFFFull);

  HANDLE h = allowCreate ? CreateFileMappingW(INVALID_HANDLE_VALUE, security.get(), PAGE_READWRITE, sizeHigh,
                                              sizeLow, kFramesMappingName)
                         : nullptr;
  bool created = false;
  if (h) {
    created = (GetLastError() != ERROR_ALREADY_EXISTS);
  } else {
    // Sin SeCreateGlobalPrivilege la creación falla con ERROR_ACCESS_DENIED; intentamos abrir uno
    // creado por el otro extremo.
    h = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, kFramesMappingName);
  }
  if (!h) {
    if (lastError) *lastError = GetLastError();
    return false;
  }
  void* view = MapViewOfFile(h, FILE_MAP_ALL_ACCESS, 0, 0, static_cast<SIZE_T>(kMappingSize));
  if (!view) {
    if (lastError) *lastError = GetLastError();
    CloseHandle(h);
    return false;
  }
  out.handle = h;
  out.view = view;
  out.created = created;

  SharedHeader* header = out.header();
  if (created || header->magic != kMagic) {
    // Inicialización idempotente: la página recién creada está a cero.
    header->slotCount = kSlotCount;
    header->slotStride = kSlotStride;
    header->version = kVersion;
    MemoryBarrier();
    header->magic = kMagic;
  }
  return true;
}

// Evento auto-reset "frame listo". Cualquiera de los dos procesos puede crearlo: a diferencia del
// mapping, crear un evento en `Global\` no exige SeCreateGlobalPrivilege (comprobado desde un proceso
// de usuario no elevado). La DLL lo espera para entregar cada frame en cuanto llega (con un timer de
// respaldo si el productor calla o el evento no se pudo abrir).
inline HANDLE openOrCreateFrameReadyEvent() {
  SharedSecurity security;
  HANDLE h = CreateEventW(security.get(), FALSE, FALSE, kFrameReadyEventName);
  if (!h) h = OpenEventW(SYNCHRONIZE | EVENT_MODIFY_STATE, FALSE, kFrameReadyEventName);
  return h;
}

// QPC en unidades de 100 ns (mismo reloj que MFGetSystemTime, válido entre procesos).
inline int64_t qpcNow100ns() {
  static LARGE_INTEGER frequency = [] {
    LARGE_INTEGER f;
    QueryPerformanceFrequency(&f);
    return f;
  }();
  LARGE_INTEGER counter;
  QueryPerformanceCounter(&counter);
  // Se divide en dos pasos para evitar desbordar el int64 con contadores grandes.
  const int64_t seconds = counter.QuadPart / frequency.QuadPart;
  const int64_t remainder = counter.QuadPart % frequency.QuadPart;
  return seconds * 10'000'000 + (remainder * 10'000'000) / frequency.QuadPart;
}

}  // namespace voxora::vcam
