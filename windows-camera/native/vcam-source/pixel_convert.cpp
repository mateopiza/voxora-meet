#include "pixel_convert.h"

#include "../common/nv12.h"

#include <algorithm>
#include <cstring>

namespace voxora::vcam {

namespace {

// Coeficientes BT.601 rango limitado en punto fijo de 8 bits fraccionales.
//   Y = 16  + (65.738 R + 129.057 G +  25.064 B) / 256
//   U = 128 + (-37.945 R - 74.494 G + 112.439 B) / 256
//   V = 128 + (112.439 R - 94.154 G - 18.285 B) / 256
inline uint8_t clampByte(int v) { return static_cast<uint8_t>(v < 0 ? 0 : (v > 255 ? 255 : v)); }

inline uint8_t lumaOf(int r, int g, int b) { return clampByte(16 + ((66 * r + 129 * g + 25 * b + 128) >> 8)); }
inline uint8_t cbOf(int r, int g, int b) { return clampByte(128 + ((-38 * r - 74 * g + 112 * b + 128) >> 8)); }
inline uint8_t crOf(int r, int g, int b) { return clampByte(128 + ((112 * r - 94 * g - 18 * b + 128) >> 8)); }

}  // namespace

void rgbaToNv12(const uint8_t* rgba, uint32_t width, uint32_t height, uint8_t* nv12, int32_t yPitch) {
  const size_t srcStride = size_t(width) * 4;
  uint8_t* uvPlane = nv12 + size_t(yPitch) * height;

  for (uint32_t y = 0; y < height; y += 2) {
    const uint8_t* row0 = rgba + size_t(y) * srcStride;
    const uint8_t* row1 = (y + 1 < height) ? row0 + srcStride : row0;
    uint8_t* yOut0 = nv12 + size_t(y) * yPitch;
    uint8_t* yOut1 = yOut0 + yPitch;
    uint8_t* uvOut = uvPlane + size_t(y / 2) * yPitch;

    for (uint32_t x = 0; x < width; x += 2) {
      const uint8_t* p00 = row0 + size_t(x) * 4;
      const uint8_t* p01 = (x + 1 < width) ? p00 + 4 : p00;
      const uint8_t* p10 = row1 + size_t(x) * 4;
      const uint8_t* p11 = (x + 1 < width) ? p10 + 4 : p10;

      yOut0[x] = lumaOf(p00[0], p00[1], p00[2]);
      yOut0[x + 1] = lumaOf(p01[0], p01[1], p01[2]);
      if (y + 1 < height) {
        yOut1[x] = lumaOf(p10[0], p10[1], p10[2]);
        yOut1[x + 1] = lumaOf(p11[0], p11[1], p11[2]);
      }

      // Croma: promedio del bloque 2x2 en RGB antes de convertir (evita sesgo por saturación).
      const int r = (p00[0] + p01[0] + p10[0] + p11[0] + 2) >> 2;
      const int g = (p00[1] + p01[1] + p10[1] + p11[1] + 2) >> 2;
      const int b = (p00[2] + p01[2] + p10[2] + p11[2] + 2) >> 2;
      uvOut[x] = cbOf(r, g, b);
      uvOut[x + 1] = crOf(r, g, b);
    }
  }
}

void rgbaToBgrx(const uint8_t* rgba, uint32_t width, uint32_t height, uint8_t* dst, int32_t pitch) {
  const size_t srcStride = size_t(width) * 4;
  for (uint32_t y = 0; y < height; ++y) {
    const uint8_t* src = rgba + size_t(y) * srcStride;
    uint8_t* out = dst + ptrdiff_t(y) * pitch;
    for (uint32_t x = 0; x < width; ++x) {
      out[0] = src[2];  // B
      out[1] = src[1];  // G
      out[2] = src[0];  // R
      out[3] = 0xFF;    // X
      src += 4;
      out += 4;
    }
  }
}

void copyNv12(const uint8_t* src, uint32_t width, uint32_t height, uint8_t* dst, int32_t pitch) {
  if (pitch == int32_t(width)) {
    std::memcpy(dst, src, nv12Size(width, height));
    return;
  }
  const uint8_t* srcUv = src + size_t(width) * height;
  uint8_t* dstUv = dst + size_t(pitch) * height;
  for (uint32_t y = 0; y < height; ++y) std::memcpy(dst + size_t(y) * pitch, src + size_t(y) * width, width);
  for (uint32_t y = 0; y < height / 2; ++y)
    std::memcpy(dstUv + size_t(y) * pitch, srcUv + size_t(y) * width, width);
}

void nv12ToBgrx(const uint8_t* nv12, uint32_t width, uint32_t height, uint8_t* dst, int32_t pitch) {
  nv12ToRgbaRows<true>(nv12, width, nv12 + size_t(width) * height, width, width, 0, height, dst, pitch);
}

void scaleRgbaLetterbox(const uint8_t* src, uint32_t srcW, uint32_t srcH, uint8_t* dst, uint32_t dstW,
                        uint32_t dstH) {
  if (srcW == dstW && srcH == dstH) {
    std::memcpy(dst, src, size_t(dstW) * dstH * 4);
    return;
  }
  // Área destino que preserva la relación de aspecto; barras negras opacas alrededor. Bilineal: el
  // vecino más cercano (lo de antes) dejaba bordes dentados al pasar de 1280x720 a 1920x1080.
  const FitRect r = fitRect(srcW, srcH, dstW, dstH);
  if (r.w != dstW || r.h != dstH) {
    uint32_t* px = reinterpret_cast<uint32_t*>(dst);
    std::fill(px, px + size_t(dstW) * dstH, 0xFF000000u);
  }
  scalePlaneBilinear<4>(src, size_t(srcW) * 4, srcW, srcH, dst + (size_t(r.y) * dstW + r.x) * 4, size_t(dstW) * 4, r.w, r.h);
}

}  // namespace voxora::vcam
