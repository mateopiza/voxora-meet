// vxpack.exe — empaqueta el layout de instalación (dist\VOXORA-Meet-<versión>) en la carga útil VXPK
// del instalador y escribe su SHA256 (hex) en <salida>.sha256. Lo invoca scripts/release.mjs.
//
//   vxpack.exe pack <carpeta> <payload.bin>
//   vxpack.exe verify <payload.bin> [<carpeta a comparar>]   descomprime en memoria y valida los hashes
#include <windows.h>

#include <cstdio>
#include <string>
#include <vector>

#include "../src/payload.h"

namespace {

bool readFileAll(const std::wstring& path, std::vector<uint8_t>& out) {
  HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
  if (h == INVALID_HANDLE_VALUE) return false;
  LARGE_INTEGER size{};
  GetFileSizeEx(h, &size);
  out.resize(static_cast<size_t>(size.QuadPart));
  size_t pos = 0;
  while (pos < out.size()) {
    DWORD read = 0;
    if (!ReadFile(h, out.data() + pos, static_cast<DWORD>(std::min<size_t>(out.size() - pos, 1u << 26)), &read, nullptr) || !read) break;
    pos += read;
  }
  CloseHandle(h);
  return pos == out.size();
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc >= 4 && std::wstring(argv[1]) == L"pack") {
    std::wstring error;
    const bool ok = vxsetup::buildPayload(argv[2], argv[3], error, [](const std::wstring& line) {
      std::fwprintf(stdout, L"  %ls\n", line.c_str());
    });
    if (!ok) {
      std::fwprintf(stderr, L"ERROR: %ls\n", error.c_str());
      return 1;
    }
    std::vector<uint8_t> data;
    if (!readFileAll(argv[3], data)) return 1;
    const std::string hex = vxsetup::sha256Hex(data.data(), data.size());
    const std::wstring shaFile = std::wstring(argv[3]) + L".sha256";
    HANDLE h = CreateFileW(shaFile.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, 0, nullptr);
    if (h == INVALID_HANDLE_VALUE) return 1;
    DWORD written = 0;
    WriteFile(h, hex.data(), static_cast<DWORD>(hex.size()), &written, nullptr);
    CloseHandle(h);
    std::printf("sha256 %s\n", hex.c_str());
    return 0;
  }
  if (argc >= 3 && std::wstring(argv[1]) == L"verify") {
    std::vector<uint8_t> data;
    if (!readFileAll(argv[2], data)) {
      std::fwprintf(stderr, L"ERROR: no se pudo leer %ls\n", argv[2]);
      return 1;
    }
    vxsetup::PayloadIndex index;
    std::wstring error;
    if (!vxsetup::parsePayload(data.data(), data.size(), index, error)) {
      std::fwprintf(stderr, L"ERROR: %ls\n", error.c_str());
      return 1;
    }
    const std::wstring compare = argc >= 4 ? argv[3] : L"";
    std::vector<uint8_t> expected;
    size_t cursor = 0;
    vxsetup::FileSink sink;
    sink.begin = [&](const vxsetup::PayloadEntry& e, std::wstring& err) {
      cursor = 0;
      expected.clear();
      if (!compare.empty() && !readFileAll(compare + L"\\" + e.path, expected)) {
        err = L"falta en la carpeta: " + e.path;
        return false;
      }
      return true;
    };
    sink.write = [&](const uint8_t* bytes, size_t n, std::wstring& err) {
      if (!compare.empty() && (cursor + n > expected.size() || memcmp(expected.data() + cursor, bytes, n) != 0)) {
        err = L"contenido distinto";
        return false;
      }
      cursor += n;
      return true;
    };
    sink.commit = [&](const vxsetup::PayloadEntry& e, std::wstring& err) {
      if (!compare.empty() && cursor != expected.size()) {
        err = L"tamaño distinto: " + e.path;
        return false;
      }
      return true;
    };
    if (!vxsetup::extractPayload(data.data(), data.size(), index, sink, nullptr, error)) {
      std::fwprintf(stderr, L"ERROR: %ls\n", error.c_str());
      return 1;
    }
    std::printf("OK %zu archivos, %llu bytes, %zu bloques, sha256 %s\n", index.files.size(),
                static_cast<unsigned long long>(index.totalBytes), index.chunks.size(),
                vxsetup::sha256Hex(data.data(), data.size()).c_str());
    return 0;
  }
  std::fwprintf(stderr, L"Uso: vxpack.exe pack <carpeta> <payload.bin> | verify <payload.bin> [<carpeta>]\n");
  return 2;
}
