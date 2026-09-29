// Contrato binario compartido entre los tres binarios de la cámara virtual VOXORA Meet:
//   - VoxoraMeetVCam.dll        (media source cargado por el FrameServer de Windows, svchost/LocalService)
//   - VoxoraMeetFrameWriter.exe (productor: lee RGBA por stdin y lo escribe en la memoria compartida)
//   - VoxoraMeetVCamHost.exe    (registra la cámara con MFCreateVirtualCamera y la mantiene viva)
//
// Este archivo NO depende de Media Foundation para poder incluirse desde cualquier binario.
#pragma once

#include <cstdint>

namespace voxora::vcam {

// CLSID del IMFActivate registrado en HKLM\Software\Classes\CLSID. Debe coincidir con
// VOXORA_VCAM_CLSID_STRING y con el `sourceId` que pasa el host a MFCreateVirtualCamera.
// {7A1E5C3B-0F4D-4B8A-9C2E-3D6F1B8E5A70}
inline constexpr wchar_t kActivateClsidString[] = L"{7A1E5C3B-0F4D-4B8A-9C2E-3D6F1B8E5A70}";
inline constexpr wchar_t kFriendlyName[] = L"VOXORA Meet Camera";

// Nombres de los objetos kernel compartidos.
//
// IMPORTANTE: se usa el espacio de nombres `Global\` y no `Local\` porque la DLL corre dentro del
// servicio "Windows Camera Frame Server" (svchost.exe, cuenta NT AUTHORITY\LocalService, sesión 0),
// mientras que el productor corre en la sesión interactiva del usuario. Un objeto `Local\` creado en
// la sesión 1 es invisible desde la sesión 0. Crear un file mapping en `Global\` desde una sesión
// distinta de 0 exige SeCreateGlobalPrivilege (que un proceso de usuario no elevado no tiene), por
// eso el protocolo es: lo crea la DLL (tiene el privilegio por correr como servicio) con una DACL
// permisiva y los productores (common/frame_producer.h) solo lo abren, reintentando cada 500 ms
// mientras no exista. Medido: la DLL lo crea ≈0,6 s después de que el host haga Start (cuando el
// FrameServer instancia la fuente, haya o no apps mirando) y lo suelta al parar el host; si un
// productor lo retiene, el objeto sobrevive y la DLL recargada reabre el mismo. El evento no necesita
// privilegio, cualquiera lo crea (la DLL no lo espera: produce con su propio timer).
inline constexpr wchar_t kFramesMappingName[] = L"Global\\VoxoraMeetVCamFrames";
inline constexpr wchar_t kFrameReadyEventName[] = L"Global\\VoxoraMeetVCamFrameReady";

// DACL permisiva para que LocalService (sesión 0) y el usuario interactivo compartan los objetos,
// más etiqueta de integridad baja para no bloquear procesos de baja integridad.
inline constexpr wchar_t kSharedObjectsSddl[] = L"D:(A;;GA;;;WD)(A;;GA;;;LS)(A;;GA;;;AC)S:(ML;;NW;;;LW)";

inline constexpr uint32_t kMagic = 0x4D435856;  // 'VXCM' en little-endian
inline constexpr uint32_t kVersion = 1;

// Formatos de píxel del productor. Por ahora solo RGBA de 8 bits por canal (orden de bytes R,G,B,A).
enum PixelFormat : uint32_t {
  PixelFormat_RGBA8 = 1,
};

inline constexpr uint32_t kSlotCount = 3;
inline constexpr uint32_t kMaxWidth = 1920;
inline constexpr uint32_t kMaxHeight = 1080;
inline constexpr uint32_t kMaxFrameBytes = kMaxWidth * kMaxHeight * 4;

// Cabecera global del mapping (64 bytes, alineación fija; los campos volátiles se acceden con
// barreras de memoria explícitas).
struct SharedHeader {
  uint32_t magic;            // kMagic
  uint32_t version;          // kVersion
  uint32_t width;            // dimensiones del último frame escrito
  uint32_t height;
  uint32_t format;           // PixelFormat
  uint32_t frameSeq;         // contador monótono de frames publicados
  uint32_t writeIndex;       // slot del último frame completo
  uint32_t slotCount;        // kSlotCount
  int64_t  timestamp100ns;   // QPC en unidades de 100 ns del último frame (reloj del sistema)
  int64_t  producerHeartbeat100ns;  // QPC en 100 ns de la última escritura (detección de productor vivo)
  uint32_t slotStride;       // bytes por slot (cabecera de slot + píxeles)
  uint32_t reserved[3];
};
static_assert(sizeof(SharedHeader) == 64, "SharedHeader debe medir 64 bytes");

// Cabecera de cada slot. Actúa como seqlock: el productor escribe seqBegin (impar), los píxeles y
// luego seqEnd (= seqBegin). El lector considera el slot válido solo si seqBegin == seqEnd antes y
// después de copiar.
struct SlotHeader {
  uint32_t seqBegin;
  uint32_t seqEnd;
  uint32_t width;
  uint32_t height;
  int64_t  timestamp100ns;
  uint32_t format;
  uint32_t reserved[5];
};
static_assert(sizeof(SlotHeader) == 48, "SlotHeader debe medir 48 bytes");

inline constexpr uint32_t kSlotStride = sizeof(SlotHeader) + kMaxFrameBytes;
inline constexpr uint64_t kMappingSize = sizeof(SharedHeader) + uint64_t(kSlotCount) * kSlotStride;

inline SlotHeader* slotAt(void* base, uint32_t index) {
  return reinterpret_cast<SlotHeader*>(static_cast<uint8_t*>(base) + sizeof(SharedHeader) +
                                       uint64_t(index) * kSlotStride);
}
inline uint8_t* slotPixels(SlotHeader* slot) {
  return reinterpret_cast<uint8_t*>(slot) + sizeof(SlotHeader);
}

// Tras cuántos ms sin heartbeat del productor la DLL vuelve al frame de "esperando".
inline constexpr int64_t kProducerTimeoutMs = 2000;

}  // namespace voxora::vcam
