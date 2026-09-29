// loopback.cpp — Buffer circular render→capture del cable virtual.
//
// Todo el código de este archivo puede ejecutarse a DISPATCH_LEVEL (lo
// llaman las DPC de los streams), por lo que NO va en la sección PAGE.
//
// Nota sobre punto flotante en kernel x64: el kernel x64 permite usar SSE/SSE2
// sin KeSaveFloatingPointState (a diferencia de x86). Este driver es solo
// NTamd64; si algún día se compila para x86 hay que envolver Write/Read con
// KeSaveFloatingPointState/KeRestoreFloatingPointState.

#include "loopback.h"

// ---------------------------------------------------------------------------
// Conversión de un frame entre el formato del stream y float estéreo.
// ---------------------------------------------------------------------------

static const float SCALE_S16_TO_FLOAT = 1.0f / 32768.0f;
static const float SCALE_FLOAT_TO_S16 = 32767.0f;

__forceinline void
ReadFrameToFloat(
    _In_reads_bytes_(Format.BlockAlign) const BYTE* Source,
    _In_ const VOXORA_PCM_FORMAT& Format,
    _Out_ float* Left,
    _Out_ float* Right)
{
    if (Format.IsFloat)
    {
        const float* s = reinterpret_cast<const float*>(Source);
        *Left = s[0];
        *Right = (Format.Channels >= 2) ? s[1] : s[0];
    }
    else
    {
        const SHORT* s = reinterpret_cast<const SHORT*>(Source);
        *Left = static_cast<float>(s[0]) * SCALE_S16_TO_FLOAT;
        *Right = (Format.Channels >= 2)
            ? static_cast<float>(s[1]) * SCALE_S16_TO_FLOAT
            : *Left;
    }
}

__forceinline SHORT
FloatToS16(_In_ float Sample)
{
    if (Sample > 1.0f) Sample = 1.0f;
    else if (Sample < -1.0f) Sample = -1.0f;
    return static_cast<SHORT>(Sample * SCALE_FLOAT_TO_S16);
}

__forceinline void
WriteFrameFromFloat(
    _Out_writes_bytes_(Format.BlockAlign) BYTE* Destination,
    _In_ const VOXORA_PCM_FORMAT& Format,
    _In_ float Left,
    _In_ float Right)
{
    if (Format.IsFloat)
    {
        float* d = reinterpret_cast<float*>(Destination);
        if (Format.Channels >= 2)
        {
            d[0] = Left;
            d[1] = Right;
        }
        else
        {
            d[0] = (Left + Right) * 0.5f;   // downmix a mono
        }
    }
    else
    {
        SHORT* d = reinterpret_cast<SHORT*>(Destination);
        if (Format.Channels >= 2)
        {
            d[0] = FloatToS16(Left);
            d[1] = FloatToS16(Right);
        }
        else
        {
            d[0] = FloatToS16((Left + Right) * 0.5f);
        }
    }
}

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------

CLoopbackBuffer*
CLoopbackBuffer::Create(
    _In_ ULONG CapacityFrames,
    _In_ ULONG MaxLatencyFrames)
{
    if (CapacityFrames == 0 || MaxLatencyFrames >= CapacityFrames)
    {
        return NULL;
    }

    // ExAllocatePool2 devuelve memoria a cero (Windows 10 2004+).
    CLoopbackBuffer* self = static_cast<CLoopbackBuffer*>(
        ExAllocatePool2(POOL_FLAG_NON_PAGED, sizeof(CLoopbackBuffer), VOXORA_POOLTAG));
    if (self == NULL)
    {
        return NULL;
    }

    const SIZE_T dataBytes = static_cast<SIZE_T>(CapacityFrames) * 2 * sizeof(float);
    self->m_Data = static_cast<float*>(
        ExAllocatePool2(POOL_FLAG_NON_PAGED, dataBytes, VOXORA_POOLTAG));
    if (self->m_Data == NULL)
    {
        ExFreePoolWithTag(self, VOXORA_POOLTAG);
        return NULL;
    }

    KeInitializeSpinLock(&self->m_Lock);
    self->m_Capacity = CapacityFrames;
    self->m_MaxLatency = MaxLatencyFrames;
    self->m_WritePos = 0;
    self->m_ReadPos = 0;
    self->m_Fill = 0;
    self->m_InPhase = 0.0f;
    self->m_InPrevL = 0.0f;
    self->m_InPrevR = 0.0f;
    self->m_OutPhase = 1.0f;    // fuerza a consumir el primer frame
    self->m_OutPrevL = 0.0f;
    self->m_OutPrevR = 0.0f;
    return self;
}

void
CLoopbackBuffer::Destroy()
{
    if (m_Data != NULL)
    {
        ExFreePoolWithTag(m_Data, VOXORA_POOLTAG);
        m_Data = NULL;
    }
    ExFreePoolWithTag(this, VOXORA_POOLTAG);
}

// ---------------------------------------------------------------------------
// Primitivas del anillo (con m_Lock tomado)
// ---------------------------------------------------------------------------

void
CLoopbackBuffer::DropOldest(_In_ ULONG Frames)
{
    if (Frames > m_Fill)
    {
        Frames = m_Fill;
    }
    m_ReadPos = (m_ReadPos + Frames) % m_Capacity;
    m_Fill -= Frames;
}

void
CLoopbackBuffer::PushFrame(_In_ float Left, _In_ float Right)
{
    if (m_Fill == m_Capacity)
    {
        // Nadie lee (capture parado): descartar lo más antiguo.
        DropOldest(1);
    }
    float* slot = m_Data + (static_cast<SIZE_T>(m_WritePos) * 2);
    slot[0] = Left;
    slot[1] = Right;
    m_WritePos = (m_WritePos + 1) % m_Capacity;
    m_Fill++;
}

BOOLEAN
CLoopbackBuffer::PopFrame(_Out_ float* Left, _Out_ float* Right)
{
    if (m_Fill == 0)
    {
        *Left = 0.0f;
        *Right = 0.0f;
        return FALSE;
    }
    const float* slot = m_Data + (static_cast<SIZE_T>(m_ReadPos) * 2);
    *Left = slot[0];
    *Right = slot[1];
    m_ReadPos = (m_ReadPos + 1) % m_Capacity;
    m_Fill--;
    return TRUE;
}

BOOLEAN
CLoopbackBuffer::PeekFrame(_Out_ float* Left, _Out_ float* Right)
{
    if (m_Fill == 0)
    {
        *Left = 0.0f;
        *Right = 0.0f;
        return FALSE;
    }
    const float* slot = m_Data + (static_cast<SIZE_T>(m_ReadPos) * 2);
    *Left = slot[0];
    *Right = slot[1];
    return TRUE;
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

_Use_decl_annotations_
void
CLoopbackBuffer::Write(
    const BYTE* Source,
    ULONG Bytes,
    const VOXORA_PCM_FORMAT& Format,
    float Gain)
{
    if (Format.BlockAlign == 0 || Format.SampleRate == 0)
    {
        return;     // SampleRate 0 -> step 0 -> bucle infinito en el remuestreo
    }

    const ULONG frames = Bytes / Format.BlockAlign;
    KIRQL oldIrql;
    KeAcquireSpinLock(&m_Lock, &oldIrql);

    if (Format.SampleRate == VOXORA_NATIVE_SAMPLE_RATE)
    {
        // Camino rápido: sin remuestreo.
        for (ULONG i = 0; i < frames; i++)
        {
            float l, r;
            ReadFrameToFloat(Source, Format, &l, &r);
            PushFrame(l * Gain, r * Gain);
            Source += Format.BlockAlign;
        }
    }
    else
    {
        // Interpolación lineal: por cada frame de entrada se emiten los
        // frames de salida cuyo instante cae entre prev y cur.
        const float step = static_cast<float>(Format.SampleRate)
                         / static_cast<float>(VOXORA_NATIVE_SAMPLE_RATE);
        for (ULONG i = 0; i < frames; i++)
        {
            float l, r;
            ReadFrameToFloat(Source, Format, &l, &r);
            l *= Gain;
            r *= Gain;
            while (m_InPhase < 1.0f)
            {
                PushFrame(m_InPrevL + (l - m_InPrevL) * m_InPhase,
                          m_InPrevR + (r - m_InPrevR) * m_InPhase);
                m_InPhase += step;
            }
            m_InPhase -= 1.0f;
            m_InPrevL = l;
            m_InPrevR = r;
            Source += Format.BlockAlign;
        }
    }

    KeReleaseSpinLock(&m_Lock, oldIrql);
}

_Use_decl_annotations_
void
CLoopbackBuffer::Read(
    BYTE* Destination,
    ULONG Bytes,
    const VOXORA_PCM_FORMAT& Format,
    float Gain)
{
    if (Format.BlockAlign == 0 || Format.SampleRate == 0)
    {
        RtlZeroMemory(Destination, Bytes);
        return;
    }

    const ULONG frames = Bytes / Format.BlockAlign;
    KIRQL oldIrql;
    KeAcquireSpinLock(&m_Lock, &oldIrql);

    // Acotar la latencia acumulada: si el render va por delante más de
    // m_MaxLatency (tras servir esta lectura), saltar el excedente.
    const ULONGLONG needed48 =
        (static_cast<ULONGLONG>(frames) * VOXORA_NATIVE_SAMPLE_RATE) / Format.SampleRate + 2;
    if (m_Fill > m_MaxLatency + needed48)
    {
        DropOldest(static_cast<ULONG>(m_Fill - m_MaxLatency - needed48));
    }

    if (Format.SampleRate == VOXORA_NATIVE_SAMPLE_RATE)
    {
        for (ULONG i = 0; i < frames; i++)
        {
            float l, r;
            PopFrame(&l, &r);  // silencio si está vacío
            WriteFrameFromFloat(Destination, Format, l * Gain, r * Gain);
            Destination += Format.BlockAlign;
        }
    }
    else
    {
        const float step = static_cast<float>(VOXORA_NATIVE_SAMPLE_RATE)
                         / static_cast<float>(Format.SampleRate);
        for (ULONG i = 0; i < frames; i++)
        {
            while (m_OutPhase >= 1.0f)
            {
                PopFrame(&m_OutPrevL, &m_OutPrevR);
                m_OutPhase -= 1.0f;
            }
            float nl, nr;
            PeekFrame(&nl, &nr);
            const float l = m_OutPrevL + (nl - m_OutPrevL) * m_OutPhase;
            const float r = m_OutPrevR + (nr - m_OutPrevR) * m_OutPhase;
            WriteFrameFromFloat(Destination, Format, l * Gain, r * Gain);
            m_OutPhase += step;
            Destination += Format.BlockAlign;
        }
    }

    KeReleaseSpinLock(&m_Lock, oldIrql);
}

_Use_decl_annotations_
void
CLoopbackBuffer::Reset()
{
    KIRQL oldIrql;
    KeAcquireSpinLock(&m_Lock, &oldIrql);
    m_WritePos = 0;
    m_ReadPos = 0;
    m_Fill = 0;
    m_InPhase = 0.0f;
    m_InPrevL = 0.0f;
    m_InPrevR = 0.0f;
    m_OutPhase = 1.0f;
    m_OutPrevL = 0.0f;
    m_OutPrevR = 0.0f;
    KeReleaseSpinLock(&m_Lock, oldIrql);
}

_Use_decl_annotations_
ULONG
CLoopbackBuffer::GetFill()
{
    KIRQL oldIrql;
    KeAcquireSpinLock(&m_Lock, &oldIrql);
    const ULONG fill = m_Fill;
    KeReleaseSpinLock(&m_Lock, oldIrql);
    return fill;
}
