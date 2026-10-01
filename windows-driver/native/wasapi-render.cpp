// wasapi-render.cpp — Helper user-mode de VOXORA Meet.
//
// Node no tiene WASAPI: este ejecutable lee PCM s16le crudo de stdin y lo
// rinde en un endpoint de salida (por defecto el que contenga "VOXORA Meet
// Speaker", es decir, el lado render del cable virtual). El driver refleja
// ese audio en "VOXORA Meet Microphone", que es lo que Meet/Zoom capturan.
//
// Uso:
//   wasapi-render.exe --list
//       Imprime en stdout un JSON con los endpoints de render activos:
//       [{"id":"{0.0.0.00000000}.{...}","name":"...","isDefault":true}]
//   wasapi-render.exe [--device <id>] [--name <substr>] [--rate 48000]
//                     [--channels 1] [--buffer-ms 100]
//       Rinde stdin. Imprime una línea JSON {"event":"ready",...} al abrir
//       el stream, {"event":"eof"} al terminar y {"event":"error",...} en
//       fallos. Sale con 0 en éxito.
//
// Salida: 0 ok · 2 argumentos · 3 dispositivo no encontrado · 4 fallo WASAPI.
//
// Compilar: native\build.cmd (MSVC x64, sin dependencias externas).

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <avrt.h>
#include <io.h>
#include <fcntl.h>

#include <atomic>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "avrt.lib")

namespace {

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

std::string WideToUtf8(const wchar_t* text)
{
    if (text == nullptr || *text == L'\0') return std::string();
    const int needed = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
    if (needed <= 0) return std::string();
    std::string out(static_cast<size_t>(needed - 1), '\0');
    WideCharToMultiByte(CP_UTF8, 0, text, -1, &out[0], needed, nullptr, nullptr);
    return out;
}

std::wstring Utf8ToWide(const char* text)
{
    if (text == nullptr || *text == '\0') return std::wstring();
    const int needed = MultiByteToWideChar(CP_UTF8, 0, text, -1, nullptr, 0);
    if (needed <= 0) return std::wstring();
    std::wstring out(static_cast<size_t>(needed - 1), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text, -1, &out[0], needed);
    return out;
}

std::string JsonEscape(const std::string& in)
{
    std::string out;
    out.reserve(in.size() + 8);
    for (unsigned char c : in)
    {
        switch (c)
        {
        case '"':  out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n";  break;
        case '\r': out += "\\r";  break;
        case '\t': out += "\\t";  break;
        default:
            if (c < 0x20)
            {
                char buf[8];
                std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                out += buf;
            }
            else
            {
                out += static_cast<char>(c);
            }
        }
    }
    return out;
}

std::wstring ToLower(std::wstring s)
{
    for (auto& ch : s) ch = static_cast<wchar_t>(towlower(ch));
    return s;
}

void EmitJson(const std::string& json)
{
    std::fputs(json.c_str(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

void EmitError(const char* code, HRESULT hr, const std::string& detail)
{
    char hex[16];
    std::snprintf(hex, sizeof(hex), "0x%08X", static_cast<unsigned>(hr));
    EmitJson("{\"event\":\"error\",\"code\":\"" + std::string(code) +
             "\",\"hresult\":\"" + hex + "\",\"detail\":\"" + JsonEscape(detail) + "\"}");
}

// RAII mínimo para interfaces COM (sin ATL/WRL para no añadir dependencias).
template <typename T>
class ComPtr
{
public:
    ComPtr() = default;
    ~ComPtr() { Reset(); }
    ComPtr(const ComPtr&) = delete;
    ComPtr& operator=(const ComPtr&) = delete;
    T** Put() { Reset(); return &m_ptr; }
    T* Get() const { return m_ptr; }
    T* operator->() const { return m_ptr; }
    explicit operator bool() const { return m_ptr != nullptr; }
    void Reset() { if (m_ptr) { m_ptr->Release(); m_ptr = nullptr; } }
private:
    T* m_ptr = nullptr;
};

struct CoTaskString
{
    LPWSTR value = nullptr;
    ~CoTaskString() { if (value) CoTaskMemFree(value); }
};

struct Options
{
    bool list = false;
    std::wstring deviceId;
    std::wstring nameSubstring = L"VOXORA Meet Speaker";
    unsigned rate = 48000;
    unsigned channels = 1;
    unsigned bufferMs = 100;
};

bool ParseArgs(int argc, wchar_t** argv, Options& opt)
{
    for (int i = 1; i < argc; i++)
    {
        const std::wstring arg = argv[i];
        auto next = [&](std::wstring& out) -> bool {
            if (i + 1 >= argc) return false;
            out = argv[++i];
            return true;
        };
        std::wstring value;
        if (arg == L"--list") { opt.list = true; }
        else if (arg == L"--device") { if (!next(opt.deviceId)) return false; }
        else if (arg == L"--name") { if (!next(opt.nameSubstring)) return false; }
        else if (arg == L"--rate") { if (!next(value)) return false; opt.rate = static_cast<unsigned>(_wtoi(value.c_str())); }
        else if (arg == L"--channels") { if (!next(value)) return false; opt.channels = static_cast<unsigned>(_wtoi(value.c_str())); }
        else if (arg == L"--buffer-ms") { if (!next(value)) return false; opt.bufferMs = static_cast<unsigned>(_wtoi(value.c_str())); }
        else if (arg == L"--help" || arg == L"-h") { return false; }
        else { return false; }
    }
    if (opt.rate < 8000 || opt.rate > 192000) return false;
    if (opt.channels < 1 || opt.channels > 2) return false;
    if (opt.bufferMs < 20 || opt.bufferMs > 2000) return false;
    return true;
}

void PrintUsage()
{
    std::fputs(
        "wasapi-render (VOXORA Meet)\n"
        "  --list                     lista endpoints de render (JSON)\n"
        "  --device <id>              endpoint por id (de --list)\n"
        "  --name <substr>            endpoint cuyo nombre contenga <substr>\n"
        "                             (defecto: \"VOXORA Meet Speaker\")\n"
        "  --rate <hz>                frecuencia del PCM de stdin (defecto 48000)\n"
        "  --channels <1|2>           canales del PCM de stdin (defecto 1)\n"
        "  --buffer-ms <ms>           buffer WASAPI (defecto 100)\n"
        "stdin: PCM s16le crudo.\n", stderr);
}

// ---------------------------------------------------------------------------
// Enumeración de endpoints
// ---------------------------------------------------------------------------

struct EndpointInfo
{
    std::wstring id;
    std::wstring name;
    bool isDefault = false;
};

HRESULT GetEndpointName(IMMDevice* device, std::wstring& name)
{
    ComPtr<IPropertyStore> props;
    HRESULT hr = device->OpenPropertyStore(STGM_READ, props.Put());
    if (FAILED(hr)) return hr;
    PROPVARIANT var;
    PropVariantInit(&var);
    hr = props->GetValue(PKEY_Device_FriendlyName, &var);
    if (SUCCEEDED(hr) && var.vt == VT_LPWSTR && var.pwszVal)
    {
        name = var.pwszVal;
    }
    PropVariantClear(&var);
    return hr;
}

HRESULT EnumerateRenderEndpoints(IMMDeviceEnumerator* enumerator, std::vector<EndpointInfo>& out)
{
    std::wstring defaultId;
    {
        ComPtr<IMMDevice> def;
        if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, def.Put())))
        {
            CoTaskString id;
            if (SUCCEEDED(def->GetId(&id.value)) && id.value) defaultId = id.value;
        }
    }

    ComPtr<IMMDeviceCollection> collection;
    HRESULT hr = enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, collection.Put());
    if (FAILED(hr)) return hr;

    UINT count = 0;
    hr = collection->GetCount(&count);
    if (FAILED(hr)) return hr;

    for (UINT i = 0; i < count; i++)
    {
        ComPtr<IMMDevice> device;
        if (FAILED(collection->Item(i, device.Put()))) continue;
        EndpointInfo info;
        CoTaskString id;
        if (FAILED(device->GetId(&id.value)) || !id.value) continue;
        info.id = id.value;
        GetEndpointName(device.Get(), info.name);
        info.isDefault = (info.id == defaultId);
        out.push_back(std::move(info));
    }
    return S_OK;
}

int RunList(IMMDeviceEnumerator* enumerator)
{
    std::vector<EndpointInfo> endpoints;
    const HRESULT hr = EnumerateRenderEndpoints(enumerator, endpoints);
    if (FAILED(hr))
    {
        EmitError("enumerate", hr, "EnumAudioEndpoints");
        return 4;
    }
    std::string json = "[";
    for (size_t i = 0; i < endpoints.size(); i++)
    {
        if (i) json += ",";
        json += "{\"id\":\"" + JsonEscape(WideToUtf8(endpoints[i].id.c_str())) +
                "\",\"name\":\"" + JsonEscape(WideToUtf8(endpoints[i].name.c_str())) +
                "\",\"isDefault\":" + (endpoints[i].isDefault ? "true" : "false") + "}";
    }
    json += "]";
    EmitJson(json);
    return 0;
}

HRESULT FindDevice(IMMDeviceEnumerator* enumerator, const Options& opt,
                   ComPtr<IMMDevice>& device, EndpointInfo& info)
{
    if (!opt.deviceId.empty())
    {
        HRESULT hr = enumerator->GetDevice(opt.deviceId.c_str(), device.Put());
        if (FAILED(hr)) return hr;
        info.id = opt.deviceId;
        GetEndpointName(device.Get(), info.name);
        return S_OK;
    }

    std::vector<EndpointInfo> endpoints;
    HRESULT hr = EnumerateRenderEndpoints(enumerator, endpoints);
    if (FAILED(hr)) return hr;

    const std::wstring needle = ToLower(opt.nameSubstring);
    for (const auto& ep : endpoints)
    {
        if (ToLower(ep.name).find(needle) != std::wstring::npos)
        {
            hr = enumerator->GetDevice(ep.id.c_str(), device.Put());
            if (FAILED(hr)) return hr;
            info = ep;
            return S_OK;
        }
    }
    return HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
}

// ---------------------------------------------------------------------------
// Cola de PCM alimentada desde stdin (con contrapresión)
// ---------------------------------------------------------------------------

class StdinQueue
{
public:
    explicit StdinQueue(size_t maxBytes, size_t blockAlign) : m_maxBytes(maxBytes), m_blockAlign(blockAlign) {}

    void Start()
    {
        m_thread = std::thread([this] { ReaderLoop(); });
    }

    void Stop()
    {
        bool eof;
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            m_abort = true;
            eof = m_eof;
        }
        m_notFull.notify_all();
        if (!m_thread.joinable()) return;
        if (eof)
        {
            m_thread.join();
        }
        else
        {
            // Cancel a blocking pipe read before destroying the queue/mutex.
            CancelSynchronousIo(m_thread.native_handle());
            while (WaitForSingleObject(m_thread.native_handle(), 50) == WAIT_TIMEOUT)
                CancelSynchronousIo(m_thread.native_handle());
            m_thread.join();
        }
    }

    // Copia hasta `bytes` a `dst`; devuelve los bytes copiados (resto = silencio).
    size_t Pull(uint8_t* dst, size_t bytes)
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        bytes = std::min(bytes, m_bytes - m_bytes % m_blockAlign);
        size_t copied = 0;
        while (copied < bytes && !m_chunks.empty())
        {
            auto& front = m_chunks.front();
            const size_t take = std::min(bytes - copied, front.size() - m_frontOffset);
            std::memcpy(dst + copied, front.data() + m_frontOffset, take);
            copied += take;
            m_frontOffset += take;
            m_bytes -= take;
            if (m_frontOffset == front.size())
            {
                m_chunks.pop_front();
                m_frontOffset = 0;
            }
        }
        if (copied > 0) m_notFull.notify_one();
        return copied;
    }

    bool Drained()
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        return m_eof && m_bytes < m_blockAlign;
    }

    bool Eof()
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        return m_eof;
    }

    size_t QueuedBytes() {
        std::lock_guard<std::mutex> lock(m_mutex);
        return m_bytes;
    }

private:
    void ReaderLoop()
    {
        std::vector<uint8_t> buf(4096);
        for (;;)
        {
            // _read returns available pipe bytes; fread can wait to fill 16 KiB.
            const int count = _read(_fileno(stdin), buf.data(), static_cast<unsigned>(buf.size()));
            if (count <= 0)
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                m_eof = true;
                return;
            }
            const size_t got = static_cast<size_t>(count);
            std::unique_lock<std::mutex> lock(m_mutex);
            m_notFull.wait(lock, [&] { return m_abort || m_bytes + got <= m_maxBytes; });
            if (m_abort) return;
            m_chunks.emplace_back(buf.begin(), buf.begin() + static_cast<std::ptrdiff_t>(got));
            m_bytes += got;
        }
    }

    std::thread m_thread;
    std::mutex m_mutex;
    std::condition_variable m_notFull;
    std::deque<std::vector<uint8_t>> m_chunks;
    size_t m_frontOffset = 0;
    size_t m_bytes = 0;
    const size_t m_maxBytes;
    const size_t m_blockAlign;
    bool m_eof = false;
    bool m_abort = false;
};

std::atomic<bool> g_stop{ false };

BOOL WINAPI ConsoleHandler(DWORD)
{
    g_stop = true;
    return TRUE;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

int RunRender(IMMDeviceEnumerator* enumerator, const Options& opt)
{
    ComPtr<IMMDevice> device;
    EndpointInfo info;
    HRESULT hr = FindDevice(enumerator, opt, device, info);
    if (FAILED(hr))
    {
        EmitError("device-not-found", hr, WideToUtf8(opt.deviceId.empty() ? opt.nameSubstring.c_str() : opt.deviceId.c_str()));
        return 3;
    }

    ComPtr<IAudioClient> client;
    hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(client.Put()));
    if (FAILED(hr))
    {
        EmitError("activate", hr, "IAudioClient");
        return 4;
    }

    // Formato de stdin. AUTOCONVERTPCM deja que el motor de audio convierta
    // (frecuencia/canales) al formato de mezcla del endpoint.
    WAVEFORMATEXTENSIBLE fmt = {};
    fmt.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    fmt.Format.nChannels = static_cast<WORD>(opt.channels);
    fmt.Format.nSamplesPerSec = opt.rate;
    fmt.Format.wBitsPerSample = 16;
    fmt.Format.nBlockAlign = static_cast<WORD>(opt.channels * 2);
    fmt.Format.nAvgBytesPerSec = opt.rate * fmt.Format.nBlockAlign;
    fmt.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
    fmt.Samples.wValidBitsPerSample = 16;
    fmt.dwChannelMask = (opt.channels == 1) ? SPEAKER_FRONT_CENTER : (SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT);
    fmt.SubFormat = KSDATAFORMAT_SUBTYPE_PCM;

    const DWORD flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                      | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                      | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    const REFERENCE_TIME bufferDuration = static_cast<REFERENCE_TIME>(opt.bufferMs) * 10000;

    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, bufferDuration, 0, &fmt.Format, nullptr);
    if (FAILED(hr))
    {
        EmitError("initialize", hr, "IAudioClient::Initialize (shared, autoconvert)");
        return 4;
    }

    UINT32 bufferFrames = 0;
    hr = client->GetBufferSize(&bufferFrames);
    if (FAILED(hr) || bufferFrames == 0)
    {
        EmitError("buffer-size", hr, "GetBufferSize");
        return 4;
    }

    ComPtr<IAudioRenderClient> render;
    hr = client->GetService(__uuidof(IAudioRenderClient), reinterpret_cast<void**>(render.Put()));
    if (FAILED(hr))
    {
        EmitError("service", hr, "IAudioRenderClient");
        return 4;
    }

    HANDLE event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (event == nullptr)
    {
        EmitError("event", HRESULT_FROM_WIN32(GetLastError()), "CreateEvent");
        return 4;
    }
    hr = client->SetEventHandle(event);
    if (FAILED(hr))
    {
        EmitError("set-event", hr, "SetEventHandle");
        CloseHandle(event);
        return 4;
    }

    // Cola: 2 s de PCM como máximo; por encima stdin se bloquea (contrapresión
    // hacia Node).
    const size_t blockAlign = fmt.Format.nBlockAlign;
    StdinQueue queue(static_cast<size_t>(opt.rate) * blockAlign / 2, blockAlign);
    queue.Start();

    // Prellenar con silencio para arrancar sin glitch.
    {
        BYTE* data = nullptr;
        if (SUCCEEDED(render->GetBuffer(bufferFrames, &data)))
        {
            render->ReleaseBuffer(bufferFrames, AUDCLNT_BUFFERFLAGS_SILENT);
        }
    }

    DWORD taskIndex = 0;
    HANDLE avrtHandle = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

    hr = client->Start();
    if (FAILED(hr))
    {
        EmitError("start", hr, "IAudioClient::Start");
        queue.Stop();
        if (avrtHandle) AvRevertMmThreadCharacteristics(avrtHandle);
        CloseHandle(event);
        return 4;
    }

    EmitJson("{\"event\":\"ready\",\"device\":{\"id\":\"" + JsonEscape(WideToUtf8(info.id.c_str())) +
             "\",\"name\":\"" + JsonEscape(WideToUtf8(info.name.c_str())) +
             "\"},\"format\":{\"rate\":" + std::to_string(opt.rate) +
             ",\"channels\":" + std::to_string(opt.channels) +
             ",\"bits\":16},\"bufferFrames\":" + std::to_string(bufferFrames) + "}");

    int exitCode = 0;
    uint64_t underrunFrames = 0;
    ULONGLONG lastStats = GetTickCount64();

    while (!g_stop)
    {
        const DWORD wait = WaitForSingleObject(event, 2000);
        if (wait != WAIT_OBJECT_0)
        {
            // Timeout: el motor de audio no avanza (endpoint desconectado?).
            if (queue.Drained()) break;
            EmitError("render-timeout", HRESULT_FROM_WIN32(ERROR_TIMEOUT), "El endpoint no consume audio");
            exitCode = 4;
            break;
        }

        UINT32 padding = 0;
        hr = client->GetCurrentPadding(&padding);
        if (FAILED(hr))
        {
            EmitError("padding", hr, "GetCurrentPadding");
            exitCode = 4;
            break;
        }
        const UINT32 available = bufferFrames - padding;
        if (available == 0) continue;

        BYTE* data = nullptr;
        hr = render->GetBuffer(available, &data);
        if (FAILED(hr))
        {
            EmitError("get-buffer", hr, "IAudioRenderClient::GetBuffer");
            exitCode = 4;
            break;
        }

        const size_t wanted = static_cast<size_t>(available) * blockAlign;
        const size_t got = queue.Pull(data, wanted);
        underrunFrames += (wanted - got) / blockAlign;
        DWORD releaseFlags = 0;
        if (got == 0)
        {
            releaseFlags = AUDCLNT_BUFFERFLAGS_SILENT;
        }
        else if (got < wanted)
        {
            std::memset(data + got, 0, wanted - got);
        }
        render->ReleaseBuffer(available, releaseFlags);
        const ULONGLONG statsNow = GetTickCount64();
        if (statsNow - lastStats >= 1000) {
            EmitJson("{\"event\":\"stats\",\"queuedMs\":" + std::to_string(queue.QueuedBytes() * 1000 / (opt.rate * blockAlign))
                + ",\"paddingMs\":" + std::to_string((padding + available) * 1000 / opt.rate)
                + ",\"underrunFrames\":" + std::to_string(underrunFrames) + "}");
            lastStats = statsNow;
        }

        if (queue.Drained())
        {
            break;  // stdin cerrado y todo lo encolado ya está entregado al motor
        }
    }

    // Dejar que el motor vacíe lo entregado antes de parar (máx. 2 buffers).
    if (exitCode == 0 && !g_stop)
    {
        const ULONGLONG deadline = GetTickCount64() + static_cast<ULONGLONG>(opt.bufferMs) * 2;
        UINT32 padding = 0;
        while (SUCCEEDED(client->GetCurrentPadding(&padding)) && padding > 0 && GetTickCount64() < deadline)
        {
            Sleep(5);
        }
    }
    client->Stop();
    queue.Stop();
    if (avrtHandle) AvRevertMmThreadCharacteristics(avrtHandle);
    CloseHandle(event);

    EmitJson(std::string("{\"event\":\"") + (g_stop ? "stopped" : "eof") + "\"}");
    return exitCode;
}

} // namespace

int wmain(int argc, wchar_t** argv)
{
    Options opt;
    if (!ParseArgs(argc, argv, opt))
    {
        PrintUsage();
        return 2;
    }

    _setmode(_fileno(stdin), _O_BINARY);
    SetConsoleCtrlHandler(ConsoleHandler, TRUE);

    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr))
    {
        EmitError("com", hr, "CoInitializeEx");
        return 4;
    }

    int code;
    {
        ComPtr<IMMDeviceEnumerator> enumerator;
        hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(enumerator.Put()));
        if (FAILED(hr))
        {
            EmitError("enumerator", hr, "MMDeviceEnumerator");
            CoUninitialize();
            return 4;
        }
        code = opt.list ? RunList(enumerator.Get()) : RunRender(enumerator.Get(), opt);
    }

    CoUninitialize();
    return code;
}
