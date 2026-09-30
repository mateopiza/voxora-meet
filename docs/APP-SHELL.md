# App: shell nativo (Win32 + WebView2) + UI local + motor Node

```
app/
  engine/            motor headless (Node ≥ 22, ESM, sin deps) — JSON-lines por stdio
    engine.mjs       proceso; protocolo v2 en docs/CONTRACTS.md
    protocol.mjs     servidor JSON-lines (testable con streams)
    session-controller.mjs   MicCapture → DubbingPipeline → SyncBuffer → VirtualMic (DI)
    settings-store.mjs       %APPDATA%\VOXORA Meet\settings.json + provider-keys.dpapi
  native-shell/      VoxoraMeet.exe (C++17, MSVC, CMake) → bin\VoxoraMeet.exe
    src/main.cpp            ventana, bandeja, instancia única, puente UI ⇄ motor, sesión de cámara
    src/webview_host.*      WebView2 (entorno, ajustes, host virtual, permisos, navegación)
    src/device_watcher.*    WM_DEVICECHANGE (KS video/capture/audio) + IMMNotificationClient
    src/camera_capture.*    webcam MF → ring (0 ms fuera de sesión, delayMs en sesión) → memoria compartida
    src/vcam_host.*         proceso VoxoraMeetVCamHost.exe (stdin por tubería: EOF = el shell murió)
    src/audio_capture.*     enumeración MMDevice (mics y salidas) + grabador WASAPI de tomas
    src/native_dialogs.*    IFileOpenDialog (audio), duración con MF, enlaces externos
    src/serial_worker.h     hilos serie (webcam / enumeración / audio) para no bloquear la UI
    res/app.rc, voxora-meet.ico   isotipo oficial (Ø sobre gradiente tri-brand) 16…256 px + versión
    third_party/webview2/   SDK WebView2 1.0.4258.31 vendorizado (cabeceras + loader estático x64)
  ui/                HTML/CSS/JS vanilla, sin frameworks ni CDN
    index.html, styles.css, app.js, js/*.js (models.js = pestaña Modelos, protocolo v3)
    tokens/          copia de project/tokens del design system VØXORA (fonts.css → woff2 locales)
    fonts/           Inter, Space Grotesk, JetBrains Mono (.woff2 variables de Google Fonts, servidos en local)
    assets/          logo.svg (wordmark), isotipo.svg, favicon.png/.ico
  test/              node --test
```

La UI **no** usa controles Win32: es una página local servida por WebView2 (runtime Evergreen).
El shell sigue siendo dueño del video (captura MF + delay + memoria compartida de la cámara
virtual), de la detección de dispositivos, de la grabación de muestras y del proceso del motor.

## WebView2

- Runtime: Evergreen instalado en el sistema. Si falta, `MessageBox` con enlace a
  `https://developer.microsoft.com/microsoft-edge/webview2/` y la app sale.
- SDK: `third_party/webview2` (`WebView2.h`, `WebView2EnvironmentOptions.h`,
  `x64/WebView2LoaderStatic.lib`, `LICENSE.txt`). Enlace **estático**: no hay `WebView2Loader.dll`
  junto al exe. Callbacks con `Microsoft::WRL::Callback` (`wrl.h` del Windows SDK).
- Datos de usuario de WebView2: `%LOCALAPPDATA%\VOXORA Meet\WebView2`.
- La carpeta `ui` se mapea con `SetVirtualHostNameToFolderMapping("app.voxora-meet", …, DENY_CORS)`
  y se navega a `https://app.voxora-meet/index.html` (contexto seguro → `getUserMedia` sin servidor).
  Las tomas grabadas (`%APPDATA%\VOXORA Meet\voice-samples`) se sirven en
  `https://samples.voxora-meet/<archivo>.wav` para poder escucharlas desde la UI, y las pruebas de
  «Grabar prueba» (`%LOCALAPPDATA%\VOXORA Meet\recordings`) en `https://recordings.voxora-meet/<archivo>.mp4`
  (los cubre el `media-src https:` de la CSP).
- Ajustes: menú contextual por defecto, zoom (Ctrl±/pellizco), atajos del navegador (F5, Ctrl+P…),
  barra de estado, autofill y guardado de contraseñas **desactivados**. DevTools (y atajos, F12)
  solo en build Debug.
- Navegación restringida al host propio; `window.open`/enlaces externos se abren en el navegador
  del sistema (solo `https:`, `http:`, `ms-settings:`). Permisos de cámara y micrófono concedidos
  solo al origen `https://app.voxora-meet/` (vista previa de la webcam y prueba de micrófono);
  el resto se deniega. Los mensajes de otros orígenes se ignoran.
- CSP en `index.html`: solo recursos propios; `media-src https:` para las muestras de voces de
  ElevenLabs.
- Si el proceso del navegador cae, se recrea una vez; si cae el renderer, se recarga.

## Puente UI ⇄ shell

La UI envía objetos con `window.chrome.webview.postMessage(obj)`; el shell responde con
`PostWebMessageAsJson`.

| Dirección | Mensaje |
|---|---|
| UI → shell | `{ type: 'engine', id, cmd, params }` — se reenvía tal cual al motor (JSON-lines) |
| shell → UI | `{ type: 'engine-reply', id, ok, result \| error: { code, message } }` |
| shell → UI | `{ type: 'engine-event', event, data, engineNowMs }` (todos los eventos salvo `log`) |
| shell → UI | `{ type: 'engine-state', state: 'starting'\|'ready'\|'exited'\|'failed', message }` |
| UI → shell | `{ type: 'native', id, cmd, params }` |
| shell → UI | `{ type: 'native-reply', id, ok, result \| error }` |
| shell → UI | `{ type: 'native-event', event, data }` |
| shell → UI | `{ type: 'devices', reason, cameras, mics, renderEndpoints, virtualMic, virtualCamera, capture?, pipeline? }` |

`engineNowMs`: instante de llegada del evento convertido por el shell al reloj del motor
(`performance.now()` ≈ ms desde que se lanzó node). La UI lo usa para la latencia por turno
(`engineNowMs(dub) − transcript.endedAt`). Si el motor no está listo, cualquier `engine` responde
`{ code: 'engine_unavailable', message }` con el motivo en español.

Efectos del shell sobre comandos del motor que atraviesan el puente:
`session.start` ok → el video pasa a `delayMs` (con `cameraAlwaysOn` la cámara ya estaba en vivo y no se
corta; sin él, arranca host + webcam en ese momento); `session.stop` / evento `status: idle` / salida
del motor → el video vuelve a 0 (o se apaga todo sin `cameraAlwaysOn`); `delay.set` → durante la sesión
el ring de video adopta el delay en la misma acción y el valor efectivo de la respuesta;
`settings.get|set` → actualiza su copia local (cámara, mic, delay, `cameraAlwaysOn`: enciende o apaga la
cámara virtual en caliente; cambiar de webcam la reabre sin cortar la cámara virtual);
`voice.set|clone` → voz.

### Comandos nativos

| `cmd` | Resultado |
|---|---|
| `native.hello` | `{ app: { version, dataDir, debug, webviewVersion }, engine: { state, message }, session: { running, camera, cameraName }, recorder, camera }` (`camera` = mismo objeto que el evento `camera`) y emite `devices` |
| `native.devices.refresh` | re-enumera ya (sin debounce) y emite `devices` con `reason: 'manual'` |
| `native.cameras.list` | `{ cameras: [{ id (symbolic link MF), name }] }` |
| `native.engine.restart` | reinicia el proceso del motor |
| `native.voice.record.start` `{ deviceId? }` | `{ path, maxSeconds }`; emite `record.level` `{ seconds, levelDb, maxSeconds }` cada 100 ms |
| `native.voice.record.stop` | `{ path, url, seconds, durationMs, ok, reason }` (WAV PCM 16-bit mono a la tasa del dispositivo) |
| `native.voice.record.discard` `{ path }` | borra una toma (solo dentro de `voice-samples`) |
| `native.pickAudioFiles` | `IFileOpenDialog` multiselección wav/mp3/m4a/ogg/flac → `{ files: [{ path, name, sizeBytes, durationMs \| null }] }` |
| `native.openExternal` `{ url }` | abre `https:`/`http:`/`ms-settings:` en el sistema |
| `native.window.minimize` · `hide` · `show` · `quit` | ventana / bandeja / salida limpia |
| `native.camera.effects` `{ camMirror?, camFlip?, camRotation?, camAspect?, camZoom?, camPanX?, camPanY?, camBrightness?, camContrast?, camSaturation?, camTemperature? }` | aplica la imagen de la cámara **en caliente** (sin reabrir la webcam ni cortar la cámara virtual); parcial; responde los 11 valores vigentes normalizados. La UI lo envía a cada cambio (una petición en vuelo; el último valor siempre llega) y además guarda con `settings.set` (debounce); durante 1,5 s tras el último `native.camera.effects` una respuesta de `settings.get/set` antigua no pisa la imagen en vivo |
| `native.recording.start` `{ seconds: 10–30 }` | empieza «Grabar prueba» → `{ path, name, url, sizeBytes, modifiedAt, seconds, videoActive, audioDevice \| null, warning? }` (`warning`: sin micrófono virtual → sin audio; cámara virtual sin publicar → video en negro); errores `busy`, `record_failed` |
| `native.recording.stop` | termina antes (el MP4 queda válido; `recording.done` con `reason: 'user'`) |
| `native.recording.status` | `{ recording, elapsedMs, seconds, path, dir }` |
| `native.recording.list` | `{ items: [{ path, name, url, sizeBytes, modifiedAt }] (12 más recientes), dir }` |
| `native.recording.delete` `{ path }` | borra una prueba (solo dentro de `recordings` y no la que se graba; reintenta ~2 s si la vista previa aún la tiene abierta; `busy` si no) |
| `native.recording.reveal` `{ path? }` | abre el Explorador con el archivo seleccionado (o la carpeta) |

Las tomas se cortan solas al llegar a 100 s o a ~10 MiB (límite por archivo de ElevenLabs IVC);
en ese caso llega `record.stopped` con el mismo resultado que `stop` y `reason: 'max'`.

Eventos nativos: `camera` `{ state: 'off'|'starting'|'live'|'lost'|'error', name, message, mode:
'off'|'live'|'dubbing', delayMs, alwaysOn, hostRunning }` (también fuera de sesión; `state` es lo que ve
Meet: `starting`/`error` con `hostRunning: false` = el host de la cámara virtual arranca o cayó; si no, el
estado de la webcam; `mode: live` = en vivo sin retraso, `dubbing` = retrasado `delayMs`),
`camera.stats` (cada 1 s mientras la cámara virtual está activa: resolución, fps, frames en ring,
`delayMs`, publicados, `sourceLost`, `vcamHostRunning`, `sharedMemoryOk`, `state`, `mode`,
`effectsMs` / `effectsPeakMs` = ms por frame de la imagen de la cámara (media y pico de la última
ventana), `recording`),
`device-lost` / `device-restored` `{ kind: 'mic' }`, `record.level`, `record.stopped`,
`recording.progress` `{ elapsedMs, seconds, levelDb, cameraFrames }` (cada ~250 ms),
`recording.done` `{ ok, reason: 'complete'|'user'|'error'|'shutdown', message, path, name, url, sizeBytes,
durationMs, hasVideo, hasAudio, audioDevice, videoFrames, cameraFrames, encoder }` (`url: null` si no
quedó archivo), `tray.toggleSession` (menú de la bandeja).

## Dispositivos en caliente

- `RegisterDeviceNotification` para `KSCATEGORY_VIDEO_CAMERA`, `KSCATEGORY_CAPTURE` y
  `KSCATEGORY_AUDIO` (llegada/salida) + `IMMNotificationClient` (alta, baja, estado y
  predeterminado de endpoints de audio).
- Todas las fuentes reinician un timer de **600 ms** (debounce); al vencer, un hilo aparte
  re-enumera cámaras (MF), micrófonos y salidas (MMDevice), el shell pide `devices.list` al motor
  y envía `{ type: 'devices' }`. Si llega otro cambio mientras tanto, se encadena una pasada más.
- Con la captura activa (en sesión, o siempre con `cameraAlwaysOn`): si desaparece la webcam en uso (o deja de entregar frames), se publica lo
  que quedaba en el ring y luego se deja de latir la memoria compartida (latido a 0) → la DLL de la
  cámara virtual muestra su **imagen de espera** en vez de congelarse; al volver la cámara se
  reabre sola (sin reiniciar el host; reintento cada 10 s si está ocupada o no hay evento de
  dispositivo). Si el host de la cámara virtual muere se relanza con espera creciente (2, 5, 10, 30 s).
  Si desaparece el micrófono elegido (en sesión) se avisa a la UI.
- La UI marca en los selectores los dispositivos elegidos que no están conectados y tiene botón
  «Actualizar dispositivos».

## UI (app/ui)

HTML/CSS/JS vanilla (módulos ES), español. Sigue el design system **VØXORA Live «Vocal Glass»**
(`CORE\VØXORA Live Design System\v-xora-live-design-system\project`): lienzo lavanda `#F7F5FF` con
tres orbes pastel (cyan / violeta / rosa, `multiply`), tarjetas de vidrio blanco 60–70 % con blur
32 px, radios 24–40 px, sombras moradas suaves, eyebrows de 10 px con tracking .3em, CTAs en
mayúsculas con tracking .2em (gradiente cyan→violeta solo para la acción principal), pestañas como
SegmentedTabs con la activa en tinta, Badge / StatTile / IconTile / Toggle del kit. Nunca modo oscuro.

- **Tokens**: `ui/tokens/{colors,effects,spacing,typography}.css` son copia literal de
  `project/tokens`; `styles.css` los importa y no redefine valores (los matices de componente se
  derivan con `color-mix()`). Para actualizar el design system basta con volver a copiarlos.
- **Fuentes**: el `fonts.css` original importa Google Fonts; aquí `ui/tokens/fonts.css` declara
  `@font-face` locales sobre los mismos `.woff2` (variables: Inter y Space Grotesk 300–700, JetBrains
  Mono 400–500; subconjuntos latin, latin-ext, cyrillic, greek, vietnamese) en `ui/fonts/`.
  La app no depende de internet para la tipografía (CSP `font-src 'self'`).
- **Logo**: `assets/logo.svg` = wordmark «VØXORA» extraído como contornos vectoriales del PDF
  oficial (brand sheet V1, sección 01; el PDF trae los glifos en ArialMT) + tag «MEET» en cyan 700
  como el `Logo` del kit. `assets/isotipo.svg` = Ø blanca sobre gradiente tri-brand (radio 22 %).
  Favicon: `favicon.ico` (16/24/32/48/64), `favicon.png` (32) y el SVG, enlazados en `index.html`.
- Iconos Lucide embebidos como sprite SVG.

- Barra superior: logo y conmutador **Simple | Avanzado**, pastillas de estado (motor, cámara
  virtual, mic virtual; bajo 1180 px solo icono + estado) con explicación y acciones al
  pasar/enfocar/pulsar (popovers opacos; la barra lleva `z-index` propio para quedar por encima de
  pestañas y tarjetas, que con `backdrop-filter` crean su propio contexto de apilamiento), contador
  VOX de la sesión (StatTile).
- **Sin scroll de página en ningún modo ni pestaña** (revisado a 1200×780, 960×640 y tamaños
  intermedios: 1024×768, 1130×700, 1200×640, 1121×660): cada vista ocupa exactamente el alto que
  queda (`.panel` con fila `minmax(0, 1fr)`) y sus tarjetas se estiran a ese alto. Solo desplazan
  dentro de su tarjeta los bloques largos (turnos/subtítulos, glosario, vocabulario); el cuerpo de
  cada tarjeta es la última red si el contenido no cupiera (p. ej. con el aviso de cuentas visible).
- **Modo Simple | Avanzado** (`js/mode.js`): se guarda en el ajuste `uiMode` (`simple` por defecto;
  copia en `localStorage` para no parpadear al arrancar). `body[data-mode]` gobierna la visibilidad
  (`.adv-only` / `.simple-only`). Si faltan API keys, un aviso bajo la barra abre la hoja **Cuentas**
  (`dialog#sheet-accounts`, en los dos modos; se cierra sola al guardar la segunda key).
- **Controles compartidos** (`js/nav.js`): vista previa (`#preview`), cámara (`#field-camera`),
  micrófono (`#field-mic`), idiomas (`#langs`), voz (`#field-voice`), botón de inicio
  (`#cta-session`) y turnos (`#card-feed`) son un único nodo (mismo id y listeners) que se mueve al
  hueco `[data-slot]` de la vista visible (Simple, Reunión, En vivo o Cámara). `state.activeTab` es la
  vista visible: `simple` o el id de la pestaña de Avanzado.
- **Simple** = una sola pantalla, sin pestañas ni chip de sesión, con lo esencial en tres pasos
  numerados; todo lo demás usa los valores guardados o recomendados:
  1. *Así te ve y te oye Meet*: vista previa (el 16:9 más grande que cabe, `container-type: size`)
     con dos botones de icono superpuestos, **Espejo** y **Voltear** (`[data-fx-toggle]`); cámara y
     micrófono (dos desplegables, sin «Probar»); **Tu voz** (desplegable con muestra; si no hay voz
     elegida ni voces propias, `#field-voice[data-empty]`, solo el botón «Clonar mi voz», que abre el
     asistente en su hoja); y una línea de ayuda fija `#meet-line`: «En Meet elige: cámara «VOXORA
     Meet Camera» y micrófono «`virtualMic.captureName`»» en verde, o en ámbar con acción si falta el
     micrófono virtual (Descargar VB-Cable), la salida no es virtual o falta la cámara virtual.
  2. *Idiomas*: «Hablas en ⇄ Meet te oye en», botón grande Iniciar/Detener doblaje y línea de estado
     con punto y cronómetro en vivo («En vivo · 1:23 · Español → Inglés»; si un cambio pide reiniciar,
     lo dice ahí).
  3. *Subtítulos en vivo*: la misma tarjeta de turnos de En vivo (eventos `transcript` /
     `translation` / `dub` de `live.js`), sin metadatos: cada frase con «Dijiste · ES» y debajo
     «Meet oye · EN»; la más reciente destacada y las anteriores atenuadas, auto-scroll dentro del
     panel (con «Ver lo último» si subiste). Vacío: «Inicia el doblaje y empieza a hablar: verás aquí
     lo que dices y cómo lo oye Meet».
- **Avanzado** = siete pestañas (ARIA tabs con flechas y Ctrl+1…7; bajo 1120 px sin iconos) y el chip
  de sesión a la derecha. Destinos antiguos: `advanced`→Modelos, `accounts`/`limits`→Ajustes. Si una
  acción (toast, línea de ayuda) lleva a un control que no existe en Simple, `reveal()` pasa a
  Avanzado.
  - **Reunión** (tres columnas): *Cámara y micrófono* (vista previa con Espejo/Voltear y ocultar,
    webcam, enlace a Cámara, micrófono + prueba de nivel); *Idiomas y voz* (idiomas, voz con escucha
    de `previewUrl`, «Clonar mi voz», retraso 2–6 s en caliente con `delay.set` y «Si el doblaje no
    llega a tiempo»: Silencio · recomendado / Mi voz en <idioma> / Mi voz, bajita); *Salida a Meet*
    (salida del doblaje `virtualMicDevice`, recomendado «VOXORA Meet Speaker» → «CABLE Input», qué
    elegir en Meet, checklist compacta y botón Iniciar/Detener).
  - **En vivo**: tarjeta *Tu voz* (medidor, par de idiomas, voz, métricas: retraso, deriva, tardíos,
    VOX/min, turnos, en proceso, y estado de la cámara para Meet) y los turnos original → traducción
    con latencia, costo y «tardío».
  - **Cámara**: *Así te ve Meet* (vista previa grande; con la cámara virtual activa abre «VOXORA Meet
    Camera», o sea lo que ve Meet, efectos incluidos; si no, la webcam emparejada por nombre con los
    efectos aproximados por CSS) + **Grabar prueba** (10/20/30 s, cuenta atrás 3-2-1, progreso y
    nivel; al terminar la hoja «Así te ve y te oye Meet» reproduce el MP4 desde
    `https://recordings.voxora-meet/…` con Abrir carpeta, Borrar y Grabar otra), e *Imagen*: espejo,
    voltear, 16:9 / 9:16, rotación 0/90/180/270, zoom 1–2× con mover ↔/↕, brillo, contraste,
    saturación, temperatura, «Restablecer» y ms/frame de `camera.stats`.
  - **Modelos**, **Traducción** y **Voz**: ver abajo.
  - **Ajustes**: *Cuentas* (API keys), *Dispositivos y límites* (`cameraAlwaysOn`, escucha local
    `monitorDevice`, avisar / dejar de doblar en N VOX) y *Aplicación* (versión, motor, datos,
    actualizaciones, reiniciar motor, ocultar, salir).
- **Modelos** (protocolo v3, `js/models.js`): resumen de costo estimado en vivo (`cost.estimate` con
  los ajustes actuales como `overrides`, debounce 350 ms): VOX/min, VOX/h y USD/h + desglose de
  costo de proveedores (USD/h sin margen) por etapa; «Actualizar lista» (`models.list
  {refresh:true}`), aviso «Sin conexión · catálogo local» si `offline` (con los `errors` del motor en
  el tooltip) y hora de la lista. Debajo, el modelo de cada etapa con su ficha (descripción, precio,
  recomendado): *Transcripción* (`models.list().stt`), *Traducción* (`.translate`) y *Voz* (`.tts`:
  idiomas, multiplicador de costo).
- **Traducción**: *Transcripción* (temperatura 0–1, vocabulario personalizado en chips con
  `vocabulary.get/set`, hasta 200, pegar separado por comas), *Traducción* (temperatura, esfuerzo de
  razonamiento solo si `supportsReasoningEffort` con las opciones de `reasoningEfforts`, memoria 0–64
  turnos, tono, instrucción de estilo) y *Glosario* (término → traducción fija o «no traducir» =
  `translation: null`; clic en una fila para editarla; `glossary.get/set`).
- **Voz** (ElevenLabs): *Carácter* (estabilidad —slider, o Creativo/Natural/Robusto si el modelo trae
  `stabilityPresets`—, similitud, estilo si `supportsStyle`), *Ritmo y lectura* (velocidad 0,7–1,2 si
  `supportsSpeed`, realce del hablante si `supportsSpeakerBoost`, normalización auto/siempre/nunca;
  «siempre» se desactiva si `supportsNormalizationOn: false`) y *Probar la voz* («Probar voz» con
  `tts.preview`, el data URL se reproduce como blob; avisa que consume caracteres y muestra cuántos
  usó; «Valores recomendados»; Voice ID manual).
  Un modelo guardado con `available: false` se marca «no disponible» y ofrece usar el recomendado.
  Los cambios se guardan con `settings.set` y el motor los aplica desde la siguiente frase aunque haya
  sesión: una pastilla sutil en la tarjeta del ajuste dice «Guardado» o, en vivo, «Desde la próxima
  frase» (tono y estilo siguen siendo de reinicio: «Al reiniciar»). Si el motor no conoce los comandos
  v3 (`unknown_command`) el resumen lo explica y se muestran los valores guardados.
- **Cuentas** (hoja y tarjeta de Ajustes): API keys de Groq y ElevenLabs (password con «mostrar»,
  estado conectada/falta, nunca se re-muestran; borrado en dos pasos).
- Los ajustes se guardan al cambiar (`settings.set` con debounce de 450 ms) y se fuerzan antes de
  `session.start` y de `tts.preview`. Errores en toasts con el `message` del motor (sin volcados
  técnicos); `model_unavailable` lleva a Modelos.
- Accesible por teclado (pestañas ARIA, foco visible), funciona desde 960×640 (segmentados con
  columnas `auto` y `min-width: min-content`, sin partir palabras; bajo 300 px de ancho la imagen de
  la cámara pone cada barra debajo de su etiqueta). Abrir `ui/index.html` servido por HTTP en un
  navegador normal usa `js/mock.js` (backend simulado con los comandos v3, `native.camera.effects` y
  `native.recording.*`; `?mock=ready|fresh|down|offline|gone|v2&mode=simple|advanced&tab=meeting|live|camera|models|translation|voice|settings&cam=live|lost|error|off|down|flap&sheet=accounts|recording|clone&autostart=1`)
  para diseñar sin el shell.

## Ventana

1200×780 (área cliente, escalada por DPI) centrada; mínimo 960×640; per-monitor DPI v2. Tema claro
del design system: fondo de ventana y de WebView2 `#F7F5FF`; en Windows 11 la barra de título usa
el mismo lavanda con texto `#0D0816` (`DWMWA_CAPTION_COLOR` / `DWMWA_TEXT_COLOR`, también con
«color de énfasis en barras de título») y Mica (`DWMWA_SYSTEMBACKDROP_TYPE`).
Icono `res/voxora-meet.ico` (recurso 101) en el exe, la ventana (grande y pequeño al tamaño exacto
de los DPI del monitor, recargados en `WM_DPICHANGED`) y la bandeja (también se actualiza al cambiar
de DPI). Se dibujó tamaño por tamaño desde el vector: en 16–40 px la Ø es más grande y algo más
gruesa para que se lea; desde 48 px usa las proporciones del brand sheet.
Cerrar oculta en la bandeja (aviso la primera vez); «Salir» desde la bandeja o Ajustes. Instancia
única (mutex `Local\VoxoraMeetShellSingleInstance`; la segunda instancia trae la ventana al frente).

## Protocolo JSON-lines (shell ⇄ motor)

Una línea JSON por mensaje, UTF-8, `\n` como separador. Petición `{ id, cmd, params }`,
respuesta `{ id, ok, result | error: { code, message } }`, eventos `{ event, data }`.
Comandos y eventos (incluido el protocolo v2: `voices.list`, `voice.set`, `voice.clone` con
`filePaths`, `renderEndpoints`, `virtualMic.resolvedDevice/captureName`, `monitorDevice`, códigos de
error estables) y el protocolo v3 (`models.list`, `cost.estimate`, `tts.preview`, `glossary.*`,
`vocabulary.*` y los ajustes de modelo) en `docs/CONTRACTS.md`; el shell los reenvía tal cual.
Cerrar stdin del motor = apagado limpio.

## Ajustes y secretos

- `settings.json` (`%APPDATA%\VOXORA Meet`): `delayMs`, `sourceLanguage`, `targetLanguage`, `tone`,
  `styleInstruction`, `fallbackMode`, `micDeviceId`, `cameraDeviceId`, `voiceId`, `voiceName`,
  `virtualMicDevice`, `monitorDevice`, `maxVoxPerSession`, `warnAtVox`, `nodePath`, `cameraAlwaysOn`,
  `uiMode` (`simple`|`advanced`), imagen de la cámara `camMirror`, `camFlip`, `camRotation`,
  `camAspect`, `camZoom`, `camPanX`, `camPanY`, `camBrightness`, `camContrast`, `camSaturation`,
  `camTemperature` (rangos en `docs/CONTRACTS.md`; el shell lee una copia de los `cam*` para la
  captura)…
- `provider-keys.dpapi`: blob DPAPI (CurrentUser) de `{ groq, elevenlabs }`. Las keys viajan en
  claro solo por el pipe local UI → shell → motor y nunca vuelven: la UI solo ve booleanos.
- Muestras grabadas: `%APPDATA%\VOXORA Meet\voice-samples\take-*.wav`.

## Compilar el shell

```
cd app\native-shell
build.cmd            (llama vcvars64.bat de VS 2026 si hace falta; NMake + CMake ≥ 3.20)
```
o `node scripts/build-native.mjs` desde la raíz. Sale `app\native-shell\bin\VoxoraMeet.exe`
(compila sin warnings con `/W4`). Linka contra `WebView2LoaderStatic.lib`, user32, gdi32, dwmapi,
shell32, shlwapi, ole32, oleaut32, uuid, advapi32, crypt32, version, mf, mfplat, mfreadwrite, mfuuid.
Runtime estático de MSVC (`/MT`).

Con la app abierta `bin\VoxoraMeet.exe` (y `VoxoraMeetVCamHost.exe`, `wasapi-*.exe`) están en uso:
Windows permite **renombrar** un exe en ejecución, así que basta con `ren VoxoraMeet.exe
VoxoraMeet.run.exe` antes de compilar (la app sigue funcionando; el exe nuevo se usa al reabrirla).

`build\tools\shell_selftest.exe` (no se empaqueta) prueba sin abrir la app: `bench` (ms/frame de la
imagen de la cámara, 1280×720 y 1920×1080 sintéticos), `snap <carpeta>` (BMP de cada ajuste sobre el
frame vivo de la cámara virtual), `record <s> <mp4>` (misma clase de grabación que «Grabar prueba»,
con video de la memoria compartida de la cámara virtual y audio del micrófono virtual), `probe <mp4>`
(duración, pistas, frames, dBFS por segundo) y `segmentation` (¿la webcam expone segmentación de fondo?).

## Dónde busca el shell cada pieza

| Pieza | Orden de búsqueda |
|---|---|
| UI `index.html` | `<exe>\ui\` → `<exe>\..\..\ui\` (árbol de desarrollo: `app\ui`) |
| `node.exe` | `settings.nodePath` → `<exe>\node\node.exe` → `<exe>\node.exe` → `PATH` |
| `engine.mjs` | `<exe>\engine\engine.mjs` → `<exe>\..\..\engine\engine.mjs` (árbol de desarrollo) |
| `VoxoraMeetVCamHost.exe` | `<exe>\VoxoraMeetVCamHost.exe` → `windows-camera\native\bin\` |

## Empaquetado con Node portable

1. Descargar el zip "Windows Binary (.zip)" de Node ≥ 22 x64 y copiar **solo** `node.exe` a
   `<carpeta de la app>\node\node.exe`.
2. Copiar `app\engine\`, `sync-buffer\src\`, `capture\src\` (+ `capture\native\bin\`),
   `pipeline\src\`, `billing\src\` y `windows-driver\src\` conservando la estructura relativa del
   repo (el motor importa hermanos por ruta relativa), o el árbol `05 VOXORA Meet` completo.
3. Poner `VoxoraMeet.exe` en `<carpeta de la app>\` con `ui\` (copia de `app\ui`) y
   `engine\engine.mjs` al lado, y `VoxoraMeetVCamHost.exe` junto al exe. No hace falta
   `WebView2Loader.dll`; sí el runtime Evergreen de WebView2 (preinstalado en Windows 11).
4. El driver WaveRT (M0) y la cámara virtual (M6) se instalan con sus propios instaladores; la app
   los detecta y lo muestra en las pastillas de estado.

## Cámara virtual siempre activa

Con `cameraAlwaysOn` (ajuste, por defecto `true`), mientras la app esté abierta:

- `VoxoraMeetVCamHost.exe` vive todo el tiempo → «VOXORA Meet Camera» existe siempre para Meet.
- La webcam configurada (o la primera) se captura y se publica **en vivo, con retraso 0**; la luz de la
  webcam queda encendida mientras la app esté abierta (también en la bandeja).
- Al iniciar el doblaje el video pasa a `delayMs` sin cortar la cámara (al subir el retraso el último
  frame queda congelado esos segundos, igual que el audio emite silencio); al detenerlo vuelve a 0.
- Sin `cameraAlwaysOn`: host + webcam solo durante la sesión (comportamiento anterior).

No se puede encender la webcam «solo cuando Meet mira»: medido, la DLL crea y retiene la memoria
compartida en cuanto el FrameServer instancia la fuente al arrancar el host, haya o no apps mirando.

El host se lanza con **stdin por tubería** (extremo de escritura solo en el shell, lista explícita de
handles heredables): el host trata EOF como `stop`, así que si el shell muere sin avisar el sistema
cierra el handle y la cámara se retira sola; al salir el shell manda `stop` y cierra la tubería.
stdout/stderr del host van a un hilo lector (READY y última línea de error para el diagnóstico).

## Sincronía de video

Ver `docs/VIDEO-SYNC.md`: el motor sincroniza solo audio; el shell aplica el mismo `delayMs` al
video con un ring de frames y escribe en la memoria compartida de la cámara virtual.

## Imagen de la cámara (`src/video_effects.*`)

`CameraCapture::captureLoop` procesa cada frame de la webcam **antes** del ring de retraso y de la
cámara virtual, en una sola pasada por píxel del buffer de Media Foundation (BGRX, leído con
`IMF2DBuffer::Lock2D`: primera fila visible + pitch real, lo que corrige la orientación de las webcams
bottom-up) al lienzo RGBA 1280×720:

- **Orientación**: espejo, volteo, rotación 0/90/180/270 (horario).
- **Encuadre**: 16:9 = recorte «cover» que llena el lienzo; 9:16 = recorte vertical centrado en el
  lienzo 16:9 con los laterales hechos de la misma imagen ampliada, difuminada y oscurecida (Meet
  sigue recibiendo 1280×720). Zoom 1–2× con desplazamiento dentro del margen que deja el zoom.
- **Color**: brillo (curva gamma), contraste, temperatura → 3 LUT de 256 entradas; saturación con
  luma BT.601 en punto fijo.
- Geometría separable: tablas por eje (`fila[oy] + columna[ox]`), bilineal en punto fijo o copia
  directa en 1:1; tablas y LUT solo se recalculan al cambiar parámetros o tamaño. Neutro = copia.
- Medido en esta máquina (Ryzen 5 3400G, `shell_selftest bench`, 1280×720): 1,1–1,5 ms/frame con
  brillo o sin efectos, 2,3–3,8 ms con rotación 90°, 9:16, zoom+pan o todo a la vez (a 30 fps el
  presupuesto es 33 ms). `camera.stats.effectsMs/effectsPeakMs` lo muestra en la UI (Avanzado).
- Se aplica **en caliente** (`native.camera.effects` o la respuesta de `settings.get/set`) sin
  reabrir la webcam ni reiniciar el host de la cámara virtual.

## Grabar prueba (`src/test_recording.*`)

MP4 de 10–30 s con exactamente lo que recibe Meet: video = los frames que el hilo de publicación
entrega a la cámara virtual (tras la imagen de la cámara y el retraso vigente; `CameraCapture::setFrameTap`,
intercambio de buffer sin copias), escrito a 30 fps constantes (repite el último; negro si la cámara
virtual no publica); audio = el endpoint de **captura** emparejado con el micrófono virtual
(`devices.list().virtualMic.captureName`: «VOXORA Meet Microphone» o «CABLE Output»; si no se
resuelve, se prueban ambos por nombre) con WASAPI compartido. Sin sesión se graba la imagen y el
silencio del micrófono virtual; con sesión, el doblaje. `IMFSinkWriter` H.264 (hardware si lo hay,
si no software) + AAC (44,1/48 kHz, mono o estéreo según el endpoint) en `%LOCALAPPDATA%\VOXORA Meet\recordings\prueba-AAAAMMDD-HHMMSS.mp4`;
al salir de la app con una prueba en curso, el MP4 se cierra válido. Probado con
`shell_selftest record 10` en esta máquina con la app del usuario abierta: MP4 válido de 10,0 s,
300 frames 1280×720 y AAC 48 kHz estéreo de «CABLE Output (VB-Audio Virtual Cable)» (ese momento
sin frames en la memoria compartida de la cámara virtual → video negro; la ruta con frames reales
—`FrameTap` dentro de la app— queda por verificar al reabrir la app con el exe nuevo).

## Fondos (evaluación, no implementado)

En esta máquina la BRIO 4K (y la cámara virtual) responden `ERROR_NOT_FOUND` (0x80070490) a
`KSPROPERTY_CAMERACONTROL_EXTENDED_BACKGROUNDSEGMENTATION`: no hay Windows Studio Effects (requiere
NPU; el equipo es Ryzen 5 3400G sin NPU). Viable con DirectML (presente, GTX 1050) + ONNX Runtime y un
modelo de segmentación ligero (~256×256, pocos ms/frame en esa GPU), a costa de ~20 MB de runtime y
un modelo que empaquetar.
