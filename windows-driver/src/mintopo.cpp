// mintopo.cpp — Miniport de topología de VOXORA Meet (render y capture).
//
// Topología mínima:
//   render : [puente desde wave] -> VOLUME -> MUTE -> [KSNODETYPE_SPEAKER]
//   capture: [KSNODETYPE_MICROPHONE] -> VOLUME -> MUTE -> [puente hacia wave]
// más KSPROPERTY_JACK_DESCRIPTION(2) reportando el jack siempre conectado.
// El estado de volumen/mute vive en el adaptador y lo aplican los streams.
//
// Referencia: sysvad/mintopo.cpp, speakertopo.cpp, mictopo.cpp (WDK).

#include "mintopo.h"

// ===========================================================================
// Property handlers (trampolines estáticos)
// ===========================================================================

static NTSTATUS PropertyHandler_TopoNode(_In_ PPCPROPERTY_REQUEST PropertyRequest);
static NTSTATUS PropertyHandler_TopoFilter(_In_ PPCPROPERTY_REQUEST PropertyRequest);

// --- Nodo de volumen ---
static PCPROPERTY_ITEM PropertiesVolume[] =
{
    {
        &KSPROPSETID_Audio,
        KSPROPERTY_AUDIO_VOLUMELEVEL,
        KSPROPERTY_TYPE_GET | KSPROPERTY_TYPE_SET | KSPROPERTY_TYPE_BASICSUPPORT,
        PropertyHandler_TopoNode
    }
};
DEFINE_PCAUTOMATION_TABLE_PROP(AutomationVolume, PropertiesVolume);

// --- Nodo de mute ---
static PCPROPERTY_ITEM PropertiesMute[] =
{
    {
        &KSPROPSETID_Audio,
        KSPROPERTY_AUDIO_MUTE,
        KSPROPERTY_TYPE_GET | KSPROPERTY_TYPE_SET | KSPROPERTY_TYPE_BASICSUPPORT,
        PropertyHandler_TopoNode
    }
};
DEFINE_PCAUTOMATION_TABLE_PROP(AutomationMute, PropertiesMute);

// --- Filtro (jack) ---
static PCPROPERTY_ITEM PropertiesTopoFilter[] =
{
    {
        &KSPROPSETID_Jack,
        KSPROPERTY_JACK_DESCRIPTION,
        KSPROPERTY_TYPE_GET | KSPROPERTY_TYPE_BASICSUPPORT,
        PropertyHandler_TopoFilter
    },
    {
        &KSPROPSETID_Jack,
        KSPROPERTY_JACK_DESCRIPTION2,
        KSPROPERTY_TYPE_GET | KSPROPERTY_TYPE_BASICSUPPORT,
        PropertyHandler_TopoFilter
    }
};
DEFINE_PCAUTOMATION_TABLE_PROP(AutomationTopoFilter, PropertiesTopoFilter);

// ===========================================================================
// Descriptores
// ===========================================================================

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

static PCNODE_DESCRIPTOR NodesTopology[] =
{
    { 0, &AutomationVolume, &KSNODETYPE_VOLUME, NULL },    // VOXORA_TOPO_NODE_VOLUME
    { 0, &AutomationMute,   &KSNODETYPE_MUTE,   NULL }     // VOXORA_TOPO_NODE_MUTE
};

// Misma cadena en ambas direcciones: pin 0 (entra) -> volumen -> mute -> pin 1 (sale).
static PCCONNECTION_DESCRIPTOR ConnectionsTopology[] =
{
    { PCFILTER_NODE,          0, VOXORA_TOPO_NODE_VOLUME, 1 },
    { VOXORA_TOPO_NODE_VOLUME, 0, VOXORA_TOPO_NODE_MUTE,   1 },
    { VOXORA_TOPO_NODE_MUTE,   0, PCFILTER_NODE,           1 }
};

static GUID CategoriesTopology[] =
{
    STATICGUIDOF(KSCATEGORY_AUDIO),
    STATICGUIDOF(KSCATEGORY_TOPOLOGY)
};

// --- Render ---
static PCPIN_DESCRIPTOR PinsTopologyRender[] =
{
    // VOXORA_TOPO_RENDER_PIN_BRIDGE: viene del filtro wave.
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
    // VOXORA_TOPO_RENDER_PIN_SPEAKER: el "altavoz" virtual. El nombre propio
    // (KSNAME_VOXORA_SPEAKER) lo resuelve el INF vía MediaCategories.
    {
        0, 0, 0,
        NULL,
        {
            0, NULL,
            0, NULL,
            SIZEOF_ARRAY(PinDataRangePointersBridge), PinDataRangePointersBridge,
            KSPIN_DATAFLOW_OUT,
            KSPIN_COMMUNICATION_NONE,
            &KSNODETYPE_SPEAKER,
            &KSNAME_VOXORA_SPEAKER,
            0
        }
    }
};

static PCFILTER_DESCRIPTOR FilterDescriptorTopologyRender =
{
    0,
    &AutomationTopoFilter,
    sizeof(PCPIN_DESCRIPTOR),
    SIZEOF_ARRAY(PinsTopologyRender),
    PinsTopologyRender,
    sizeof(PCNODE_DESCRIPTOR),
    SIZEOF_ARRAY(NodesTopology),
    NodesTopology,
    SIZEOF_ARRAY(ConnectionsTopology),
    ConnectionsTopology,
    SIZEOF_ARRAY(CategoriesTopology),
    CategoriesTopology
};

// --- Capture ---
static PCPIN_DESCRIPTOR PinsTopologyCapture[] =
{
    // VOXORA_TOPO_CAPTURE_PIN_MIC: el "micrófono" virtual.
    {
        0, 0, 0,
        NULL,
        {
            0, NULL,
            0, NULL,
            SIZEOF_ARRAY(PinDataRangePointersBridge), PinDataRangePointersBridge,
            KSPIN_DATAFLOW_IN,
            KSPIN_COMMUNICATION_NONE,
            &KSNODETYPE_MICROPHONE,
            &KSNAME_VOXORA_MICROPHONE,
            0
        }
    },
    // VOXORA_TOPO_CAPTURE_PIN_BRIDGE: va al filtro wave.
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

static PCFILTER_DESCRIPTOR FilterDescriptorTopologyCapture =
{
    0,
    &AutomationTopoFilter,
    sizeof(PCPIN_DESCRIPTOR),
    SIZEOF_ARRAY(PinsTopologyCapture),
    PinsTopologyCapture,
    sizeof(PCNODE_DESCRIPTOR),
    SIZEOF_ARRAY(NodesTopology),
    NodesTopology,
    SIZEOF_ARRAY(ConnectionsTopology),
    ConnectionsTopology,
    SIZEOF_ARRAY(CategoriesTopology),
    CategoriesTopology
};

// ===========================================================================
// Soporte básico genérico (KSPROPERTY_TYPE_BASICSUPPORT)
// ===========================================================================

// Rellena la respuesta de BASICSUPPORT en sus tres tamaños posibles
// (ULONG de flags, KSPROPERTY_DESCRIPTION, o descripción + miembros).
// `Stepping` != NULL añade un rango escalonado VT_I4 por canal
// (VOXORA_VOLUME_CHANNELS) con KSPROPERTY_MEMBER_FLAG_BASICSUPPORT_MULTICHANNEL:
// así el motor de audio sabe que el nodo de volumen es por canal y cuántos
// canales tiene (con un solo miembro y Flags = 0 lo trataría como mono y
// solo ajustaría el canal 0).
#pragma code_seg("PAGE")
static NTSTATUS
BasicSupport(
    _In_ PPCPROPERTY_REQUEST Request,
    _In_ ULONG AccessFlags,
    _In_ ULONG VarType,         // VARENUM (VT_I4, VT_BOOL...): en km no existe VARTYPE
    _In_opt_ const KSPROPERTY_STEPPING_LONG* Stepping)
{
    PAGED_CODE();

    const ULONG fullSize = sizeof(KSPROPERTY_DESCRIPTION) +
        (Stepping ? sizeof(KSPROPERTY_MEMBERSHEADER) +
                    VOXORA_VOLUME_CHANNELS * sizeof(KSPROPERTY_STEPPING_LONG)
                  : 0);

    if (Request->ValueSize >= fullSize && Stepping != NULL)
    {
        PKSPROPERTY_DESCRIPTION desc = static_cast<PKSPROPERTY_DESCRIPTION>(Request->Value);
        desc->AccessFlags = AccessFlags;
        desc->DescriptionSize = fullSize;
        desc->PropTypeSet.Set = KSPROPTYPESETID_General;
        desc->PropTypeSet.Id = VarType;
        desc->PropTypeSet.Flags = 0;
        desc->MembersListCount = 1;
        desc->Reserved = 0;

        PKSPROPERTY_MEMBERSHEADER members = reinterpret_cast<PKSPROPERTY_MEMBERSHEADER>(desc + 1);
        members->MembersFlags = KSPROPERTY_MEMBER_STEPPEDRANGES;
        members->MembersSize = sizeof(KSPROPERTY_STEPPING_LONG);
        members->MembersCount = VOXORA_VOLUME_CHANNELS;
        members->Flags = KSPROPERTY_MEMBER_FLAG_BASICSUPPORT_MULTICHANNEL;

        PKSPROPERTY_STEPPING_LONG range = reinterpret_cast<PKSPROPERTY_STEPPING_LONG>(members + 1);
        for (ULONG c = 0; c < VOXORA_VOLUME_CHANNELS; c++)
        {
            range[c] = *Stepping;
        }

        Request->ValueSize = fullSize;
        return STATUS_SUCCESS;
    }

    if (Request->ValueSize >= sizeof(KSPROPERTY_DESCRIPTION))
    {
        PKSPROPERTY_DESCRIPTION desc = static_cast<PKSPROPERTY_DESCRIPTION>(Request->Value);
        desc->AccessFlags = AccessFlags;
        desc->DescriptionSize = fullSize;
        desc->PropTypeSet.Set = KSPROPTYPESETID_General;
        desc->PropTypeSet.Id = VarType;
        desc->PropTypeSet.Flags = 0;
        desc->MembersListCount = 0;
        desc->Reserved = 0;
        Request->ValueSize = sizeof(KSPROPERTY_DESCRIPTION);
        return STATUS_SUCCESS;
    }

    if (Request->ValueSize >= sizeof(ULONG))
    {
        *static_cast<PULONG>(Request->Value) = AccessFlags;
        Request->ValueSize = sizeof(ULONG);
        return STATUS_SUCCESS;
    }

    Request->ValueSize = sizeof(ULONG);
    return STATUS_BUFFER_TOO_SMALL;
}

// ===========================================================================
// Fábrica
// ===========================================================================

#pragma code_seg("PAGE")
_IRQL_requires_max_(PASSIVE_LEVEL)
NTSTATUS
CreateMiniportTopologyVoxora(
    _Out_ PUNKNOWN* Unknown,
    _In_opt_ PUNKNOWN UnknownOuter,
    _In_  POOL_FLAGS PoolFlags,
    _In_  BOOLEAN   Capture)
{
    PAGED_CODE();
    ASSERT(Unknown);

    CMiniportTopology* miniport = new(PoolFlags, VOXORA_POOLTAG) CMiniportTopology(UnknownOuter, Capture);
    if (miniport == NULL)
    {
        *Unknown = NULL;
        return STATUS_INSUFFICIENT_RESOURCES;
    }

    miniport->AddRef();
    *Unknown = PUNKNOWN(static_cast<PMINIPORTTOPOLOGY>(miniport));
    return STATUS_SUCCESS;
}

// ===========================================================================
// CMiniportTopology
// ===========================================================================

#pragma code_seg("PAGE")
CMiniportTopology::CMiniportTopology(_In_opt_ PUNKNOWN UnknownOuter, _In_ BOOLEAN Capture)
    : CUnknown(UnknownOuter),
      m_Adapter(NULL),
      m_Port(NULL),
      m_Capture(Capture)
{
    PAGED_CODE();
}

#pragma code_seg("PAGE")
CMiniportTopology::~CMiniportTopology()
{
    PAGED_CODE();
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
CMiniportTopology::NonDelegatingQueryInterface(
    _In_ REFIID Interface,
    _COM_Outptr_ PVOID* Object)
{
    PAGED_CODE();
    ASSERT(Object);

    if (IsEqualGUIDAligned(Interface, IID_IUnknown))
    {
        *Object = PVOID(PUNKNOWN(static_cast<PMINIPORTTOPOLOGY>(this)));
    }
    else if (IsEqualGUIDAligned(Interface, IID_IMiniport))
    {
        *Object = PVOID(static_cast<PMINIPORT>(this));
    }
    else if (IsEqualGUIDAligned(Interface, IID_IMiniportTopology))
    {
        *Object = PVOID(static_cast<PMINIPORTTOPOLOGY>(this));
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
CMiniportTopology::Init(
    _In_ PUNKNOWN       UnknownAdapter,
    _In_ PRESOURCELIST  ResourceList,
    _In_ PPORTTOPOLOGY  Port)
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
    }
    return ntStatus;
}

#pragma code_seg("PAGE")
STDMETHODIMP_(NTSTATUS)
CMiniportTopology::GetDescription(_Out_ PPCFILTER_DESCRIPTOR* OutFilterDescriptor)
{
    PAGED_CODE();
    ASSERT(OutFilterDescriptor);

    *OutFilterDescriptor = m_Capture ? &FilterDescriptorTopologyCapture
                                     : &FilterDescriptorTopologyRender;
    return STATUS_SUCCESS;
}

#pragma code_seg("PAGE")
STDMETHODIMP_(NTSTATUS)
CMiniportTopology::DataRangeIntersection(
    _In_        ULONG        PinId,
    _In_        PKSDATARANGE ClientDataRange,
    _In_        PKSDATARANGE MyDataRange,
    _In_        ULONG        OutputBufferLength,
    _Out_writes_bytes_to_opt_(OutputBufferLength, *ResultantFormatLength)
                PVOID        ResultantFormat,
    _Out_       PULONG       ResultantFormatLength)
{
    PAGED_CODE();
    UNREFERENCED_PARAMETER(PinId);
    UNREFERENCED_PARAMETER(ClientDataRange);
    UNREFERENCED_PARAMETER(MyDataRange);
    UNREFERENCED_PARAMETER(OutputBufferLength);
    UNREFERENCED_PARAMETER(ResultantFormat);
    UNREFERENCED_PARAMETER(ResultantFormatLength);
    // Los pins de topología no negocian formato: intersección por defecto.
    return STATUS_NOT_IMPLEMENTED;
}

// ---------------------------------------------------------------------------
// KSPROPERTY_AUDIO_VOLUMELEVEL
// ---------------------------------------------------------------------------
#pragma code_seg("PAGE")
NTSTATUS
CMiniportTopology::PropertyHandlerVolume(_In_ PPCPROPERTY_REQUEST Request)
{
    PAGED_CODE();

    if (Request->Verb & KSPROPERTY_TYPE_BASICSUPPORT)
    {
        KSPROPERTY_STEPPING_LONG stepping;
        stepping.SteppingDelta = VOXORA_VOLUME_STEP_DB;
        stepping.Reserved = 0;
        stepping.Bounds.SignedMinimum = VOXORA_VOLUME_MIN_DB;
        stepping.Bounds.SignedMaximum = VOXORA_VOLUME_MAX_DB;
        return BasicSupport(Request,
                            KSPROPERTY_TYPE_BASICSUPPORT | KSPROPERTY_TYPE_GET | KSPROPERTY_TYPE_SET,
                            VT_I4, &stepping);
    }

    // KSNODEPROPERTY_AUDIO_CHANNEL: Instance apunta al canal (LONG, -1 = todos).
    if (Request->InstanceSize < sizeof(LONG))
    {
        return STATUS_INVALID_PARAMETER;
    }
    const LONG channel = *static_cast<PLONG>(Request->Instance);
    if (channel != -1 && (channel < 0 || static_cast<ULONG>(channel) >= VOXORA_VOLUME_CHANNELS))
    {
        return STATUS_INVALID_PARAMETER;
    }

    if (Request->ValueSize < sizeof(LONG))
    {
        Request->ValueSize = sizeof(LONG);
        return STATUS_BUFFER_TOO_SMALL;
    }
    PLONG value = static_cast<PLONG>(Request->Value);

    if (Request->Verb & KSPROPERTY_TYPE_GET)
    {
        *value = m_Adapter->GetVolume(m_Capture, (channel == -1) ? 0 : static_cast<ULONG>(channel));
        Request->ValueSize = sizeof(LONG);
        return STATUS_SUCCESS;
    }
    if (Request->Verb & KSPROPERTY_TYPE_SET)
    {
        m_Adapter->SetVolume(m_Capture, static_cast<ULONG>(channel), *value);
        return STATUS_SUCCESS;
    }
    return STATUS_INVALID_DEVICE_REQUEST;
}

// ---------------------------------------------------------------------------
// KSPROPERTY_AUDIO_MUTE
// ---------------------------------------------------------------------------
#pragma code_seg("PAGE")
NTSTATUS
CMiniportTopology::PropertyHandlerMute(_In_ PPCPROPERTY_REQUEST Request)
{
    PAGED_CODE();

    if (Request->Verb & KSPROPERTY_TYPE_BASICSUPPORT)
    {
        return BasicSupport(Request,
                            KSPROPERTY_TYPE_BASICSUPPORT | KSPROPERTY_TYPE_GET | KSPROPERTY_TYPE_SET,
                            VT_BOOL, NULL);
    }

    if (Request->InstanceSize < sizeof(LONG))
    {
        return STATUS_INVALID_PARAMETER;
    }
    const LONG channel = *static_cast<PLONG>(Request->Instance);
    if (channel != -1 && (channel < 0 || static_cast<ULONG>(channel) >= VOXORA_VOLUME_CHANNELS))
    {
        return STATUS_INVALID_PARAMETER;
    }

    if (Request->ValueSize < sizeof(BOOL))
    {
        Request->ValueSize = sizeof(BOOL);
        return STATUS_BUFFER_TOO_SMALL;
    }
    PBOOL value = static_cast<PBOOL>(Request->Value);

    if (Request->Verb & KSPROPERTY_TYPE_GET)
    {
        *value = m_Adapter->GetMute(m_Capture) ? TRUE : FALSE;
        Request->ValueSize = sizeof(BOOL);
        return STATUS_SUCCESS;
    }
    if (Request->Verb & KSPROPERTY_TYPE_SET)
    {
        // El mute es global al endpoint (no por canal).
        m_Adapter->SetMute(m_Capture, (*value) ? TRUE : FALSE);
        return STATUS_SUCCESS;
    }
    return STATUS_INVALID_DEVICE_REQUEST;
}

// ---------------------------------------------------------------------------
// KSPROPERTY_JACK_DESCRIPTION
// ---------------------------------------------------------------------------
#pragma code_seg("PAGE")
NTSTATUS
CMiniportTopology::PropertyHandlerJackDescription(_In_ PPCPROPERTY_REQUEST Request)
{
    PAGED_CODE();

    if (Request->Verb & KSPROPERTY_TYPE_BASICSUPPORT)
    {
        return BasicSupport(Request,
                            KSPROPERTY_TYPE_BASICSUPPORT | KSPROPERTY_TYPE_GET,
                            VT_ILLEGAL, NULL);
    }
    if (!(Request->Verb & KSPROPERTY_TYPE_GET))
    {
        return STATUS_INVALID_DEVICE_REQUEST;
    }

    // Instance apunta al PinId de la KSP_PIN.
    if (Request->InstanceSize < sizeof(ULONG))
    {
        return STATUS_INVALID_PARAMETER;
    }
    const ULONG pinId = *static_cast<PULONG>(Request->Instance);
    const ULONG endpointPin = m_Capture ? VOXORA_TOPO_CAPTURE_PIN_MIC : VOXORA_TOPO_RENDER_PIN_SPEAKER;
    const ULONG jackCount = (pinId == endpointPin) ? 1 : 0;
    if (pinId >= 2)
    {
        return STATUS_INVALID_PARAMETER;
    }

    const ULONG needed = sizeof(KSMULTIPLE_ITEM) + jackCount * sizeof(KSJACK_DESCRIPTION);
    if (Request->ValueSize == 0)
    {
        Request->ValueSize = needed;
        return STATUS_BUFFER_OVERFLOW;
    }
    if (Request->ValueSize < needed)
    {
        Request->ValueSize = needed;
        return STATUS_BUFFER_TOO_SMALL;
    }

    PKSMULTIPLE_ITEM item = static_cast<PKSMULTIPLE_ITEM>(Request->Value);
    item->Size = needed;
    item->Count = jackCount;

    if (jackCount == 1)
    {
        PKSJACK_DESCRIPTION jack = reinterpret_cast<PKSJACK_DESCRIPTION>(item + 1);
        RtlZeroMemory(jack, sizeof(KSJACK_DESCRIPTION));
        jack->ChannelMapping = m_Capture ? KSAUDIO_SPEAKER_MONO : KSAUDIO_SPEAKER_STEREO;
        jack->Color = 0x000000;
        jack->ConnectionType = eConnTypeUnknown;
        jack->GeoLocation = eGeoLocNotApplicable;
        jack->GenLocation = eGenLocInternal;
        jack->PortConnection = ePortConnIntegratedDevice;
        jack->IsConnected = TRUE;   // dispositivo virtual: siempre presente
    }

    Request->ValueSize = needed;
    return STATUS_SUCCESS;
}

// ---------------------------------------------------------------------------
// KSPROPERTY_JACK_DESCRIPTION2
// ---------------------------------------------------------------------------
#pragma code_seg("PAGE")
NTSTATUS
CMiniportTopology::PropertyHandlerJackDescription2(_In_ PPCPROPERTY_REQUEST Request)
{
    PAGED_CODE();

    if (Request->Verb & KSPROPERTY_TYPE_BASICSUPPORT)
    {
        return BasicSupport(Request,
                            KSPROPERTY_TYPE_BASICSUPPORT | KSPROPERTY_TYPE_GET,
                            VT_ILLEGAL, NULL);
    }
    if (!(Request->Verb & KSPROPERTY_TYPE_GET))
    {
        return STATUS_INVALID_DEVICE_REQUEST;
    }

    if (Request->InstanceSize < sizeof(ULONG))
    {
        return STATUS_INVALID_PARAMETER;
    }
    const ULONG pinId = *static_cast<PULONG>(Request->Instance);
    const ULONG endpointPin = m_Capture ? VOXORA_TOPO_CAPTURE_PIN_MIC : VOXORA_TOPO_RENDER_PIN_SPEAKER;
    const ULONG jackCount = (pinId == endpointPin) ? 1 : 0;
    if (pinId >= 2)
    {
        return STATUS_INVALID_PARAMETER;
    }

    const ULONG needed = sizeof(KSMULTIPLE_ITEM) + jackCount * sizeof(KSJACK_DESCRIPTION2);
    if (Request->ValueSize == 0)
    {
        Request->ValueSize = needed;
        return STATUS_BUFFER_OVERFLOW;
    }
    if (Request->ValueSize < needed)
    {
        Request->ValueSize = needed;
        return STATUS_BUFFER_TOO_SMALL;
    }

    PKSMULTIPLE_ITEM item = static_cast<PKSMULTIPLE_ITEM>(Request->Value);
    item->Size = needed;
    item->Count = jackCount;

    if (jackCount == 1)
    {
        PKSJACK_DESCRIPTION2 jack = reinterpret_cast<PKSJACK_DESCRIPTION2>(item + 1);
        jack->DeviceStateInfo = 0;
        jack->JackCapabilities = 0;   // sin detección de presencia ni cambio dinámico de formato
    }

    Request->ValueSize = needed;
    return STATUS_SUCCESS;
}

// ---------------------------------------------------------------------------
// Trampolines
// ---------------------------------------------------------------------------

#pragma code_seg("PAGE")
static NTSTATUS
PropertyHandler_TopoNode(_In_ PPCPROPERTY_REQUEST PropertyRequest)
{
    PAGED_CODE();
    ASSERT(PropertyRequest);

    CMiniportTopology* miniport = static_cast<CMiniportTopology*>(
        static_cast<PMINIPORTTOPOLOGY>(PropertyRequest->MajorTarget));

    if (!IsEqualGUIDAligned(*PropertyRequest->PropertyItem->Set, KSPROPSETID_Audio))
    {
        return STATUS_INVALID_DEVICE_REQUEST;
    }

    switch (PropertyRequest->Node)
    {
    case VOXORA_TOPO_NODE_VOLUME:
        if (PropertyRequest->PropertyItem->Id == KSPROPERTY_AUDIO_VOLUMELEVEL)
        {
            return miniport->PropertyHandlerVolume(PropertyRequest);
        }
        break;
    case VOXORA_TOPO_NODE_MUTE:
        if (PropertyRequest->PropertyItem->Id == KSPROPERTY_AUDIO_MUTE)
        {
            return miniport->PropertyHandlerMute(PropertyRequest);
        }
        break;
    default:
        break;
    }
    return STATUS_INVALID_DEVICE_REQUEST;
}

#pragma code_seg("PAGE")
static NTSTATUS
PropertyHandler_TopoFilter(_In_ PPCPROPERTY_REQUEST PropertyRequest)
{
    PAGED_CODE();
    ASSERT(PropertyRequest);

    CMiniportTopology* miniport = static_cast<CMiniportTopology*>(
        static_cast<PMINIPORTTOPOLOGY>(PropertyRequest->MajorTarget));

    if (!IsEqualGUIDAligned(*PropertyRequest->PropertyItem->Set, KSPROPSETID_Jack))
    {
        return STATUS_INVALID_DEVICE_REQUEST;
    }

    switch (PropertyRequest->PropertyItem->Id)
    {
    case KSPROPERTY_JACK_DESCRIPTION:
        return miniport->PropertyHandlerJackDescription(PropertyRequest);
    case KSPROPERTY_JACK_DESCRIPTION2:
        return miniport->PropertyHandlerJackDescription2(PropertyRequest);
    default:
        return STATUS_INVALID_DEVICE_REQUEST;
    }
}
