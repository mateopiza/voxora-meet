// Firma Authenticode de los binarios user-mode de VOXORA Meet con el
// certificado de SSL.com eSigner (clave en HSM, accedida por eSigner CKA).
//
// Reglas (docs/SIGNING.md):
//   - Nunca /f ni /p: se firma por thumbprint (/sha1).
//   - eSigner pide un TOTP por firma: ≥ 36 s entre firmas; si responde
//     "The OTP is invalid" se espera y se reintenta sin tocar el CKA.
//   - Una firma solo cuenta si `signtool verify /pa` pasa.
//   - Si un binario se recompila después de firmar, hay que volver a firmarlo
//     (este script re-firma todo lo que no verifique o sea más nuevo que su firma).
//   - Release (docs/RELEASE.md): binarios internos del layout ANTES de empaquetar
//     (--layout), y el instalador al final (--installer).
//
// Uso: node scripts/sign.mjs [--force] [--dry-run] [archivo ...]
//      node scripts/sign.mjs --layout dist/VOXORA-Meet-<versión>     (binarios internos, en orden)
//      node scripts/sign.mjs --installer dist/VOXORA-Meet-Setup-<versión>.exe

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const SIGNTOOL = process.env.VOXORA_SIGNTOOL
  || String.raw`C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe`;
export const THUMBPRINT = process.env.VOXORA_SIGN_THUMBPRINT || 'F105226E95107920D137D7E761C605F0EF30933B';
const TIMESTAMP_URL = 'http://ts.ssl.com';
const MIN_GAP_MS = 36_000;
const MAX_ATTEMPTS = 4;

// Orden: primero lo que otros binarios lanzan o cargan, al final el shell.
const DEFAULT_TARGETS = [
  'capture/native/bin/wasapi-capture.exe',
  'windows-driver/native/bin/wasapi-render.exe',
  'windows-camera/native/bin/VoxoraMeetVCam.dll',
  'windows-camera/native/bin/VoxoraMeetFrameWriter.exe',
  'windows-camera/native/bin/VoxoraMeetVCamHost.exe',
  'app/native-shell/bin/VoxoraMeet.exe',
];

// Binarios internos del layout de instalación, en orden de firma. node\node.exe NO se re-firma:
// conserva la firma oficial de la OpenJS Foundation (verify-release la comprueba).
export const LAYOUT_SIGN_ORDER = [
  'wasapi-capture.exe',
  'wasapi-render.exe',
  'VoxoraMeetVCam.dll',
  'VoxoraMeetFrameWriter.exe',
  'VoxoraMeetVCamHost.exe',
  'VoxoraMeetUninstall.exe',
  'VoxoraMeet.exe',
];

/** .exe/.dll del layout (sin node\) en el orden de firma; los no listados, antes que el shell. */
export function layoutTargets(layoutDir) {
  const found = readdirSync(layoutDir).filter((f) => /\.(exe|dll)$/i.test(f));
  const known = LAYOUT_SIGN_ORDER.filter((f) => found.includes(f));
  const extra = found.filter((f) => !LAYOUT_SIGN_ORDER.includes(f)).sort();
  const ordered = [...known.slice(0, -1), ...extra, ...known.slice(-1)];
  return ordered.map((f) => path.join(layoutDir, f));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// En esta máquina eSigner CKA no logra generar el TOTP automático (su secreto
// configurado no es Base64 válido) y abre una ventana para escribir el OTP a
// mano. Sin alguien que lo escriba, signtool se queda esperando: se corta a
// los 3 minutos para no colgar el proceso.
const SIGN_TIMEOUT_MS = Number(process.env.VOXORA_SIGN_TIMEOUT_MS) || 180_000;

function run(argv, { timeout } = {}) {
  const res = spawnSync(SIGNTOOL, argv, { encoding: 'utf8', windowsHide: false, timeout });
  if (res.error?.code === 'ETIMEDOUT') {
    return { code: -1, out: 'Tiempo agotado esperando a eSigner (¿nadie escribió el OTP en su ventana?)' };
  }
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() };
}

export function verify(file) {
  return run(['verify', '/pa', file]);
}

/** Firmado y verificado con NUESTRO certificado. */
export function isSignedByUs(file) {
  // `verify /v` imprime el "SHA1 hash" de cada certificado de la cadena.
  const res = run(['verify', '/pa', '/v', file]);
  return res.code === 0 && res.out.toUpperCase().includes(THUMBPRINT.toUpperCase());
}

export function checkSigntool() {
  if (process.platform !== 'win32') throw new Error('La firma Authenticode solo corre en Windows.');
  if (!existsSync(SIGNTOOL)) throw new Error(`No se encontró signtool en ${SIGNTOOL}. Define VOXORA_SIGNTOOL.`);
}

let lastSignAt = 0;

/** Firma `files` en orden. Devuelve [{ file, status }] (status empieza por ERROR/falta si falló). */
export async function signFiles(files, { force = false, dryRun = false, log = console.log } = {}) {
  checkSigntool();
  const results = [];
  for (const file of files) {
    const rel = path.relative(root, file);
    if (!existsSync(file)) {
      results.push({ file, rel, status: 'falta (compila primero)' });
      continue;
    }
    if (!force && isSignedByUs(file)) {
      results.push({ file, rel, status: 'ya firmado y verificado' });
      continue;
    }
    if (dryRun) {
      results.push({ file, rel, status: 'se firmaría' });
      continue;
    }

    let signed = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !signed; attempt += 1) {
      const wait = lastSignAt + MIN_GAP_MS - Date.now();
      if (wait > 0) {
        log(`  esperando ${Math.ceil(wait / 1000)} s por el TOTP de eSigner...`);
        await sleep(wait);
      }
      log(`Firmando ${rel} (intento ${attempt}). Si eSigner abre su ventana, escribe el OTP de tu app autenticadora.`);
      const res = run(['sign', '/fd', 'SHA256', '/tr', TIMESTAMP_URL, '/td', 'SHA256', '/sha1', THUMBPRINT, file], { timeout: SIGN_TIMEOUT_MS });
      lastSignAt = Date.now();
      if (res.code !== 0) {
        const otp = /OTP is invalid/i.test(res.out);
        log(`  falló${otp ? ' (OTP inválido, se reintenta tras la pausa)' : ''}: ${res.out.split(/\r?\n/).slice(-2).join(' ')}`);
        if (res.code === -1 || (!otp && attempt >= 2)) break;
        continue;
      }
      const check = verify(file);
      if (check.code === 0) {
        signed = true;
      } else {
        log(`  la verificación falló: ${check.out.split(/\r?\n/).slice(-2).join(' ')}`);
      }
    }
    results.push({ file, rel, status: signed ? 'firmado y verificado' : 'ERROR: sin firma válida' });
  }
  return results;
}

export const failed = (results) => results.some((r) => r.status.startsWith('ERROR') || r.status.startsWith('falta'));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');
  const valueOf = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const layout = valueOf('--layout');
  const installer = valueOf('--installer');
  const skip = new Set([layout, installer].filter(Boolean));
  const explicit = args.filter((a) => !a.startsWith('--') && !skip.has(a));
  let targets;
  if (layout) targets = layoutTargets(path.resolve(root, layout));
  else if (installer) targets = [path.resolve(root, installer)];
  else targets = (explicit.length ? explicit : DEFAULT_TARGETS).map((p) => path.resolve(root, p));
  try {
    const results = await signFiles(targets, { force, dryRun });
    console.log('\nResultado:');
    for (const r of results) console.log(`  ${r.status.padEnd(26)} ${r.rel}`);
    process.exit(failed(results) ? 1 : 0);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
