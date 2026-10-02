// Conversión de píxeles propia (sin SIMD): RGBA/NV12 → NV12 (BT.601, rango limitado) y → BGRX (RGB32 de MF),
// más escalado bilineal con letterbox para adaptar el frame del productor a la resolución negociada. Los
// coeficientes y el escalado de NV12 son los de common/nv12.h (los mismos que usa el shell).
#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace voxora::vcam {

// Convierte un frame RGBA (top-down, stride = width*4) a NV12 en un buffer con `yPitch` bytes por fila
// (el plano UV se escribe a continuación del Y, con el mismo pitch). width y height deben ser pares.
void rgbaToNv12(const uint8_t* rgba, uint32_t width, uint32_t height, uint8_t* nv12, int32_t yPitch);

// Convierte RGBA a BGRX de 32 bits. `pitch` puede ser negativo (imagen bottom-up): en ese caso `dst`
// apunta a la primera fila lógica según convención de IMF2DBuffer y se avanza restando.
void rgbaToBgrx(const uint8_t* rgba, uint32_t width, uint32_t height, uint8_t* dst, int32_t pitch);

// Copia NV12 (empaquetado, pitch = width) a un destino con pitch arbitrario.
void copyNv12(const uint8_t* src, uint32_t width, uint32_t height, uint8_t* dst, int32_t pitch);

// NV12 compacto → BGRX de 32 bits (mismo convenio de `pitch` que rgbaToBgrx).
void nv12ToBgrx(const uint8_t* nv12, uint32_t width, uint32_t height, uint8_t* dst, int32_t pitch);

// Escala `src` (RGBA srcW x srcH) al lienzo `dst` (RGBA dstW x dstH) preservando la relación de aspecto
// (barras negras), con filtro bilineal. Si las dimensiones coinciden hace una copia directa.
void scaleRgbaLetterbox(const uint8_t* src, uint32_t srcW, uint32_t srcH, uint8_t* dst, uint32_t dstW,
                        uint32_t dstH);

inline size_t nv12Size(uint32_t width, uint32_t height) { return size_t(width) * height * 3 / 2; }

}  // namespace voxora::vcam
