#pragma once
#include <algorithm>
#include <cmath>

namespace voxora {
// Milliseconds on shell QPC. Access is protected by CameraCapture::ringMutex_.
struct AudioPresentation {
  double wallMs = 0, sourceMs = 0, rate = 1, expiresMs = 0;
  static constexpr double kMaxHistoryMs = 7500;
  bool update(double now, double age, double sourceRate, double validFor) {
    if (!std::isfinite(age) || !std::isfinite(sourceRate) || !std::isfinite(validFor)
        || age < 0 || age > kMaxHistoryMs || sourceRate <= 0 || sourceRate > 8 || validFor <= 0) {
      expiresMs = 0;
      return false;
    }
    wallMs = now;
    sourceMs = now - age;
    rate = sourceRate;
    expiresMs = now + std::min(500.0, validFor);
    return true;
  }
  bool active(double now) const { return expiresMs > now; }
  double target(double now, double nominalDelay) const {
    return active(now) ? sourceMs + (now - wallMs) * rate : now - nominalDelay;
  }
  // Inverso de target() mientras está activo: instante (reloj de pared) en que el objetivo alcanza `source`.
  double wallTimeFor(double source) const { return wallMs + (source - sourceMs) / rate; }
  void reset() { expiresMs = 0; }
};
}
