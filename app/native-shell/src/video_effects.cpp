#include "video_effects.h"

#include <algorithm>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <functional>
#include <mutex>
#include <thread>

#include "nv12.h"

namespace voxora {

namespace {

inline uint32_t load32(const uint8_t* p) {
  uint32_t v;
  std::memcpy(&v, p, 4);
  return v;
}

// Interpola dos píxeles empaquetados (4 canales de 8 bits) con peso `w` (0..256) del segundo.
// SWAR: dos canales por multiplicación de 32 bits (cada carril ≤ 255·256, no desborda).
inline uint32_t lerp32(uint32_t a, uint32_t b, uint32_t w) {
  const uint32_t iw = 256 - w;
  const uint32_t rb = (((a & 0x00FF00FFu) * iw + (b & 0x00FF00FFu) * w) >> 8) & 0x00FF00FFu;
  const uint32_t ga = ((((a >> 8) & 0x00FF00FFu) * iw + ((b >> 8) & 0x00FF00FFu) * w) >> 8) & 0x00FF00FFu;
  return rb | (ga << 8);
}

// Recorte a 0..255 sin saltos: tabla indexada por v + 512 (v ∈ [-512, 767]).
struct ClampTable {
  uint8_t t[1280];
  ClampTable() {
    for (int i = 0; i < 1280; i++) t[i] = static_cast<uint8_t>(std::min(255, std::max(0, i - 512)));
  }
};
const ClampTable kClamp;

struct ColorOps {
  const uint8_t* r;
  const uint8_t* g;
  const uint8_t* b;
  int sat256;
};

// BGRX (Media Foundation RGB32) → RGBA8 (contrato de la cámara virtual) con LUT y saturación opcionales.
template <bool Color, bool Sat>
inline uint32_t toRgba(uint32_t p, const ColorOps& c) {
  uint32_t r = (p >> 16) & 0xFF, g = (p >> 8) & 0xFF, b = p & 0xFF;
  if constexpr (Color) {
    r = c.r[r];
    g = c.g[g];
    b = c.b[b];
  }
  if constexpr (Sat) {
    const int ri = static_cast<int>(r), gi = static_cast<int>(g), bi = static_cast<int>(b);
    const int y = (77 * ri + 150 * gi + 29 * bi) >> 8;
    // y + (c - y)·s con s ∈ [0, 2] en Q8 (desplazamiento aritmético: redondeo hacia abajo).
    const uint8_t* clamp = kClamp.t + 512 + y;
    r = clamp[((ri - y) * c.sat256) >> 8];
    g = clamp[((gi - y) * c.sat256) >> 8];
    b = clamp[((bi - y) * c.sat256) >> 8];
  }
  return r | (g << 8) | (b << 16) | 0xFF000000u;
}

struct ContentJob {
  const uint8_t* src;
  uint32_t* dst;
  int dstW, rectX, rectY, w;
  const ptrdiff_t *c0, *c1, *r0, *r1;
  const uint16_t *cw, *rw;
  ColorOps color;
};

// Rellena las filas [j0, j1) de la zona de imagen del lienzo. `Bilinear` = alguna escala no es 1:1.
template <bool Bilinear, bool Color, bool Sat>
void renderContent(const ContentJob& job, int j0, int j1) {
  const int w = job.w;
  const ptrdiff_t* col0 = job.c0;
  for (int j = j0; j < j1; j++) {
    uint32_t* out = job.dst + static_cast<size_t>(job.rectY + j) * job.dstW + job.rectX;
    const uint8_t* top = job.src + job.r0[j];
    if constexpr (!Bilinear) {
      for (int i = 0; i < w; i++) out[i] = toRgba<Color, Sat>(load32(top + col0[i]), job.color);
    } else {
      const uint8_t* bottom = job.src + job.r1[j];
      const uint32_t wy = job.rw[j];
      const ptrdiff_t* col1 = job.c1;
      const uint16_t* wx = job.cw;
      for (int i = 0; i < w; i++) {
        const ptrdiff_t a = col0[i], b = col1[i];
        const uint32_t fx = wx[i];
        uint32_t p = fx ? lerp32(load32(top + a), load32(top + b), fx) : load32(top + a);
        if (wy) {
          const uint32_t q = fx ? lerp32(load32(bottom + a), load32(bottom + b), fx) : load32(bottom + a);
          p = lerp32(p, q, wy);
        }
        out[i] = toRgba<Color, Sat>(p, job.color);
      }
    }
  }
}

using ContentFn = void (*)(const ContentJob&, int, int);

ContentFn pickContent(bool bilinear, bool color, bool sat) {
  if (bilinear) {
    if (color) return sat ? renderContent<true, true, true> : renderContent<true, true, false>;
    return sat ? renderContent<true, false, true> : renderContent<true, false, false>;
  }
  if (color) return sat ? renderContent<false, true, true> : renderContent<false, true, false>;
  return sat ? renderContent<false, false, true> : renderContent<false, false, false>;
}

double clampD(double v, double lo, double hi) { return std::isfinite(v) ? std::min(hi, std::max(lo, v)) : 0.0; }

}  // namespace

// ── Franjas de filas en paralelo ────────────────────────────────────────────
// Hilos persistentes (hasta 3 + el que llama): repartir un frame cuesta unos µs frente a crear hilos.
class VideoEffectsRenderer::RowPool {
 public:
  RowPool() {
    const unsigned hw = std::max(1u, std::thread::hardware_concurrency());
    const int workers = static_cast<int>(std::min(3u, hw > 2 ? hw / 2 : 0u));
    for (int i = 0; i < workers; i++) threads_.emplace_back([this, i] { loop(i); });
  }
  ~RowPool() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      stop_ = true;
    }
    wake_.notify_all();
    for (auto& t : threads_) t.join();
  }
  // Ejecuta fn(j0, j1) sobre [0, rows) en franjas contiguas; el hilo que llama hace la última.
  void run(int rows, const std::function<void(int, int)>& fn) {
    const int parts = static_cast<int>(threads_.size()) + 1;
    if (parts == 1 || rows < parts * 8) {
      fn(0, rows);
      return;
    }
    {
      std::lock_guard<std::mutex> lock(mutex_);
      job_ = &fn;
      rows_ = rows;
      parts_ = parts;
      pending_ = parts - 1;
      gen_++;
    }
    wake_.notify_all();
    fn(rows * (parts - 1) / parts, rows);
    std::unique_lock<std::mutex> lock(mutex_);
    done_.wait(lock, [this] { return pending_ == 0; });
    job_ = nullptr;
  }

 private:
  void loop(int index) {
    uint64_t seen = 0;
    for (;;) {
      const std::function<void(int, int)>* job;
      int rows, parts;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        wake_.wait(lock, [&] { return stop_ || gen_ != seen; });
        if (stop_) return;
        seen = gen_;
        job = job_;
        rows = rows_;
        parts = parts_;
      }
      (*job)(rows * index / parts, rows * (index + 1) / parts);
      {
        std::lock_guard<std::mutex> lock(mutex_);
        if (--pending_ == 0) done_.notify_one();
      }
    }
  }

  std::vector<std::thread> threads_;
  std::mutex mutex_;
  std::condition_variable wake_, done_;
  const std::function<void(int, int)>* job_ = nullptr;
  int rows_ = 0, parts_ = 0, pending_ = 0;
  uint64_t gen_ = 0;
  bool stop_ = false;
};

VideoEffectsRenderer::VideoEffectsRenderer() = default;
VideoEffectsRenderer::~VideoEffectsRenderer() = default;

// ── Parámetros ──────────────────────────────────────────────────────────────
VideoEffectsParams VideoEffectsParams::sanitized() const {
  VideoEffectsParams p = *this;
  p.rotation = ((p.rotation % 360) + 360) % 360;
  if (p.rotation % 90 != 0) p.rotation = 0;
  p.zoom = std::isfinite(p.zoom) ? std::min(2.0, std::max(1.0, p.zoom)) : 1.0;
  p.panX = clampD(p.panX, -1, 1);
  p.panY = clampD(p.panY, -1, 1);
  p.brightness = clampD(p.brightness, -1, 1);
  p.contrast = clampD(p.contrast, -1, 1);
  p.saturation = clampD(p.saturation, -1, 1);
  p.temperature = clampD(p.temperature, -1, 1);
  return p;
}

bool VideoEffectsParams::sameGeometry(const VideoEffectsParams& o) const {
  return mirror == o.mirror && flip == o.flip && rotation == o.rotation && portrait == o.portrait && zoom == o.zoom &&
         panX == o.panX && panY == o.panY;
}

bool VideoEffectsParams::sameColor(const VideoEffectsParams& o) const {
  return brightness == o.brightness && contrast == o.contrast && saturation == o.saturation && temperature == o.temperature;
}

// ── Renderizador ────────────────────────────────────────────────────────────
void VideoEffectsRenderer::setParams(const VideoEffectsParams& params) {
  const VideoEffectsParams p = params.sanitized();
  if (!p.sameGeometry(params_)) geometryDirty_ = true;
  if (!p.sameColor(params_)) colorDirty_ = true;
  params_ = p;
}

void VideoEffectsRenderer::rebuildColor() {
  const VideoEffectsParams& p = params_;
  colorIdentity_ = p.brightness == 0 && p.contrast == 0 && p.temperature == 0;
  satIdentity_ = p.saturation == 0;
  sat256_ = static_cast<int>(std::lround((1.0 + p.saturation) * 256.0));
  // Brillo como gamma (levanta sombras sin quemar blancos): +1 → γ≈0,42, -1 → γ≈2,4.
  const double gamma = std::pow(2.0, -p.brightness * 1.25);
  // Contraste alrededor del gris medio: ×0,5 … ×2.
  const double k = std::pow(2.0, p.contrast);
  // Temperatura: ganancia por canal (cálida = más rojo y menos azul).
  const double gainR = 1.0 + 0.18 * p.temperature;
  const double gainG = 1.0 + 0.04 * p.temperature;
  const double gainB = 1.0 - 0.18 * p.temperature;
  for (int v = 0; v < 256; v++) {
    double x = v / 255.0;
    if (gamma != 1.0) x = std::pow(x, gamma);
    x = (x - 0.5) * k + 0.5;
    auto to8 = [](double y) { return static_cast<uint8_t>(std::lround(std::min(1.0, std::max(0.0, y)) * 255.0)); };
    lutR_[v] = to8(x * gainR);
    lutG_[v] = to8(x * gainG);
    lutB_[v] = to8(x * gainB);
  }
  colorDirty_ = false;
}

void VideoEffectsRenderer::rebuildGeometry(ptrdiff_t pitch, int srcW, int srcH, int dstW, int dstH) {
  const VideoEffectsParams& p = params_;
  pitch_ = pitch;
  srcW_ = srcW;
  srcH_ = srcH;
  dstW_ = dstW;
  dstH_ = dstH;
  const bool swap = p.rotation == 90 || p.rotation == 270;
  dispW_ = swap ? srcH : srcW;
  dispH_ = swap ? srcW : srcH;

  // Zona del lienzo con imagen: todo el lienzo (16:9) o una franja vertical 9:16 centrada.
  if (p.portrait) {
    rectH_ = dstH;
    rectW_ = std::max(2, std::min(dstW, static_cast<int>(std::lround(dstH * 9.0 / 16.0))));
    rectX_ = (dstW - rectW_) / 2;
    rectY_ = 0;
  } else {
    rectX_ = rectY_ = 0;
    rectW_ = dstW;
    rectH_ = dstH;
  }

  // Recorte «cover» de la imagen mostrada con la relación de aspecto de la zona, zoom y desplazamiento.
  const double aspect = static_cast<double>(rectW_) / rectH_;
  double cropW, cropH;
  if (static_cast<double>(dispW_) / dispH_ > aspect) {
    cropH = dispH_;
    cropW = dispH_ * aspect;
  } else {
    cropW = dispW_;
    cropH = dispW_ / aspect;
  }
  cropW /= p.zoom;
  cropH /= p.zoom;
  // Escala 1:1 (el caso habitual): recorte en píxeles enteros para leer sin interpolar.
  if (std::fabs(cropW - rectW_) < 0.5) cropW = rectW_;
  if (std::fabs(cropH - rectH_) < 0.5) cropH = rectH_;
  double cropX = dispW_ / 2.0 + p.panX * (dispW_ - cropW) / 2.0 - cropW / 2.0;
  double cropY = dispH_ / 2.0 + p.panY * (dispH_ - cropH) / 2.0 - cropH / 2.0;
  cropX = std::min(std::max(0.0, cropX), std::max(0.0, dispW_ - cropW));
  cropY = std::min(std::max(0.0, cropY), std::max(0.0, dispH_ - cropH));
  if (cropW == rectW_) cropX = std::floor(cropX + 0.5);
  if (cropH == rectH_) cropY = std::floor(cropY + 0.5);

  // Contribución en bytes de cada eje de la imagen mostrada. Rotaciones y espejos mantienen los ejes
  // alineados: el eje horizontal mostrado recorre x del origen (0°/180°) o y (90°/270°), y viceversa.
  auto axisOffset = [&](int d, bool horizontal) -> ptrdiff_t {
    if (horizontal) {
      const int uo = p.mirror ? dispW_ - 1 - d : d;
      switch (p.rotation) {
        case 90: return static_cast<ptrdiff_t>(srcH - 1 - uo) * pitch;
        case 180: return static_cast<ptrdiff_t>(srcW - 1 - uo) * 4;
        case 270: return static_cast<ptrdiff_t>(uo) * pitch;
        default: return static_cast<ptrdiff_t>(uo) * 4;
      }
    }
    const int vo = p.flip ? dispH_ - 1 - d : d;
    switch (p.rotation) {
      case 90: return static_cast<ptrdiff_t>(vo) * 4;
      case 180: return static_cast<ptrdiff_t>(srcH - 1 - vo) * pitch;
      case 270: return static_cast<ptrdiff_t>(srcW - 1 - vo) * 4;
      default: return static_cast<ptrdiff_t>(vo) * pitch;
    }
  };
  auto build = [&](Axis& ax, int n, double start, double len, int dispLen, bool horizontal) {
    ax.off0.resize(n);
    ax.off1.resize(n);
    ax.w.resize(n);
    ax.exact = true;
    const double scale = len / n;
    for (int k = 0; k < n; k++) {
      double d = start + (k + 0.5) * scale - 0.5;
      d = std::min(std::max(0.0, d), dispLen - 1.0);
      int d0 = static_cast<int>(std::floor(d));
      int wgt = static_cast<int>(std::lround((d - d0) * 256.0));
      if (wgt >= 256) {
        d0 = std::min(d0 + 1, dispLen - 1);
        wgt = 0;
      }
      const int d1 = wgt ? std::min(d0 + 1, dispLen - 1) : d0;
      ax.off0[k] = axisOffset(d0, horizontal);
      ax.off1[k] = axisOffset(d1, horizontal);
      ax.w[k] = static_cast<uint16_t>(wgt);
      if (wgt) ax.exact = false;
    }
  };
  build(cols_, rectW_, cropX, cropW, dispW_, true);
  build(rows_, rectH_, cropY, cropH, dispH_, false);

  // Fondo de los laterales (9:16): muestras de la imagen completa (recorte 16:9 sin zoom) por celda.
  if (p.portrait) {
    constexpr int S = 3;  // 3x3 muestras por celda
    double bw, bh;
    if (static_cast<double>(dispW_) / dispH_ > 16.0 / 9.0) {
      bh = dispH_;
      bw = dispH_ * 16.0 / 9.0;
    } else {
      bw = dispW_;
      bh = dispW_ * 9.0 / 16.0;
    }
    const double bx = (dispW_ - bw) / 2.0, by = (dispH_ - bh) / 2.0;
    bgSampleCols_.resize(kBgW * S);
    bgSampleRows_.resize(kBgH * S);
    for (int i = 0; i < kBgW * S; i++) {
      const int d = std::min(dispW_ - 1, std::max(0, static_cast<int>(bx + (i + 0.5) * bw / (kBgW * S))));
      bgSampleCols_[i] = axisOffset(d, true);
    }
    for (int i = 0; i < kBgH * S; i++) {
      const int d = std::min(dispH_ - 1, std::max(0, static_cast<int>(by + (i + 0.5) * bh / (kBgH * S))));
      bgSampleRows_[i] = axisOffset(d, false);
    }
    bg_.assign(static_cast<size_t>(kBgW) * kBgH, 0xFF000000u);
    bgTmp_.assign(bg_.size(), 0xFF000000u);
    // Escalado de la rejilla al lienzo en bloques de 2x2 (el fondo está muy difuminado).
    const int blocksX = (dstW + 1) / 2, blocksY = (dstH + 1) / 2;
    bgX0_.resize(blocksX);
    bgX1_.resize(blocksX);
    bgWx_.resize(blocksX);
    bgY0_.resize(blocksY);
    bgY1_.resize(blocksY);
    bgWy_.resize(blocksY);
    auto grid = [](int block, int canvas, int cells, int& g0, int& g1, uint16_t& w) {
      double g = (block * 2 + 1) * static_cast<double>(cells) / canvas - 0.5;
      g = std::min(std::max(0.0, g), cells - 1.0);
      g0 = static_cast<int>(std::floor(g));
      g1 = std::min(g0 + 1, cells - 1);
      w = static_cast<uint16_t>(std::min(255L, std::lround((g - g0) * 256.0)));
    };
    for (int i = 0; i < blocksX; i++) grid(i, dstW, kBgW, bgX0_[i], bgX1_[i], bgWx_[i]);
    for (int i = 0; i < blocksY; i++) grid(i, dstH, kBgH, bgY0_[i], bgY1_[i], bgWy_[i]);
  }
  geometryDirty_ = false;
}

void VideoEffectsRenderer::renderBackground(const uint8_t* src, uint8_t* dstBytes, int dstW, int dstH) {
  constexpr int S = 3;
  const ColorOps color{lutR_, lutG_, lutB_, sat256_};
  // 1) Rejilla 32x18: media de 3x3 muestras por celda, con el mismo color que la imagen y oscurecida.
  for (int gy = 0; gy < kBgH; gy++) {
    for (int gx = 0; gx < kBgW; gx++) {
      uint32_t sr = 0, sg = 0, sb = 0;
      for (int sy = 0; sy < S; sy++) {
        const uint8_t* row = src + bgSampleRows_[gy * S + sy];
        for (int sx = 0; sx < S; sx++) {
          const uint32_t px = load32(row + bgSampleCols_[gx * S + sx]);
          sr += (px >> 16) & 0xFF;
          sg += (px >> 8) & 0xFF;
          sb += px & 0xFF;
        }
      }
      const uint32_t avg = ((sr / (S * S)) << 16) | ((sg / (S * S)) << 8) | (sb / (S * S));
      uint32_t c = colorIdentity_ ? (satIdentity_ ? toRgba<false, false>(avg, color) : toRgba<false, true>(avg, color))
                                  : (satIdentity_ ? toRgba<true, false>(avg, color) : toRgba<true, true>(avg, color));
      // Oscurecer al 42 % para que la franja vertical destaque.
      const uint32_t rb = (((c & 0x00FF00FFu) * 108) >> 8) & 0x00FF00FFu;
      const uint32_t g = (((c >> 8) & 0xFFu) * 108) >> 8;
      bg_[static_cast<size_t>(gy) * kBgW + gx] = rb | (g << 8) | 0xFF000000u;
    }
  }
  // 2) Desenfoque separable [1 2 1]/4, dos pasadas.
  auto blur121 = [](uint32_t a, uint32_t b, uint32_t c) { return lerp32(lerp32(a, c, 128), b, 128); };
  for (int pass = 0; pass < 2; pass++) {
    for (int y = 0; y < kBgH; y++) {
      for (int x = 0; x < kBgW; x++) {
        const uint32_t* r = bg_.data() + static_cast<size_t>(y) * kBgW;
        bgTmp_[static_cast<size_t>(y) * kBgW + x] = blur121(r[std::max(0, x - 1)], r[x], r[std::min(kBgW - 1, x + 1)]);
      }
    }
    for (int y = 0; y < kBgH; y++) {
      for (int x = 0; x < kBgW; x++) {
        const uint32_t up = bgTmp_[static_cast<size_t>(std::max(0, y - 1)) * kBgW + x];
        const uint32_t mid = bgTmp_[static_cast<size_t>(y) * kBgW + x];
        const uint32_t down = bgTmp_[static_cast<size_t>(std::min(kBgH - 1, y + 1)) * kBgW + x];
        bg_[static_cast<size_t>(y) * kBgW + x] = blur121(up, mid, down);
      }
    }
  }
  // 3) Escalado bilineal a los laterales, un valor por bloque de 2x2.
  uint32_t* dst = reinterpret_cast<uint32_t*>(dstBytes);
  const int leftEnd = rectX_, rightStart = rectX_ + rectW_;
  for (int y = 0; y < dstH; y += 2) {
    const int by = y >> 1;
    const uint32_t* rowA = bg_.data() + static_cast<size_t>(bgY0_[by]) * kBgW;
    const uint32_t* rowB = bg_.data() + static_cast<size_t>(bgY1_[by]) * kBgW;
    const uint32_t wy = bgWy_[by];
    uint32_t* out0 = dst + static_cast<size_t>(y) * dstW;
    uint32_t* out1 = y + 1 < dstH ? out0 + dstW : nullptr;
    auto fill = [&](int xStart, int xEnd) {
      for (int x = xStart; x < xEnd;) {
        const int bx = x >> 1;
        const uint32_t top = lerp32(rowA[bgX0_[bx]], rowA[bgX1_[bx]], bgWx_[bx]);
        const uint32_t bottom = lerp32(rowB[bgX0_[bx]], rowB[bgX1_[bx]], bgWx_[bx]);
        const uint32_t v = lerp32(top, bottom, wy);
        const int xe = std::min(xEnd, (bx + 1) * 2);
        for (; x < xe; x++) {
          out0[x] = v;
          if (out1) out1[x] = v;
        }
      }
    };
    fill(0, leftEnd);
    fill(rightStart, dstW);
  }
}

void VideoEffectsRenderer::render(const uint8_t* src, ptrdiff_t pitch, int srcW, int srcH, uint8_t* dst, int dstW, int dstH) {
  if (!src || !dst || srcW < 2 || srcH < 2 || dstW < 2 || dstH < 2) return;
  if (colorDirty_) rebuildColor();
  if (geometryDirty_ || pitch != pitch_ || srcW != srcW_ || srcH != srcH_ || dstW != dstW_ || dstH != dstH_) {
    rebuildGeometry(pitch, srcW, srcH, dstW, dstH);
  }
  const bool bilinear = !(cols_.exact && rows_.exact);
  const ContentJob job{src, reinterpret_cast<uint32_t*>(dst), dstW, rectX_, rectY_, rectW_,
                       cols_.off0.data(), cols_.off1.data(), rows_.off0.data(), rows_.off1.data(), cols_.w.data(), rows_.w.data(),
                       ColorOps{lutR_, lutG_, lutB_, sat256_}};
  const ContentFn fn = pickContent(bilinear, !colorIdentity_, !satIdentity_);
  // El caso 1:1 sin color (~1,5 ms, limitado por memoria) va en el hilo de captura; interpolar o
  // ajustar color se reparte por franjas de filas entre unos pocos hilos persistentes.
  if (bilinear || !colorIdentity_ || !satIdentity_) {
    if (!pool_) pool_ = std::make_unique<RowPool>();
    pool_->run(rectH_, [&](int j0, int j1) { fn(job, j0, j1); });
  } else {
    fn(job, 0, rectH_);
  }
  if (params_.portrait && (rectW_ < dstW || rectH_ < dstH)) renderBackground(src, dst, dstW, dstH);
}

void VideoEffectsRenderer::renderNv12(const uint8_t* src, ptrdiff_t pitch, int srcW, int srcH, uint8_t* nv12, int dstW, int dstH) {
  if (!nv12 || dstW < 2 || dstH < 2 || ((dstW | dstH) & 1)) return;
  canvas_.resize(static_cast<size_t>(dstW) * dstH * 4);
  render(src, pitch, srcW, srcH, canvas_.data(), dstW, dstH);
  if (!pool_) pool_ = std::make_unique<RowPool>();
  const uint32_t w = static_cast<uint32_t>(dstW), h = static_cast<uint32_t>(dstH);
  uint8_t* yPlane = nv12;
  uint8_t* uvPlane = nv12 + static_cast<size_t>(w) * h;
  // Por pares de filas (cada fila de croma sale de dos de luma).
  pool_->run(dstH / 2, [&](int p0, int p1) {
    vcam::rgbaToNv12Rows(canvas_.data(), static_cast<size_t>(w) * 4, w, h, static_cast<uint32_t>(p0) * 2, static_cast<uint32_t>(p1) * 2,
                         yPlane, w, uvPlane, w);
  });
}


}  // namespace voxora
