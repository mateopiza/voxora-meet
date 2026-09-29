// minwavert.cpp — Miniport WaveRT de VOXORA Meet (render y capture).
//
// No hay hardware: la "posición de DMA" es virtual y avanza con el tiempo
// real (KeQueryPerformanceCounter). Un timer periódico (KeSetTimerEx, 10 ms)
// dispara una DPC que:
//   - render : copia lo que el motor de audio escribió en el buffer cíclico
//              hacia el buffer de loopback del adaptador;
//   - capture: rellena el buffer cíclico con lo que hay en el loopback (o
//              silencio si nadie está rindiendo).
// y dispara los eventos de notificación del modo pull (WaveRT con
// IMiniportWaveRTStreamNotification).
//
// Referencia: sysvad/minwavert.cpp y minwavertstream.cpp (WDK).

#include "minwavert.h"

// ===========================================================================
// Rangos de datos y descriptores de filtro
// ===========================================================================

// Pins de streaming: PCM s16le y float32, 1–2 canales, 16–48 kHz.
static KSDATARANGE_AUDIO PinDataRangesStream[] =
{
    {
        {
            sizeof(KSDATARANGE_AUDIO),
            0,
            0,
            0,
            STATICGUIDOF(KSDATAFORMAT_TYPE_AUDIO),
            STATICGUIDOF(KSDATAFORMAT_SUBTYPE_PCM),
            STATICGUIDOF(KSDATAFORMAT_SPECIFIER_WAVEFORMATEX)
        },
        VOXORA_MAX_CHANNELS,
        VOXORA_PCM_BITS,
        VOXORA_PCM_BITS,
        VOXORA_MIN_SAMPLE_RATE,
        VOXORA_MAX_SAMPLE_RATE
    },
    {
        {
            sizeof(KSDATARANGE_AUDIO),
            0,
            0,
            0,
            STATICGUIDOF(KSDATAFORMAT_TYPE_AUDIO),
            STATICGUIDOF(KSDATAFORMAT_SUBTYPE_IEEE_FLOAT),
            STATICGUIDOF(KSDATAFORMAT_SPECIFIER_WAVEFORMATEX)
        },
        VOXORA_MAX_CHANNELS,
        VOXORA_FLOAT_BITS,
        VOXORA_FLOAT_BITS,
        VOXORA_MIN_SAMPLE_RATE,
        VOXORA_MAX_SAMPLE_RATE
    }
};

static PKSDATARANGE PinDataRangePointersStream[] =
{
    PKSDATARANGE(&PinDataRangesStream[0]),
    PKSDATARANGE(&PinDataRangesStream[1])
};

// Pin puente hacia/desde la topología (formato "analógico" sin especificador).
static KSDATARANGE PinDataRangesBridge[] =
{
    {
        sizeof(KSDATARANGE),
        0,
        0,
        0,
        STATICGUIDOF(KSDATAFORMAT_TYPE_AUDIO),
        STATICGUIDOF(KSDATAFORMAT_SUBTYPE_ANALOG),
        STATICGUIDOF(KSDATAFORMAT_SPECIFIER_NONE)
    }
};

static PKSDATARANGE PinDataRangePointersBridge[] =
{
    &PinDataRangesBridge[0]
};

// --- Propiedades del filtro wave -------------------------------------------

static NTSTATUS PropertyHandler_WaveFilter(_In_ PPCPROPERTY_REQUEST PropertyRequest);

static PCPROPERTY_ITEM PropertiesWaveFilter[] =
{
    {
        &KSPROPSETID_Pin,
        KSPROPERTY_PIN_PROPOSEDATAFORMAT,
        KSPROPERTY_TYPE_SET | KSPROPERTY_TYPE_BASICSUPPORT,
        PropertyHandler_WaveFilter
    }
};

DEFINE_PCAUTOMATION_TABLE_PROP(AutomationWaveFilter, PropertiesWaveFilter);

// --- Render ("VOXORA Meet Speaker") ----------------------------------------

static PCPIN_DESCRIPTOR PinsRender[] =
{
    // VOXORA_WAVE_RENDER_PIN_HOST: el motor de audio escribe aquí.
    {
        1, 1, 0,
        NULL,
        {
            0, NULL,
            0, NULL,
            SIZEOF_ARRAY(PinDataRangePointersStream), PinDataRangePointersStream,
            KSPIN_DATAFLOW_IN,
            KSPIN_COMMUNICATION_SINK,
            &KSCATEGORY_AUDIO,
            NULL,
            0
        }
    },
    // VOXORA_WAVE_RENDER_PIN_BRIDGE: conexión física a la topología.
    {
        0, 0, 0,
        NULL,
        {
            0, NULL,
            0, NULL,
            SIZEOF_ARRAY(PinDataRangePointersBridge), PinDataRangePointersBridge,
            KSPIN_DATAFLOW_OUT,
            KSPIN_COMMUNICATION_NONE,
            &KSCATEGORY_AUDIO,
            NULL,
            0
        }
    }
};

static PCNODE_DESCRIPTOR NodesRender[] =
{
    { 0, NULL, &KSNODETYPE_DAC, NULL }
};

static PCCONNECTION_DESCRIPTOR ConnectionsRender[] =
{
    { PCFILTER_NODE, VOXORA_WAVE_RENDER_PIN_HOST,   0,             1 },
    { 0,             0,                             PCFILTER_NODE, VOXORA_WAVE_RENDER_PIN_BRIDGE }
};

static GUID CategoriesRender[] =
{
    STATICGUIDOF(KSCATEGORY_AUDIO),
    STATICGUIDOF(KSCATEGORY_RENDER),
    STATICGUIDOF(KSCATEGORY_REALTIME)
};

static PCFILTER_DESCRIPTOR FilterDescriptorRender =
{
    0,                                  // Version
    &AutomationWaveFilter,              // AutomationTable
    sizeof(PCPIN_DESCRIPTOR),           // PinSize
    SIZEOF_ARRAY(PinsRender),           // PinCount
    PinsRender,                         // Pins
    sizeof(PCNODE_DESCRIPTOR),          // NodeSize
    SIZEOF_ARRAY(NodesRender),          // NodeCount
    NodesRender,                        // Nodes
    SIZEOF_ARRAY(ConnectionsRender),    // ConnectionCount
    ConnectionsRender,                  // Connections
    SIZEOF_ARRAY(CategoriesRender),     // CategoryCount
    CategoriesRender                    // Categories
};

// --- Capture ("VOXORA Meet Microphone") ------------------------------------

static PCPIN_DESCRIPTOR PinsCapture[] =
{
    // VOXORA_WAVE_CAPTURE_PIN_BRIDGE: conexión física desde la topología.
    {
        0, 0, 0,
        NULL,
        {
            0, NULL,
            0, NULL,
            SIZEOF_ARRAY(PinDataRangePointersBridge), PinDataRangePointersBridge,
            KSPIN_DATAFLOW_IN,
            KSPIN_COMMUNICATION_NONE,
            &KSCATEGORY_AUDIO,
            NULL,
            0
        }
    },
    // VOXORA_WAVE_CAPTURE_PIN_HOST: el motor de audio lee de aquí.
    {
        1, 1, 0,
        NULL,
        {
            0, NULL,
            0, NULL,
            SIZEOF_ARRAY(PinDataRangePointersStream), PinDataRangePointersStream,
            KSPIN_DATAFLOW_OUT,
            KSPIN_COMMUNICATION_SINK,
            &KSCATEGORY_AUDIO,
            NULL,
            0
        }
    }
};

static PCNODE_DESCRIPTOR NodesCapture[] =
{
    { 0, NULL, &KSNODETYPE_ADC, NULL }
};

static PCCONNECTION_DESCRIPTOR ConnectionsCapture[] =
{
    { PCFILTER_NODE, VOXORA_WAVE_CAPTURE_PIN_BRIDGE, 0,             1 },
    { 0,             0,                              PCFILTER_NODE, VOXORA_WAVE_CAPTURE_PIN_HOST }
};

static GUID CategoriesCapture[] =
{
    STATICGUIDOF(KSCATEGORY_AUDIO),
    STATICGUIDOF(KSCATEGORY_CAPTURE),
    STATICGUIDOF(KSCATEGORY_REALTIME)
};

static PCFILTER_DESCRIPTOR FilterDescriptorCapture =
{
    0,
    &AutomationWaveFilter,
    sizeof(PCPIN_DESCRIPTOR),
    SIZEOF_ARRAY(PinsCapture),
    PinsCapture,
    sizeof(PCNODE_DESCRIPTOR),
    SIZEOF_ARRAY(NodesCapture),
    NodesCapture,
    SIZEOF_ARRAY(ConnectionsCapture),
    ConnectionsCapture,
    SIZEOF_ARRAY(CategoriesCapture),
    CategoriesCapture
};

// ===========================================================================
// Utilidades locales
// ===========================================================================

__forceinline ULONG VoxoraMin(ULONG a, ULONG b) { return (a < b) ? a : b; }

__forceinline BOOLEAN
IsWildcardGuid(_In_ REFGUID Guid)
{
    return IsEqualGUIDAligned(Guid, KSDATAFORMAT_TYPE_WILDCARD) ? TRUE : FALSE;
}

// ===========================================================================
// Fábrica
// ===========================================================================

#pragma code_seg("PAGE")
_IRQL_requires_max_(PASSIVE_LEVEL)
NTSTATUS
CreateMiniportWaveRTVoxora(
    _Out_ PUNKNOWN* Unknown,
    _In_opt_ PUNKNOWN UnknownOuter,
    _In_  POOL_FLAGS PoolFlags,
    _In_  BOOLEAN   Capture)
{
    PAGED_CODE();
    ASSERT(Unknown);

    CMiniportWaveRT* miniport = new(PoolFlags, VOXORA_POOLTAG) CMiniportWaveRT(UnknownOuter, Capture);
    if (miniport == NULL)
    {
        *Unknown = NULL;
        return STATUS_INSUFFICIENT_RESOURCES;
    }

    miniport->AddRef();
    *Unknown = PUNKNOWN(static_cast<PMINIPORTWAVERT>(miniport));
    return STATUS_SUCCESS;
}

// ===========================================================================
// CMiniportWaveRT
// ===========================================================================

#pragma code_seg("PAGE")
CMiniportWaveRT::CMiniportWaveRT(_In_opt_ PUNKNOWN UnknownOuter, _In_ BOOLEAN Capture)
    : CUnknown(UnknownOuter),
      m_Adapter(NULL),
      m_Port(NULL),
      m_Capture(Capture),
      m_Stream(NULL)
{
    PAGED_CODE();
}

#pragma code_seg("PAGE")
CMiniportWaveRT::~CMiniportWaveRT()
{
    PAGED_CODE();
    ASSERT(m_Stream == NULL);

    if (m_Port != NULL)
    {
        m_Port->Release();
        m_Port = NULL;
    }
    if (m_Adapter != NULL)
    {
        m_Adapter->Release();
        m_Adapter = NULL;
    }
}

#pragma code_seg("PAGE")
STDMETHODIMP_(NTSTATUS)
CMiniportWaveRT::NonDelegatingQueryInterface(
    _In_ REFIID Interface,
    _COM_Outptr_ PVOID* Object)
{
    PAGED_CODE();
    ASSERT(Object);

    if (IsEqualGUIDAligned(Interface, IID_IUnknown))
    {
        *Object = PVOID(PUNKNOWN(static_cast<PMINIPORTWAVERT>(this)));
    }
    else if (IsEqualGUIDAligned(Interface, IID_IMiniport))
    {
        *Object = PVOID(static_cast<PMINIPORT>(this));
    }
    else if (IsEqualGUIDAligned(Interface, IID_IMiniportWaveRT))
    {
        *Object = PVOID(static_cast<PMINIPORTWAVERT>(this));
    }
    else
    {
        *Object = NULL;
        return STATUS_INVALID_PARAMETER;
    }

    PUNKNOWN(*Object)->AddRef();
    return STATUS_SUCCESS;
}

#pragma code_seg("PAGE")
STDMETHODIMP_(NTSTATUS)
CMiniportWaveRT::Init(
    _In_ PUNKNOWN       UnknownAdapter,
    _In_ PRESOURCELIST  ResourceList,
    _In_ PPORTWAVERT    Port)
{
    PAGED_CODE();
    UNREFERENCED_PARAMETER(ResourceList);
    ASSERT(UnknownAdapter);
    ASSERT(Port);

    m_Port = Port;
    m_Port->AddRef();

    NTSTATUS ntStatus = UnknownAdapter->QueryInterface(IID_IVoxoraAdapter,
                                                       reinterpret_cast<PVOID*>(&m_Adapter));
    if (!NT_SUCCESS(ntStatus))
    {
        m_Adapter = NULL;
        return ntStatus;
    }

    VOXORA_TRACE("MiniportWaveRT(%s) Init\n", m_Capture ? "capture" : "render");
    return STATUS_SUCCESS;
}

#pragma code_seg("PAGE")
STDMETHODIMP_(NTSTATUS)
CMiniportWaveRT::GetDescription(_Out_ PPCFILTER_DESCRIPTOR* OutFilterDescriptor)
{
    PAGED_CODE();
    ASSERT(OutFilterDescriptor);

    *OutFilterDescriptor = m_Capture ? &FilterDescriptorCapture : &FilterDescriptorRender;
    return STATUS_SUCCESS;
}

#pragma code_seg("PAGE")
STDMETHODIMP_(NTSTATUS)
CMiniportWaveRT::GetDeviceDescription(_Out_ PDEVICE_DESCRIPTION DeviceDescription)
{
    PAGED_CODE();
    ASSERT(DeviceDescription);

    // Valores nominales: el dispositivo es virtual y nunca hace DMA real,
    // pero PortCls exige una descripción coherente para crear el adaptador
    // de DMA que respalda AllocatePagesForMdl.
    RtlZeroMemory(DeviceDescription, sizeof(DEVICE_DESCRIPTION));
    DeviceDescription->Master = TRUE;
    DeviceDescription->ScatterGather = TRUE;
    DeviceDescription->Dma32BitAddresses = TRUE;
    DeviceDescription->InterfaceType = PCIBus;
    DeviceDescription->MaximumLength = 0xFFFFFFFF;
    return STATUS_SUCCESS;
}

// Valida un KSDATAFORMAT_WAVEFORMATEX(TENSIBLE) contra lo que soporta el cable.
#pragma code_seg("PAGE")
NTSTATUS
CMiniportWaveRT::ValidateDataFormat(
    _In_ PKSDATAFORMAT DataFormat,
    _Out_opt_ PVOXORA_PCM_FORMAT Out)
{
    PAGED_CODE();
    ASSERT(DataFormat);

    if (DataFormat->FormatSize < sizeof(KSDATAFORMAT_WAVEFORMATEX))
    {
        return STATUS_INVALID_PARAMETER;
    }
    if (!IsEqualGUIDAligned(DataFormat->MajorFormat, KSDATAFORMAT_TYPE_AUDIO) ||
        !IsEqualGUIDAligned(DataFormat->Specifier, KSDATAFORMAT_SPECIFIER_WAVEFORMATEX))
    {
        return STATUS_NO_MATCH;
    }

    PWAVEFORMATEX wfx = &(reinterpret_cast<PKSDATAFORMAT_WAVEFORMATEX>(DataFormat)->WaveFormatEx);
    BOOLEAN isFloat;

    if (wfx->wFormatTag == WAVE_FORMAT_EXTENSIBLE)
    {
        if (DataFormat->FormatSize < sizeof(KSDATAFORMAT_WAVEFORMATEXTENSIBLE) ||
            wfx->cbSize < sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX))
        {
            return STATUS_INVALID_PARAMETER;
        }
        PWAVEFORMATEXTENSIBLE ext = reinterpret_cast<PWAVEFORMATEXTENSIBLE>(wfx);
        if (IsEqualGUIDAligned(ext->SubFormat, KSDATAFORMAT_SUBTYPE_PCM))
        {
            isFloat = FALSE;
        }
        else if (IsEqualGUIDAligned(ext->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT))
        {
            isFloat = TRUE;
        }
        else
        {
            return STATUS_NO_MATCH;
        }
        if (ext->Samples.wValidBitsPerSample != wfx->wBitsPerSample)
        {
            return STATUS_NO_MATCH;
        }
    }
    else if (wfx->wFormatTag == WAVE_FORMAT_PCM)
    {
        isFloat = FALSE;
    }
    else if (wfx->wFormatTag == WAVE_FORMAT_IEEE_FLOAT)
    {
        isFloat = TRUE;
    }
    else
    {
        return STATUS_NO_MATCH;
    }

    const USHORT bits = isFloat ? VOXORA_FLOAT_BITS : VOXORA_PCM_BITS;
    if (wfx->wBitsPerSample != bits)
    {
        return STATUS_NO_MATCH;
    }
    if (wfx->nChannels < VOXORA_MIN_CHANNELS || wfx->nChannels > VOXORA_MAX_CHANNELS)
    {
        return STATUS_NO_MATCH;
    }
    if (wfx->nSamplesPerSec < VOXORA_MIN_SAMPLE_RATE || wfx->nSamplesPerSec > VOXORA_MAX_SAMPLE_RATE)
    {
        return STATUS_NO_MATCH;
    }
    const USHORT blockAlign = static_cast<USHORT>(wfx->nChannels * bits / 8);
    if (wfx->nBlockAlign != blockAlign ||
        wfx->nAvgBytesPerSec != wfx->nSamplesPerSec * blockAlign)
    {
        return STATUS_NO_MATCH;
    }

    if (Out != NULL)
    {
        Out->SampleRate = wfx->nSamplesPerSec;
        Out->Channels = wfx->nChannels;
        Out->BitsPerSample = bits;
        Out->BlockAlign = blockAlign;
        Out->IsFloat = isFloat;
    }
    return STATUS_SUCCESS;
}

// Propone un formato concreto dentro de la intersección cliente/miniport.
#pragma code_seg("PAGE")
STDMETHODIMP_(NTSTATUS)
CMiniportWaveRT::DataRangeIntersection(
    _In_        ULONG        PinId,
    _In_        PKSDATARANGE ClientDataRange,
    _In_        PKSDATARANGE MyDataRange,
    _In_        ULONG        OutputBufferLength,
    _Out_writes_bytes_to_opt_(OutputBufferLength, *ResultantFormatLength)
                PVOID        ResultantFormat,
    _Out_       PULONG       ResultantFormatLength)
{
    PAGED_CODE();
    ASSERT(ClientDataRange);
    ASSERT(MyDataRange);
    ASSERT(ResultantFormatLength);

    const ULONG hostPin = m_Capture ? VOXORA_WAVE_CAPTURE_PIN_HOST : VOXORA_WAVE_RENDER_PIN_HOST;
    if (PinId != hostPin)
    {
        // Pins puente: que PortCls aplique su intersección por defecto.
        return STATUS_NOT_IMPLEMENTED;
    }

    if (!IsWildcardGuid(ClientDataRange->MajorFormat) &&
        !IsEqualGUIDAligned(ClientDataRange->MajorFormat, KSDATAFORMAT_TYPE_AUDIO))
    {
        return STATUS_NO_MATCH;
    }
    if (!IsWildcardGuid(ClientDataRange->Specifier) &&
        !IsEqualGUIDAligned(ClientDataRange->Specifier, KSDATAFORMAT_SPECIFIER_WAVEFORMATEX))
    {
        return STATUS_NO_MATCH;
    }
    if (!IsWildcardGuid(ClientDataRange->SubFormat) &&
        !IsEqualGUIDAligned(ClientDataRange->SubFormat, MyDataRange->SubFormat))
    {
        return STATUS_NO_MATCH;
    }

    PKSDATARANGE_AUDIO mine = reinterpret_cast<PKSDATARANGE_AUDIO>(MyDataRange);
    ULONG rate = mine->MaximumSampleFrequency;
    ULONG channels = mine->MaximumChannels;
    const ULONG bits = mine->MaximumBitsPerSample;

    if (ClientDataRange->FormatSize >= sizeof(KSDATARANGE_AUDIO))
    {
        PKSDATARANGE_AUDIO client = reinterpret_cast<PKSDATARANGE_AUDIO>(ClientDataRange);
        if (client->MaximumSampleFrequency < mine->MinimumSampleFrequency ||
            client->MinimumSampleFrequency > mine->MaximumSampleFrequency)
        {
            return STATUS_NO_MATCH;
        }
        if (bits < client->MinimumBitsPerSample || bits > client->MaximumBitsPerSample)
        {
            return STATUS_NO_MATCH;
        }
        if (client->MaximumChannels < VOXORA_MIN_CHANNELS)
        {
            return STATUS_NO_MATCH;
        }
        rate = VoxoraMin(client->MaximumSampleFrequency, mine->MaximumSampleFrequency);
        channels = VoxoraMin(client->MaximumChannels, mine->MaximumChannels);
    }

    *ResultantFormatLength = sizeof(KSDATAFORMAT_WAVEFORMATEXTENSIBLE);
    if (OutputBufferLength == 0)
    {
        return STATUS_BUFFER_OVERFLOW;   // el llamador pregunta el tamaño
    }
    if (OutputBufferLength < sizeof(KSDATAFORMAT_WAVEFORMATEXTENSIBLE) || ResultantFormat == NULL)
    {
        return STATUS_BUFFER_TOO_SMALL;
    }

    PKSDATAFORMAT_WAVEFORMATEXTENSIBLE fmt =
        static_cast<PKSDATAFORMAT_WAVEFORMATEXTENSIBLE>(ResultantFormat);
    RtlZeroMemory(fmt, sizeof(KSDATAFORMAT_WAVEFORMATEXTENSIBLE));

    const USHORT blockAlign = static_cast<USHORT>(channels * bits / 8);

    fmt->DataFormat.FormatSize = sizeof(KSDATAFORMAT_WAVEFORMATEXTENSIBLE);
    fmt->DataFormat.Flags = 0;
    fmt->DataFormat.SampleSize = blockAlign;
    fmt->DataFormat.Reserved = 0;
    fmt->DataFormat.MajorFormat = KSDATAFORMAT_TYPE_AUDIO;
    fmt->DataFormat.SubFormat = MyDataRange->SubFormat;
    fmt->DataFormat.Specifier = KSDATAFORMAT_SPECIFIER_WAVEFORMATEX;

    fmt->WaveFormatExt.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    fmt->WaveFormatExt.Format.nChannels = static_cast<WORD>(channels);
    fmt->WaveFormatExt.Format.nSamplesPerSec = rate;
    fmt->WaveFormatExt.Format.wBitsPerSample = static_cast<WORD>(bits);
    fmt->WaveFormatExt.Format.nBlockAlign = blockAlign;
    fmt->WaveFormatExt.Format.nAvgBytesPerSec = rate * blockAlign;
    fmt->WaveFormatExt.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
    fmt->WaveFormatExt.Samples.wValidBitsPerSample = static_cast<WORD>(bits);
    fmt->WaveFormatExt.dwChannelMask = (channels == 1) ? KSAUDIO_SPEAKER_MONO : KSAUDIO_SPEAKER_STEREO;
    fmt->WaveFormatExt.SubFormat = MyDataRange->SubFormat;

    return STATUS_SUCCESS;
}

#pragma code_seg("PAGE")
STDMETHODIMP_(NTSTATUS)
CMiniportWaveRT::NewStream(
    _Out_ PMINIPORTWAVERTSTREAM* OutStream,
    _In_  PPORTWAVERTSTREAM      PortStream,
    _In_  ULONG                  Pin,
    _In_  BOOLEAN                Capture,
    _In_  PKSDATAFORMAT          DataFormat)
{
    PAGED_CODE();
    ASSERT(OutStream);
    ASSERT(PortStream);
    ASSERT(DataFormat);

    *OutStream = NULL;

    const ULONG hostPin = m_Capture ? VOXORA_WAVE_CAPTURE_PIN_HOST : VOXORA_WAVE_RENDER_PIN_HOST;
    if (Pin != hostPin || Capture != m_Capture)
    {
        return STATUS_INVALID_PARAMETER;
    }

    NTSTATUS ntStatus = ValidateDataFormat(DataFormat, NULL);
    if (!NT_SUCCESS(ntStatus))
    {
        return ntStatus;
    }

    CMiniportWaveRTStream* stream =
        new(POOL_FLAG_NON_PAGED, VOXORA_POOLTAG) CMiniportWaveRTStream(NULL);
    if (stream == NULL)
    {
        return STATUS_INSUFFICIENT_RESOURCES;
    }
    stream->AddRef();

    ntStatus = stream->Init(this, PortStream, Pin, Capture, DataFormat);
    if (NT_SUCCESS(ntStatus))
    {
        // Un solo stream por filtro (MaxFilterInstances = 1). Sin spinlock:
        // esta función es paginable (ver minwavert.h).
        if (InterlockedCompareExchangePointer(
                reinterpret_cast<PVOID volatile*>(&m_Stream), stream, NULL) != NULL)
        {
            ntStatus = STATUS_INVALID_DEVICE_REQUEST;
        }
    }

    if (!NT_SUCCESS(ntStatus))
    {
        stream->Release();
        return ntStatus;
    }

    *OutStream = PMINIPORTWAVERTSTREAM(stream);   // la referencia pasa al puerto
    return STATUS_SUCCESS;
}

// Se llama desde el destructor del stream: libera el slot.
#pragma code_seg("PAGE")
void
CMiniportWaveRT::StreamClosed(_In_ CMiniportWaveRTStream* Stream)
{
    PAGED_CODE();
    // Libera el slot solo si es de este stream (un NewStream rechazado por
    // slot ocupado también pasa por aquí al destruirse).
    InterlockedCompareExchangePointer(
        reinterpret_cast<PVOID volatile*>(&m_Stream), NULL, Stream);
}

// KSPROPERTY_PIN_PROPOSEDATAFORMAT: el motor de audio pregunta si aceptamos
// un formato concreto antes de crear el pin.
#pragma code_seg("PAGE")
NTSTATUS
CMiniportWaveRT::PropertyHandlerProposedFormat(_In_ PPCPROPERTY_REQUEST Request)
{
    PAGED_CODE();

    // Instance apunta al PinId de la KSP_PIN.
    ULONG pinId = ULONG(-1);
    if (Request->InstanceSize >= sizeof(ULONG))
    {
        pinId = *static_cast<PULONG>(Request->Instance);
    }
    const ULONG hostPin = m_Capture ? VOXORA_WAVE_CAPTURE_PIN_HOST : VOXORA_WAVE_RENDER_PIN_HOST;
    if (pinId != hostPin)
    {
        return STATUS_INVALID_PARAMETER;
    }

    if (Request->Verb & KSPROPERTY_TYPE_BASICSUPPORT)
    {
        if (Request->ValueSize < sizeof(ULONG))
        {
            Request->ValueSize = sizeof(ULONG);
            return STATUS_BUFFER_TOO_SMALL;
        }
        *static_cast<PULONG>(Request->Value) = KSPROPERTY_TYPE_BASICSUPPORT | KSPROPERTY_TYPE_SET;
        Request->ValueSize = sizeof(ULONG);
        return STATUS_SUCCESS;
    }

    if (Request->Verb & KSPROPERTY_TYPE_SET)
    {
        if (Request->ValueSize < sizeof(KSDATAFORMAT))
        {
            return STATUS_BUFFER_TOO_SMALL;
        }
        PKSDATAFORMAT format = static_cast<PKSDATAFORMAT>(Request->Value);
        if (format->FormatSize > Request->ValueSize)
        {
            return STATUS_INVALID_PARAMETER;
        }
        return ValidateDataFormat(format, NULL);
    }

    return STATUS_INVALID_DEVICE_REQUEST;
}

#pragma code_seg("PAGE")
static NTSTATUS
PropertyHandler_WaveFilter(_In_ PPCPROPERTY_REQUEST PropertyRequest)
{
    PAGED_CODE();
    ASSERT(PropertyRequest);

    // MajorTarget es el IUnknown del miniport que entregamos a IPort::Init
    // (su IMiniportWaveRT); bajamos al objeto concreto.
    CMiniportWaveRT* miniport = static_cast<CMiniportWaveRT*>(
        static_cast<PMINIPORTWAVERT>(PropertyRequest->MajorTarget));

    if (IsEqualGUIDAligned(*PropertyRequest->PropertyItem->Set, KSPROPSETID_Pin) &&
        PropertyRequest->PropertyItem->Id == KSPROPERTY_PIN_PROPOSEDATAFORMAT)
    {
        return miniport->PropertyHandlerProposedFormat(PropertyRequest);
    }
    return STATUS_INVALID_DEVICE_REQUEST;
}

// ===========================================================================
// CMiniportWaveRTStream
// ===========================================================================

#pragma code_seg("PAGE")
CMiniportWaveRTStream::~CMiniportWaveRTStream()
{
    PAGED_CODE();

    // Parar el timer antes de soltar nada que la DPC pueda tocar.
    if (m_TimerActive)
    {
        KeCancelTimer(&m_Timer);
        KeFlushQueuedDpcs();
        m_TimerActive = FALSE;
    }
    if (m_TimerResolutionRaised)
    {
        ExSetTimerResolution(0, FALSE);
        m_TimerResolutionRaised = FALSE;
    }

    // Normalmente el puerto ya llamó a FreeAudioBuffer; por si acaso.
    if (m_DmaMdl != NULL)
    {
        FreeBufferInternal(m_DmaMdl);
    }

    if (m_Miniport != NULL)
    {
        m_Miniport->StreamClosed(this);
        m_Miniport->Release();
        m_Miniport = NULL;
    }
    if (m_Adapter != NULL)
    {
        m_Adapter->Release();
        m_Adapter = NULL;
    }
    if (m_PortStream != NULL)
    {
        m_PortStream->Release();
        m_PortStream = NULL;
    }
}

#pragma code_seg("PAGE")
STDMETHODIMP_(NTSTATUS)
CMiniportWaveRTStream::NonDelegatingQueryInterface(
    _In_ REFIID Interface,
    _COM_Outptr_ PVOID* Object)
{
    PAGED_CODE();
    ASSERT(Object);

    if (IsEqualGUIDAligned(Interface, IID_IUnknown))
    {
        *Object = PVOID(PUNKNOWN(static_cast<PMINIPORTWAVERTSTREAM>(this)));
    }
    else if (IsEqualGUIDAligned(Interface, IID_IMiniportWaveRTStream))
    {
        *Object = PVOID(static_cast<PMINIPORTWAVERTSTREAM>(this));
    }
    else if (IsEqualGUIDAligned(Interface, IID_IMiniportWaveRTStreamNotification))
    {
        *Object = PVOID(static_cast<PMINIPORTWAVERTSTREAMNOTIFICATION>(this));
    }
    else
    {
        *Object = NULL;
        return STATUS_INVALID_PARAMETER;
    }

    PUNKNOWN(*Object)->AddRef();
    return STATUS_SUCCESS;
}

#pragma code_seg("PAGE")
NTSTATUS
CMiniportWaveRTStream::Init(
    _In_ CMiniportWaveRT*   Miniport,
    _In_ PPORTWAVERTSTREAM  PortStream,
    _In_ ULONG              Pin,
    _In_ BOOLEAN            Capture,
    _In_ PKSDATAFORMAT      DataFormat)
{
    PAGED_CODE();

    // Estado explícito (operator new de stdunk.h ya deja la memoria a cero,
    // pero no dependemos de ello).
    m_State = KSSTATE_STOP;
    m_DmaMdl = NULL;
    m_DmaBuffer = NULL;
    m_DmaBufferSize = 0;
    m_NotificationCount = 0;
    m_LinearPosition = 0;
    m_LinearAtRun = 0;
    m_QpcAtRun = 0;
    m_PlayOffset = 0;
    m_TimerActive = FALSE;
    m_TimerResolutionRaised = FALSE;
    RtlZeroMemory(m_NotificationEvents, sizeof(m_NotificationEvents));

    m_Miniport = Miniport;
    m_Miniport->AddRef();

    m_PortStream = PortStream;
    m_PortStream->AddRef();

    m_Adapter = Miniport->GetAdapter();
    m_Adapter->AddRef();
    m_Loopback = m_Adapter->GetLoopback();

    m_Capture = Capture;
    m_Pin = Pin;

    NTSTATUS ntStatus = Miniport->ValidateDataFormat(DataFormat, &m_Format);
    if (!NT_SUCCESS(ntStatus))
    {
        return ntStatus;
    }

    KeInitializeSpinLock(&m_Lock);
    KeInitializeTimerEx(&m_Timer, NotificationTimer);
    KeInitializeDpc(&m_Dpc, TimerDpcRoutine, this);

    LARGE_INTEGER freq;
    KeQueryPerformanceCounter(&freq);
    m_QpcFrequency = freq.QuadPart;
    if (m_QpcFrequency <= 0)
    {
        return STATUS_UNSUCCESSFUL;
    }

    VOXORA_TRACE("Stream(%s) %u Hz, %u ch, %s\n",
                 m_Capture ? "capture" : "render",
                 m_Format.SampleRate, m_Format.Channels,
                 m_Format.IsFloat ? "float32" : "s16le");
    return STATUS_SUCCESS;
}

// ---------------------------------------------------------------------------
// Buffer cíclico
//
// AllocateBufferInternal / FreeBufferInternal, Register/Unregister-
// NotificationEvent y SetState toman m_Lock (spinlock compartido con la DPC):
// mientras lo sostienen corren a DISPATCH_LEVEL, así que NO pueden estar en
// la sección PAGE (se ejecutaría código paginable a DISPATCH_LEVEL ->
// IRQL_NOT_LESS_OR_EQUAL si la página se ha descartado). Van en la sección
// no paginada y comprueban PASSIVE_LEVEL de forma explícita.
// ---------------------------------------------------------------------------

#pragma code_seg()
_Use_decl_annotations_
NTSTATUS
CMiniportWaveRTStream::AllocateBufferInternal(
    ULONG                 NotificationCount,
    ULONG                 RequestedSize,
    PMDL*                 AudioBufferMdl,
    ULONG*                ActualSize,
    ULONG*                OffsetFromFirstPage,
    MEMORY_CACHING_TYPE*  CacheType)
{
    ASSERT(KeGetCurrentIrql() == PASSIVE_LEVEL);

    *AudioBufferMdl = NULL;
    *ActualSize = 0;
    *OffsetFromFirstPage = 0;
    *CacheType = MmCached;

    if (m_DmaMdl != NULL)
    {
        return STATUS_DEVICE_BUSY;      // ya hay un buffer: liberar primero
    }
    if (NotificationCount > 2)
    {
        return STATUS_INVALID_PARAMETER;
    }

    // El tamaño debe ser múltiplo del frame y divisible en
    // NotificationCount trozos iguales alineados a frame.
    const ULONG align = m_Format.BlockAlign * (NotificationCount ? NotificationCount : 1);
    ULONG size = RequestedSize - (RequestedSize % align);
    if (size == 0)
    {
        size = align;
    }
    if (size > VOXORA_MAX_DMA_BUFFER_BYTES)
    {
        size = VOXORA_MAX_DMA_BUFFER_BYTES - (VOXORA_MAX_DMA_BUFFER_BYTES % align);
    }

    // Páginas físicas propias (MmAllocatePagesForMdl por debajo) mapeadas en
    // espacio de sistema; PortCls las mapea después al proceso del motor de
    // audio a partir de esta MDL.
    PHYSICAL_ADDRESS highAddress;
    highAddress.QuadPart = MAXULONGLONG;   // sin restricción: no hay DMA real

    PMDL mdl = m_PortStream->AllocatePagesForMdl(highAddress, size);
    if (mdl == NULL)
    {
        return STATUS_INSUFFICIENT_RESOURCES;
    }

    BYTE* buffer = static_cast<BYTE*>(m_PortStream->MapAllocatedPages(mdl, MmCached));
    if (buffer == NULL)
    {
        m_PortStream->FreePagesFromMdl(mdl);
        return STATUS_INSUFFICIENT_RESOURCES;
    }
    RtlZeroMemory(buffer, size);

    KIRQL oldIrql;
    KeAcquireSpinLock(&m_Lock, &oldIrql);
    m_DmaMdl = mdl;
    m_DmaBuffer = buffer;
    m_DmaBufferSize = size;
    m_NotificationCount = NotificationCount;
    m_LinearPosition = 0;
    m_LinearAtRun = 0;
    m_PlayOffset = 0;
    KeReleaseSpinLock(&m_Lock, oldIrql);

    *AudioBufferMdl = mdl;
    *ActualSize = size;
    *OffsetFromFirstPage = 0;
    *CacheType = MmCached;

    VOXORA_TRACE("Stream(%s) buffer %u bytes, %u notificaciones\n",
                 m_Capture ? "capture" : "render", size, NotificationCount);
    return STATUS_SUCCESS;
}

#pragma code_seg()
_Use_decl_annotations_
void
CMiniportWaveRTStream::FreeBufferInternal(PMDL Mdl)
{
    ASSERT(KeGetCurrentIrql() == PASSIVE_LEVEL);

    BYTE* buffer;
    KIRQL oldIrql;
    KeAcquireSpinLock(&m_Lock, &oldIrql);
    // A partir de aquí la DPC ve m_DmaBuffer == NULL y no toca la memoria.
    buffer = m_DmaBuffer;
    m_DmaBuffer = NULL;
    m_DmaMdl = NULL;
    m_DmaBufferSize = 0;
    m_NotificationCount = 0;
    KeReleaseSpinLock(&m_Lock, oldIrql);

    if (buffer != NULL)
    {
        m_PortStream->UnmapAllocatedPages(buffer, Mdl);
    }
    m_PortStream->FreePagesFromMdl(Mdl);
}

#pragma code_seg("PAGE")
STDMETHODIMP_(NTSTATUS)
CMiniportWaveRTStream::AllocateAudioBuffer(
    _In_  ULONG                 RequestedSize,
    _Out_ PMDL*                 AudioBufferMdl,
    _Out_ ULONG*                ActualSize,
    _Out_ ULONG*                OffsetFromFirstPage,
    _Out_ MEMORY_CACHING_TYPE*  CacheType)
{
    PAGED_CODE();
    return AllocateBufferInternal(0, RequestedSize, AudioBufferMdl, ActualSize,
                                  OffsetFromFirstPage, CacheType);
}

#pragma code_seg("PAGE")
STDMETHODIMP_(VOID)
CMiniportWaveRTStream::FreeAudioBuffer(
    _In_opt_ PMDL  AudioBufferMdl,
    _In_     ULONG BufferSize)
{
    PAGED_CODE();
    UNREFERENCED_PARAMETER(BufferSize);
    if (AudioBufferMdl != NULL)
    {
        FreeBufferInternal(AudioBufferMdl);
    }
}

#pragma code_seg("PAGE")
STDMETHODIMP_(NTSTATUS)
CMiniportWaveRTStream::AllocateBufferWithNotification(
    _In_  ULONG                 NotificationCount,
    _In_  ULONG                 RequestedSize,
    _Out_ PMDL*                 AudioBufferMdl,
    _Out_ ULONG*                ActualSize,
    _Out_ ULONG*                OffsetFromFirstPage,
    _Out_ MEMORY_CACHING_TYPE*  CacheType)
{
    PAGED_CODE();
    if (NotificationCount != 1 && NotificationCount != 2)
    {
        return STATUS_INVALID_PARAMETER;
    }
    return AllocateBufferInternal(NotificationCount, RequestedSize, AudioBufferMdl,
                                  ActualSize, OffsetFromFirstPage, CacheType);
}

#pragma code_seg("PAGE")
STDMETHODIMP_(VOID)
CMiniportWaveRTStream::FreeBufferWithNotification(
    _In_ PMDL  AudioBufferMdl,
    _In_ ULONG BufferSize)
{
    PAGED_CODE();
    UNREFERENCED_PARAMETER(BufferSize);
    if (AudioBufferMdl != NULL)
    {
        FreeBufferInternal(AudioBufferMdl);
    }
}

// ---------------------------------------------------------------------------
// Eventos de notificación (modo pull)
// ---------------------------------------------------------------------------

#pragma code_seg()
STDMETHODIMP_(NTSTATUS)
CMiniportWaveRTStream::RegisterNotificationEvent(_In_ PKEVENT NotificationEvent)
{
    ASSERT(KeGetCurrentIrql() == PASSIVE_LEVEL);
    ASSERT(NotificationEvent);

    NTSTATUS ntStatus = STATUS_INSUFFICIENT_RESOURCES;
    KIRQL oldIrql;
    KeAcquireSpinLock(&m_Lock, &oldIrql);
    for (ULONG i = 0; i < MAX_NOTIFICATION_EVENTS; i++)
    {
        if (m_NotificationEvents[i] == NotificationEvent)
        {
            ntStatus = STATUS_SUCCESS;  // ya registrado
            break;
        }
        if (m_NotificationEvents[i] == NULL)
        {
            m_NotificationEvents[i] = NotificationEvent;
            ntStatus = STATUS_SUCCESS;
            break;
        }
    }
    KeReleaseSpinLock(&m_Lock, oldIrql);
    return ntStatus;
}

#pragma code_seg()
STDMETHODIMP_(NTSTATUS)
CMiniportWaveRTStream::UnregisterNotificationEvent(_In_ PKEVENT NotificationEvent)
{
    ASSERT(KeGetCurrentIrql() == PASSIVE_LEVEL);
    ASSERT(NotificationEvent);

    NTSTATUS ntStatus = STATUS_NOT_FOUND;
    KIRQL oldIrql;
    KeAcquireSpinLock(&m_Lock, &oldIrql);
    for (ULONG i = 0; i < MAX_NOTIFICATION_EVENTS; i++)
    {
        if (m_NotificationEvents[i] == NotificationEvent)
        {
            m_NotificationEvents[i] = NULL;
            ntStatus = STATUS_SUCCESS;
            break;
        }
    }
    KeReleaseSpinLock(&m_Lock, oldIrql);
    return ntStatus;
}

// ---------------------------------------------------------------------------
// Estado y formato
// ---------------------------------------------------------------------------

#pragma code_seg("PAGE")
STDMETHODIMP_(NTSTATUS)
CMiniportWaveRTStream::SetFormat(_In_ PKSDATAFORMAT DataFormat)
{
    PAGED_CODE();
    UNREFERENCED_PARAMETER(DataFormat);
    // El formato se fija en NewStream; los cambios en caliente no se soportan
    // (comportamiento estándar de WaveRT).
    return STATUS_NOT_SUPPORTED;
}

// No paginada: toma m_Lock (ver comentario de "Buffer cíclico").
#pragma code_seg()
STDMETHODIMP_(NTSTATUS)
CMiniportWaveRTStream::SetState(_In_ KSSTATE State)
{
    // KeFlushQueuedDpcs y ExSetTimerResolution exigen PASSIVE_LEVEL.
    ASSERT(KeGetCurrentIrql() == PASSIVE_LEVEL);

    KIRQL oldIrql;

    switch (State)
    {
    case KSSTATE_STOP:
        if (m_TimerActive)
        {
            KeCancelTimer(&m_Timer);
            KeFlushQueuedDpcs();
            m_TimerActive = FALSE;
        }
        if (m_TimerResolutionRaised)
        {
            ExSetTimerResolution(0, FALSE);
            m_TimerResolutionRaised = FALSE;
        }
        KeAcquireSpinLock(&m_Lock, &oldIrql);
        m_State = KSSTATE_STOP;
        m_LinearPosition = 0;
        m_LinearAtRun = 0;
        m_PlayOffset = 0;
        KeReleaseSpinLock(&m_Lock, oldIrql);
        break;

    case KSSTATE_ACQUIRE:
        KeAcquireSpinLock(&m_Lock, &oldIrql);
        m_State = KSSTATE_ACQUIRE;
        KeReleaseSpinLock(&m_Lock, oldIrql);
        break;

    case KSSTATE_PAUSE:
        // Desde RUN: congelar la posición (se conserva para reanudar).
        if (m_TimerActive)
        {
            KeCancelTimer(&m_Timer);
            KeFlushQueuedDpcs();
            m_TimerActive = FALSE;
        }
        if (m_TimerResolutionRaised)
        {
            ExSetTimerResolution(0, FALSE);
            m_TimerResolutionRaised = FALSE;
        }
        KeAcquireSpinLock(&m_Lock, &oldIrql);
        if (m_State == KSSTATE_RUN && m_DmaBuffer != NULL)
        {
            // Consolidar el audio transcurrido desde el último tick para que
            // la posición congelada sea la real.
            AdvancePosition();
        }
        m_State = KSSTATE_PAUSE;
        KeReleaseSpinLock(&m_Lock, oldIrql);
        break;

    case KSSTATE_RUN:
        if (m_DmaBuffer == NULL)
        {
            return STATUS_INVALID_DEVICE_STATE;   // RUN sin buffer asignado
        }
        if (!m_TimerResolutionRaised)
        {
            ExSetTimerResolution(VOXORA_TIMER_RESOLUTION_100NS, TRUE);
            m_TimerResolutionRaised = TRUE;
        }
        KeAcquireSpinLock(&m_Lock, &oldIrql);
        m_QpcAtRun = KeQueryPerformanceCounter(NULL).QuadPart;
        m_LinearAtRun = m_LinearPosition;
        m_State = KSSTATE_RUN;
        KeReleaseSpinLock(&m_Lock, oldIrql);

        if (!m_TimerActive)
        {
            LARGE_INTEGER dueTime;
            dueTime.QuadPart = -static_cast<LONGLONG>(VOXORA_TIMER_PERIOD_MS) * 10000LL; // relativo
            KeSetTimerEx(&m_Timer, dueTime, VOXORA_TIMER_PERIOD_MS, &m_Dpc);
            m_TimerActive = TRUE;
        }
        break;

    default:
        return STATUS_INVALID_PARAMETER;
    }

    VOXORA_TRACE("Stream(%s) SetState(%d)\n", m_Capture ? "capture" : "render", State);
    return STATUS_SUCCESS;
}

// ---------------------------------------------------------------------------
// Posición / latencia / registros
// ---------------------------------------------------------------------------

// Sección no paginada: GetPosition puede llamarse a DISPATCH_LEVEL.
#pragma code_seg()

STDMETHODIMP_(NTSTATUS)
CMiniportWaveRTStream::GetPosition(_Out_ PKSAUDIO_POSITION Position)
{
    ASSERT(Position);

    KIRQL oldIrql;
    KeAcquireSpinLock(&m_Lock, &oldIrql);
    if (m_State == KSSTATE_RUN && m_DmaBuffer != NULL)
    {
        // Posición fresca entre ticks del timer.
        AdvancePosition();
    }
    Position->PlayOffset = m_PlayOffset;
    Position->WriteOffset = m_PlayOffset;   // sin FIFO de hardware
    KeReleaseSpinLock(&m_Lock, oldIrql);
    return STATUS_SUCCESS;
}

STDMETHODIMP_(VOID)
CMiniportWaveRTStream::GetHWLatency(_Out_ PKSRTAUDIO_HWLATENCY Latency)
{
    ASSERT(Latency);
    Latency->FifoSize = 0;
    Latency->ChipsetDelay = 0;
    Latency->CodecDelay = 0;
}

STDMETHODIMP_(NTSTATUS)
CMiniportWaveRTStream::GetPositionRegister(_Out_ PKSRTAUDIO_HWREGISTER Register)
{
    UNREFERENCED_PARAMETER(Register);
    // Sin registro de posición mapeable: el motor usa GetPosition.
    return STATUS_NOT_IMPLEMENTED;
}

STDMETHODIMP_(NTSTATUS)
CMiniportWaveRTStream::GetClockRegister(_Out_ PKSRTAUDIO_HWREGISTER Register)
{
    UNREFERENCED_PARAMETER(Register);
    // Sin reloj de hardware: no soportado (el motor usa QPC).
    return STATUS_NOT_IMPLEMENTED;
}

// ---------------------------------------------------------------------------
// Motor de posición virtual (DISPATCH_LEVEL, con m_Lock tomado)
// ---------------------------------------------------------------------------

ULONGLONG
CMiniportWaveRTStream::TicksToFrames(_In_ LONGLONG Ticks) const
{
    if (Ticks <= 0 || m_QpcFrequency <= 0)
    {
        return 0;
    }
    const ULONGLONG t = static_cast<ULONGLONG>(Ticks);
    const ULONGLONG f = static_cast<ULONGLONG>(m_QpcFrequency);
    const ULONGLONG rate = m_Format.SampleRate;
    // Dividir antes de multiplicar para no desbordar en sesiones largas.
    return (t / f) * rate + ((t % f) * rate) / f;
}

_Use_decl_annotations_
void
CMiniportWaveRTStream::TransferChunk(ULONG Offset, ULONG Bytes)
{
    const float gain = m_Adapter->GetLinearGain(m_Capture);

    while (Bytes > 0)
    {
        const ULONG chunk = VoxoraMin(Bytes, m_DmaBufferSize - Offset);
        if (m_Capture)
        {
            // Loopback -> buffer cíclico (silencio si no hay render activo).
            m_Loopback->Read(m_DmaBuffer + Offset, chunk, m_Format, gain);
        }
        else
        {
            // Buffer cíclico (escrito por el motor de audio) -> loopback.
            m_Loopback->Write(m_DmaBuffer + Offset, chunk, m_Format, gain);
        }
        Offset = (Offset + chunk) % m_DmaBufferSize;
        Bytes -= chunk;
    }
}

_Use_decl_annotations_
void
CMiniportWaveRTStream::SignalNotifications()
{
    for (ULONG i = 0; i < MAX_NOTIFICATION_EVENTS; i++)
    {
        if (m_NotificationEvents[i] != NULL)
        {
            KeSetEvent(m_NotificationEvents[i], 0, FALSE);
        }
    }
}

_Use_decl_annotations_
void
CMiniportWaveRTStream::AdvancePosition()
{
    const LONGLONG now = KeQueryPerformanceCounter(NULL).QuadPart;
    const ULONGLONG frames = TicksToFrames(now - m_QpcAtRun);
    const ULONGLONG target = m_LinearAtRun + frames * m_Format.BlockAlign;

    if (target <= m_LinearPosition)
    {
        return;
    }

    ULONGLONG delta = target - m_LinearPosition;
    if (delta > m_DmaBufferSize)
    {
        // La DPC llegó muy tarde (más de un buffer completo): se pierde
        // audio; saltar y procesar solo el último buffer.
        m_LinearPosition = target - m_DmaBufferSize;
        m_PlayOffset = static_cast<ULONG>(m_LinearPosition % m_DmaBufferSize);
        delta = m_DmaBufferSize;
    }

    const ULONG bytes = static_cast<ULONG>(delta);
    TransferChunk(m_PlayOffset, bytes);

    const ULONGLONG previous = m_LinearPosition;
    m_LinearPosition += bytes;
    m_PlayOffset = static_cast<ULONG>(m_LinearPosition % m_DmaBufferSize);

    // Notificar al cruzar un límite de periodo (buffer / NotificationCount).
    if (m_NotificationCount > 0)
    {
        const ULONG period = m_DmaBufferSize / m_NotificationCount;
        if (period > 0 && (previous / period) != (m_LinearPosition / period))
        {
            SignalNotifications();
        }
    }
}

_Use_decl_annotations_
void
CMiniportWaveRTStream::TimerDpcRoutine(
    PKDPC Dpc,
    PVOID DeferredContext,
    PVOID SystemArgument1,
    PVOID SystemArgument2)
{
    UNREFERENCED_PARAMETER(Dpc);
    UNREFERENCED_PARAMETER(SystemArgument1);
    UNREFERENCED_PARAMETER(SystemArgument2);

    CMiniportWaveRTStream* self = static_cast<CMiniportWaveRTStream*>(DeferredContext);
    if (self == NULL)
    {
        return;
    }

    KeAcquireSpinLockAtDpcLevel(&self->m_Lock);
    if (self->m_State == KSSTATE_RUN && self->m_DmaBuffer != NULL)
    {
        self->AdvancePosition();
    }
    KeReleaseSpinLockFromDpcLevel(&self->m_Lock);
}
