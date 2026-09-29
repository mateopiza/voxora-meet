// Runtime de Node.js que viaja con la app (<instalación>\node\node.exe): binario oficial win-x64 de
// nodejs.org, verificado contra SHASUMS256.txt del mismo release y cacheado en .cache/node/<versión>/.
//
// Versión: package.json → config.nodeRuntime (fija, reproducible) o `lts` (la LTS más reciente).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractZipEntry } from './zip.mjs';
import { ROOT, readPackage } from './version.mjs';

const DIST = 'https://nodejs.org/dist';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function download(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'voxora-meet-release' } });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Resuelve `lts` a la última LTS con build win-x64-zip; deja pasar versiones explícitas. */
export async function resolveNodeVersion(requested) {
  const wanted = String(requested || readPackage().config?.nodeRuntime || 'lts').replace(/^v/, '');
  if (wanted !== 'lts') {
    if (!/^\d+\.\d+\.\d+$/.test(wanted)) throw new Error(`Versión de Node no válida: ${wanted}`);
    return wanted;
  }
  const index = JSON.parse((await download(`${DIST}/index.json`)).toString('utf8'));
  const lts = index.find((r) => r.lts && Array.isArray(r.files) && r.files.includes('win-x64-zip'));
  if (!lts) throw new Error('No se encontró una versión LTS de Node con build win-x64');
  return lts.version.replace(/^v/, '');
}

/** Busca el hash del zip en el contenido de SHASUMS256.txt. */
export function shaFromShasums(text, fileName) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m && m[2] === fileName) return m[1];
  }
  return null;
}

/**
 * Devuelve { version, nodeExe, sha256 } con node.exe verificado (descarga si no está en caché).
 * La caché guarda node.exe + node.exe.sha256 (calculado tras verificar el zip contra SHASUMS256).
 */
export async function ensureNodeRuntime({ version: requested, cacheDir = path.join(ROOT, '.cache', 'node'), log = console.log } = {}) {
  const version = await resolveNodeVersion(requested);
  const dir = path.join(cacheDir, `v${version}`);
  const nodeExe = path.join(dir, 'node.exe');
  const shaFile = `${nodeExe}.sha256`;
  if (existsSync(nodeExe) && existsSync(shaFile)) {
    const expected = readFileSync(shaFile, 'utf8').trim();
    if (sha256(readFileSync(nodeExe)) === expected) return { version, nodeExe, sha256: expected, cached: true };
    log(`La caché de Node ${version} no coincide con su huella: se vuelve a descargar.`);
  }
  mkdirSync(dir, { recursive: true });
  const zipName = `node-v${version}-win-x64.zip`;
  log(`Descargando Node.js ${version} (win-x64) de nodejs.org…`);
  const shasums = (await download(`${DIST}/v${version}/SHASUMS256.txt`)).toString('utf8');
  const expectedZip = shaFromShasums(shasums, zipName);
  if (!expectedZip) throw new Error(`SHASUMS256.txt de Node ${version} no lista ${zipName}`);
  const zip = await download(`${DIST}/v${version}/${zipName}`);
  const actualZip = sha256(zip);
  if (actualZip !== expectedZip) throw new Error(`SHA256 del zip de Node no coincide (esperado ${expectedZip}, obtenido ${actualZip})`);
  const exe = extractZipEntry(zip, `node-v${version}-win-x64/node.exe`);
  writeFileSync(path.join(dir, 'SHASUMS256.txt'), shasums);
  writeFileSync(nodeExe, exe);
  const exeSha = sha256(exe);
  writeFileSync(shaFile, `${exeSha}\n`);
  log(`Node.js ${version} verificado (zip ${actualZip.slice(0, 16)}…) y cacheado en ${path.relative(ROOT, dir)}`);
  return { version, nodeExe, sha256: exeSha, cached: false };
}
