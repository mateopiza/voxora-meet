// Registro a archivo del motor: %LOCALAPPDATA%\VOXORA Meet\logs\engine.log, rotado por tamaño
// (engine.log → engine.1.log → … → engine.<keep>.log). Escritura síncrona (volumen bajo: arranque,
// sesiones, errores y avisos) para no perder la última línea si el proceso cae.
// Nunca lanza: si no se puede escribir, el motor sigue igual.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_KEEP = 4;

/** Carpeta de registros compartida con el shell nativo. */
export function defaultLogsDir(env = process.env) {
  const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'VOXORA Meet', 'logs');
}

function stamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}.${p(date.getMilliseconds(), 3)}`;
}

/**
 * @param {object} options
 * @param {string} options.dir        carpeta de registros (se crea si falta)
 * @param {string} [options.name]     base del archivo (engine → engine.log)
 * @param {number} [options.maxBytes] tamaño a partir del cual se rota
 * @param {number} [options.keep]     archivos rotados que se conservan
 * @param {() => Date} [options.now]  reloj (tests)
 */
export function createFileLogger({ dir, name = 'engine', maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP, now = () => new Date() } = {}) {
  const file = path.join(dir, `${name}.log`);
  const rotated = (i) => path.join(dir, `${name}.${i}.log`);
  let size = 0;
  let ok = true;
  try {
    fs.mkdirSync(dir, { recursive: true });
    size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  } catch {
    ok = false;
  }

  function rotate() {
    try {
      fs.rmSync(rotated(keep), { force: true });
      for (let i = keep - 1; i >= 1; i -= 1) {
        if (fs.existsSync(rotated(i))) fs.renameSync(rotated(i), rotated(i + 1));
      }
      if (fs.existsSync(file)) fs.renameSync(file, rotated(1));
      size = 0;
    } catch {
      // Otro proceso tiene el archivo abierto: se sigue escribiendo en el actual.
    }
  }

  function write(level, message) {
    if (!ok) return;
    const text = String(message ?? '').replace(/\r?\n/g, '\r\n    ');
    const line = `${stamp(now())} [${level}] [pid ${process.pid}] ${text}\r\n`;
    try {
      if (size > maxBytes) rotate();
      fs.appendFileSync(file, line, 'utf8');
      size += Buffer.byteLength(line);
    } catch {
      /* disco lleno o sin permisos: se ignora */
    }
  }

  return {
    file,
    write,
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
  };
}
