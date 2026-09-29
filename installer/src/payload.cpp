#include "payload.h"

#include <bcrypt.h>
#include <compressapi.h>

#include <algorithm>
#include <cstring>
#include <memory>

#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "cabinet.lib")

namespace vxsetup {
namespace {

constexpr char kMagic[8] = {'V', 'X', 'P', 'K', '0', '0', '0', '1'};
constexpr uint32_t kChunkSize = 16u * 1024 * 1024;

class Reader {
 public:
  Reader(const uint8_t* data, size_t size) : data_(data), size_(size) {}
  bool bytes(void* out, size_t n) {
    if (pos_ + n > size_ || pos_ + n < pos_) return false;
    std::memcpy(out, data_ + pos_, n);
    pos_ += n;
    return true;
  }
  template <typename T>
  bool value(T& out) { return bytes(&out, sizeof(T)); }
  size_t pos() const { return pos_; }

 private:
  const uint8_t* data_;
  size_t size_;
  size_t pos_ = 0;
};

template <typename T>
void put(std::string& out, T v) { out.append(reinterpret_cast<const char*>(&v), sizeof(T)); }

bool validRelativePath(const std::wstring& p) {
  if (p.empty() || p.size() > 400 || p[0] == L'\\' || p[0] == L'/' || p.find(L':') != std::wstring::npos) return false;
  size_t start = 0;
  for (;;) {
    const size_t end = p.find(L'\\', start);
    const std::wstring part = p.substr(start, end == std::wstring::npos ? std::wstring::npos : end - start);
    if (part.empty() || part == L"." || part == L".." || part.find(L'/') != std::wstring::npos) return false;
    if (end == std::wstring::npos) return true;
    start = end + 1;
  }
}

}  // namespace

std::string toUtf8(const std::wstring& text) {
  if (text.empty()) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  std::string out(static_cast<size_t>(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), out.data(), n, nullptr, nullptr);
  return out;
}

std::wstring toWide(const std::string& text) {
  if (text.empty()) return {};
  const int n = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), nullptr, 0);
  std::wstring out(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), out.data(), n);
  return out;
}

Sha256::Sha256() {
  BCRYPT_ALG_HANDLE alg = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0) BCryptCreateHash(alg, &hash, nullptr, 0, nullptr, 0, 0);
  alg_ = alg;
  hash_ = hash;
}

Sha256::~Sha256() {
  if (hash_) BCryptDestroyHash(static_cast<BCRYPT_HASH_HANDLE>(hash_));
  if (alg_) BCryptCloseAlgorithmProvider(static_cast<BCRYPT_ALG_HANDLE>(alg_), 0);
}

void Sha256::update(const void* data, size_t size) {
  const auto* p = static_cast<const uint8_t*>(data);
  while (hash_ && size > 0) {
    const ULONG n = static_cast<ULONG>(std::min<size_t>(size, 1u << 30));
    BCryptHashData(static_cast<BCRYPT_HASH_HANDLE>(hash_), const_cast<PUCHAR>(p), n, 0);
    p += n;
    size -= n;
  }
}

void Sha256::finish(uint8_t out[32]) {
  std::memset(out, 0, 32);
  if (hash_) BCryptFinishHash(static_cast<BCRYPT_HASH_HANDLE>(hash_), out, 32, 0);
}

std::string toHex(const uint8_t* data, size_t size) {
  static const char* digits = "0123456789abcdef";
  std::string out;
  out.reserve(size * 2);
  for (size_t i = 0; i < size; ++i) {
    out += digits[data[i] >> 4];
    out += digits[data[i] & 15];
  }
  return out;
}

std::string sha256Hex(const void* data, size_t size) {
  Sha256 h;
  h.update(data, size);
  uint8_t digest[32];
  h.finish(digest);
  return toHex(digest, 32);
}

bool parsePayload(const uint8_t* data, size_t size, PayloadIndex& index, std::wstring& error) {
  Reader r(data, size);
  char magic[8];
  uint32_t fileCount = 0, chunkCount = 0;
  if (!r.bytes(magic, 8) || std::memcmp(magic, kMagic, 8) != 0) {
    error = L"la carga útil no tiene el formato esperado";
    return false;
  }
  if (!r.value(fileCount) || !r.value(index.totalBytes) || !r.value(index.chunkSize) || !r.value(chunkCount) ||
      fileCount > 100000 || chunkCount > 100000 || index.chunkSize == 0 || index.chunkSize > 256u * 1024 * 1024) {
    error = L"cabecera de la carga útil dañada";
    return false;
  }
  uint64_t sum = 0;
  index.files.clear();
  for (uint32_t i = 0; i < fileCount; ++i) {
    uint16_t len = 0;
    PayloadEntry e;
    std::string path;
    if (!r.value(len)) break;
    path.resize(len);
    if (!r.bytes(path.data(), len) || !r.value(e.size) || !r.bytes(e.sha256, 32)) {
      error = L"índice de la carga útil dañado";
      return false;
    }
    e.path = toWide(path);
    if (!validRelativePath(e.path)) {
      error = L"ruta no válida en la carga útil: " + e.path;
      return false;
    }
    sum += e.size;
    index.files.push_back(std::move(e));
  }
  if (index.files.size() != fileCount || sum != index.totalBytes) {
    error = L"índice de la carga útil incoherente";
    return false;
  }
  uint64_t raw = 0, compressed = 0;
  index.chunks.clear();
  for (uint32_t i = 0; i < chunkCount; ++i) {
    uint32_t c = 0, u = 0;
    if (!r.value(c) || !r.value(u) || u > index.chunkSize) {
      error = L"tabla de bloques dañada";
      return false;
    }
    raw += u;
    compressed += c;
    index.chunks.emplace_back(c, u);
  }
  index.dataOffset = r.pos();
  if (raw != index.totalBytes || index.dataOffset + compressed != size) {
    error = L"la carga útil está incompleta o dañada";
    return false;
  }
  return true;
}

bool extractPayload(const uint8_t* data, size_t size, const PayloadIndex& index, const FileSink& sink,
                    const ExtractProgress& progress, std::wstring& error) {
  (void)size;
  DECOMPRESSOR_HANDLE decompressor = nullptr;
  if (!CreateDecompressor(COMPRESS_ALGORITHM_LZMS, nullptr, &decompressor)) {
    error = L"no se pudo iniciar el descompresor (" + std::to_wstring(GetLastError()) + L")";
    return false;
  }
  std::vector<uint8_t> buffer(index.chunkSize);
  size_t fileIdx = 0;
  uint64_t fileLeft = 0;
  uint64_t done = 0;
  bool open = false;
  std::unique_ptr<Sha256> hash;
  bool ok = true;

  auto openNext = [&]() -> bool {
    // Abre el siguiente archivo (los de tamaño 0 se abren y confirman al momento).
    while (fileIdx < index.files.size()) {
      const PayloadEntry& e = index.files[fileIdx];
      if (!sink.begin(e, error)) return false;
      hash = std::make_unique<Sha256>();
      fileLeft = e.size;
      open = true;
      if (fileLeft > 0) return true;
      uint8_t digest[32];
      hash->finish(digest);
      if (std::memcmp(digest, e.sha256, 32) != 0) {
        error = L"archivo dañado en la carga útil: " + e.path;
        return false;
      }
      if (!sink.commit(e, error)) return false;
      open = false;
      ++fileIdx;
    }
    return true;
  };

  if (!openNext()) ok = false;
  size_t offset = index.dataOffset;
  for (size_t c = 0; ok && c < index.chunks.size(); ++c) {
    const auto [compressedSize, rawSize] = index.chunks[c];
    SIZE_T produced = 0;
    if (!Decompress(decompressor, data + offset, compressedSize, buffer.data(), rawSize, &produced) || produced != rawSize) {
      error = L"no se pudo descomprimir el bloque " + std::to_wstring(c) + L" (" + std::to_wstring(GetLastError()) + L")";
      ok = false;
      break;
    }
    offset += compressedSize;
    size_t pos = 0;
    while (ok && pos < rawSize) {
      if (!open || fileIdx >= index.files.size()) {
        error = L"la carga útil tiene más datos de los declarados";
        ok = false;
        break;
      }
      const PayloadEntry& e = index.files[fileIdx];
      const size_t n = static_cast<size_t>(std::min<uint64_t>(fileLeft, rawSize - pos));
      if (!sink.write(buffer.data() + pos, n, error)) {
        ok = false;
        break;
      }
      hash->update(buffer.data() + pos, n);
      pos += n;
      fileLeft -= n;
      done += n;
      if (fileLeft == 0) {
        uint8_t digest[32];
        hash->finish(digest);
        if (std::memcmp(digest, e.sha256, 32) != 0) {
          error = L"archivo dañado en la carga útil: " + e.path;
          ok = false;
          break;
        }
        if (!sink.commit(e, error)) {
          ok = false;
          break;
        }
        open = false;
        ++fileIdx;
        if (!openNext()) {
          ok = false;
          break;
        }
      }
      if (progress && !progress(done, index.totalBytes, e.path)) {
        error = L"cancelado";
        ok = false;
      }
    }
  }
  if (ok && (fileIdx != index.files.size() || done != index.totalBytes)) {
    error = L"la carga útil terminó antes de tiempo";
    ok = false;
  }
  if (!ok && open && sink.abort) sink.abort();
  CloseDecompressor(decompressor);
  return ok;
}

// ── Empaquetado ───────────────────────────────────────────────────────────────
namespace {

void collect(const std::wstring& root, const std::wstring& rel, std::vector<std::wstring>& out) {
  WIN32_FIND_DATAW fd{};
  const std::wstring dir = rel.empty() ? root : root + L"\\" + rel;
  HANDLE find = FindFirstFileW((dir + L"\\*").c_str(), &fd);
  if (find == INVALID_HANDLE_VALUE) return;
  std::vector<std::pair<std::wstring, bool>> entries;
  do {
    const std::wstring name = fd.cFileName;
    if (name == L"." || name == L"..") continue;
    entries.emplace_back(name, (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0);
  } while (FindNextFileW(find, &fd));
  FindClose(find);
  std::sort(entries.begin(), entries.end(), [](const auto& a, const auto& b) { return _wcsicmp(a.first.c_str(), b.first.c_str()) < 0; });
  for (const auto& [name, isDir] : entries) {
    const std::wstring child = rel.empty() ? name : rel + L"\\" + name;
    if (isDir) collect(root, child, out);
    else out.push_back(child);
  }
}

bool readAll(const std::wstring& path, std::vector<uint8_t>& out) {
  HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  if (h == INVALID_HANDLE_VALUE) return false;
  LARGE_INTEGER size{};
  GetFileSizeEx(h, &size);
  out.resize(static_cast<size_t>(size.QuadPart));
  size_t pos = 0;
  bool ok = true;
  while (pos < out.size()) {
    DWORD read = 0;
    const DWORD want = static_cast<DWORD>(std::min<size_t>(out.size() - pos, 64u * 1024 * 1024));
    if (!ReadFile(h, out.data() + pos, want, &read, nullptr) || read == 0) {
      ok = false;
      break;
    }
    pos += read;
  }
  CloseHandle(h);
  return ok;
}

}  // namespace

bool buildPayload(const std::wstring& root, const std::wstring& outFile, std::wstring& error,
                  const std::function<void(const std::wstring&)>& log) {
  std::vector<std::wstring> files;
  collect(root, L"", files);
  if (files.empty()) {
    error = L"no hay archivos en " + root;
    return false;
  }
  COMPRESSOR_HANDLE compressor = nullptr;
  if (!CreateCompressor(COMPRESS_ALGORITHM_LZMS, nullptr, &compressor)) {
    error = L"CreateCompressor falló (" + std::to_wstring(GetLastError()) + L")";
    return false;
  }
  std::string index;
  std::vector<std::pair<uint32_t, uint32_t>> chunkTable;
  std::string compressedData;
  std::vector<uint8_t> chunk;
  chunk.reserve(kChunkSize);
  uint64_t total = 0;
  bool ok = true;

  auto flush = [&]() -> bool {
    if (chunk.empty()) return true;
    SIZE_T needed = 0;
    Compress(compressor, chunk.data(), chunk.size(), nullptr, 0, &needed);
    std::vector<uint8_t> out(needed ? needed : chunk.size() + 4096);
    SIZE_T written = 0;
    if (!Compress(compressor, chunk.data(), chunk.size(), out.data(), out.size(), &written)) {
      error = L"Compress falló (" + std::to_wstring(GetLastError()) + L")";
      return false;
    }
    chunkTable.emplace_back(static_cast<uint32_t>(written), static_cast<uint32_t>(chunk.size()));
    compressedData.append(reinterpret_cast<const char*>(out.data()), written);
    chunk.clear();
    return true;
  };

  for (const auto& rel : files) {
    std::vector<uint8_t> bytes;
    if (!readAll(root + L"\\" + rel, bytes)) {
      error = L"no se pudo leer " + rel;
      ok = false;
      break;
    }
    const std::string path = toUtf8(rel);
    if (path.size() > 0xFFFF) {
      error = L"ruta demasiado larga: " + rel;
      ok = false;
      break;
    }
    put(index, static_cast<uint16_t>(path.size()));
    index += path;
    put(index, static_cast<uint64_t>(bytes.size()));
    Sha256 h;
    h.update(bytes.data(), bytes.size());
    uint8_t digest[32];
    h.finish(digest);
    index.append(reinterpret_cast<const char*>(digest), 32);
    total += bytes.size();
    size_t pos = 0;
    while (pos < bytes.size()) {
      const size_t n = std::min<size_t>(bytes.size() - pos, kChunkSize - chunk.size());
      chunk.insert(chunk.end(), bytes.begin() + static_cast<ptrdiff_t>(pos), bytes.begin() + static_cast<ptrdiff_t>(pos + n));
      pos += n;
      if (chunk.size() == kChunkSize && !flush()) {
        ok = false;
        break;
      }
    }
    if (!ok) break;
    if (log) log(rel + L" (" + std::to_wstring(bytes.size()) + L" bytes)");
  }
  if (ok) ok = flush();
  CloseCompressor(compressor);
  if (!ok) return false;

  std::string header(kMagic, 8);
  put(header, static_cast<uint32_t>(files.size()));
  put(header, total);
  put(header, kChunkSize);
  put(header, static_cast<uint32_t>(chunkTable.size()));
  header += index;
  for (const auto& [c, u] : chunkTable) {
    put(header, c);
    put(header, u);
  }
  HANDLE out = CreateFileW(outFile.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (out == INVALID_HANDLE_VALUE) {
    error = L"no se pudo crear " + outFile;
    return false;
  }
  DWORD written = 0;
  ok = WriteFile(out, header.data(), static_cast<DWORD>(header.size()), &written, nullptr) && written == header.size();
  size_t pos = 0;
  while (ok && pos < compressedData.size()) {
    const DWORD n = static_cast<DWORD>(std::min<size_t>(compressedData.size() - pos, 64u * 1024 * 1024));
    ok = WriteFile(out, compressedData.data() + pos, n, &written, nullptr) && written == n;
    pos += n;
  }
  CloseHandle(out);
  if (!ok) error = L"no se pudo escribir " + outFile;
  if (ok && log) {
    log(L"VXPK: " + std::to_wstring(files.size()) + L" archivos, " + std::to_wstring(total) + L" → " +
        std::to_wstring(header.size() + compressedData.size()) + L" bytes, " + std::to_wstring(chunkTable.size()) + L" bloques");
  }
  return ok;
}

}  // namespace vxsetup
