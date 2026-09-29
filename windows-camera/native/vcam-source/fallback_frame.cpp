#include "fallback_frame.h"

#include <algorithm>
#include <cstring>

namespace voxora::vcam {

namespace {

// Fuente 5x7 (una fila por byte, 5 bits útiles, bit 4 = columna izquierda). Solo los glifos que usamos.
struct Glyph {
  char ch;
  uint8_t rows[7];
};

constexpr Glyph kGlyphs[] = {
    {'A', {0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11}}, {'D', {0x1E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1E}},
    {'E', {0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F}}, {'I', {0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E}},
    {'M', {0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11}}, {'N', {0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11}},
    {'O', {0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E}}, {'P', {0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10}},
    {'R', {0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11}}, {'S', {0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E}},
    {'T', {0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04}}, {'V', {0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04}},
    {'X', {0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11}}, {'C', {0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E}},
    {'L', {0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F}}, {'-', {0x00, 0x00, 0x00, 0x1F, 0x00, 0x00, 0x00}},
    {' ', {0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}},
};

const Glyph* findGlyph(char ch) {
  for (const Glyph& g : kGlyphs)
    if (g.ch == ch) return &g;
  return nullptr;
}

constexpr uint32_t kBackground = 0x101418;   // gris azulado muy oscuro
constexpr uint32_t kAccent = 0x7C3AED;       // violeta VOXORA
constexpr uint32_t kAccentBright = 0xC4B5FD;  // brillo que se desplaza por la barra
constexpr uint32_t kTextPrimary = 0xF5F3FF;
constexpr uint32_t kTextSecondary = 0x9CA3AF;

}  // namespace

void FallbackFrame::prepare(uint32_t width, uint32_t height) {
  if (width == width_ && height == height_ && !canvas_.empty()) return;
  width_ = width;
  height_ = height;
  canvas_.assign(size_t(width) * height * 4, 0);
  drawStatic();
}

void FallbackFrame::fillRect(uint32_t x, uint32_t y, uint32_t w, uint32_t h, uint32_t rgb) {
  const uint32_t x1 = std::min(width_, x + w);
  const uint32_t y1 = std::min(height_, y + h);
  for (uint32_t yy = y; yy < y1; ++yy) {
    uint8_t* row = canvas_.data() + (size_t(yy) * width_ + x) * 4;
    for (uint32_t xx = x; xx < x1; ++xx) {
      row[0] = static_cast<uint8_t>(rgb >> 16);
      row[1] = static_cast<uint8_t>(rgb >> 8);
      row[2] = static_cast<uint8_t>(rgb);
      row[3] = 0xFF;
      row += 4;
    }
  }
}

void FallbackFrame::drawText(const char* text, uint32_t x, uint32_t y, uint32_t scale, uint32_t rgb) {
  uint32_t cursor = x;
  for (const char* p = text; *p; ++p) {
    const Glyph* glyph = findGlyph(*p);
    if (glyph) {
      for (uint32_t row = 0; row < 7; ++row) {
        for (uint32_t col = 0; col < 5; ++col) {
          if (glyph->rows[row] & (0x10 >> col)) fillRect(cursor + col * scale, y + row * scale, scale, scale, rgb);
        }
      }
    }
    cursor += 6 * scale;  // 5 columnas + 1 de espacio
  }
}

void FallbackFrame::drawStatic() {
  fillRect(0, 0, width_, height_, kBackground);

  // Escala del texto proporcional a la altura (7 filas de glifo ≈ 7 % de la altura).
  const uint32_t titleScale = std::max<uint32_t>(2, height_ / 100);
  const uint32_t subScale = std::max<uint32_t>(1, titleScale / 2);

  const char* title = "VOXORA MEET";
  const char* subtitle = "ESPERANDO VIDEO";
  const uint32_t titleW = uint32_t(std::strlen(title)) * 6 * titleScale;
  const uint32_t subW = uint32_t(std::strlen(subtitle)) * 6 * subScale;

  const uint32_t titleY = height_ / 2 - 7 * titleScale;
  drawText(title, (width_ - titleW) / 2, titleY, titleScale, kTextPrimary);

  barY_ = titleY + 7 * titleScale + titleScale * 2;
  barHeight_ = std::max<uint32_t>(2, titleScale / 2);
  fillRect(width_ / 4, barY_, width_ / 2, barHeight_, kAccent);

  drawText(subtitle, (width_ - subW) / 2, barY_ + barHeight_ + titleScale * 2, subScale, kTextSecondary);
}

void FallbackFrame::drawAccentBar(int64_t now100ns) {
  // Un brillo de 1/8 del ancho de la barra recorre la barra cada 2 s.
  const uint32_t barX = width_ / 4;
  const uint32_t barW = width_ / 2;
  const uint32_t glowW = std::max<uint32_t>(4, barW / 8);
  const int64_t periodTicks = 20'000'000;  // 2 s en 100 ns
  const int64_t phase = ((now100ns % periodTicks) + periodTicks) % periodTicks;
  const uint32_t glowX = barX + static_cast<uint32_t>((uint64_t(barW - glowW) * phase) / periodTicks);

  fillRect(barX, barY_, barW, barHeight_, kAccent);
  fillRect(glowX, barY_, glowW, barHeight_, kAccentBright);
}

const uint8_t* FallbackFrame::render(int64_t now100ns) {
  drawAccentBar(now100ns);
  return canvas_.data();
}

}  // namespace voxora::vcam
