// Utilidades WAV/PCM sin dependencias: envolver PCM s16le en un contenedor
// RIFF/WAVE (lo que esperan Groq Whisper y ElevenLabs para muestras) y leer
// la cabecera de un WAV para conocer duración, sample rate y canales.

const RIFF = "RIFF";
const WAVE = "WAVE";
const FMT = "fmt ";
const DATA = "data";

/** Duración en ms de un bloque PCM entrelazado. */
export function pcmDurationMs(byteLength, { sampleRate, channels = 1, bitsPerSample = 16 } = {}) {
  const rate = Number(sampleRate);
  const bytesPerFrame = channels * (bitsPerSample / 8);
  if (!Number.isFinite(rate) || rate <= 0 || bytesPerFrame <= 0) return 0;
  return (Number(byteLength) / bytesPerFrame / rate) * 1000;
}

/**
 * Envuelve PCM (Buffer/Uint8Array) en un WAV PCM lineal. No copia el audio
 * dos veces: reserva cabecera + datos y escribe una sola vez.
 */
export function pcmToWav(pcm, { sampleRate, channels = 1, bitsPerSample = 16 } = {}) {
  const rate = Number(sampleRate);
  if (!Number.isFinite(rate) || rate <= 0) throw new TypeError("pcmToWav: sampleRate inválido");
  if (![8, 16, 24, 32].includes(bitsPerSample)) throw new TypeError("pcmToWav: bitsPerSample inválido");
  if (!Number.isInteger(channels) || channels < 1) throw new TypeError("pcmToWav: channels inválido");
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm?.buffer ?? pcm, pcm?.byteOffset ?? 0, pcm?.byteLength);
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = rate * blockAlign;
  const header = Buffer.alloc(44);
  header.write(RIFF, 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write(WAVE, 8, "ascii");
  header.write(FMT, 12, "ascii");
  header.writeUInt32LE(16, 16); // tamaño del chunk fmt (PCM)
  header.writeUInt16LE(1, 20); // formato 1 = PCM lineal
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write(DATA, 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Lee la cabecera de un WAV y devuelve `{ format, channels, sampleRate,
 * bitsPerSample, dataOffset, dataBytes, durationMs }`. Recorre los chunks en
 * orden (soporta LIST/JUNK antes de `data`). Lanza si no es RIFF/WAVE válido.
 */
export function readWavInfo(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input?.buffer ?? input, input?.byteOffset ?? 0, input?.byteLength);
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== RIFF || buf.toString("ascii", 8, 12) !== WAVE) {
    throw new Error("readWavInfo: el buffer no es un archivo RIFF/WAVE");
  }
  let offset = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataBytes = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === FMT) {
      if (body + 16 > buf.length) throw new Error("readWavInfo: chunk fmt truncado");
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === DATA) {
      dataOffset = body;
      // Algunos grabadores dejan size=0xFFFFFFFF en streams; se acota al buffer real.
      dataBytes = Math.min(size, buf.length - body);
      break;
    }
    // Los chunks van alineados a 2 bytes.
    offset = body + size + (size % 2);
  }
  if (!fmt) throw new Error("readWavInfo: falta chunk fmt");
  if (dataOffset < 0) throw new Error("readWavInfo: falta chunk data");
  return {
    ...fmt,
    dataOffset,
    dataBytes,
    durationMs: pcmDurationMs(dataBytes, fmt),
  };
}

/** Extrae el PCM crudo de un WAV (sin decodificar formatos comprimidos). */
export function wavToPcm(input) {
  const info = readWavInfo(input);
  if (info.format !== 1) throw new Error(`wavToPcm: formato ${info.format} no soportado (solo PCM lineal)`);
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return { pcm: buf.subarray(info.dataOffset, info.dataOffset + info.dataBytes), ...info };
}
