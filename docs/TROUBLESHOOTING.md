# Guía de Resolución de Problemas (Troubleshooting)

Esta guía cubre los problemas y diagnósticos más comunes en **VOXORA Meet**.

---

## 1. Dispositivos Virtuales

### A. "VOXORA Meet Microphone" no aparece en Google Meet
- **Causa**: El driver WaveRT de kernel aún no está firmado por atestación de Microsoft (Milestone M0).
- **Solución temporal recomendada**: Instala **VB-Audio Virtual Cable** (VB-Cable).
  1. Descarga VB-Cable desde `https://vb-audio.com/Cable/`.
  2. Instala como Administrador y reinicia si es necesario.
  3. VOXORA Meet detecta automáticamente «CABLE Input» como salida de doblaje.
  4. En Google Meet, selecciona **CABLE Output** como tu micrófono.
- **Solución para desarrolladores**: Si compilas el driver propio, habilita el modo de pruebas en una VM:
  ```powershell
  bcdedit /set testsigning on
  .\windows-driver\installer\install.ps1
  ```

### B. "VOXORA Meet Camera" muestra la pantalla de espera ("ESPERANDO VIDEO")
- **Causa**: La cámara virtual está activa pero no está recibiendo frames de la webcam física (latido detenido o webcam ocupada).
- **Verificaciones**:
  1. Asegúrate de que ninguna otra aplicación (Zoom, Teams, OBS) tenga abierta la webcam física en modo exclusivo.
  2. En VOXORA Meet, ve a **Ajustes** $\to$ **Cámara** y selecciona manualmente tu webcam en el desplegable.
  3. Revisa en la barra superior de la app que la pastilla de la cámara virtual indique «En vivo» o «Doblaje».
  4. Si la DLL no está registrada en Windows, regístrala con elevación:
     ```powershell
     .\windows-camera\native\bin\VoxoraMeetVCamHost.exe --register-dll
     ```

---

## 2. Audio y Calidad de Doblaje

### A. La voz clonada suena desfasada respecto a los labios
- **Causa**: El retraso temporal configurado (`delayMs`) es menor que el tiempo que tarda la IA en procesar la frase.
- **Solución**:
  - En la pestaña **Reunión** (o en Modo Simple), aumenta el retraso temporal a **3.5 s o 4.0 s**.
  - Si hablas frases muy largas de 10 a 15 segundos, el pipeline requiere más tiempo para transcribir y sintetizar.
  - Verifica que el modelo TTS seleccionado sea rápido (ej. `eleven_multilingual_v2` o `eleven_flash_v2_5`).

### B. Salen frases traducidas que no dijiste (Alucinaciones de Whisper)
- **Causa**: Micrófono con ruido de fondo constante o ganancia muy baja.
- **Solución**:
  1. En la pestaña **Reunión**, revisa el nivel de entrada en reposo (debe estar en la zona verde baja / silencio).
  2. Acerca el micrófono o activa la supresión de ruido física de tu micrófono.
  3. En la pestaña **Traducción**, añade términos comunes en el **Vocabulario STT** para forzar la transcripción exacta de nombres o jerga.

### C. La reunión escucha eco o doble voz
- **Causa**: Google Meet tiene activado un micrófono físico además del micrófono virtual, o la cancelación de ruido de Meet está interfiriendo.
- **Solución**:
  1. En Google Meet $\to$ **Configuración** $\to$ **Audio**, confirma que el **único** micrófono seleccionado sea el virtual («VOXORA Meet Microphone» o «CABLE Output»).
  2. Desactiva la casilla *"Cancelación de ruido"* de Google Meet (puede interpretar la voz sintetizada como ruido si detecta desfase acústico).

---

## 3. Cuentas y Proveedores de IA

### A. Error de autenticación (`provider_auth` / 401)
- **Causa**: La API key de Groq o de ElevenLabs es inválida o ha expirado.
- **Solución**:
  - Ve a **Ajustes** $\to$ **Cuentas** y vuelve a introducir tu API Key.
  - Comprueba el estado de las credenciales desde consola:
    ```bash
    npm run check:providers
    ```

### B. Error de cuota o saldo agotado (`provider_quota` / 429)
- **Causa**: Se ha superado el límite de caracteres en ElevenLabs o de tokens por minuto (TPM) en Groq.
- **Solución**:
  - Revisa tu saldo de caracteres en `elevenlabs.io`.
  - En la pestaña **Modelos**, selecciona un modelo TTS más económico (ej. `eleven_flash_v2_5`, que consume la mitad de caracteres).

---

## 4. Sistema e Instalación

### A. "Falta el entorno Microsoft Edge WebView2"
- **Causa**: El runtime WebView2 Evergreen no está instalado (habitual en versiones antiguas de Windows 10 o Windows Server).
- **Solución**:
  - Descarga e instala el instalador Evergreen Bootstrapper de WebView2 desde:
    `https://developer.microsoft.com/microsoft-edge/webview2/`

### B. Ubicación de Registros (Logs) y Diagnóstico
Si experimentas un cierre inesperado o comportamiento anómalo, consulta los registros generados en:
```
%LOCALAPPDATA%\VOXORA Meet\logs\
```
- `shell.log`: Registro del shell Win32, eventos de WebView2 y captura de webcam (incluye el stderr del motor).
- `engine.log`: Registro del motor Node.js, llamadas a APIs y decisiones de VAD.
- `installer.log`: Registro de instalaciones y actualizaciones automáticas.
- `crash-shell-*.dmp`: Minivolcados de memoria creados automáticamente ante excepciones no controladas.

Puedes abrir esta carpeta directamente desde la aplicación en:
**Ajustes** $\to$ **Aplicación** $\to$ **Abrir carpeta de registros**.

---

## 5. Restablecimiento Completo de Ajustes

Si deseas reiniciar la aplicación al estado original de fábrica:
1. Cierra completamente VOXORA Meet (incluso desde la bandeja del sistema).
2. Abre el Explorador de Windows y elimina (o renombra):
   - `%APPDATA%\VOXORA Meet\settings.json` (ajustes generales).
   - `%APPDATA%\VOXORA Meet\provider-keys.dpapi` (claves API cifradas).
3. Vuelve a iniciar VOXORA Meet.

