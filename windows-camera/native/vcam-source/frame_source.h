// Origen de frames para el media stream: lee el ring de memoria compartida escrito por
// VoxoraMeetFrameWriter.exe, lo adapta a la resolución negociada y lo convierte al formato de salida.
// Si no hay productor (o dejó de latir) genera el frame de "esperando".
#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <cstdint>
#include <vector>

#include "../common/shared_memory.h"
#include "fallback_frame.h"

namespace voxora::vcam {

enum class OutputFormat { NV12, RGB32 };

class FrameSource {
 public:
  FrameSource() = default;
  ~FrameSource();
  FrameSource(const FrameSource&) = delete;
  FrameSource& operator=(const FrameSource&) = delete;

  // Fija la resolución y formato negociados con el FrameServer.
  void configure(uint32_t width, uint32_t height, OutputFormat format);

  // Escribe en `dst` (con `pitch` bytes por fila, puede ser negativo para RGB32 bottom-up) el frame a
  // emitir en el instante `now100ns`. Devuelve el timestamp de captura del productor si lo hubo, o
  // `now100ns` si es el frame de espera.
  int64_t produce(int64_t now100ns, uint8_t* dst, int32_t pitch);

  // true si el último produce() sirvió un frame del productor.
  bool producerLive() const { return producerLive_; }

  // Evento "frame listo" (puede ser nullptr si aún no pudo abrirse).
  HANDLE frameReadyEvent();

  void close();

 private:
  bool ensureMapping(int64_t now100ns);
  bool readLatestFrame(int64_t now100ns);

  FramesMapping mapping_;
  HANDLE frameReadyEvent_ = nullptr;
  int64_t lastOpenAttempt100ns_ = 0;

  uint32_t width_ = 0;
  uint32_t height_ = 0;
  OutputFormat format_ = OutputFormat::NV12;

  std::vector<uint8_t> producerRgba_;  // copia cruda del slot (tamaño del productor)
  std::vector<uint8_t> scaledRgba_;    // RGBA a la resolución de salida
  std::vector<uint8_t> nv12Cache_;     // NV12 empaquetado cacheado del último frame convertido
  uint32_t lastProducerSeq_ = 0;
  int64_t lastProducerTimestamp_ = 0;
  bool nv12CacheValid_ = false;
  bool producerLive_ = false;
  bool lastWasFallback_ = true;

  FallbackFrame fallback_;
};

}  // namespace voxora::vcam
