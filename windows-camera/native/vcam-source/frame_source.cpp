#include "frame_source.h"

#include <cstring>

#include "pixel_convert.h"

namespace voxora::vcam {

namespace {
constexpr int64_t kOpenRetryInterval100ns = 10'000'000;  // reintentar abrir el mapping cada 1 s
}

FrameSource::~FrameSource() { close(); }

void FrameSource::close() {
  mapping_.close();
  if (frameReadyEvent_) {
    CloseHandle(frameReadyEvent_);
    frameReadyEvent_ = nullptr;
  }
}

void FrameSource::configure(uint32_t width, uint32_t height, OutputFormat format) {
  if (width == width_ && height == height_ && format == format_ && !scaledRgba_.empty()) return;
  width_ = width;
  height_ = height;
  format_ = format;
  scaledRgba_.assign(size_t(width) * height * 4, 0);
  nv12Cache_.assign(nv12Size(width, height), 0);
  nv12CacheValid_ = false;
  lastProducerSeq_ = 0;
  fallback_.prepare(width, height);
  // Apertura/creación temprana del mapping: si este proceso tiene SeCreateGlobalPrivilege (el
  // FrameServer lo tiene) el objeto queda disponible para el productor desde el arranque de la cámara.
  lastOpenAttempt100ns_ = 0;
  ensureMapping(qpcNow100ns());
}

HANDLE FrameSource::frameReadyEvent() {
  if (!frameReadyEvent_) frameReadyEvent_ = openOrCreateFrameReadyEvent();
  return frameReadyEvent_;
}

bool FrameSource::ensureMapping(int64_t now100ns) {
  if (mapping_.valid()) return true;
  if (now100ns - lastOpenAttempt100ns_ < kOpenRetryInterval100ns && lastOpenAttempt100ns_ != 0) return false;
  lastOpenAttempt100ns_ = now100ns;
  return openOrCreateFramesMapping(mapping_);
}

// Copia el último slot completo a producerRgba_ y lo escala a scaledRgba_. Devuelve false si no hay
// frame nuevo utilizable (sin productor, productor caído o slot en escritura).
bool FrameSource::readLatestFrame(int64_t now100ns) {
  if (!ensureMapping(now100ns)) return false;
  SharedHeader* header = mapping_.header();
  if (header->magic != kMagic || header->version != kVersion) return false;

  MemoryBarrier();
  const uint32_t seq = header->frameSeq;
  const int64_t heartbeat = header->producerHeartbeat100ns;
  if (seq == 0) return false;
  if (now100ns - heartbeat > kProducerTimeoutMs * 10'000) return false;  // productor caído
  if (seq == lastProducerSeq_) return true;                                // sin frame nuevo: se reutiliza

  // Intentamos el slot más reciente y, si está a medio escribir, el anterior.
  for (uint32_t attempt = 0; attempt < kSlotCount; ++attempt) {
    const uint32_t index = (header->writeIndex + kSlotCount - attempt) % kSlotCount;
    SlotHeader* slot = slotAt(mapping_.view, index);
    MemoryBarrier();
    const uint32_t seqBegin = slot->seqBegin;
    const uint32_t w = slot->width;
    const uint32_t h = slot->height;
    const int64_t ts = slot->timestamp100ns;
    if (seqBegin == 0 || slot->format != PixelFormat_RGBA8) continue;
    if (w < 2 || h < 2 || w > kMaxWidth || h > kMaxHeight) continue;
    MemoryBarrier();
    if (slot->seqEnd != seqBegin) continue;  // en escritura

    const size_t bytes = size_t(w) * h * 4;
    producerRgba_.resize(bytes);
    std::memcpy(producerRgba_.data(), slotPixels(slot), bytes);
    MemoryBarrier();
    if (slot->seqBegin != seqBegin || slot->seqEnd != seqBegin) continue;  // sobrescrito durante la copia

    scaleRgbaLetterbox(producerRgba_.data(), w, h, scaledRgba_.data(), width_, height_);
    lastProducerSeq_ = seq;
    lastProducerTimestamp_ = ts;
    nv12CacheValid_ = false;
    return true;
  }
  return false;
}

int64_t FrameSource::produce(int64_t now100ns, uint8_t* dst, int32_t pitch) {
  const bool haveProducer = readLatestFrame(now100ns);
  producerLive_ = haveProducer;

  const uint8_t* rgba = nullptr;
  int64_t timestamp = now100ns;
  if (haveProducer) {
    rgba = scaledRgba_.data();
    lastWasFallback_ = false;
    // El timestamp del productor sirve para diagnóstico; el sample usa el reloj de emisión.
    timestamp = now100ns;
  } else {
    rgba = fallback_.render(now100ns);
    lastWasFallback_ = true;
    nv12CacheValid_ = false;  // la animación cambia cada tick
  }

  if (format_ == OutputFormat::RGB32) {
    rgbaToBgrx(rgba, width_, height_, dst, pitch);
    return timestamp;
  }

  if (!nv12CacheValid_) {
    rgbaToNv12(rgba, width_, height_, nv12Cache_.data(), int32_t(width_));
    nv12CacheValid_ = true;
  }
  copyNv12(nv12Cache_.data(), width_, height_, dst, pitch);
  return timestamp;
}

}  // namespace voxora::vcam
