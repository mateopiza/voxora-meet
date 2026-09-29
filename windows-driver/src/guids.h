// guids.h — GUIDs propios del driver VOXORA Meet (voxorameet.sys).
//
// Convención: este header usa DEFINE_GUID. Exactamente UN .cpp del proyecto
// (adapter.cpp) incluye <initguid.h> antes que este archivo para instanciar
// los símbolos; el resto solo obtiene declaraciones extern.
//
// Los GUIDs fueron generados una sola vez para este producto; NO reutilizar
// en otros drivers ni cambiarlos entre versiones (el INF los referencia).
#pragma once

// ---------------------------------------------------------------------------
// Nombres de pin (KSPIN_DESCRIPTOR.Name). El INF los registra bajo
// HKLM\SYSTEM\CurrentControlSet\Control\MediaCategories\{GUID} con el valor
// "Name", y así el panel de sonido muestra "VOXORA Meet Speaker (...)" y
// "VOXORA Meet Microphone (...)" en lugar de "Altavoces"/"Micrófono".
// ---------------------------------------------------------------------------

// {41C0553A-7829-48E5-A2FA-43867BAB3D06}
DEFINE_GUID(KSNAME_VOXORA_SPEAKER,
    0x41C0553A, 0x7829, 0x48E5, 0xA2, 0xFA, 0x43, 0x86, 0x7B, 0xAB, 0x3D, 0x06);

// {B4FC850B-F02A-4AF0-B4C6-521D3F5C89FF}
DEFINE_GUID(KSNAME_VOXORA_MICROPHONE,
    0xB4FC850B, 0xF02A, 0x4AF0, 0xB4, 0xC6, 0x52, 0x1D, 0x3F, 0x5C, 0x89, 0xFF);

// ---------------------------------------------------------------------------
// Interfaz interna del adaptador (IVoxoraAdapter): la comparten los miniports
// wave (render/capture) y de topología para acceder al buffer de loopback y
// al estado de volumen/mute.
// ---------------------------------------------------------------------------

// {9F259B59-C035-4EC9-A514-4604D4A072F2}
DEFINE_GUID(IID_IVoxoraAdapter,
    0x9F259B59, 0xC035, 0x4EC9, 0xA5, 0x14, 0x46, 0x04, 0xD4, 0xA0, 0x72, 0xF2);

// ---------------------------------------------------------------------------
// Identificadores de componente (KSCOMPONENTID.Manufacturer / Product).
// Reservados para diagnóstico (KSPROPERTY_GENERAL_COMPONENTID); el driver
// todavía no expone esa propiedad.
// ---------------------------------------------------------------------------

// {84F991B4-98D4-413F-86C4-09B4381460CD}
DEFINE_GUID(VOXORA_MANUFACTURER_GUID,
    0x84F991B4, 0x98D4, 0x413F, 0x86, 0xC4, 0x09, 0xB4, 0x38, 0x14, 0x60, 0xCD);

// {7E748BE6-0428-4EBA-9C80-38B56949C284}
DEFINE_GUID(VOXORA_PRODUCT_GUID,
    0x7E748BE6, 0x0428, 0x4EBA, 0x9C, 0x80, 0x38, 0xB5, 0x69, 0x49, 0xC2, 0x84);
