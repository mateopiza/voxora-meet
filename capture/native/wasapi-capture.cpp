// wasapi-capture — helper nativo de captura de micrófono para VOXORA Meet.
//
// Abre el endpoint de captura por defecto (o el indicado con --device <id>) en modo compartido
// WASAPI y escribe PCM s16le mono crudo por stdout a la tasa pedida (--rate, default 16000).
// Pide al motor de audio la conversión de formato (AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
// SRC_DEFAULT_QUALITY); si el driver la rechaza, captura en el formato de mezcla y convierte
// aquí (downmix + remuestreo lineal).
//
//   wasapi-capture.exe --list                      → JSON [{id,name,default}] por stdout
//   wasapi-capture.exe [--device <id>] [--rate N] [--buffer-ms N]
//
// Diagnóstico por stderr en líneas JSON ({"event":"ready",...}, {"event":"error",...}).
// Códigos de salida: 0 ok/parada, 1 argumentos, 2 dispositivo/inicialización, 3 dispositivo
// invalidado durante la captura (el proceso padre lo relanza), 4 error de E/S.

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#include <initguid.h> // Define las GUID/PROPERTYKEY usadas abajo sin necesidad de libs extra.
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <avrt.h>
#include <ks.h>
#include <ksmedia.h>
#include <wrl/client.h>

#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

std::atomic<bool> g_stop{false};
HANDLE g_stopEvent = nullptr;

// ------------------------------------------------------------------------------------------
// Utilidades

std::string toUtf8(const wchar_t* text) {
    if (!text || !*text) return {};
    const int needed = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
    if (needed <= 1) return {};
    std::string out(static_cast<size_t>(needed - 1), '\0');
    WideCharToMultiByte(CP_UTF8, 0, text, -1, out.data(), needed, nullptr, nullptr);
    return out;
}

std::string jsonEscape(const std::string& text) {
    std::string out;
    out.reserve(text.size() + 8);
    for (const unsigned char c : text) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += static_cast<char>(c);
                }
        }
    }
    return out;
}

void logJson(const std::string& body) {
    std::fprintf(stderr, "{%s}\n", body.c_str());
    std::fflush(stderr);
}

void logError(const char* stage, HRESULT hr, const std::string& detail = {}) {
    char code[16];
    std::snprintf(code, sizeof(code), "0x%08lX", static_cast<unsigned long>(hr));
    logJson("\"event\":\"error\",\"stage\":\"" + std::string(stage) + "\",\"hresult\":\"" + code +
            "\",\"detail\":\"" + jsonEscape(detail) + "\"");
}

BOOL WINAPI onConsoleCtrl(DWORD) {
    g_stop.store(true);
    if (g_stopEvent) SetEvent(g_stopEvent);
    return TRUE;
}

struct ComScope {
    HRESULT hr;
    ComScope() : hr(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) {}
    ~ComScope() {
        if (SUCCEEDED(hr)) CoUninitialize();
    }
};

struct CoTaskMemString {
    LPWSTR value = nullptr;
    ~CoTaskMemString() {
        if (value) CoTaskMemFree(value);
    }
};

struct CoTaskMemFormat {
    WAVEFORMATEX* value = nullptr;
    ~CoTaskMemFormat() {
        if (value) CoTaskMemFree(value);
    }
};

// Escritor binario a stdout (sin buffering de CRT para minimizar latencia).
class StdoutWriter {
public:
    StdoutWriter() : handle_(GetStdHandle(STD_OUTPUT_HANDLE)) {}

    bool write(const void* data, size_t bytes) {
        const auto* ptr = static_cast<const uint8_t*>(data);
        while (bytes > 0) {
            DWORD written = 0;
            const DWORD chunk = bytes > 0x7fffffff ? 0x7fffffffu : static_cast<DWORD>(bytes);
            if (!WriteFile(handle_, ptr, chunk, &written, nullptr) || written == 0) return false;
            ptr += written;
            bytes -= written;
        }
        return true;
    }

private:
    HANDLE handle_;
};

// ------------------------------------------------------------------------------------------
// Dispositivos

struct DeviceInfo {
    std::wstring id;
    std::wstring name;
    bool isDefault = false;
};

HRESULT deviceName(IMMDevice* device, std::wstring& out) {
    ComPtr<IPropertyStore> props;
    HRESULT hr = device->OpenPropertyStore(STGM_READ, &props);
    if (FAILED(hr)) return hr;
    PROPVARIANT value;
    PropVariantInit(&value);
    hr = props->GetValue(PKEY_Device_FriendlyName, &value);
    if (SUCCEEDED(hr) && value.vt == VT_LPWSTR && value.pwszVal) out = value.pwszVal;
    PropVariantClear(&value);
    return hr;
}

HRESULT enumerateCaptureDevices(IMMDeviceEnumerator* enumerator, std::vector<DeviceInfo>& out) {
    std::wstring defaultId;
    {
        ComPtr<IMMDevice> def;
        if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(eCapture, eCommunications, &def))) {
            CoTaskMemString id;
            if (SUCCEEDED(def->GetId(&id.value)) && id.value) defaultId = id.value;
        }
    }
    ComPtr<IMMDeviceCollection> collection;
    HRESULT hr = enumerator->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &collection);
    if (FAILED(hr)) return hr;
    UINT count = 0;
    hr = collection->GetCount(&count);
    if (FAILED(hr)) return hr;
    for (UINT i = 0; i < count; ++i) {
        ComPtr<IMMDevice> device;
        if (FAILED(collection->Item(i, &device))) continue;
        CoTaskMemString id;
        if (FAILED(device->GetId(&id.value)) || !id.value) continue;
        DeviceInfo info;
        info.id = id.value;
        deviceName(device.Get(), info.name);
        info.isDefault = (info.id == defaultId);
        out.push_back(std::move(info));
    }
    return S_OK;
}

int listDevices() {
    ComPtr<IMMDeviceEnumerator> enumerator;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                  IID_PPV_ARGS(&enumerator));
    if (FAILED(hr)) {
        logError("enumerator", hr);
        return 2;
    }
    std::vector<DeviceInfo> devices;
    hr = enumerateCaptureDevices(enumerator.Get(), devices);
    if (FAILED(hr)) {
        logError("enumerate", hr);
        return 2;
    }
    std::string json = "[";
    for (size_t i = 0; i < devices.size(); ++i) {
        if (i) json += ",";
        json += "{\"id\":\"" + jsonEscape(toUtf8(devices[i].id.c_str())) + "\",\"name\":\"" +
                jsonEscape(toUtf8(devices[i].name.c_str())) + "\",\"default\":" +
                (devices[i].isDefault ? "true" : "false") + "}";
    }
    json += "]\n";
    StdoutWriter out;
    return out.write(json.data(), json.size()) ? 0 : 4;
}

HRESULT openDevice(IMMDeviceEnumerator* enumerator, const std::wstring& deviceId, ComPtr<IMMDevice>& device) {
    if (deviceId.empty() || deviceId == L"default") {
        return enumerator->GetDefaultAudioEndpoint(eCapture, eCommunications, &device);
    }
    return enumerator->GetDevice(deviceId.c_str(), &device);
}

// ------------------------------------------------------------------------------------------
// Conversión manual (fallback cuando el motor no acepta AUTOCONVERTPCM)

struct SourceFormat {
    uint32_t channels = 0;
    uint32_t rate = 0;
    uint32_t bitsPerSample = 0;
    uint32_t validBits = 0;
    uint32_t blockAlign = 0;
    bool isFloat = false;
};

bool describeFormat(const WAVEFORMATEX* fmt, SourceFormat& out) {
    out.channels = fmt->nChannels;
    out.rate = fmt->nSamplesPerSec;
    out.bitsPerSample = fmt->wBitsPerSample;
    out.validBits = fmt->wBitsPerSample;
    out.blockAlign = fmt->nBlockAlign;
    if (fmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) {
        out.isFloat = true;
    } else if (fmt->wFormatTag == WAVE_FORMAT_PCM) {
        out.isFloat = false;
    } else if (fmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE && fmt->cbSize >= 22) {
        const auto* ext = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(fmt);
        if (IsEqualGUID(ext->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT)) {
            out.isFloat = true;
        } else if (IsEqualGUID(ext->SubFormat, KSDATAFORMAT_SUBTYPE_PCM)) {
            out.isFloat = false;
        } else {
            return false;
        }
        if (ext->Samples.wValidBitsPerSample) out.validBits = ext->Samples.wValidBitsPerSample;
    } else {
        return false;
    }
    if (out.isFloat && out.bitsPerSample != 32) return false;
    if (!out.isFloat && out.bitsPerSample != 8 && out.bitsPerSample != 16 && out.bitsPerSample != 24 &&
        out.bitsPerSample != 32) {
        return false;
    }
    return out.channels > 0 && out.rate > 0 && out.blockAlign > 0;
}

// Convierte frames del formato de mezcla a mono float [-1,1] y luego remuestrea linealmente a
// la tasa de salida, manteniendo la fase entre llamadas.
class Converter {
public:
    Converter(const SourceFormat& src, uint32_t outRate)
        : src_(src), step_(static_cast<double>(src.rate) / outRate) {}

    void convert(const uint8_t* data, uint32_t frames, bool silent, std::vector<int16_t>& out) {
        mono_.resize(frames);
        if (silent) {
            std::fill(mono_.begin(), mono_.end(), 0.0f);
        } else {
            for (uint32_t f = 0; f < frames; ++f) {
                const uint8_t* frame = data + static_cast<size_t>(f) * src_.blockAlign;
                float sum = 0.0f;
                for (uint32_t c = 0; c < src_.channels; ++c) {
                    sum += readSample(frame + c * (src_.bitsPerSample / 8));
                }
                mono_[f] = sum / static_cast<float>(src_.channels);
            }
        }
        // Vector extendido [prev, x0..x(n-1)]; pos_ = 1 apunta a x0.
        const size_t n = mono_.size();
        while (pos_ <= static_cast<double>(n)) {
            const size_t i0 = static_cast<size_t>(pos_);
            const double frac = pos_ - static_cast<double>(i0);
            const float a = i0 == 0 ? prev_ : mono_[i0 - 1];
            const float b = i0 >= n ? mono_[n - 1] : mono_[i0];
            const double v = a + (b - a) * frac;
            out.push_back(toInt16(v));
            pos_ += step_;
        }
        if (n > 0) {
            prev_ = mono_[n - 1];
            pos_ -= static_cast<double>(n);
        }
    }

private:
    float readSample(const uint8_t* p) const {
        if (src_.isFloat) {
            float v;
            std::memcpy(&v, p, sizeof(v));
            return v;
        }
        switch (src_.bitsPerSample) {
            case 8: return (static_cast<int>(p[0]) - 128) / 128.0f;
            case 16: {
                int16_t v;
                std::memcpy(&v, p, sizeof(v));
                return v / 32768.0f;
            }
            case 24: {
                const int32_t v = (static_cast<int32_t>(p[2]) << 24 | static_cast<int32_t>(p[1]) << 16 |
                                   static_cast<int32_t>(p[0]) << 8) >> 8;
                return v / 8388608.0f;
            }
            default: {
                int32_t v;
                std::memcpy(&v, p, sizeof(v));
                return static_cast<float>(v / 2147483648.0);
            }
        }
    }

    static int16_t toInt16(double v) {
        if (v > 1.0) v = 1.0;
        if (v < -1.0) v = -1.0;
        return static_cast<int16_t>(std::lround(v * 32767.0));
    }

    SourceFormat src_;
    double step_;
    double pos_ = 1.0;
    float prev_ = 0.0f;
    std::vector<float> mono_;
};

// ------------------------------------------------------------------------------------------
// Captura

struct Options {
    bool list = false;
    std::wstring deviceId;
    uint32_t rate = 16000;
    uint32_t bufferMs = 100;
};

void printUsage() {
    std::fputs(
        "Uso: wasapi-capture.exe [--list] [--device <id>] [--rate <Hz>] [--buffer-ms <ms>]\n"
        "  --list          Lista endpoints de captura activos (JSON) y termina.\n"
        "  --device <id>   Id WASAPI del endpoint (por defecto: dispositivo de comunicaciones).\n"
        "  --rate <Hz>     Tasa de salida (8000-192000, por defecto 16000).\n"
        "  --buffer-ms     Tamano del buffer de captura (20-500, por defecto 100).\n"
        "Salida: PCM s16le mono crudo por stdout.\n",
        stderr);
}

bool parseArgs(int argc, wchar_t** argv, Options& opts) {
    for (int i = 1; i < argc; ++i) {
        const std::wstring arg = argv[i];
        auto needValue = [&](const wchar_t* name) -> const wchar_t* {
            if (i + 1 >= argc) {
                std::fwprintf(stderr, L"Falta el valor de %s\n", name);
                return nullptr;
            }
            return argv[++i];
        };
        if (arg == L"--list") {
            opts.list = true;
        } else if (arg == L"--device") {
            const wchar_t* v = needValue(L"--device");
            if (!v) return false;
            opts.deviceId = v;
        } else if (arg == L"--rate") {
            const wchar_t* v = needValue(L"--rate");
            if (!v) return false;
            const long parsed = std::wcstol(v, nullptr, 10);
            if (parsed < 8000 || parsed > 192000) {
                std::fputs("--rate fuera de rango (8000-192000)\n", stderr);
                return false;
            }
            opts.rate = static_cast<uint32_t>(parsed);
        } else if (arg == L"--buffer-ms") {
            const wchar_t* v = needValue(L"--buffer-ms");
            if (!v) return false;
            const long parsed = std::wcstol(v, nullptr, 10);
            if (parsed < 20 || parsed > 500) {
                std::fputs("--buffer-ms fuera de rango (20-500)\n", stderr);
                return false;
            }
            opts.bufferMs = static_cast<uint32_t>(parsed);
        } else if (arg == L"--help" || arg == L"-h" || arg == L"/?") {
            printUsage();
            return false;
        } else {
            std::fwprintf(stderr, L"Argumento desconocido: %s\n", arg.c_str());
            printUsage();
            return false;
        }
    }
    return true;
}

int runCapture(const Options& opts) {
    ComPtr<IMMDeviceEnumerator> enumerator;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                  IID_PPV_ARGS(&enumerator));
    if (FAILED(hr)) {
        logError("enumerator", hr);
        return 2;
    }
    ComPtr<IMMDevice> device;
    hr = openDevice(enumerator.Get(), opts.deviceId, device);
    if (FAILED(hr)) {
        logError("open-device", hr, toUtf8(opts.deviceId.c_str()));
        return 2;
    }
    std::wstring friendly;
    deviceName(device.Get(), friendly);
    CoTaskMemString actualId;
    device->GetId(&actualId.value);

    ComPtr<IAudioClient> client;
    hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &client);
    if (FAILED(hr)) {
        logError("activate", hr);
        return 2;
    }

    // Formato deseado: PCM 16 bit mono a la tasa pedida. El motor convierte (AUTOCONVERTPCM).
    WAVEFORMATEX wanted = {};
    wanted.wFormatTag = WAVE_FORMAT_PCM;
    wanted.nChannels = 1;
    wanted.nSamplesPerSec = opts.rate;
    wanted.wBitsPerSample = 16;
    wanted.nBlockAlign = 2;
    wanted.nAvgBytesPerSec = wanted.nSamplesPerSec * wanted.nBlockAlign;
    wanted.cbSize = 0;

    const REFERENCE_TIME bufferDuration = static_cast<REFERENCE_TIME>(opts.bufferMs) * 10000; // 100 ns
    const DWORD baseFlags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
    bool autoConvert = true;
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                            baseFlags | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                            bufferDuration, 0, &wanted, nullptr);

    CoTaskMemFormat mix;
    SourceFormat source;
    if (FAILED(hr)) {
        // Fallback: capturamos en el formato de mezcla del motor y convertimos aquí.
        autoConvert = false;
        logError("initialize-autoconvert", hr, "se usa el formato de mezcla con conversion propia");
        client.Reset();
        hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, &client);
        if (FAILED(hr)) {
            logError("activate", hr);
            return 2;
        }
        hr = client->GetMixFormat(&mix.value);
        if (FAILED(hr)) {
            logError("mix-format", hr);
            return 2;
        }
        if (!describeFormat(mix.value, source)) {
            logError("mix-format", E_INVALIDARG, "formato de mezcla no soportado");
            return 2;
        }
        hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, baseFlags, bufferDuration, 0, mix.value, nullptr);
        if (FAILED(hr)) {
            logError("initialize", hr);
            return 2;
        }
    }

    HANDLE audioEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!audioEvent) {
        logError("event", HRESULT_FROM_WIN32(GetLastError()));
        return 2;
    }
    hr = client->SetEventHandle(audioEvent);
    if (FAILED(hr)) {
        logError("set-event", hr);
        CloseHandle(audioEvent);
        return 2;
    }
    ComPtr<IAudioCaptureClient> capture;
    hr = client->GetService(IID_PPV_ARGS(&capture));
    if (FAILED(hr)) {
        logError("capture-client", hr);
        CloseHandle(audioEvent);
        return 2;
    }

    // Prioridad de hilo de audio (MMCSS). Si falla no es fatal.
    DWORD taskIndex = 0;
    HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Audio", &taskIndex);

    hr = client->Start();
    if (FAILED(hr)) {
        logError("start", hr);
        if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
        CloseHandle(audioEvent);
        return 2;
    }

    logJson("\"event\":\"ready\",\"device\":\"" + jsonEscape(toUtf8(actualId.value)) + "\",\"name\":\"" +
            jsonEscape(toUtf8(friendly.c_str())) + "\",\"rate\":" + std::to_string(opts.rate) +
            ",\"channels\":1,\"format\":\"s16le\",\"autoConvert\":" + (autoConvert ? "true" : "false") +
            (autoConvert ? "" : ",\"sourceRate\":" + std::to_string(source.rate) + ",\"sourceChannels\":" +
                                    std::to_string(source.channels)));

    StdoutWriter out;
    std::vector<int16_t> converted;
    std::vector<uint8_t> zeros;
    Converter converter(source, opts.rate);
    int exitCode = 0;
    HANDLE handles[2] = {g_stopEvent, audioEvent};

    while (!g_stop.load()) {
        const DWORD waited = WaitForMultipleObjects(2, handles, FALSE, 2000);
        if (waited == WAIT_OBJECT_0) break; // parada solicitada
        if (waited == WAIT_TIMEOUT) continue; // el dispositivo no entrega datos; seguimos esperando
        if (waited != WAIT_OBJECT_0 + 1) {
            logError("wait", HRESULT_FROM_WIN32(GetLastError()));
            exitCode = 3;
            break;
        }

        UINT32 packet = 0;
        hr = capture->GetNextPacketSize(&packet);
        while (SUCCEEDED(hr) && packet > 0) {
            BYTE* data = nullptr;
            UINT32 frames = 0;
            DWORD flags = 0;
            hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
            if (FAILED(hr)) break;
            const bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
            bool ok = true;
            if (autoConvert) {
                const size_t bytes = static_cast<size_t>(frames) * 2;
                if (silent) {
                    if (zeros.size() < bytes) zeros.assign(bytes, 0);
                    ok = out.write(zeros.data(), bytes);
                } else {
                    ok = out.write(data, bytes);
                }
            } else {
                converted.clear();
                converter.convert(data, frames, silent, converted);
                if (!converted.empty()) ok = out.write(converted.data(), converted.size() * sizeof(int16_t));
            }
            capture->ReleaseBuffer(frames);
            if (!ok) {
                // stdout cerrado: el proceso padre terminó. Salida silenciosa.
                g_stop.store(true);
                exitCode = 0;
                break;
            }
            hr = capture->GetNextPacketSize(&packet);
        }
        if (FAILED(hr)) {
            logError("capture", hr, hr == AUDCLNT_E_DEVICE_INVALIDATED ? "dispositivo invalidado" : "");
            exitCode = 3;
            break;
        }
    }

    client->Stop();
    if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
    CloseHandle(audioEvent);
    logJson("\"event\":\"stopped\",\"code\":" + std::to_string(exitCode));
    return exitCode;
}

} // namespace

int wmain(int argc, wchar_t** argv) {
    Options opts;
    if (!parseArgs(argc, argv, opts)) return 1;

    ComScope com;
    if (FAILED(com.hr)) {
        logError("com", com.hr);
        return 2;
    }
    if (opts.list) return listDevices();

    g_stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!g_stopEvent) {
        logError("event", HRESULT_FROM_WIN32(GetLastError()));
        return 2;
    }
    SetConsoleCtrlHandler(onConsoleCtrl, TRUE);
    const int code = runCapture(opts);
    CloseHandle(g_stopEvent);
    g_stopEvent = nullptr;
    return code;
}
