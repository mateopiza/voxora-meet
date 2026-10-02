// NV12 (BT.601, rango limitado 16–235) común al shell (ring de retraso y publicación), a la DLL de la
// cámara virtual y a las herramientas: conversión desde/hacia RGBA8 y escalado bilineal de planos.
// Header-only y sin dependencias (la DLL corre dentro del FrameServer).
//
// Coeficientes en punto fijo de 8 bits, los mismos en todos los binarios para que una ida y vuelta
// RGBA → NV12 → RGBA no derive el color:
//   Y = 16  + ( 66 R + 129 G +  25 B) / 256
//   U = 128 + (-38 R -  74 G + 112 B) / 256
//   V = 128 + (112 R -  94 G -  18 B) / 256
// NV12 compacto = plano Y (width x height) seguido del plano UV entrelazado (width x height/2), ambos con
// pitch = width. Ancho y alto siempre pares.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

namespace voxora::vcam {

inline size_t nv12Bytes(uint32_t width, uint32_t height) { return size_t(width) * height * 3 / 2; }

namespace nv12detail {
inline uint8_t clamp255(int v) { return static_cast<uint8_t>(v < 0 ? 0 : (v > 255 ? 255 : v)); }
inline uint8_t lumaOf(int r, int g, int b) { return static_cast<uint8_t>(16 + ((66 * r + 129 * g + 25 * b + 128) >> 8)); }
}  // namespace nv12detail

// RGBA8 (bytes R,G,B,A) → NV12, filas [y0, y1) del frame (y0 par). `rgba`, `yPlane` y `uvPlane` apuntan a
// la fila 0 de cada uno. Croma: media del bloque 2x2 en RGB (sin sesgo por saturación). Pensado para
// repartirse por franjas de filas entre hilos.
inline void rgbaToNv12Rows(const uint8_t* rgba, size_t rgbaStride, uint32_t width, uint32_t height, uint32_t y0, uint32_t y1,
                           uint8_t* yPlane, size_t yPitch, uint8_t* uvPlane, size_t uvPitch) {
  using nv12detail::lumaOf;
  y1 = std::min(y1, height);
  for (uint32_t y = y0; y < y1; y += 2) {
    const uint8_t* r0 = rgba + size_t(y) * rgbaStride;
    const uint8_t* r1 = y + 1 < height ? r0 + rgbaStride : r0;
    uint8_t* o0 = yPlane + size_t(y) * yPitch;
    uint8_t* o1 = y + 1 < height ? o0 + yPitch : o0;
    uint8_t* uv = uvPlane + size_t(y / 2) * uvPitch;
    for (uint32_t x = 0; x + 1 < width; x += 2) {
      const uint8_t* a = r0 + size_t(x) * 4;
      const uint8_t* b = r1 + size_t(x) * 4;
      o0[x] = lumaOf(a[0], a[1], a[2]);
      o0[x + 1] = lumaOf(a[4], a[5], a[6]);
      o1[x] = lumaOf(b[0], b[1], b[2]);
      o1[x + 1] = lumaOf(b[4], b[5], b[6]);
      const int r = (a[0] + a[4] + b[0] + b[4] + 2) >> 2;
      const int g = (a[1] + a[5] + b[1] + b[5] + 2) >> 2;
      const int bl = (a[2] + a[6] + b[2] + b[6] + 2) >> 2;
      uv[x] = static_cast<uint8_t>(128 + ((-38 * r - 74 * g + 112 * bl + 128) >> 8));
      uv[x + 1] = static_cast<uint8_t>(128 + ((112 * r - 94 * g - 18 * bl + 128) >> 8));
    }
  }
}

// NV12 → RGBA8 (Bgrx = false: bytes R,G,B,255) o BGRX (Bgrx = true, el RGB32 de Media Foundation), filas
// [y0, y1). `out` apunta a la fila 0 y `outPitch` puede ser negativo (destino de abajo arriba).
template <bool Bgrx>
inline void nv12ToRgbaRows(const uint8_t* yPlane, size_t yPitch, const uint8_t* uvPlane, size_t uvPitch, uint32_t width,
                           uint32_t y0, uint32_t y1, uint8_t* out, ptrdiff_t outPitch) {
  using nv12detail::clamp255;
  for (uint32_t y = y0; y < y1; y++) {
    const uint8_t* ys = yPlane + size_t(y) * yPitch;
    const uint8_t* uv = uvPlane + size_t(y / 2) * uvPitch;
    uint8_t* o = out + ptrdiff_t(y) * outPitch;
    for (uint32_t x = 0; x + 1 < width; x += 2) {
      const int d = uv[x] - 128, e = uv[x + 1] - 128;
      const int cr = 409 * e, cg = -100 * d - 208 * e, cb = 516 * d;
      for (int k = 0; k < 2; k++) {
        const int c = 298 * (ys[x + k] - 16) + 128;
        uint8_t* p = o + size_t(x + k) * 4;
        const uint8_t r = clamp255((c + cr) >> 8), g = clamp255((c + cg) >> 8), b = clamp255((c + cb) >> 8);
        p[0] = Bgrx ? b : r;
        p[1] = g;
        p[2] = Bgrx ? r : b;
        p[3] = 255;
      }
    }
  }
}

// Escala bilineal de un plano con `Channels` bytes por muestra (1 = Y, 2 = UV entrelazado, 4 = RGBA),
// centros de píxel alineados. Pensado para ampliar o reducir hasta ~2x (más reducción, más aliasing).
template <int Channels>
inline void scalePlaneBilinear(const uint8_t* src, size_t srcPitch, uint32_t srcW, uint32_t srcH, uint8_t* dst, size_t dstPitch,
                               uint32_t dstW, uint32_t dstH) {
  if (!srcW || !srcH || !dstW || !dstH) return;
  struct Tap {
    uint32_t i0, i1;
    uint32_t w;  // peso de i1, 0..256
  };
  auto taps = [](uint32_t n, uint32_t srcN) {
    std::vector<Tap> t(n);
    const double scale = double(srcN) / n;
    for (uint32_t k = 0; k < n; k++) {
      double s = (k + 0.5) * scale - 0.5;
      s = std::min(std::max(0.0, s), double(srcN - 1));
      uint32_t i0 = static_cast<uint32_t>(s);
      uint32_t w = static_cast<uint32_t>(std::lround((s - i0) * 256.0));
      if (w >= 256) {
        i0 = std::min(i0 + 1, srcN - 1);
        w = 0;
      }
      t[k] = {i0, std::min(i0 + 1, srcN - 1), w};
    }
    return t;
  };
  const std::vector<Tap> cols = taps(dstW, srcW), rows = taps(dstH, srcH);
  for (uint32_t y = 0; y < dstH; y++) {
    const uint8_t* top = src + size_t(rows[y].i0) * srcPitch;
    const uint8_t* bottom = src + size_t(rows[y].i1) * srcPitch;
    const uint32_t wy = rows[y].w, iwy = 256 - wy;
    uint8_t* o = dst + size_t(y) * dstPitch;
    for (uint32_t x = 0; x < dstW; x++) {
      const Tap& c = cols[x];
      const uint8_t* t0 = top + size_t(c.i0) * Channels;
      const uint8_t* t1 = top + size_t(c.i1) * Channels;
      const uint8_t* b0 = bottom + size_t(c.i0) * Channels;
      const uint8_t* b1 = bottom + size_t(c.i1) * Channels;
      const uint32_t iwx = 256 - c.w;
      for (int ch = 0; ch < Channels; ch++) {
        const uint32_t t = t0[ch] * iwx + t1[ch] * c.w;
        const uint32_t b = b0[ch] * iwx + b1[ch] * c.w;
        o[size_t(x) * Channels + ch] = static_cast<uint8_t>((t * iwy + b * wy + 32768) >> 16);
      }
    }
  }
}

// Rectángulo (par) que ocupa una imagen srcW x srcH ajustada a dstW x dstH sin deformarla.
struct FitRect {
  uint32_t x, y, w, h;
};
inline FitRect fitRect(uint32_t srcW, uint32_t srcH, uint32_t dstW, uint32_t dstH) {
  uint32_t w = dstW, h = static_cast<uint32_t>(uint64_t(dstW) * srcH / srcW);
  if (h > dstH) {
    h = dstH;
    w = static_cast<uint32_t>(uint64_t(dstH) * srcW / srcH);
  }
  w = std::max<uint32_t>(2, std::min(dstW, w) & ~1u);
  h = std::max<uint32_t>(2, std::min(dstH, h) & ~1u);
  return {((dstW - w) / 2) & ~1u, ((dstH - h) / 2) & ~1u, w, h};
}

// NV12 compacto srcW x srcH → NV12 compacto dstW x dstH, bilineal y con barras negras si cambia la
// relación de aspecto. Copia directa si coinciden.
inline void scaleNv12Letterbox(const uint8_t* src, uint32_t srcW, uint32_t srcH, uint8_t* dst, uint32_t dstW, uint32_t dstH) {
  if (srcW == dstW && srcH == dstH) {
    std::memcpy(dst, src, nv12Bytes(dstW, dstH));
    return;
  }
  const FitRect r = fitRect(srcW, srcH, dstW, dstH);
  uint8_t* dstUv = dst + size_t(dstW) * dstH;
  if (r.w != dstW || r.h != dstH) {
    std::memset(dst, 16, size_t(dstW) * dstH);
    std::memset(dstUv, 128, size_t(dstW) * dstH / 2);
  }
  const uint8_t* srcUv = src + size_t(srcW) * srcH;
  scalePlaneBilinear<1>(src, srcW, srcW, srcH, dst + size_t(r.y) * dstW + r.x, dstW, r.w, r.h);
  scalePlaneBilinear<2>(srcUv, srcW, srcW / 2, srcH / 2, dstUv + size_t(r.y / 2) * dstW + r.x, dstW, r.w / 2, r.h / 2);
}

}  // namespace voxora::vcam
