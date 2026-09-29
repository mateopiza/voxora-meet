// loopback.h — Buffer circular render→capture del cable virtual.
//
// Vive en pool no paginado dentro del objeto adaptador. Dos productores /
// consumidores independientes (DPC del stream render y DPC del stream
// capture) lo usan a DISPATCH_LEVEL protegidos por un KSPIN_LOCK.
//
// Formato interno canónico: float32 estéreo a 48 kHz. El render escribe
// convirtiendo desde su formato negociado (s16/float, 1–2 ch, 16–48 kHz) y
// el capture lee convirtiendo hacia el suyo; la reconversión de frecuencia
// es interpolación lineal (suficiente para voz; el pipeline ya trabaja a
// 48 kHz de punta a punta, así que en el caso normal no se remuestrea).
#pragma once

#include "common.h"

class CLoopbackBuffer
{
public:
    // Reserva el objeto y su almacenamiento en NonPagedPoolNx. NULL si falla.
    static CLoopbackBuffer* Create(_In_ ULONG CapacityFrames, _In_ ULONG MaxLatencyFrames);
    void Destroy();

    // Escribe `Bytes` de audio en formato `Format` (múltiplo de BlockAlign).
    // Si el buffer se llena se descarta lo más antiguo (el capture no lee).
    _IRQL_requires_max_(DISPATCH_LEVEL)
    void Write(_In_reads_bytes_(Bytes) const BYTE* Source,
               _In_ ULONG Bytes,
               _In_ const VOXORA_PCM_FORMAT& Format,
               _In_ float Gain);

    // Rellena `Bytes` en `Destination` con formato `Format`. Si no hay
    // suficiente audio se completa con silencio (render inactivo).
    _IRQL_requires_max_(DISPATCH_LEVEL)
    void Read(_Out_writes_bytes_all_(Bytes) BYTE* Destination,
              _In_ ULONG Bytes,
              _In_ const VOXORA_PCM_FORMAT& Format,
              _In_ float Gain);

    // Vacía el buffer y reinicia el estado de los remuestreadores.
    _IRQL_requires_max_(DISPATCH_LEVEL)
    void Reset();

    // Frames de 48 kHz actualmente encolados (diagnóstico).
    _IRQL_requires_max_(DISPATCH_LEVEL)
    ULONG GetFill();

private:
    CLoopbackBuffer() = default;
    ~CLoopbackBuffer() = default;

    // --- internos: se llaman con el spinlock tomado ---
    void PushFrame(_In_ float Left, _In_ float Right);
    BOOLEAN PopFrame(_Out_ float* Left, _Out_ float* Right);
    BOOLEAN PeekFrame(_Out_ float* Left, _Out_ float* Right);
    void DropOldest(_In_ ULONG Frames);

    KSPIN_LOCK  m_Lock;
    float*      m_Data;             // Capacity * 2 floats (L,R intercalado)
    ULONG       m_Capacity;         // frames
    ULONG       m_MaxLatency;       // frames
    ULONG       m_WritePos;         // índice de frame
    ULONG       m_ReadPos;
    ULONG       m_Fill;             // frames disponibles

    // Estado del remuestreador de entrada (render → 48 kHz).
    float       m_InPhase;
    float       m_InPrevL;
    float       m_InPrevR;

    // Estado del remuestreador de salida (48 kHz → capture).
    float       m_OutPhase;
    float       m_OutPrevL;
    float       m_OutPrevR;
};
