# Ventanas sincronizadas en Meet · 0.3.2

El selector **Segmentos de voz** permite elegir `fixed` (Ventanas sincronizadas, predeterminado) o `pause` (Por pausas). El cambio se guarda y requiere reiniciar la sesión, porque también cambia la concurrencia de la síntesis. Los ajustes existentes de retraso se conservan; las instalaciones nuevas comienzan con 6000 ms.

En `fixed`, la captura se divide sobre el reloj de muestras en bloques consecutivos. El VAD aporta evidencia de voz, pero una pausa no cierra ni reinicia el bloque. Los bloques silenciosos no se envían al proveedor. Cada bloque con voz conserva el instante de inicio real de voz y elimina únicamente el silencio anterior y posterior; las pausas internas siguen en el PCM de transcripción.

La duración de una nueva ventana se calcula como:

```text
reserva = max(1200 ms, P95 de procesamiento + 400 ms)
ventana = floor(clamp(delay - reserva, 500 ms, 4000 ms) / 20) * 20
objetivo ideal del doblaje = inicio original de la voz + delay
```

Hasta tener mediciones se usan 3200 ms de procesamiento. Con 6000 ms de delay, la ventana inicial es de 2400 ms. Con un delay insuficiente se conserva el aviso de presupuesto: el mínimo de 500 ms no garantiza que un proveedor lento alcance el objetivo. La recomendación puede superar el techo de 6000 ms; en ese caso el presupuesto no es alcanzable con la configuración actual.

La medición de procesamiento parte de `capturedUntil`, el cierre del bloque, y termina en `readyAt`; no confunde el silencio final del bloque con latencia del proveedor. Cambiar el delay o recalibrar modifica la próxima ventana, sin recortar la que ya se está capturando. Un hueco en la fuente cierra el audio anterior antes de reanclar el reloj.

STT y traducción mantienen su orden por etapa para preservar contexto. En el modo fijo hay dos solicitudes TTS concurrentes como máximo. `SyncBuffer` ordena los resultados por timestamp fuente, recoloca solo clips que no han comenzado y rechaza una frase antigua si una posterior ya empezó. El desplazamiento máximo al inicio de cada clip se limita a `maxDriftMs` (1500 ms por defecto), también al cambiarlo en caliente. No se acelera ni trunca el audio para forzarlo dentro de la ventana.

La salida PCM continua y el seguimiento de cámara mediante `presentation` permanecen activos. La cámara sigue el progreso del audio escrito, incluyendo la cola del dispositivo y la relación entre duración fuente y duración sintetizada. Esto alinea segmentos; no crea animación labial ni correspondencia fonema a fonema entre idiomas.

## Verificación

Ejecutar la suite con concurrencia 1:

```powershell
node --test --test-concurrency=1 "capture/**/*.test.mjs" "pipeline/**/*.test.mjs" "sync-buffer/**/*.test.mjs" "billing/**/*.test.mjs" "windows-camera/**/*.test.mjs" "app/**/*.test.mjs" "windows-driver/**/*.test.mjs" "scripts/**/*.test.mjs"
```

Las pruebas cubren voz continua, silencios, inicio de voz dentro de una ventana, recalibración, corte por hueco de captura, dos TTS en vuelo, errores de síntesis, llegada en orden inverso, límite de desplazamiento y el recorrido PCM → MicCapture → SessionController → pipeline. La suite usa proveedores simulados; la sincronía audiovisual y la estabilidad deben comprobarse en una llamada real con los proveedores seleccionados.

`node scripts/release.mjs --no-sign` genera el paquete local completo. El paquete sin firma es para revisión local; no se publicó al canal de actualizaciones.
