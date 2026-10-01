# @voxora-meet/app

Aplicación de usuario de **VOXORA Meet**: motor headless Node.js + shell nativo Win32 en C++17 + interfaz de usuario web local servida con Microsoft Edge WebView2.

---

## Componentes

```
app/
├── package.json
├── README.md
├── engine/              # Motor headless Node.js (protocolo JSON-lines por stdio)
│   ├── engine.mjs       # Proceso principal y despacho de eventos
│   ├── protocol.mjs     # Servidor de líneas JSON por stdio
│   ├── session-controller.mjs # Orquestador: MicCapture → Pipeline → SyncBuffer → VirtualMic
│   ├── settings-store.mjs     # Persistencia atómica de settings.json y cifrado DPAPI
│   ├── models.mjs       # Catálogo en vivo de modelos (Groq y ElevenLabs) con caché
│   └── output-device.mjs# Detección y fallback de endpoints de salida
├── native-shell/        # VoxoraMeet.exe (C++17 Win32 + WebView2 Evergreen)
│   ├── src/             # Ventana, captura de webcam, efectos de video, grabador MP4
│   ├── res/             # Iconos multi-resolución (16 a 256 px) y versión
│   └── third_party/     # WebView2 SDK estático vendorizado
└── ui/                  # Interfaz gráfica local (HTML5, CSS modular, JS ESM vanilla)
    ├── index.html       # Vista de usuario (modos Simple y Avanzado)
    ├── styles.css       # Design system "Vocal Glass" (lavanda #F7F5FF)
    ├── app.js           # Controlador principal y enrutador
    ├── tokens/          # Copia oficial de tokens del design system
    ├── fonts/           # Fuentes WOFF2 locales (Inter, Space Grotesk, JetBrains Mono)
    └── js/              # Módulos de lógica UI (cámara, modelos, traducción, voz, mock)
```

---

## Compilación y Ejecución

### 1. Iniciar en desarrollo (árbol de código)
```bash
npm start
```

### 2. Compilar el shell nativo (`VoxoraMeet.exe`)
```bash
cd native-shell
build.cmd
```

### 3. Pruebas del motor
```bash
npm test -- "app/**/*.test.mjs"
```

---

## Documentación Detallada

- [`docs/APP-SHELL.md`](../docs/APP-SHELL.md): Especificación exhaustiva de WebView2, comandos nativos, efectos de cámara, grabación de pruebas y empaquetado.
- [`docs/CONTRACTS.md`](../docs/CONTRACTS.md): Especificación de contratos y protocolo JSON-lines v1, v2 y v3.
- [`docs/VIDEO-SYNC.md`](../docs/VIDEO-SYNC.md): Modelo de sincronía y memoria compartida hacia la cámara virtual.

---

## Licencia

VOXORA Community & Fair Source License v1.0 (gratuita para uso personal/académico; requiere licencia comercial para startups y empresas). Consulta [`LICENSE`](../LICENSE).
