// common.h — Definiciones compartidas por todo el driver VOXORA Meet.
//
// Driver PortCls/WaveRT (WDM puro, x64). Referencia de estilo: samples
// oficiales `sysvad` y `simpleaudiosample` del WDK. Comentarios en español.
#pragma once

// stdunk.h trae operator new/delete *inline* sobre ExAllocatePoolWithTag
// (obsoleta desde Windows 10 2004, y "will be removed soon" según el propio
// header). Como en el sysvad actual, se desactivan con _NEW_DELETE_OPERATORS_
// y se implementan (no inline, C4595) sobre ExAllocatePool2 en adapter.cpp.
#define _NEW_DELETE_OPERATORS_

// Silenciar avisos ruidosos de los headers del WDK con /W4.
#pragma warning(push)
#pragma warning(disable : 4201) // nameless struct/union
#pragma warning(disable : 4214) // bit field types other than int
#include <portcls.h>
#include <stdunk.h>
#include <ksdebug.h>
#pragma warning(pop)

// ---------------------------------------------------------------------------
// Asignación de objetos C++ en kernel (adapter.cpp). ExAllocatePool2 devuelve
// memoria a cero, igual que el operator new histórico de stdunk.h.
// Uso: new (POOL_FLAG_NON_PAGED, VOXORA_POOLTAG) CClase(...)
// ---------------------------------------------------------------------------
_When_(return != NULL, __drv_allocatesMem(Mem))
_Must_inspect_result_
PVOID __cdecl operator new(_In_ size_t Size, _In_ POOL_FLAGS PoolFlags, _In_ ULONG Tag);
void __cdecl operator delete(_Pre_maybenull_ __drv_freesMem(Mem) PVOID Buffer, _In_ POOL_FLAGS PoolFlags, _In_ ULONG Tag);
// operator delete(PVOID) lo aporta stdunk.lib (ExFreePool).
void __cdecl operator delete(_Pre_maybenull_ __drv_freesMem(Mem) PVOID Buffer, _In_ size_t Size);
void __cdecl operator delete[](_Pre_maybenull_ __drv_freesMem(Mem) PVOID Buffer);
void __cdecl operator delete[](_Pre_maybenull_ __drv_freesMem(Mem) PVOID Buffer, _In_ size_t Size);

#include "guids.h"

// Code Analysis C28110 ("Drivers must protect floating point hardware
// state"): la regla es genérica x86/x64. Este driver es SOLO x64, donde el
// compilador usa SSE (nunca x87/MMX) y el kernel preserva los XMM volátiles
// en interrupciones y cambios de contexto, así que no hace falta
// KeSaveFloatingPointState (ver "Using Floating Point in a WDM Driver"). Si
// algún día se compila para x86 hay que envolver el código float y quitar
// esta supresión.
#if defined(_M_AMD64) || defined(_M_X64)
#pragma warning(disable : 28110)
#else
#error "voxorameet.sys solo soporta x64 (uso de float sin KeSaveFloatingPointState)"
#endif

// ---------------------------------------------------------------------------
// Constantes generales
// ---------------------------------------------------------------------------

// Pool tag: se lee como 'MVox' en herramientas (poolmon, !poolused).
#define VOXORA_POOLTAG          'xoVM'

// Número máximo de subdispositivos registrados por el adaptador
// (WaveSpeaker, TopologySpeaker, WaveMicrophone, TopologyMicrophone).
#define VOXORA_MAX_MINIPORTS    4

// Nombres de subdispositivo. DEBEN coincidir con las cadenas de referencia
// (%KSNAME_*%) usadas por AddInterface en voxorameet.inf.
#define VOXORA_SUBDEVICE_WAVE_SPEAKER       L"WaveSpeaker"
#define VOXORA_SUBDEVICE_TOPO_SPEAKER       L"TopologySpeaker"
#define VOXORA_SUBDEVICE_WAVE_MICROPHONE    L"WaveMicrophone"
#define VOXORA_SUBDEVICE_TOPO_MICROPHONE    L"TopologyMicrophone"

// Formato soportado por los pins de streaming.
#define VOXORA_MIN_SAMPLE_RATE      16000
#define VOXORA_MAX_SAMPLE_RATE      48000
#define VOXORA_NATIVE_SAMPLE_RATE   48000   // frecuencia interna del cable
#define VOXORA_MIN_CHANNELS         1
#define VOXORA_MAX_CHANNELS         2
#define VOXORA_PCM_BITS             16      // PCM entero: s16le
#define VOXORA_FLOAT_BITS           32      // IEEE float32

// Periodo del timer DPC que avanza la posición virtual (ms).
#define VOXORA_TIMER_PERIOD_MS      10

// Resolución de timer del sistema solicitada mientras hay streams en RUN
// (unidades de 100 ns). 10 ms para que KeSetTimerEx no dependa del tick de
// 15.6 ms por defecto.
#define VOXORA_TIMER_RESOLUTION_100NS   100000

// Tamaño máximo de buffer WaveRT que aceptamos por stream (bytes). El motor
// de audio de Windows suele pedir 10–30 ms; 1 MiB deja margen holgado.
#define VOXORA_MAX_DMA_BUFFER_BYTES     (1024 * 1024)

// Buffer circular de loopback: 250 ms a 48 kHz estéreo float32, y latencia
// objetivo máxima render→capture de 100 ms (por encima se descarta lo viejo).
#define VOXORA_LOOPBACK_CAPACITY_FRAMES     (VOXORA_NATIVE_SAMPLE_RATE / 4)
#define VOXORA_LOOPBACK_MAX_LATENCY_FRAMES  (VOXORA_NATIVE_SAMPLE_RATE / 10)

// Volumen (unidades KS: 1/65536 dB, LONG 16.16).
#define VOXORA_VOLUME_MAX_DB        (0L)
#define VOXORA_VOLUME_MIN_DB        (-60L * 0x10000)   // -60 dB
#define VOXORA_VOLUME_STEP_DB       (0x8000)           // 0.5 dB
#define VOXORA_VOLUME_CHANNELS      VOXORA_MAX_CHANNELS

// Índices de nodos de la topología.
#define VOXORA_TOPO_NODE_VOLUME     0
#define VOXORA_TOPO_NODE_MUTE       1

// Índices de pins del filtro WAVE. Render: pin 0 = sink del host (entra),
// pin 1 = puente hacia topología (sale). Capture: pin 0 = puente desde
// topología (entra), pin 1 = fuente para el host (sale).
#define VOXORA_WAVE_RENDER_PIN_HOST     0
#define VOXORA_WAVE_RENDER_PIN_BRIDGE   1
#define VOXORA_WAVE_CAPTURE_PIN_BRIDGE  0
#define VOXORA_WAVE_CAPTURE_PIN_HOST    1

// Índices de pins del filtro de TOPOLOGÍA. Render: pin 0 = puente desde wave
// (entra), pin 1 = altavoz (sale). Capture: pin 0 = micrófono (entra),
// pin 1 = puente hacia wave (sale).
#define VOXORA_TOPO_RENDER_PIN_BRIDGE   0
#define VOXORA_TOPO_RENDER_PIN_SPEAKER  1
#define VOXORA_TOPO_CAPTURE_PIN_MIC     0
#define VOXORA_TOPO_CAPTURE_PIN_BRIDGE  1

// ---------------------------------------------------------------------------
// Descripción compacta de un formato PCM negociado (se deriva del
// KSDATAFORMAT_WAVEFORMATEXTENSIBLE en NewStream).
// ---------------------------------------------------------------------------
typedef struct _VOXORA_PCM_FORMAT {
    ULONG   SampleRate;     // 16000..48000
    USHORT  Channels;       // 1..2
    USHORT  BitsPerSample;  // 16 (PCM) o 32 (float)
    USHORT  BlockAlign;     // Channels * BitsPerSample / 8
    BOOLEAN IsFloat;        // TRUE = IEEE float32, FALSE = PCM s16le
} VOXORA_PCM_FORMAT, *PVOXORA_PCM_FORMAT;

class CLoopbackBuffer; // loopback.h

// ---------------------------------------------------------------------------
// IVoxoraAdapter — objeto común del adaptador. Lo crea StartDevice y se pasa
// como UnknownAdapter a cada IPort::Init; los miniports lo consultan por
// QueryInterface(IID_IVoxoraAdapter).
// ---------------------------------------------------------------------------
DECLARE_INTERFACE_(IVoxoraAdapter, IUnknown)
{
    DEFINE_ABSTRACT_UNKNOWN()

    // Inicialización post-construcción (reserva el buffer de loopback).
    STDMETHOD_(NTSTATUS, Init)(THIS_ _In_ PDEVICE_OBJECT DeviceObject) PURE;

    // Buffer circular render→capture (vive mientras viva el adaptador).
    STDMETHOD_(CLoopbackBuffer*, GetLoopback)(THIS) PURE;

    // Volumen/mute por dirección (Capture=FALSE → nodo del altavoz,
    // Capture=TRUE → nodo del micrófono). Channel en 0..VOXORA_VOLUME_CHANNELS-1.
    STDMETHOD_(LONG, GetVolume)(THIS_ _In_ BOOLEAN Capture, _In_ ULONG Channel) PURE;
    STDMETHOD_(void, SetVolume)(THIS_ _In_ BOOLEAN Capture, _In_ ULONG Channel, _In_ LONG LevelDb) PURE;
    STDMETHOD_(BOOLEAN, GetMute)(THIS_ _In_ BOOLEAN Capture) PURE;
    STDMETHOD_(void, SetMute)(THIS_ _In_ BOOLEAN Capture, _In_ BOOLEAN Mute) PURE;

    // Ganancia lineal efectiva (volumen + mute) que aplican los streams al
    // copiar hacia/desde el loopback. Seguro a DISPATCH_LEVEL.
    STDMETHOD_(float, GetLinearGain)(THIS_ _In_ BOOLEAN Capture) PURE;
};
typedef IVoxoraAdapter* PVOXORAADAPTER;

// Fábrica del objeto común (adapter.cpp). PoolFlags = POOL_FLAG_NON_PAGED
// (el objeto se toca desde DPC).
_IRQL_requires_max_(PASSIVE_LEVEL)
NTSTATUS
CreateVoxoraAdapter(
    _Out_ PUNKNOWN* Unknown,
    _In_opt_ PUNKNOWN UnknownOuter,
    _In_  POOL_FLAGS PoolFlags
);

// Fábricas de miniports (minwavert.cpp / mintopo.cpp). Devuelven el IUnknown
// del miniport listo para pasar a IPort::Init.
_IRQL_requires_max_(PASSIVE_LEVEL)
NTSTATUS
CreateMiniportWaveRTVoxora(
    _Out_ PUNKNOWN* Unknown,
    _In_opt_ PUNKNOWN UnknownOuter,
    _In_  POOL_FLAGS PoolFlags,
    _In_  BOOLEAN   Capture
);

_IRQL_requires_max_(PASSIVE_LEVEL)
NTSTATUS
CreateMiniportTopologyVoxora(
    _Out_ PUNKNOWN* Unknown,
    _In_opt_ PUNKNOWN UnknownOuter,
    _In_  POOL_FLAGS PoolFlags,
    _In_  BOOLEAN   Capture
);

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

// Convierte dB (LONG 16.16 KS) a ganancia lineal sin CRT (no hay exp2f en
// kernel). Aproximación polinómica de 2^x con error < 0.1 %.
float VoxoraDbToLinear(_In_ LONG LevelDb);

// Trazas: solo en builds Debug (DBG=1 lo define el toolset del WDK).
#if DBG
#define VOXORA_TRACE(...) DbgPrintEx(DPFLTR_IHVAUDIO_ID, DPFLTR_INFO_LEVEL, "voxorameet: " __VA_ARGS__)
#else
#define VOXORA_TRACE(...) ((void)0)
#endif

#ifndef SIZEOF_ARRAY
#define SIZEOF_ARRAY(ar) (sizeof(ar) / sizeof((ar)[0]))
#endif
