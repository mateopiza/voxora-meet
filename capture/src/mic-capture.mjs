// MicCapture — captura de micrófono para VOXORA Meet.
//
// Une una fuente de PCM s16le mono 16 kHz con el `PhraseSegmenter` y re-emite sus eventos
// (`turn`, `level`). La fuente puede ser:
//   - un `Readable` inyectado (`{ source }`): útil en tests o para otras capturas;
//   - el helper nativo `native/bin/wasapi-capture.exe`, lanzado con `--device <id> --rate 16000`,
//     cuyo stdout es PCM crudo. Si el helper muere, se relanza con backoff exponencial.
//
// Eventos: `turn`, `level`, `error`, `started`, `stopped`, `helperLog` (líneas de stderr),
// `helperExit` ({ code, signal, restartInMs }), `sourceEnd`.

import { EventEmitter } from "node:events";
import { spawn as nodeSpawn, execFile as nodeExecFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PhraseSegmenter } from "./phrase-segmenter.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Helper nativo: `VOXORA_MEET_BIN_DIR`, el árbol de desarrollo (native/bin) o, en la app instalada
 * (motor empaquetado en <instalación>\engine\engine.mjs), junto a VoxoraMeet.exe.
 */
export function resolveHelperPath(name, { here = HERE, env = process.env, exists = existsSync } = {}) {
  const dev = path.resolve(here, "..", "native", "bin", name);
  const candidates = [env.VOXORA_MEET_BIN_DIR && path.join(env.VOXORA_MEET_BIN_DIR, name), dev, path.resolve(here, "..", name)];
  return candidates.find((p) => p && exists(p)) ?? dev;
}

export const DEFAULT_HELPER_PATH = resolveHelperPath("wasapi-capture.exe");

const RESTART_DEFAULTS = Object.freeze({
  baseMs: 500, // primera espera
  maxMs: 8000, // tope del backoff
  factor: 2,
  stableAfterMs: 10000, // si el helper vivió al menos esto, el backoff vuelve a empezar
  maxAttempts: Infinity, // reintentos consecutivos antes de rendirse (emite `error` y para)
});

/** Une chunks de stderr y entrega líneas completas. */
function lineSplitter(onLine) {
  let rest = "";
  return (chunk) => {
    rest += chunk.toString("utf8");
    let index;
    while ((index = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, index).replace(/\r$/, "");
      rest = rest.slice(index + 1);
      if (line) onLine(line);
    }
  };
}

export class MicCapture extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {import('node:stream').Readable} [options.source] fuente PCM s16le 16 kHz (si se omite, helper nativo)
   * @param {string} [options.deviceId] id WASAPI del endpoint (omitir = dispositivo por defecto)
   * @param {string} [options.helperPath] ruta al helper nativo
   * @param {number} [options.sampleRate] tasa del PCM (default 16000)
   * @param {object} [options.segmenter] opciones para `PhraseSegmenter`
   * @param {object} [options.restart] política de reinicio del helper (ver RESTART_DEFAULTS)
   * @param {Function} [options.spawn] reemplazo de `child_process.spawn` (tests)
   * @param {Function} [options.clock] reloj monotónico en ms (default `performance.now`)
   */
  constructor(options = {}) {
    super();
    this.source = options.source ?? null;
    this.deviceId = options.deviceId ?? null;
    this.helperPath = options.helperPath ?? DEFAULT_HELPER_PATH;
    this.sampleRate = options.sampleRate ?? 16000;
    this.segmenterOptions = options.segmenter ?? {};
    this.restartPolicy = { ...RESTART_DEFAULTS, ...(options.restart ?? {}) };
    this.spawn = options.spawn ?? nodeSpawn;
    this.clock = options.clock ?? (() => performance.now());

    this.segmenter = null;
    this.running = false;
    this.helper = null;
    this.helperStartedAt = 0;
    this.restartAttempts = 0;
    this.restartTimer = null;
    this.sourceHandlers = null;
  }

  /** Argumentos con los que se lanza el helper (expuesto para diagnóstico/tests). */
  get helperArgs() {
    const args = ["--rate", String(this.sampleRate)];
    if (this.deviceId) args.push("--device", this.deviceId);
    return args;
  }

  /** Cambia los límites de turno (maxTurnMs, endSilenceMs…) en caliente; se recuerdan para el próximo start(). */
  setSegmenterLimits(patch = {}) {
    this.segmenterOptions = { ...this.segmenterOptions, ...patch };
    return this.segmenter ? this.segmenter.setLimits(patch) : this.segmenterOptions;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.segmenter = new PhraseSegmenter({ sampleRate: this.sampleRate, ...this.segmenterOptions });
    this.segmenter.on("turn", (turn) => this.emit("turn", turn));
    this.segmenter.on("level", (level) => this.emit("level", level));
    if (this.source) {
      this.#attachSource(this.source);
    } else {
      this.restartAttempts = 0;
      this.#spawnHelper();
    }
    this.emit("started");
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.source) this.#detachSource();
    this.#killHelper();
    // Cierra el turno en curso para no perder la última frase.
    this.segmenter.flush();
    this.segmenter.removeAllListeners();
    this.segmenter = null;
    this.emit("stopped");
  }

  /** Nivel/estado actual de la compuerta (null si no está capturando). */
  get decision() {
    return this.segmenter?.decision ?? null;
  }

  // --- Fuente inyectada ------------------------------------------------------------------------

  #attachSource(source) {
    const onData = (chunk) => {
      if (this.segmenter) this.segmenter.push(chunk, this.clock());
    };
    const onEnd = () => {
      if (!this.running) return;
      this.segmenter.flush();
      this.emit("sourceEnd");
    };
    const onError = (error) => this.emit("error", error);
    this.sourceHandlers = { onData, onEnd, onError };
    source.on("data", onData);
    source.on("end", onEnd);
    source.on("error", onError);
  }

  #detachSource() {
    if (!this.sourceHandlers) return;
    const { onData, onEnd, onError } = this.sourceHandlers;
    this.source.off("data", onData);
    this.source.off("end", onEnd);
    this.source.off("error", onError);
    this.sourceHandlers = null;
    if (typeof this.source.pause === "function") this.source.pause();
  }

  // --- Helper nativo --------------------------------------------------------------------------

  #spawnHelper() {
    let child;
    try {
      child = this.spawn(this.helperPath, this.helperArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      this.#onHelperFailure(error);
      return;
    }
    this.helper = child;
    this.helperStartedAt = this.clock();
    let spawnFailed = false;

    child.stdout.on("data", (chunk) => {
      if (this.segmenter && this.helper === child) this.segmenter.push(chunk, this.clock());
    });
    if (child.stderr) {
      child.stderr.on("data", lineSplitter((line) => this.emit("helperLog", line)));
    }
    child.on("error", (error) => {
      // ENOENT o permisos: el helper no arrancó. Ambos eventos (error + exit/close) pueden llegar;
      // tratamos el fallo una sola vez.
      spawnFailed = true;
      if (this.helper === child) this.#onHelperFailure(error);
    });
    child.on("exit", (code, signal) => {
      if (spawnFailed || this.helper !== child) return;
      this.helper = null;
      if (!this.running) return;
      // Cierra el turno en curso: el audio siguiente vendrá de un proceso nuevo.
      this.segmenter?.flush();
      this.#scheduleRestart({ code, signal });
    });
  }

  #onHelperFailure(error) {
    this.helper = null;
    if (!this.running) return;
    if (error && error.code === "ENOENT") {
      // Sin binario no tiene sentido reintentar.
      this.emit("error", Object.assign(new Error(`Helper de captura no encontrado: ${this.helperPath}`), {
        code: "HELPER_NOT_FOUND",
        cause: error,
      }));
      this.stop();
      return;
    }
    this.#scheduleRestart({ code: null, signal: null, error });
  }

  #scheduleRestart({ code, signal, error }) {
    const policy = this.restartPolicy;
    const lifetime = this.clock() - this.helperStartedAt;
    if (lifetime >= policy.stableAfterMs) this.restartAttempts = 0;
    if (this.restartAttempts >= policy.maxAttempts) {
      this.emit("error", Object.assign(new Error("El helper de captura falló demasiadas veces seguidas"), {
        code: "HELPER_UNSTABLE",
        exitCode: code,
        signal,
        cause: error,
      }));
      this.stop();
      return;
    }
    const delay = Math.min(policy.maxMs, policy.baseMs * policy.factor ** this.restartAttempts);
    this.restartAttempts += 1;
    this.emit("helperExit", { code, signal, error: error ?? null, restartInMs: delay });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.running) this.#spawnHelper();
    }, delay);
    if (typeof this.restartTimer.unref === "function") this.restartTimer.unref();
  }

  #killHelper() {
    const child = this.helper;
    if (!child) return;
    this.helper = null;
    try {
      child.kill();
    } catch {
      // Ya terminó; nada que hacer.
    }
  }

  /**
   * Lista los endpoints de captura WASAPI ejecutando `wasapi-capture.exe --list`.
   * @returns {Promise<Array<{ id: string, name: string, default: boolean }>>}
   */
  static listDevices({ helperPath = DEFAULT_HELPER_PATH, execFile = nodeExecFile, timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      execFile(helperPath, ["--list"], { timeout: timeoutMs, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout));
          if (!Array.isArray(parsed)) throw new TypeError("la salida de --list no es un array");
          resolve(parsed.map((device) => ({
            id: String(device.id ?? ""),
            name: String(device.name ?? ""),
            default: Boolean(device.default),
          })));
        } catch (parseError) {
          reject(Object.assign(new Error("No se pudo interpretar la lista de dispositivos del helper"), {
            code: "HELPER_BAD_OUTPUT",
            cause: parseError,
          }));
        }
      });
    });
  }
}
