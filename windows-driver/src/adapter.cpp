// adapter.cpp — Punto de entrada del driver VOXORA Meet (voxorameet.sys).
//
// Adaptador PortCls con cuatro subdispositivos:
//   WaveSpeaker / TopologySpeaker         -> endpoint de render "VOXORA Meet Speaker"
//   WaveMicrophone / TopologyMicrophone   -> endpoint de captura "VOXORA Meet Microphone"
// Un objeto común (CVoxoraAdapter) posee el buffer de loopback que conecta
// ambos y el estado de volumen/mute de la topología.
//
// Estructura calcada de sysvad/simpleaudiosample: DriverEntry ->
// PcInitializeAdapterDriver; AddDevice -> PcAddAdapterDevice; StartDevice ->
// InstallSubdevices + PcRegisterPhysicalConnection.

// <initguid.h> ANTES de common.h: este es el único TU que instancia los GUIDs
// de guids.h (DEFINE_GUID). El resto del proyecto solo los declara.
#include <initguid.h>
#include "common.h"
#include "loopback.h"

// ---------------------------------------------------------------------------
// Extensión de dispositivo propia. PortCls usa los primeros
// PORT_CLASS_DEVICE_EXTENSION_SIZE bytes; la nuestra va a continuación.
// ---------------------------------------------------------------------------
typedef struct _VOXORA_DEVICE_EXTENSION
{
    PVOXORAADAPTER Adapter;     // referencia fuerte, se libera en REMOVE_DEVICE
} VOXORA_DEVICE_EXTENSION, *PVOXORA_DEVICE_EXTENSION;

__forceinline PVOXORA_DEVICE_EXTENSION
GetVoxoraExtension(_In_ PDEVICE_OBJECT DeviceObject)
{
    return reinterpret_cast<PVOXORA_DEVICE_EXTENSION>(
        static_cast<PBYTE>(DeviceObject->DeviceExtension) + PORT_CLASS_DEVICE_EXTENSION_SIZE);
}

// ---------------------------------------------------------------------------
// Prototipos
// ---------------------------------------------------------------------------
extern "C" DRIVER_INITIALIZE DriverEntry;
DRIVER_UNLOAD       DriverUnload;
DRIVER_ADD_DEVICE   AddDevice;
_Dispatch_type_(IRP_MJ_PNP)
DRIVER_DISPATCH     PnpHandler;

NTSTATUS
StartDevice(
    _In_ PDEVICE_OBJECT DeviceObject,
    _In_ PIRP           Irp,
    _In_ PRESOURCELIST  ResourceList
);

// Rutina de descarga que PcInitializeAdapterDriver instala en el
// DRIVER_OBJECT. DriverUnload la encadena (patrón sysvad): portcls.h no
// exporta ningún "PcUnload".
static PDRIVER_UNLOAD g_PortClsDriverUnload = NULL;

// ===========================================================================
// operator new / delete sobre ExAllocatePool2 (ver common.h)
// ===========================================================================
#pragma code_seg()

_Use_decl_annotations_
PVOID __cdecl
operator new(size_t Size, POOL_FLAGS PoolFlags, ULONG Tag)
{
    // ExAllocatePool2 devuelve la memoria a cero salvo POOL_FLAG_UNINITIALIZED.
    return ExAllocatePool2(PoolFlags, Size, Tag);
}

// Pareja del operator new con placement: solo se usaría si el constructor
// lanzara una excepción (no hay excepciones en kernel), pero evita C4291.
_Use_decl_annotations_
void __cdecl
operator delete(PVOID Buffer, POOL_FLAGS PoolFlags, ULONG Tag)
{
    UNREFERENCED_PARAMETER(PoolFlags);
    if (Buffer != NULL)
    {
        ExFreePoolWithTag(Buffer, Tag);
    }
}

// operator delete(void*) "plano" NO se define aquí: ya lo exporta
// stdunk.lib (stdunk.obj, junto a CUnknown) sobre ExFreePool, válido para
// memoria de ExAllocatePool2. Redefinirlo da LNK2005.

// Sized delete: el compilador ya lo declara implícitamente (C++14), así que
// _Use_decl_annotations_ no encuentra "declaración previa" (C28213): se
// repiten las anotaciones de common.h.
void __cdecl
operator delete(_Pre_maybenull_ __drv_freesMem(Mem) PVOID Buffer, _In_ size_t Size)
{
    UNREFERENCED_PARAMETER(Size);
    if (Buffer != NULL)
    {
        ExFreePool(Buffer);
    }
}

_Use_decl_annotations_
void __cdecl
operator delete[](PVOID Buffer)
{
    if (Buffer != NULL)
    {
        ExFreePool(Buffer);
    }
}

void __cdecl
operator delete[](_Pre_maybenull_ __drv_freesMem(Mem) PVOID Buffer, _In_ size_t Size)
{
    UNREFERENCED_PARAMETER(Size);
    if (Buffer != NULL)
    {
        ExFreePool(Buffer);
    }
}

// ===========================================================================
// CVoxoraAdapter — implementación de IVoxoraAdapter
// ===========================================================================
class CVoxoraAdapter
    : public IVoxoraAdapter,
      public CUnknown
{
public:
    DECLARE_STD_UNKNOWN();
    DEFINE_STD_CONSTRUCTOR(CVoxoraAdapter);
    ~CVoxoraAdapter();

    // IVoxoraAdapter
    STDMETHODIMP_(NTSTATUS) Init(_In_ PDEVICE_OBJECT DeviceObject);
    STDMETHODIMP_(CLoopbackBuffer*) GetLoopback();
    STDMETHODIMP_(LONG) GetVolume(_In_ BOOLEAN Capture, _In_ ULONG Channel);
    STDMETHODIMP_(void) SetVolume(_In_ BOOLEAN Capture, _In_ ULONG Channel, _In_ LONG LevelDb);
    STDMETHODIMP_(BOOLEAN) GetMute(_In_ BOOLEAN Capture);
    STDMETHODIMP_(void) SetMute(_In_ BOOLEAN Capture, _In_ BOOLEAN Mute);
    STDMETHODIMP_(float) GetLinearGain(_In_ BOOLEAN Capture);

private:
    void RecomputeGain(_In_ ULONG Direction);   // con m_Lock tomado

    PDEVICE_OBJECT      m_DeviceObject;
    CLoopbackBuffer*    m_Loopback;
    KSPIN_LOCK          m_Lock;
    LONG                m_Volume[2][VOXORA_VOLUME_CHANNELS];  // [render|capture][canal]
    BOOLEAN             m_Mute[2];
    float               m_Gain[2];
};

// ---------------------------------------------------------------------------
// Fábrica
// ---------------------------------------------------------------------------
#pragma code_seg("PAGE")
_IRQL_requires_max_(PASSIVE_LEVEL)
NTSTATUS
CreateVoxoraAdapter(
    _Out_ PUNKNOWN* Unknown,
    _In_opt_ PUNKNOWN UnknownOuter,
    _In_  POOL_FLAGS PoolFlags)
{
    PAGED_CODE();
    ASSERT(Unknown);

    // El objeto se toca desde DPC (GetLinearGain): debe ser no paginado (NX).
    ASSERT(PoolFlags == POOL_FLAG_NON_PAGED);

    CVoxoraAdapter* adapter = new(PoolFlags, VOXORA_POOLTAG) CVoxoraAdapter(UnknownOuter);
    if (adapter == NULL)
    {
        *Unknown = NULL;
        return STATUS_INSUFFICIENT_RESOURCES;
    }

    adapter->AddRef();
    *Unknown = PUNKNOWN(static_cast<PVOXORAADAPTER>(adapter));
    return STATUS_SUCCESS;
}

#pragma code_seg("PAGE")
CVoxoraAdapter::~CVoxoraAdapter()
{
    PAGED_CODE();
    if (m_Loopback != NULL)
    {
        m_Loopback->Destroy();
        m_Loopback = NULL;
    }
}

#pragma code_seg("PAGE")
STDMETHODIMP_(NTSTATUS)
CVoxoraAdapter::NonDelegatingQueryInterface(
    _In_ REFIID Interface,
    _COM_Outptr_ PVOID* Object)
{
    PAGED_CODE();
    ASSERT(Object);

    if (IsEqualGUIDAligned(Interface, IID_IUnknown))
    {
        *Object = PVOID(PUNKNOWN(static_cast<PVOXORAADAPTER>(this)));
    }
    else if (IsEqualGUIDAligned(Interface, IID_IVoxoraAdapter))
    {
        *Object = PVOID(static_cast<PVOXORAADAPTER>(this));
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
CVoxoraAdapter::Init(_In_ PDEVICE_OBJECT DeviceObject)
{
    PAGED_CODE();
    ASSERT(DeviceObject);

    m_DeviceObject = DeviceObject;
    KeInitializeSpinLock(&m_Lock);

    for (ULONG d = 0; d < 2; d++)
    {
        for (ULONG c = 0; c < VOXORA_VOLUME_CHANNELS; c++)
        {
            m_Volume[d][c] = VOXORA_VOLUME_MAX_DB;
        }
        m_Mute[d] = FALSE;
        m_Gain[d] = 1.0f;
    }

    m_Loopback = CLoopbackBuffer::Create(VOXORA_LOOPBACK_CAPACITY_FRAMES,
                                         VOXORA_LOOPBACK_MAX_LATENCY_FRAMES);
    if (m_Loopback == NULL)
    {
        return STATUS_INSUFFICIENT_RESOURCES;
    }

    VOXORA_TRACE("adaptador inicializado (loopback %u frames)\n", VOXORA_LOOPBACK_CAPACITY_FRAMES);
    return STATUS_SUCCESS;
}

// Los métodos siguientes pueden llamarse a DISPATCH_LEVEL (DPC de streams):
// sección de código por defecto (no paginada).
#pragma code_seg()

STDMETHODIMP_(CLoopbackBuffer*)
CVoxoraAdapter::GetLoopback()
{
    return m_Loopback;
}

void
CVoxoraAdapter::RecomputeGain(_In_ ULONG Direction)
{
    if (m_Mute[Direction])
    {
        m_Gain[Direction] = 0.0f;
        return;
    }
    // Windows fija todos los canales al mismo nivel; usamos la media en dB.
    LONGLONG sum = 0;
    for (ULONG c = 0; c < VOXORA_VOLUME_CHANNELS; c++)
    {
        sum += m_Volume[Direction][c];
    }
    m_Gain[Direction] = VoxoraDbToLinear(static_cast<LONG>(sum / VOXORA_VOLUME_CHANNELS));
}

STDMETHODIMP_(LONG)
CVoxoraAdapter::GetVolume(_In_ BOOLEAN Capture, _In_ ULONG Channel)
{
    if (Channel >= VOXORA_VOLUME_CHANNELS)
    {
        Channel = 0;
    }
    KIRQL oldIrql;
    KeAcquireSpinLock(&m_Lock, &oldIrql);
    const LONG level = m_Volume[Capture ? 1 : 0][Channel];
    KeReleaseSpinLock(&m_Lock, oldIrql);
    return level;
}

STDMETHODIMP_(void)
CVoxoraAdapter::SetVolume(_In_ BOOLEAN Capture, _In_ ULONG Channel, _In_ LONG LevelDb)
{
    if (LevelDb > VOXORA_VOLUME_MAX_DB) LevelDb = VOXORA_VOLUME_MAX_DB;
    if (LevelDb < VOXORA_VOLUME_MIN_DB) LevelDb = VOXORA_VOLUME_MIN_DB;

    const ULONG dir = Capture ? 1 : 0;
    KIRQL oldIrql;
    KeAcquireSpinLock(&m_Lock, &oldIrql);
    if (Channel == ULONG(-1))
    {
        for (ULONG c = 0; c < VOXORA_VOLUME_CHANNELS; c++)
        {
            m_Volume[dir][c] = LevelDb;
        }
    }
    else if (Channel < VOXORA_VOLUME_CHANNELS)
    {
        m_Volume[dir][Channel] = LevelDb;
    }
    RecomputeGain(dir);
    KeReleaseSpinLock(&m_Lock, oldIrql);
}

STDMETHODIMP_(BOOLEAN)
CVoxoraAdapter::GetMute(_In_ BOOLEAN Capture)
{
    KIRQL oldIrql;
    KeAcquireSpinLock(&m_Lock, &oldIrql);
    const BOOLEAN mute = m_Mute[Capture ? 1 : 0];
    KeReleaseSpinLock(&m_Lock, oldIrql);
    return mute;
}

STDMETHODIMP_(void)
CVoxoraAdapter::SetMute(_In_ BOOLEAN Capture, _In_ BOOLEAN Mute)
{
    const ULONG dir = Capture ? 1 : 0;
    KIRQL oldIrql;
    KeAcquireSpinLock(&m_Lock, &oldIrql);
    m_Mute[dir] = Mute ? TRUE : FALSE;
    RecomputeGain(dir);
    KeReleaseSpinLock(&m_Lock, oldIrql);
}

STDMETHODIMP_(float)
CVoxoraAdapter::GetLinearGain(_In_ BOOLEAN Capture)
{
    // Lectura de un float alineado: atómica en x64. Se actualiza bajo m_Lock
    // pero leerlo sin el lock evita contención en la DPC de audio.
    return m_Gain[Capture ? 1 : 0];
}

// ---------------------------------------------------------------------------
// VoxoraDbToLinear — 10^(dB/20) = 2^(dB/6.0206) sin CRT.
// ---------------------------------------------------------------------------
float
VoxoraDbToLinear(_In_ LONG LevelDb)
{
    if (LevelDb <= VOXORA_VOLUME_MIN_DB)
    {
        return 0.0f;
    }
    if (LevelDb >= VOXORA_VOLUME_MAX_DB)
    {
        return 1.0f;
    }

    const float db = static_cast<float>(LevelDb) / 65536.0f;   // negativo
    const float x = db / 6.0205999f;                            // exponente base 2

    // floor(x) para x negativo.
    int n = static_cast<int>(x);
    if (static_cast<float>(n) > x)
    {
        n--;
    }
    const float f = x - static_cast<float>(n);                  // [0, 1)

    // 2^f por polinomio (Taylor truncado en ln 2), error < 0.1 %.
    const float p = 1.0f + f * (0.6931472f + f * (0.2402265f + f * (0.0555041f + f * 0.0096181f)));

    // 2^n con n en [-10, 0].
    float scale = 1.0f;
    for (int i = 0; i < -n; i++)
    {
        scale *= 0.5f;
    }
    return p * scale;
}

// ===========================================================================
// Instalación de subdispositivos
// ===========================================================================

// Crea un puerto PortCls + su miniport, los inicializa y registra el
// subdispositivo con el nombre indicado (debe coincidir con el INF).
#pragma code_seg("PAGE")
static NTSTATUS
InstallSubdevice(
    _In_  PDEVICE_OBJECT  DeviceObject,
    _In_  PIRP            Irp,
    _In_  PWSTR           Name,
    _In_  REFGUID         PortClassId,
    _In_  BOOLEAN         IsWave,
    _In_  BOOLEAN         Capture,
    _In_  PUNKNOWN        UnknownAdapter,
    _In_  PRESOURCELIST   ResourceList,
    _Out_ PUNKNOWN*       OutPortUnknown)
{
    PAGED_CODE();

    NTSTATUS ntStatus;
    PPORT    port = NULL;
    PUNKNOWN miniport = NULL;

    *OutPortUnknown = NULL;

    ntStatus = PcNewPort(&port, PortClassId);
    if (NT_SUCCESS(ntStatus))
    {
        ntStatus = IsWave
            ? CreateMiniportWaveRTVoxora(&miniport, NULL, POOL_FLAG_NON_PAGED, Capture)
            : CreateMiniportTopologyVoxora(&miniport, NULL, POOL_FLAG_NON_PAGED, Capture);
    }
    if (NT_SUCCESS(ntStatus))
    {
        ntStatus = port->Init(DeviceObject, Irp, miniport, UnknownAdapter, ResourceList);
    }
    if (NT_SUCCESS(ntStatus))
    {
        ntStatus = PcRegisterSubdevice(DeviceObject, Name, port);
    }
    if (NT_SUCCESS(ntStatus))
    {
        ntStatus = port->QueryInterface(IID_IUnknown, reinterpret_cast<PVOID*>(OutPortUnknown));
    }

    if (miniport != NULL)
    {
        miniport->Release();    // el puerto conserva su propia referencia
    }
    if (port != NULL)
    {
        port->Release();        // PortCls conserva la del subdispositivo
    }

    if (!NT_SUCCESS(ntStatus))
    {
        VOXORA_TRACE("InstallSubdevice(%ws) fallo 0x%08X\n", Name, ntStatus);
    }
    return ntStatus;
}

#pragma code_seg("PAGE")
static NTSTATUS
InstallSubdevices(
    _In_ PDEVICE_OBJECT DeviceObject,
    _In_ PIRP           Irp,
    _In_ PUNKNOWN       UnknownAdapter,
    _In_ PRESOURCELIST  ResourceList)
{
    PAGED_CODE();

    NTSTATUS ntStatus;
    PUNKNOWN waveSpeaker = NULL;
    PUNKNOWN topoSpeaker = NULL;
    PUNKNOWN waveMic = NULL;
    PUNKNOWN topoMic = NULL;

    // --- Render: "VOXORA Meet Speaker" ---
    ntStatus = InstallSubdevice(DeviceObject, Irp, VOXORA_SUBDEVICE_TOPO_SPEAKER,
                                CLSID_PortTopology, FALSE, FALSE,
                                UnknownAdapter, ResourceList, &topoSpeaker);
    if (NT_SUCCESS(ntStatus))
    {
        ntStatus = InstallSubdevice(DeviceObject, Irp, VOXORA_SUBDEVICE_WAVE_SPEAKER,
                                    CLSID_PortWaveRT, TRUE, FALSE,
                                    UnknownAdapter, ResourceList, &waveSpeaker);
    }
    if (NT_SUCCESS(ntStatus))
    {
        // Wave (pin puente, sale) -> Topología (pin puente, entra)
        ntStatus = PcRegisterPhysicalConnection(DeviceObject,
                                                waveSpeaker, VOXORA_WAVE_RENDER_PIN_BRIDGE,
                                                topoSpeaker, VOXORA_TOPO_RENDER_PIN_BRIDGE);
    }

    // --- Capture: "VOXORA Meet Microphone" ---
    if (NT_SUCCESS(ntStatus))
    {
        ntStatus = InstallSubdevice(DeviceObject, Irp, VOXORA_SUBDEVICE_TOPO_MICROPHONE,
                                    CLSID_PortTopology, FALSE, TRUE,
                                    UnknownAdapter, ResourceList, &topoMic);
    }
    if (NT_SUCCESS(ntStatus))
    {
        ntStatus = InstallSubdevice(DeviceObject, Irp, VOXORA_SUBDEVICE_WAVE_MICROPHONE,
                                    CLSID_PortWaveRT, TRUE, TRUE,
                                    UnknownAdapter, ResourceList, &waveMic);
    }
    if (NT_SUCCESS(ntStatus))
    {
        // Topología (pin puente, sale) -> Wave (pin puente, entra)
        ntStatus = PcRegisterPhysicalConnection(DeviceObject,
                                                topoMic, VOXORA_TOPO_CAPTURE_PIN_BRIDGE,
                                                waveMic, VOXORA_WAVE_CAPTURE_PIN_BRIDGE);
    }

    if (waveSpeaker) waveSpeaker->Release();
    if (topoSpeaker) topoSpeaker->Release();
    if (waveMic)     waveMic->Release();
    if (topoMic)     topoMic->Release();

    return ntStatus;
}

// ===========================================================================
// Callbacks PnP / PortCls
// ===========================================================================

// StartDevice — PortCls lo invoca en IRP_MN_START_DEVICE. Dispositivo
// root-enumerado: ResourceList viene vacío (sin IRQ/puertos), y así debe ser.
#pragma code_seg("PAGE")
NTSTATUS
StartDevice(
    _In_ PDEVICE_OBJECT DeviceObject,
    _In_ PIRP           Irp,
    _In_ PRESOURCELIST  ResourceList)
{
    PAGED_CODE();
    ASSERT(DeviceObject);
    ASSERT(Irp);

    NTSTATUS        ntStatus;
    PUNKNOWN        unknownAdapter = NULL;
    PVOXORAADAPTER  adapter = NULL;

    ntStatus = CreateVoxoraAdapter(&unknownAdapter, NULL, POOL_FLAG_NON_PAGED);
    if (NT_SUCCESS(ntStatus))
    {
        ntStatus = unknownAdapter->QueryInterface(IID_IVoxoraAdapter, reinterpret_cast<PVOID*>(&adapter));
    }
    if (NT_SUCCESS(ntStatus))
    {
        ntStatus = adapter->Init(DeviceObject);
    }
    if (NT_SUCCESS(ntStatus))
    {
        ntStatus = InstallSubdevices(DeviceObject, Irp, unknownAdapter, ResourceList);
    }

    if (NT_SUCCESS(ntStatus))
    {
        // La extensión conserva la referencia hasta IRP_MN_REMOVE_DEVICE.
        GetVoxoraExtension(DeviceObject)->Adapter = adapter;
        adapter = NULL;
    }

    if (adapter != NULL)
    {
        adapter->Release();
    }
    if (unknownAdapter != NULL)
    {
        unknownAdapter->Release();
    }

    VOXORA_TRACE("StartDevice -> 0x%08X\n", ntStatus);
    return ntStatus;
}

// AddDevice — crea el FDO PortCls con nuestra extensión extra.
#pragma code_seg("PAGE")
NTSTATUS
AddDevice(
    _In_ PDRIVER_OBJECT DriverObject,
    _In_ PDEVICE_OBJECT PhysicalDeviceObject)
{
    PAGED_CODE();

    return PcAddAdapterDevice(DriverObject,
                              PhysicalDeviceObject,
                              StartDevice,
                              VOXORA_MAX_MINIPORTS,
                              PORT_CLASS_DEVICE_EXTENSION_SIZE + sizeof(VOXORA_DEVICE_EXTENSION));
}

// PnpHandler — intercepta IRP_MN_REMOVE_DEVICE para soltar el objeto común
// antes de que PortCls desmonte el resto; todo lo demás va a PcDispatchIrp.
#pragma code_seg("PAGE")
NTSTATUS
PnpHandler(
    _In_ PDEVICE_OBJECT DeviceObject,
    _Inout_ PIRP        Irp)
{
    PAGED_CODE();

    PIO_STACK_LOCATION stack = IoGetCurrentIrpStackLocation(Irp);
    if (stack->MajorFunction == IRP_MJ_PNP && stack->MinorFunction == IRP_MN_REMOVE_DEVICE)
    {
        PVOXORA_DEVICE_EXTENSION ext = GetVoxoraExtension(DeviceObject);
        if (ext->Adapter != NULL)
        {
            ext->Adapter->Release();
            ext->Adapter = NULL;
        }
    }

    return PcDispatchIrp(DeviceObject, Irp);
}

#pragma code_seg("PAGE")
void
DriverUnload(_In_ PDRIVER_OBJECT DriverObject)
{
    PAGED_CODE();
    VOXORA_TRACE("DriverUnload\n");
    if (g_PortClsDriverUnload != NULL)
    {
        g_PortClsDriverUnload(DriverObject);
    }
}

// DriverEntry — sección INIT (se descarta tras la carga).
#pragma code_seg("INIT")
extern "C" NTSTATUS
DriverEntry(
    _In_ PDRIVER_OBJECT  DriverObject,
    _In_ PUNICODE_STRING RegistryPathName)
{
    PAGED_CODE();

    VOXORA_TRACE("DriverEntry\n");

    NTSTATUS ntStatus = PcInitializeAdapterDriver(DriverObject, RegistryPathName, AddDevice);
    if (NT_SUCCESS(ntStatus))
    {
        // PortCls ya instaló sus dispatch y su unload: interceptamos PnP
        // (liberar el objeto común en REMOVE_DEVICE) y encadenamos el unload.
        g_PortClsDriverUnload = DriverObject->DriverUnload;
        DriverObject->MajorFunction[IRP_MJ_PNP] = PnpHandler;
        DriverObject->DriverUnload = DriverUnload;
    }
    return ntStatus;
}
#pragma code_seg()
