// Frame de "esperando" que emite la cámara cuando no hay productor: fondo oscuro, barra de color de marca
// con un brillo que se desplaza (para que el preview no parezca congelado) y texto en una fuente 5x7
// embebida. Todo en RGBA top-down, sin dependencias de GDI (la DLL corre dentro de svchost).
#pragma once

#include <cstdint>
#include <vector>

namespace voxora::vcam {

class FallbackFrame {
 public:
  // Prepara el lienzo estático para la resolución dada (idempotente si no cambia).
  void prepare(uint32_t width, uint32_t height);

  // Actualiza la animación en función del tiempo y devuelve el RGBA listo para convertir.
  const uint8_t* render(int64_t now100ns);

  uint32_t width() const { return width_; }
  uint32_t height() const { return height_; }

 private:
  void drawStatic();
  void drawText(const char* text, uint32_t x, uint32_t y, uint32_t scale, uint32_t rgb);
  void fillRect(uint32_t x, uint32_t y, uint32_t w, uint32_t h, uint32_t rgb);
  void drawAccentBar(int64_t now100ns);

  uint32_t width_ = 0;
  uint32_t height_ = 0;
  std::vector<uint8_t> canvas_;
  uint32_t barY_ = 0;
  uint32_t barHeight_ = 0;
};

}  // namespace voxora::vcam
