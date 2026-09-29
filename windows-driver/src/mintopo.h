// mintopo.h — Miniport de topología (render y capture) de VOXORA Meet.
//
// Expone el pin de endpoint (KSNODETYPE_SPEAKER o KSNODETYPE_MICROPHONE) con
// nodos de volumen y mute, y la descripción de jack "siempre conectado". Es
// lo mínimo para que el motor de audio construya un endpoint visible en el
// panel de sonido y en las apps (Meet, Zoom, Discord...).
#pragma once

#include "common.h"

class CMiniportTopology
    : public IMiniportTopology,
      public CUnknown
{
public:
    DECLARE_STD_UNKNOWN();

    CMiniportTopology(_In_opt_ PUNKNOWN UnknownOuter, _In_ BOOLEAN Capture);
    ~CMiniportTopology();

    // IMiniport + IMiniportTopology
    IMP_IMiniportTopology;

    BOOLEAN IsCapture() const { return m_Capture; }
    PVOXORAADAPTER GetAdapter() const { return m_Adapter; }

    // Property handlers (nodos y filtro).
    NTSTATUS PropertyHandlerVolume(_In_ PPCPROPERTY_REQUEST Request);
    NTSTATUS PropertyHandlerMute(_In_ PPCPROPERTY_REQUEST Request);
    NTSTATUS PropertyHandlerJackDescription(_In_ PPCPROPERTY_REQUEST Request);
    NTSTATUS PropertyHandlerJackDescription2(_In_ PPCPROPERTY_REQUEST Request);

private:
    PVOXORAADAPTER  m_Adapter;
    PPORTTOPOLOGY   m_Port;
    BOOLEAN         m_Capture;
};
