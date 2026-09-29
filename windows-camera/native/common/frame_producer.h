// Lado productor de la memoria compartida de la cámara virtual, común a los dos productores:
//   - VoxoraMeetFrameWriter.exe (frames RGBA por stdin; lo usa Node y el test E2E)
//   - VoxoraMeet.exe (el shell: webcam → ring de delayMs → cámara virtual)
// Así ambos comparten la MISMA lógica de apertura, publicación y latido (header-only).
//
// Apertura: el mapping `Global\VoxoraMeetVCamFrames` lo crea la DLL (FrameServer, LocalService, con
// SeCreateGlobalPrivilege) cuando el FrameServer instancia la fuente — medido: ≈0,6 s después de que
// el host haga Start, y lo retiene hasta que el host para — y un proceso de usuario no elevado solo
// puede abrirlo. Por eso el productor reintenta cada kProducerRetry100ns SIEMPRE que no lo tenga,
// llegue o no un frame (intentarlo una vez antes de lanzar el host y luego reintentar solo "cuando no
// hay frames" fue justo el bug por el que Meet veía para siempre la imagen de espera con la webcam
// activa). Si la DLL se descarga y se vuelve a cargar (el host se reinicia) mientras el productor
// mantiene su handle, el objeto con nombre sigue vivo y la DLL reabre el mismo mapping.
#pragma once

#include <cstdint>
#include <cstring>

#include "shared_memory.h"

namespace voxora::vcam {

inline constexpr int64_t kProducerRetry100ns = 5'000'000;  // 500 ms entre intentos de apertura

class FrameProducer {
 public:
  FrameProducer() = default;
  ~FrameProducer() { close(); }
  FrameProducer(const FrameProducer&) = delete;
  FrameProducer& operator=(const FrameProducer&) = delete;

  // Abre el mapping si aún no lo tiene, como mucho cada 500 ms salvo `force`. Devuelve true si está
  // disponible. También abre (o crea: no exige privilegio) el evento si falta.
  //
  // El productor NUNCA crea el mapping, aunque pudiera (proceso elevado): el único creador es la DLL,
  // con su tamaño y cabecera; un productor solo abre y retiene el objeto existente.
  bool ensureOpen(int64_t now100ns, bool force = false) {
    if (!event_) event_ = openOrCreateFrameReadyEvent();
    if (mapping_.valid()) return true;
    if (!force && lastAttempt_ != 0 && now100ns - lastAttempt_ < kProducerRetry100ns) return false;
    lastAttempt_ = now100ns;
    DWORD error = 0;
    if (!openOrCreateFramesMapping(mapping_, &error, /*allowCreate=*/false)) {
      lastError_ = error;
      return false;
    }
    lastError_ = 0;
    ++opens_;
    return true;
  }

  bool connected() const { return mapping_.valid(); }
  bool createdMapping() const { return mapping_.created; }
  DWORD lastError() const { return lastError_; }
  uint32_t opens() const { return opens_; }  // veces que se (re)abrió el mapping

  // Publica un frame RGBA8 top-down. `slotTimestamp100ns`: instante de captura (diagnóstico de la DLL).
  // false si no hay mapping o las dimensiones no caben (2..1920 x 2..1080; la DLL escala a la
  // resolución negociada, así que no hace falta que sean pares).
  bool publish(const uint8_t* rgba, uint32_t width, uint32_t height, int64_t slotTimestamp100ns, int64_t now100ns) {
    if (!mapping_.valid() || !rgba) return false;
    if (width < 2 || height < 2 || width > kMaxWidth || height > kMaxHeight) return false;
    SharedHeader* header = mapping_.header();
    if (header->magic != kMagic) return false;
    const uint32_t index = (header->writeIndex + 1) % kSlotCount;
    SlotHeader* slot = slotAt(mapping_.view, index);

    // Seqlock por slot: seqBegin = seqEnd + 1 (impar respecto al último valor completo) mientras se
    // escribe. Derivarlo del propio slot (y no de un contador del proceso) evita repetir un valor viejo
    // si el productor se reinicia.
    uint32_t seq = slot->seqEnd + 1;
    if (seq == 0) seq = 1;
    slot->seqBegin = seq;
    MemoryBarrier();
    slot->width = width;
    slot->height = height;
    slot->format = PixelFormat_RGBA8;
    slot->timestamp100ns = slotTimestamp100ns;
    std::memcpy(slotPixels(slot), rgba, size_t(width) * height * 4);
    MemoryBarrier();
    slot->seqEnd = seq;
    MemoryBarrier();

    header->width = width;
    header->height = height;
    header->format = PixelFormat_RGBA8;
    header->timestamp100ns = now100ns;
    header->producerHeartbeat100ns = now100ns;
    header->writeIndex = index;
    MemoryBarrier();
    header->frameSeq = header->frameSeq + 1;
    MemoryBarrier();
    if (event_) SetEvent(event_);
    ++published_;
    return true;
  }

  // Latido sin frame nuevo: la DLL sigue mostrando el último frame publicado.
  void heartbeat(int64_t now100ns) {
    if (!mapping_.valid()) return;
    mapping_.header()->producerHeartbeat100ns = now100ns;
    MemoryBarrier();
  }

  // Deja de latir: la DLL pasa a su imagen de espera en el siguiente frame (sin esperar el timeout).
  void clearHeartbeat() {
    if (!mapping_.valid()) return;
    mapping_.header()->producerHeartbeat100ns = 0;
    MemoryBarrier();
  }

  uint64_t published() const { return published_; }

  void close() {
    mapping_.close();
    if (event_) {
      CloseHandle(event_);
      event_ = nullptr;
    }
  }

 private:
  FramesMapping mapping_;
  HANDLE event_ = nullptr;
  int64_t lastAttempt_ = 0;
  DWORD lastError_ = 0;
  uint32_t opens_ = 0;
  uint64_t published_ = 0;
};

}  // namespace voxora::vcam
