// minwavert.h — Miniport WaveRT (render y capture) de VOXORA Meet.
//
// Un mismo tipo de miniport sirve para ambos filtros; `m_Capture` decide el
// descriptor de filtro, la dirección de copia hacia el buffer de loopback y
// la categoría KSCATEGORY_RENDER/CAPTURE.
#pragma once

#include "common.h"
#include "loopback.h"

class CMiniportWaveRTStream;

// ===========================================================================
// CMiniportWaveRT
// ===========================================================================
class CMiniportWaveRT
    : public IMiniportWaveRT,
      public CUnknown
{
public:
    DECLARE_STD_UNKNOWN();

    CMiniportWaveRT(_In_opt_ PUNKNOWN UnknownOuter, _In_ BOOLEAN Capture);
    ~CMiniportWaveRT();

    // IMiniport + IMiniportWaveRT
    IMP_IMiniportWaveRT;

    // --- helpers usados por el stream y los property handlers ---
    BOOLEAN IsCapture() const { return m_Capture; }
    PVOXORAADAPTER GetAdapter() const { return m_Adapter; }

    // Valida un KSDATAFORMAT contra lo que soporta el cable; si Out != NULL
    // devuelve el formato compacto.
    NTSTATUS ValidateDataFormat(_In_ PKSDATAFORMAT DataFormat, _Out_opt_ PVOXORA_PCM_FORMAT Out);

    // Callback del stream al destruirse (libera el slot único).
    void StreamClosed(_In_ CMiniportWaveRTStream* Stream);

    // KSPROPERTY_PIN_PROPOSEDATAFORMAT
    NTSTATUS PropertyHandlerProposedFormat(_In_ PPCPROPERTY_REQUEST Request);

private:
    PVOXORAADAPTER          m_Adapter;
    PPORTWAVERT             m_Port;
    BOOLEAN                 m_Capture;
    // Como máximo un stream por filtro. Se reserva/libera con
    // InterlockedCompareExchangePointer: NewStream y el destructor del stream
    // corren a PASSIVE_LEVEL en código paginable, donde no se puede tomar un
    // spinlock (subiría a DISPATCH_LEVEL ejecutando desde la sección PAGE).
    CMiniportWaveRTStream* volatile m_Stream;
};

// ===========================================================================
// CMiniportWaveRTStream
// ===========================================================================
class CMiniportWaveRTStream
    : public IMiniportWaveRTStreamNotification,
      public CUnknown
{
public:
    DECLARE_STD_UNKNOWN();
    DEFINE_STD_CONSTRUCTOR(CMiniportWaveRTStream);
    ~CMiniportWaveRTStream();

    // IMiniportWaveRTStream + IMiniportWaveRTStreamNotification (el macro de
    // la segunda NO incluye los métodos de la primera).
    IMP_IMiniportWaveRTStream;
    IMP_IMiniportWaveRTStreamNotification;

    NTSTATUS Init(
        _In_ CMiniportWaveRT*   Miniport,
        _In_ PPORTWAVERTSTREAM  PortStream,
        _In_ ULONG              Pin,
        _In_ BOOLEAN            Capture,
        _In_ PKSDATAFORMAT      DataFormat);

private:
    // Rutina DPC del timer periódico (10 ms).
    static KDEFERRED_ROUTINE TimerDpcRoutine;

    // Avanza la posición virtual y mueve audio hacia/desde el loopback.
    // Se llama a DISPATCH_LEVEL con m_Lock tomado.
    _IRQL_requires_(DISPATCH_LEVEL)
    void AdvancePosition();

    // Copia `Bytes` desde/hacia el buffer WaveRT a partir del offset
    // circular `Offset` (maneja el wrap). Con m_Lock tomado.
    _IRQL_requires_(DISPATCH_LEVEL)
    void TransferChunk(_In_ ULONG Offset, _In_ ULONG Bytes);

    // Dispara los eventos de notificación registrados (KeSetEvent).
    _IRQL_requires_(DISPATCH_LEVEL)
    void SignalNotifications();

    // Convierte ticks QPC transcurridos a frames sin desbordar.
    ULONGLONG TicksToFrames(_In_ LONGLONG Ticks) const;

    _IRQL_requires_(PASSIVE_LEVEL)
    NTSTATUS AllocateBufferInternal(
        _In_  ULONG                 NotificationCount,
        _In_  ULONG                 RequestedSize,
        _Out_ PMDL*                 AudioBufferMdl,
        _Out_ ULONG*                ActualSize,
        _Out_ ULONG*                OffsetFromFirstPage,
        _Out_ MEMORY_CACHING_TYPE*  CacheType);

    _IRQL_requires_(PASSIVE_LEVEL)
    void FreeBufferInternal(_In_ PMDL Mdl);

    CMiniportWaveRT*    m_Miniport;         // referencia fuerte
    PPORTWAVERTSTREAM   m_PortStream;       // referencia fuerte
    PVOXORAADAPTER      m_Adapter;          // referencia fuerte
    CLoopbackBuffer*    m_Loopback;         // propiedad del adaptador
    BOOLEAN             m_Capture;
    ULONG               m_Pin;
    VOXORA_PCM_FORMAT   m_Format;

    KSPIN_LOCK          m_Lock;
    KSSTATE             m_State;

    // Buffer cíclico WaveRT (páginas propias mapeadas en espacio de sistema).
    PMDL                m_DmaMdl;
    BYTE*               m_DmaBuffer;
    ULONG               m_DmaBufferSize;    // bytes, múltiplo de BlockAlign
    ULONG               m_NotificationCount;// 0 (sin eventos), 1 o 2

    // Posición virtual.
    ULONGLONG           m_LinearPosition;   // bytes totales desde STOP
    ULONGLONG           m_LinearAtRun;      // m_LinearPosition al entrar en RUN
    LONGLONG            m_QpcAtRun;         // KeQueryPerformanceCounter al entrar en RUN
    LONGLONG            m_QpcFrequency;
    ULONG               m_PlayOffset;       // m_LinearPosition % m_DmaBufferSize

    // Timer periódico.
    KTIMER              m_Timer;
    KDPC                m_Dpc;
    BOOLEAN             m_TimerActive;
    BOOLEAN             m_TimerResolutionRaised;

    // Eventos de notificación (pull mode). Lista simple protegida por m_Lock.
    static const ULONG  MAX_NOTIFICATION_EVENTS = 8;
    PKEVENT             m_NotificationEvents[MAX_NOTIFICATION_EVENTS];
};
