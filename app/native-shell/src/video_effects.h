// Imagen de la cámara: procesado en CPU de cada frame de la webcam ANTES de publicarlo en la cámara
// virtual (y, por tanto, antes del ring de retraso). Una sola pasada por píxel, directa del buffer de
// Media Foundation (BGRX) al frame RGBA del lienzo 1280x720, sin copias intermedias:
//
//   orientación  espejo (horizontal), volteo (vertical), rotación 0/90/180/270 (horario)
//   encuadre     16:9 = recorte «cover» que llena el lienzo · 9:16 = recorte vertical centrado,
//                colocado en el lienzo 16:9 con los laterales difuminados y oscurecidos
//                zoom 1x–2x con desplazamiento (pan) dentro del margen que deja el zoom
//   color        brillo (gamma), contraste, temperatura → 3 LUT de 256 entradas; saturación (luma
//                BT.601 en punto fijo)
//
// Todas las transformaciones geométricas son separables (ejes alineados): la dirección de cada píxel
// de origen es `fila[oy] + columna[ox]`, con tablas precalculadas por eje; el remuestreo es bilineal
// en punto fijo (SWAR, dos canales por multiplicación) o una lectura directa cuando la escala es 1:1
// (el caso habitual: 1280x720 → 1280x720 sin zoom). Las tablas y las LUT solo se recalculan cuando
// cambian los parámetros o el tamaño del frame.
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

namespace voxora {

struct VideoEffectsParams {
  bool mirror = false;
  bool flip = false;
  int rotation = 0;          // 0 | 90 | 180 | 270 (sentido horario)
  bool portrait = false;     // true = 9:16 (recorte vertical centrado en el lienzo 16:9)
  double zoom = 1.0;         // 1..2
  double panX = 0.0;         // -1 (izquierda) .. 1 (derecha)
  double panY = 0.0;         // -1 (arriba) .. 1 (abajo)
  double brightness = 0.0;   // -1..1
  double contrast = 0.0;     // -1..1
  double saturation = 0.0;   // -1..1
  double temperature = 0.0;  // -1 (fría) .. 1 (cálida)

  // Recorta a rangos válidos (rotación a múltiplos de 90).
  VideoEffectsParams sanitized() const;
  bool sameGeometry(const VideoEffectsParams& o) const;
  bool sameColor(const VideoEffectsParams& o) const;
  bool operator==(const VideoEffectsParams& o) const { return sameGeometry(o) && sameColor(o); }
  bool operator!=(const VideoEffectsParams& o) const { return !(*this == o); }
  bool isNeutral() const { return *this == VideoEffectsParams{}; }
};

class VideoEffectsRenderer {
 public:
  VideoEffectsRenderer();
  ~VideoEffectsRenderer();
  VideoEffectsRenderer(const VideoEffectsRenderer&) = delete;
  VideoEffectsRenderer& operator=(const VideoEffectsRenderer&) = delete;

  void setParams(const VideoEffectsParams& params);
  const VideoEffectsParams& params() const { return params_; }

  // `src` apunta a la primera fila VISIBLE (BGRX, 4 bytes por píxel); `pitch` en bytes (negativo si la
  // imagen está de abajo arriba). `dst` = RGBA8 compacto de dstW x dstH (orden R,G,B,A del contrato de
  // la cámara virtual). No reserva memoria salvo al cambiar tamaños o parámetros.
  void render(const uint8_t* src, ptrdiff_t pitch, int srcW, int srcH, uint8_t* dst, int dstW, int dstH);

  // Igual que render() pero entrega NV12 compacto (BT.601 limitado, windows-camera/native/common/nv12.h),
  // el formato del ring y de la cámara virtual: render() a un lienzo RGBA interno y conversión por
  // franjas de filas en paralelo. dstW y dstH pares.
  void renderNv12(const uint8_t* src, ptrdiff_t pitch, int srcW, int srcH, uint8_t* nv12, int dstW, int dstH);

 private:
  class RowPool;  // franjas de filas en paralelo (solo se crea si hay interpolación o color)
  std::unique_ptr<RowPool> pool_;

  struct Axis {
    std::vector<ptrdiff_t> off0, off1;  // desplazamiento en bytes de las dos muestras
    std::vector<uint16_t> w;            // peso de la segunda muestra, 0..256
    bool exact = true;                  // todos los pesos a 0 (lectura directa)
  };

  void rebuildColor();
  void rebuildGeometry(ptrdiff_t pitch, int srcW, int srcH, int dstW, int dstH);
  void renderBackground(const uint8_t* src, uint8_t* dst, int dstW, int dstH);

  VideoEffectsParams params_;
  std::vector<uint8_t> canvas_;  // lienzo RGBA de renderNv12()
  bool geometryDirty_ = true;
  bool colorDirty_ = true;

  // Geometría cacheada.
  ptrdiff_t pitch_ = 0;
  int srcW_ = 0, srcH_ = 0, dstW_ = 0, dstH_ = 0;
  int dispW_ = 0, dispH_ = 0;  // tamaño de la imagen orientada (tras rotar)
  int rectX_ = 0, rectY_ = 0, rectW_ = 0, rectH_ = 0;  // zona del lienzo con imagen
  Axis cols_, rows_;

  // Color.
  bool colorIdentity_ = true;
  bool satIdentity_ = true;
  int sat256_ = 256;
  uint8_t lutR_[256]{}, lutG_[256]{}, lutB_[256]{};

  // Fondo difuminado (9:16): rejilla pequeña → desenfoque → escalado bilineal a los laterales.
  static constexpr int kBgW = 32, kBgH = 18;
  std::vector<uint32_t> bg_, bgTmp_;
  std::vector<ptrdiff_t> bgSampleCols_, bgSampleRows_;  // 4 muestras por celda y eje
  std::vector<int> bgX0_, bgX1_, bgY0_, bgY1_;
  std::vector<uint16_t> bgWx_, bgWy_;
};

}  // namespace voxora
