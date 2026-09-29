// Lector mínimo de .zip (sin zip64) para extraer node.exe del zip oficial de Node.js sin depender de
// herramientas externas. Verifica el CRC32 de cada entrada extraída.
import zlib from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Lista las entradas del zip: [{ name, method, compressedSize, size, crc32, localOffset }]. */
export function listZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: no se encontró el directorio central');
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(pos) !== CENTRAL) throw new Error('zip: directorio central dañado');
    const method = buf.readUInt16LE(pos + 10);
    const crc32 = buf.readUInt32LE(pos + 16);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new Error('zip: zip64 no soportado');
    entries.push({ name, method, compressedSize, size, crc32, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Extrae una entrada (por nombre exacto) y devuelve su contenido. */
export function extractZipEntry(buf, name) {
  const entry = listZip(buf).find((e) => e.name === name);
  if (!entry) throw new Error(`zip: no existe ${name}`);
  const p = entry.localOffset;
  if (buf.readUInt32LE(p) !== LOCAL) throw new Error('zip: cabecera local dañada');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const raw = buf.subarray(start, start + entry.compressedSize);
  let data;
  if (entry.method === 0) data = Buffer.from(raw);
  else if (entry.method === 8) data = zlib.inflateRawSync(raw);
  else throw new Error(`zip: método de compresión ${entry.method} no soportado`);
  if (data.length !== entry.size) throw new Error(`zip: tamaño inesperado en ${name}`);
  if ((zlib.crc32(data) >>> 0) !== entry.crc32) throw new Error(`zip: CRC32 incorrecto en ${name}`);
  return data;
}
