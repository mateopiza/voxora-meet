// VoxoraMeetFrameWriter.exe — productor de frames. Lee por stdin (binario) frames RGBA crudos con una
// cabecera de 16 bytes little-endian { uint32 width; uint32 height; uint64 timestampMs } seguida de
// width*height*4 bytes, los copia al ring de memoria compartida del contrato y señala el evento
// "frame listo". Así Node puede alimentar la cámara sin addon nativo.
//
// La apertura/publicación/latido es la MISMA que usa el shell (VoxoraMeet.exe): common/frame_producer.h.
// El mapping lo crea la DLL cuando una app abre la cámara; hasta entonces los frames se descartan y se
// reintenta abrirlo cada 500 ms (también mientras llegan frames).
//
// Salida por stdout: `READY` al arrancar; por stderr mensajes de diagnóstico (`WAITING`, `MAPPING
// opened|created`, `MAPPING lost`, `EOF frames=… dropped=…`).
// Códigos de salida: 0 OK (EOF en stdin) · 2 uso · 3 error de protocolo (cabecera inválida)

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <fcntl.h>
#include <io.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "../common/frame_producer.h"

using namespace voxora::vcam;

namespace {

constexpr wchar_t kWriterVersion[] = L"0.2.0";

#pragma pack(push, 1)
struct FrameHeader {
  uint32_t width;
  uint32_t height;
  uint64_t timestampMs;
};
#pragma pack(pop)
static_assert(sizeof(FrameHeader) == 16, "la cabecera de frame debe medir 16 bytes");

// Lee exactamente `size` bytes de stdin; false en EOF.
bool readExact(void* dst, size_t size) {
  uint8_t* out = static_cast<uint8_t*>(dst);
  while (size > 0) {
    const size_t got = std::fread(out, 1, size, stdin);
    if (got == 0) return false;
    out += got;
    size -= got;
  }
  return true;
}

// Envuelve FrameProducer con los mensajes de diagnóstico del writer.
class Producer {
 public:
  bool ensureOpen(int64_t now) {
    const bool wasConnected = producer_.connected();
    if (producer_.ensureOpen(now)) {
      if (!wasConnected) {
        std::fprintf(stderr, "MAPPING %s %ls\n", producer_.createdMapping() ? "created" : "opened", kFramesMappingName);
        warned_ = false;
      }
      return true;
    }
    if (!warned_ && producer_.lastError() != 0) {
      std::fprintf(stderr,
                   "WAITING mapping %ls no disponible (Win32 %lu). Se crea cuando una app abre la camara "
                   "(la DLL corre en el FrameServer); reintentando cada 500 ms.\n",
                   kFramesMappingName, producer_.lastError());
      warned_ = true;
    }
    return false;
  }

  void publish(const FrameHeader& frame, const std::vector<uint8_t>& pixels, int64_t now) {
    producer_.publish(pixels.data(), frame.width, frame.height, int64_t(frame.timestampMs) * 10'000, now);
  }

 private:
  FrameProducer producer_;
  bool warned_ = false;
};

}  // namespace

int wmain(int argc, wchar_t** argv) {
  for (int i = 1; i < argc; ++i) {
    const std::wstring arg = argv[i];
    if (arg == L"--version") {
      std::wprintf(L"VoxoraMeetFrameWriter %ls\n", kWriterVersion);
      return 0;
    }
    std::fwprintf(stderr, L"Uso: VoxoraMeetFrameWriter.exe [--version]  (frames RGBA por stdin)\n");
    return 2;
  }

  _setmode(_fileno(stdin), _O_BINARY);
  Producer producer;
  producer.ensureOpen(qpcNow100ns());

  std::printf("READY\n");
  std::fflush(stdout);

  std::vector<uint8_t> pixels;
  uint64_t received = 0;
  uint64_t dropped = 0;
  FrameHeader frame{};
  while (readExact(&frame, sizeof(frame))) {
    if (frame.width < 2 || frame.height < 2 || frame.width > kMaxWidth || frame.height > kMaxHeight ||
        (frame.width & 1) || (frame.height & 1)) {
      std::fprintf(stderr, "ERROR cabecera invalida: %u x %u (max %u x %u, dimensiones pares)\n", frame.width,
                   frame.height, kMaxWidth, kMaxHeight);
      return 3;
    }
    const size_t bytes = size_t(frame.width) * frame.height * 4;
    pixels.resize(bytes);
    if (!readExact(pixels.data(), bytes)) break;
    ++received;

    const int64_t now = qpcNow100ns();
    if (!producer.ensureOpen(now)) {
      ++dropped;  // sin mapping todavía: se descarta pero se sigue consumiendo stdin
      continue;
    }
    producer.publish(frame, pixels, now);
  }

  std::fprintf(stderr, "EOF frames=%llu dropped=%llu\n", static_cast<unsigned long long>(received),
               static_cast<unsigned long long>(dropped));
  return 0;
}
