// Carga útil del instalador (formato VXPK): índice de archivos + datos comprimidos con LZMS
// (Windows Compression API, cabinet.dll) en bloques de 16 MiB, para extraer en streaming con progreso.
//
//   "VXPK0001" | u32 fileCount | u64 totalBytes | u32 chunkSize | u32 chunkCount
//   fileCount × { u16 pathLen | path UTF-8 (separador '\') | u64 size | u8 sha256[32] }
//   chunkCount × { u32 compressedSize | u32 rawSize }
//   datos de los bloques (concatenación de los archivos en el orden del índice)
//
// Integridad: el instalador verifica el SHA256 de la carga completa (recurso PAYLOAD_SHA256) antes de
// extraer y el SHA256 de cada archivo antes de darlo por escrito.
#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace vxsetup {

struct PayloadEntry {
  std::wstring path;  // relativo, con '\'
  uint64_t size = 0;
  uint8_t sha256[32] = {};
};

struct PayloadIndex {
  std::vector<PayloadEntry> files;
  uint64_t totalBytes = 0;
  uint32_t chunkSize = 0;
  std::vector<std::pair<uint32_t, uint32_t>> chunks;  // compressed, raw
  size_t dataOffset = 0;
};

// SHA256 (CNG).
class Sha256 {
 public:
  Sha256();
  ~Sha256();
  Sha256(const Sha256&) = delete;
  Sha256& operator=(const Sha256&) = delete;
  void update(const void* data, size_t size);
  void finish(uint8_t out[32]);

 private:
  void* alg_ = nullptr;
  void* hash_ = nullptr;
};
std::string toHex(const uint8_t* data, size_t size);
std::string sha256Hex(const void* data, size_t size);

bool parsePayload(const uint8_t* data, size_t size, PayloadIndex& index, std::wstring& error);

// Destino de la extracción: begin → write* → commit (solo si el SHA256 coincide) | abort.
struct FileSink {
  std::function<bool(const PayloadEntry&, std::wstring& error)> begin;
  std::function<bool(const uint8_t* bytes, size_t size, std::wstring& error)> write;
  std::function<bool(const PayloadEntry&, std::wstring& error)> commit;
  std::function<void()> abort;
};
// Progreso: bytes escritos, total. Devuelve false para cancelar.
using ExtractProgress = std::function<bool(uint64_t done, uint64_t total, const std::wstring& file)>;

bool extractPayload(const uint8_t* data, size_t size, const PayloadIndex& index, const FileSink& sink,
                    const ExtractProgress& progress, std::wstring& error);

// Empaquetado (vxpack.exe): todos los archivos bajo `root`, en orden estable.
bool buildPayload(const std::wstring& root, const std::wstring& outFile, std::wstring& error,
                  const std::function<void(const std::wstring&)>& log);

std::string toUtf8(const std::wstring& text);
std::wstring toWide(const std::string& text);

}  // namespace vxsetup
