#include "native_dialogs.h"

#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <shellapi.h>
#include <shobjidl.h>
#include <wrl/client.h>

#include <algorithm>
#include <cwctype>

using Microsoft::WRL::ComPtr;

namespace voxora {

std::vector<std::wstring> pickAudioFiles(HWND owner) {
  std::vector<std::wstring> out;
  ComPtr<IFileOpenDialog> dialog;
  if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog)))) return out;
  const COMDLG_FILTERSPEC filters[] = {
      {L"Audio (wav, mp3, m4a, ogg, flac)", L"*.wav;*.mp3;*.m4a;*.ogg;*.flac"},
      {L"Todos los archivos", L"*.*"},
  };
  dialog->SetFileTypes(static_cast<UINT>(std::size(filters)), filters);
  dialog->SetFileTypeIndex(1);
  dialog->SetTitle(L"Elige muestras de tu voz");
  dialog->SetOkButtonLabel(L"Añadir");
  DWORD options = 0;
  dialog->GetOptions(&options);
  dialog->SetOptions(options | FOS_ALLOWMULTISELECT | FOS_FILEMUSTEXIST | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
  if (FAILED(dialog->Show(owner))) return out;  // cancelado
  ComPtr<IShellItemArray> items;
  if (FAILED(dialog->GetResults(&items))) return out;
  DWORD count = 0;
  items->GetCount(&count);
  for (DWORD i = 0; i < count; i++) {
    ComPtr<IShellItem> item;
    if (FAILED(items->GetItemAt(i, &item))) continue;
    PWSTR path = nullptr;
    if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path)) && path) {
      out.emplace_back(path);
      CoTaskMemFree(path);
    }
  }
  return out;
}

uint64_t fileSizeBytes(const std::wstring& path) {
  WIN32_FILE_ATTRIBUTE_DATA data{};
  if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &data)) return 0;
  return (static_cast<uint64_t>(data.nFileSizeHigh) << 32) | data.nFileSizeLow;
}

namespace {

bool endsWithNoCase(const std::wstring& s, const wchar_t* suffix) {
  const size_t n = wcslen(suffix);
  if (s.size() < n) return false;
  for (size_t i = 0; i < n; i++) {
    if (std::towlower(s[s.size() - n + i]) != std::towlower(suffix[i])) return false;
  }
  return true;
}

// Lee la cabecera RIFF/WAVE y calcula la duración a partir de `data` y `byteRate`.
int64_t wavDurationMs(const std::wstring& path) {
  HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return -1;
  auto readAt = [h](uint64_t offset, void* buf, DWORD n) {
    LARGE_INTEGER li;
    li.QuadPart = static_cast<LONGLONG>(offset);
    DWORD got = 0;
    return SetFilePointerEx(h, li, nullptr, FILE_BEGIN) && ReadFile(h, buf, n, &got, nullptr) && got == n;
  };
  int64_t result = -1;
  char riff[12];
  if (readAt(0, riff, 12) && memcmp(riff, "RIFF", 4) == 0 && memcmp(riff + 8, "WAVE", 4) == 0) {
    uint64_t offset = 12;
    uint32_t byteRate = 0;
    for (int guard = 0; guard < 64; guard++) {
      char hdr[8];
      if (!readAt(offset, hdr, 8)) break;
      uint32_t size = 0;
      memcpy(&size, hdr + 4, 4);
      if (memcmp(hdr, "fmt ", 4) == 0 && size >= 16) {
        char fmt[16];
        if (readAt(offset + 8, fmt, 16)) memcpy(&byteRate, fmt + 8, 4);
      } else if (memcmp(hdr, "data", 4) == 0) {
        if (byteRate > 0) result = static_cast<int64_t>(static_cast<double>(size) / byteRate * 1000.0);
        break;
      }
      offset += 8 + size + (size & 1);
    }
  }
  CloseHandle(h);
  return result;
}

}  // namespace

int64_t audioDurationMs(const std::wstring& path) {
  if (endsWithNoCase(path, L".wav")) {
    const int64_t ms = wavDurationMs(path);
    if (ms >= 0) return ms;
  }
  if (FAILED(MFStartup(MF_VERSION, MFSTARTUP_LITE))) return -1;
  int64_t result = -1;
  {
    ComPtr<IMFSourceReader> reader;
    if (SUCCEEDED(MFCreateSourceReaderFromURL(path.c_str(), nullptr, &reader))) {
      PROPVARIANT var;
      PropVariantInit(&var);
      if (SUCCEEDED(reader->GetPresentationAttribute(static_cast<DWORD>(MF_SOURCE_READER_MEDIASOURCE), MF_PD_DURATION, &var)) &&
          var.vt == VT_UI8) {
        result = static_cast<int64_t>(var.uhVal.QuadPart / 10'000);
      }
      PropVariantClear(&var);
    }
  }
  MFShutdown();
  return result;
}

bool openExternalUrl(const std::wstring& url) {
  std::wstring lower = url;
  std::transform(lower.begin(), lower.end(), lower.begin(), [](wchar_t c) { return static_cast<wchar_t>(std::towlower(c)); });
  const bool allowed = lower.rfind(L"https://", 0) == 0 || lower.rfind(L"http://", 0) == 0 || lower.rfind(L"ms-settings:", 0) == 0;
  if (!allowed || url.size() > 2048) return false;
  if (url.find_first_of(L"\r\n\"") != std::wstring::npos) return false;
  const auto rc = reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL));
  return rc > 32;
}

}  // namespace voxora
