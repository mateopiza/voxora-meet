#include "frame_source.h"

#include <cstring>

#include "../common/nv12.h"
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
  if (width == width_ && height == height_ && format == format_ && !frameRgba_.empty()) return;
  width_ = width;
  height_ = height;
  format_ = format;
  frameRgba_.assign(size_t(width) * height * 4, 0);
  frameNv12_.assign(nv12Size(width, height), 0);
  fallbackNv12_.assign(nv12Size(width, height), 0);
  frameIsNv12_ = false;
  nv12Valid_ = false;
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
  if (!openOrCreateFramesMapping(mapping_)) return false;
  // Anuncia que esta DLL acepta NV12: el shell deja de convertir a RGBA (y esta DLL de volver a NV12).
  mapping_.header()->consumerCaps = kConsumerCapNV12;
  MemoryBarrier();
  return true;
}

// Copia el último slot completo y lo deja a la resolución de salida en frameNv12_ (productor NV12) o en
// frameRgba_ (productor RGBA8). Devuelve false si no hay frame utilizable (sin productor, productor
// caído o slot en escritura); true también si no hay frame nuevo (se reutiliza el último).
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
    const uint32_t format = slot->format;
    if (seqBegin == 0 || (format != PixelFormat_RGBA8 && format != PixelFormat_NV12)) continue;
    if (w < 2 || h < 2 || w > kMaxWidth || h > kMaxHeight) continue;
    const bool nv12 = format == PixelFormat_NV12;
    if (nv12 && ((w | h) & 1)) continue;
    MemoryBarrier();
    if (slot->seqEnd != seqBegin) continue;  // en escritura

    const size_t bytes = nv12 ? nv12Size(w, h) : size_t(w) * h * 4;
    slotCopy_.resize(bytes);
    std::memcpy(slotCopy_.data(), slotPixels(slot), bytes);
    MemoryBarrier();
    if (slot->seqBegin != seqBegin || slot->seqEnd != seqBegin) continue;  // sobrescrito durante la copia

    if (nv12) {
      // Misma resolución (Meet): la copia del slot ES el frame; se intercambian buffers sin copiar.
      if (w == width_ && h == height_) slotCopy_.swap(frameNv12_);
      else scaleNv12Letterbox(slotCopy_.data(), w, h, frameNv12_.data(), width_, height_);
      nv12Valid_ = true;
    } else {
      scaleRgbaLetterbox(slotCopy_.data(), w, h, frameRgba_.data(), width_, height_);
      nv12Valid_ = false;
    }
    frameIsNv12_ = nv12;
    lastProducerSeq_ = seq;
    lastProducerTimestamp_ = ts;
    return true;
  }
  return false;
}

int64_t FrameSource::produce(int64_t now100ns, uint8_t* dst, int32_t pitch) {
  // El timestamp del productor sirve para diagnóstico; el sample usa el reloj de emisión.
  producerLive_ = readLatestFrame(now100ns);
  if (!producerLive_) {
    const uint8_t* rgba = fallback_.render(now100ns);  // la animación cambia cada tick
    if (format_ == OutputFormat::RGB32) {
      rgbaToBgrx(rgba, width_, height_, dst, pitch);
    } else {
      rgbaToNv12(rgba, width_, height_, fallbackNv12_.data(), int32_t(width_));
      copyNv12(fallbackNv12_.data(), width_, height_, dst, pitch);
    }
    return now100ns;
  }

  if (format_ == OutputFormat::RGB32) {
    if (frameIsNv12_) nv12ToBgrx(frameNv12_.data(), width_, height_, dst, pitch);
    else rgbaToBgrx(frameRgba_.data(), width_, height_, dst, pitch);
    return now100ns;
  }
  if (!nv12Valid_) {  // productor RGBA8: se convierte una vez por frame nuevo
    rgbaToNv12(frameRgba_.data(), width_, height_, frameNv12_.data(), int32_t(width_));
    nv12Valid_ = true;
  }
  copyNv12(frameNv12_.data(), width_, height_, dst, pitch);
  return now100ns;
}

}  // namespace voxora::vcam
