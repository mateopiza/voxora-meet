# Versiones, firma, publicación y cómo se comparte

Todo sale de un comando: `npm run release`. El resultado es **un solo archivo**,
`dist/VOXORA-Meet-Setup-<versión>.exe`, firmado, que se comparte por enlace. Después, cada app
instalada se actualiza sola desde el canal de S3 de MEGA.

## 1. Generar una versión

1. Sube la versión en el `package.json` raíz (`"version": "0.3.0"`). Es la **única** fuente: de ahí
   salen el VERSIONINFO de todos los `.exe`/`.dll` (`native-common/voxora_version.h`, lo estampa
   `npm run stamp-version`), la versión que muestra la UI (panel «Acerca de»), el nombre del instalador y
   el `latest.json` del canal.
2. Cierra VOXORA Meet (un exe en ejecución no se puede firmar; para compilar sin cerrarla, renombra los
   exe bloqueados a `*.run.exe`).
3. `npm test` en verde.
4. `npm run release` (ver pasos abajo). Pide un OTP de eSigner por cada binario firmado (8 firmas: 7 internos + instalador,
   36 s entre ellas): quédate frente al PC con la app autenticadora.

`npm run release` = `node scripts/release.mjs`:

| Paso | Qué hace | Saltar |
|---|---|---|
| build | `scripts/build-native.mjs`: helpers WASAPI, cámara virtual, shell, desinstalador y `vxpack` | `--no-build` |
| layout | `dist/VOXORA-Meet-<v>/`: binarios, `engine/engine.mjs` (esbuild en un archivo + javascript-obfuscator 5.4.3), `ui/` (cada módulo ES ofuscado, imports intactos), `node/node.exe` (Node LTS oficial `config.nodeRuntime`, verificado con SHASUMS256, caché en `.cache/node/`). Nunca `.pdb`, `.map` ni pruebas | — |
| sign interno | `scripts/sign.mjs` firma los `.exe`/`.dll` del layout **antes** de empaquetar (helpers → cámara → desinstalador → `VoxoraMeet.exe`); `node.exe` conserva la firma de OpenJS | `--no-sign` |
| package | `vxpack` comprime el layout (LZMS) con SHA256 y lo incrusta en `VoxoraMeetSetup.exe` | — |
| sign instalador | firma `dist/VOXORA-Meet-Setup-<v>.exe` | `--no-sign` |
| verify | `scripts/verify-release.mjs` (abajo) | `--no-verify` |

Otras opciones: `--node-version <x.y.z|lts>`. Además deja `dist/VOXORA-Meet-<v>.release.json` con el
SHA256 del instalador, la carga útil, el Node incluido y la lista de archivos.

`--no-sign` sirve para probar: produce todo igual, pero **no se publica** (las apps rechazan un
instalador sin nuestra firma).

### Qué comprueba `npm run verify:release`

- Layout completo y limpio (sin pdb/map/pruebas/node_modules/.env).
- Ningún JS legible: compacto, sin comentarios ni `sourceMappingURL`, con identificadores ofuscados.
- Ninguna credencial S3 del `.env` dentro del layout ni del instalador.
- VERSIONINFO = versión del `package.json` en todos los binarios propios y el instalador.
- El motor empaquetado arranca con el `node\node.exe` incluido y responde `ping`.
- La UI ofuscada carga en Edge headless (modo simulado del puente) sin errores nuevos respecto de
  `app/ui` ni recursos 404; el grafo de módulos resuelve completo.
- `node.exe` con la firma oficial; con `--signed`, todo lo propio firmado con el thumbprint de
  `docs/SIGNING.md`.
- `VOXORA-Meet-Setup-<v>.exe /extract` (sin elevar) reproduce el layout byte a byte.

## 2. El instalador

`VoxoraMeetSetup.exe` (C++ + WebView2, identidad VØXORA; `installer/`): Bienvenida → Licencia y
privacidad → Ubicación (Program Files) → Progreso → Listo (abrir la app). Pide administrador
(`requireAdministrator`): la DLL de la cámara virtual se registra en HKLM y debe vivir en una ruta
legible por LocalService. Instala en `C:\Program Files\VOXORA Meet`, registra la cámara
(`VoxoraMeetVCamHost.exe --register-dll`), crea accesos directos y la entrada en «Aplicaciones
instaladas» con `VoxoraMeetUninstall.exe`. Si falta el runtime de WebView2 lo avisa; si no hay
micrófono virtual, la pantalla final explica cómo conseguirlo.

| Modo | Uso |
|---|---|
| (sin argumentos) | asistente |
| `/S [/D=<carpeta>] [/relaunch] [/log=<archivo>]` | silencioso (actualizaciones): cierra la app, instala y la reabre |
| `/uninstall [/S] [/purge]` | desinstala; conserva `%APPDATA%`/`%LOCALAPPDATA%\VOXORA Meet` salvo `/purge` o «Borrar mis datos» |
| `/extract <carpeta>` | solo extrae y verifica la carga útil (no toca el sistema) |
| `/preview [/screen=<id>] [/capture=<png>] [/uninstall]` | recorre la UI simulando la instalación; `/capture` guarda una captura |

Para probar `/extract` y `/preview` sin UAC: `set __COMPAT_LAYER=RunAsInvoker` antes de lanzarlo.

## 3. Publicar (auto-actualización)

Canal: `$VOXORA_UPDATE_S3_ENDPOINT/$VOXORA_UPDATE_S3_BUCKET/voxora-meet-updates/` (configura las variables de entorno en `CORE/.env`).
Credenciales: `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` en `CORE/.env`; solo las usa
`scripts/publish.mjs` en esta máquina, nunca viajan en la app.

```
npm run publish:release -- --dry-run                     # todo menos subir: firma, SHA256, credenciales,
                                                          # versión publicada (operaciones de solo lectura)
npm run publish:release -- --notes-file notas-0.3.0.md    # sube de verdad
```

Sube, en este orden: `VOXORA-Meet-Setup-<v>.exe` (inmutable), `VOXORA-Meet-<v>.json` (historial) y
por último `latest.json` (sin caché), todos con lectura pública:

```json
{ "version": "0.3.0", "url": "$VOXORA_UPDATE_S3_ENDPOINT/$VOXORA_UPDATE_S3_BUCKET/voxora-meet-updates/VOXORA-Meet-Setup-0.3.0.exe",
  "sha256": "…", "size": 34000000, "releaseNotes": "…", "minSupportedVersion": "0.0.0",
  "publishedAt": "2026-10-01T12:00:00.000Z" }
```

Se niega a publicar un instalador sin nuestra firma, una versión menor que la publicada o la misma
versión con otro archivo (`--force` para republicar). `--min-supported <v>` marca la actualización como
obligatoria para versiones anteriores (la UI no ofrece «Más tarde»). Al terminar descarga `latest.json`
y el instalador **sin credenciales**, como una app, y compara el SHA256.

**Lectura pública (primera publicación).** Si el bucket no tiene política pública, `publish.mjs` sube con
ACL `public-read`; si el proveedor la ignora, relánzalo con `--apply-public-policy`, que añade al bucket solo
esta regla (sin tocar otras): `s3:GetObject` para `arn:aws:s3:::$VOXORA_UPDATE_S3_BUCKET/voxora-meet-updates/*`.
También puede hacerse desde la consola del proveedor S3.

### En la app (`app/native-shell/src/updater.cpp`)

A los 30 s de abrir y luego cada 6 h lee `latest.json`; si hay una versión mayor descarga el instalador
en `%LOCALAPPDATA%\VOXORA Meet\updates`, comprueba tamaño + SHA256 + Authenticode (WinVerifyTrust y
firmante = thumbprint de `docs/SIGNING.md`) y avisa en la UI. Nunca durante una sesión de doblaje. Al
aceptar, vuelve a verificar, lanza el instalador elevado con `/S /relaunch` y se cierra; el instalador
la reabre. Variables para pruebas: `VOXORA_UPDATE_FEED`, `VOXORA_UPDATE_ALLOW_UNSIGNED=1` (acepta
instaladores sin firma), `VOXORA_UPDATE_DISABLE=1`, `VOXORA_UPDATE_DELAY_MS`, `VOXORA_UPDATE_INTERVAL_MS`.

`npm run test:update-flow` comprueba que el stderr del motor llega a `shell.log` y prueba el actualizador
real (build/tools/updater_selftest.exe) contra un
servidor HTTP local: al día, sin firma, firma de otro emisor, SHA256 alterado, 404, obligatoria, URL
relativa + aplicar (lanza un instalador falso con `/S /relaunch`), aplicar durante una sesión, y la
descarga del instalador real de `dist/`.

## 4. Cómo se comparte

- Se comparte **un único archivo**: `VOXORA-Meet-Setup-<versión>.exe`, firmado. Lo más simple es un
  enlace de descarga (la URL pública del canal o Drive/web propia). No hace falta zip ni Node instalado: el instalador lleva todo.
- Quien lo instala ya no necesita nada más: la app se actualiza sola con cada `publish`.
- **SmartScreen**: con el certificado OV actual, las primeras descargas pueden mostrar «Windows protegió
  su PC» (→ «Más información» → «Ejecutar de todas formas») hasta que el certificado acumule reputación
  por descargas; firmar siempre con el mismo certificado ayuda. Un certificado EV elimina el aviso desde
  el primer día. Nunca compartas builds `--no-sign`.
- El micrófono virtual propio requiere el driver firmado por Microsoft (`docs/SIGNING.md`); mientras
  tanto la app usa VB-Cable, y el instalador explica cómo conseguirlo.

## 5. Estabilidad y diagnóstico

- Registros en `%LOCALAPPDATA%\VOXORA Meet\logs\`: `shell.log` (rota a 2 MiB, 5 archivos; incluye el
  stderr del motor), `engine.log` (rotado), `installer.log` (actualizaciones silenciosas) y
  `crash-shell-*.dmp` (minidump si el shell cae; se conservan 5).
- Si el motor muere, el shell lo relanza con espera creciente (1, 3, 10, 30, 60 s) y lo avisa en la
  UI; tras 5 caídas seguidas queda el botón «Reiniciar motor».
- «Acerca de» → «Abrir carpeta de registros» (comando nativo `native.logs.open`). Pide esa carpeta a
  quien reporte un problema.
