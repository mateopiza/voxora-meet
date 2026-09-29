// Genera una versión distribuible de VOXORA Meet (docs/RELEASE.md):
//
//   1. versión única del package.json → native-common/voxora_version.h (VERSIONINFO)
//   2. compila los binarios nativos (salvo --no-build)
//   3. arma el layout de instalación dist/VOXORA-Meet-<versión>/:
//        VoxoraMeet.exe, VoxoraMeetUninstall.exe, helpers WASAPI, cámara virtual (DLL + host + writer),
//        engine/engine.mjs (esbuild, un solo archivo, ofuscado), ui/ (módulos ES ofuscados),
//        node/node.exe (LTS oficial de nodejs.org verificado con SHASUMS256, caché en .cache/)
//   4. firma los binarios internos (salvo --no-sign; eSigner pide un OTP por firma)
//   5. empaqueta el layout (VXPK, LZMS) y compila dist/VOXORA-Meet-Setup-<versión>.exe con la carga útil
//   6. firma el instalador (salvo --no-sign)
//   7. verifica el resultado (scripts/verify-release.mjs; salvo --no-verify)
//
// Uso: node scripts/release.mjs [--no-sign] [--no-build] [--no-verify] [--node-version <x.y.z|lts>]
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInstaller } from './build-installer.mjs';
import { buildNative } from './build-native.mjs';
import { ensureNodeRuntime } from './lib/node-runtime.mjs';
import { bundleEngine, obfuscateUiModule } from './lib/obfuscate.mjs';
import { ROOT } from './lib/version.mjs';
import { failed as signFailed, layoutTargets, signFiles } from './sign.mjs';
import { stampVersion } from './stamp-version.mjs';
import { verifyRelease } from './verify-release.mjs';
import { spawnSync } from 'node:child_process';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Binarios nativos del layout: destino ← origen.
export const NATIVE_FILES = [
  ['VoxoraMeet.exe', 'app/native-shell/bin/VoxoraMeet.exe'],
  ['VoxoraMeetUninstall.exe', 'installer/bin/VoxoraMeetUninstall.exe'],
  ['wasapi-capture.exe', 'capture/native/bin/wasapi-capture.exe'],
  ['wasapi-render.exe', 'windows-driver/native/bin/wasapi-render.exe'],
  ['VoxoraMeetVCam.dll', 'windows-camera/native/bin/VoxoraMeetVCam.dll'],
  ['VoxoraMeetVCamHost.exe', 'windows-camera/native/bin/VoxoraMeetVCamHost.exe'],
  ['VoxoraMeetFrameWriter.exe', 'windows-camera/native/bin/VoxoraMeetFrameWriter.exe'],
];

// Nunca en la UI empaquetada.
const UI_EXCLUDE = [/\.test\.[cm]?js$/i, /\.spec\.[cm]?js$/i, /\.map$/i, /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/i, /\.md$/i];

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out.sort();
}

async function buildUi(layoutUi, log) {
  const src = path.join(ROOT, 'app', 'ui');
  let js = 0;
  let other = 0;
  for (const rel of walk(src)) {
    if (UI_EXCLUDE.some((re) => re.test(rel))) continue;
    const from = path.join(src, rel);
    const to = path.join(layoutUi, rel);
    mkdirSync(path.dirname(to), { recursive: true });
    if (/\.m?js$/i.test(rel)) {
      writeFileSync(to, await obfuscateUiModule(readFileSync(from, 'utf8'), rel));
      js += 1;
    } else {
      copyFileSync(from, to);
      other += 1;
    }
  }
  log(`UI: ${js} módulos JS ofuscados, ${other} recursos copiados`);
}

function packLayout(vxpack, layout, payload, log) {
  const res = spawnSync(vxpack, ['pack', layout, payload], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`vxpack falló: ${res.stderr || res.stdout}`);
  const last = res.stdout.trim().split(/\r?\n/).filter((l) => l.includes('VXPK'));
  if (last.length) log(last[last.length - 1].trim());
}

export async function release({ sign = true, build = true, verify = true, nodeVersion, log = console.log } = {}) {
  const version = stampVersion({ quiet: true });
  const v = version.text;
  log(`\n▶ VOXORA Meet ${v}${sign ? '' : ' (sin firma)'}`);
  const dist = path.join(ROOT, 'dist');
  const layout = path.join(dist, `VOXORA-Meet-${v}`);
  const work = path.join(dist, '.work');
  const setupOut = path.join(dist, `VOXORA-Meet-Setup-${v}.exe`);

  if (build) {
    log('\n▶ Compilando binarios nativos');
    const failedTargets = buildNative({ log });
    if (failedTargets.length) throw new Error(`Falló la compilación de: ${failedTargets.join(', ')}`);
  } else {
    log('\n▶ Sin compilar (--no-build): se usan los binarios existentes');
    buildInstaller({ quiet: true });  // la UI del instalador y el desinstalador siguen la versión actual
  }

  log(`\n▶ Layout ${path.relative(ROOT, layout)}`);
  rmSync(layout, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  mkdirSync(layout, { recursive: true });
  mkdirSync(work, { recursive: true });
  for (const [dest, src] of NATIVE_FILES) {
    const from = path.join(ROOT, src);
    if (!existsSync(from)) throw new Error(`Falta ${src} (compila con npm run build:native)`);
    copyFileSync(from, path.join(layout, dest));
  }
  const engine = await bundleEngine();
  mkdirSync(path.join(layout, 'engine'), { recursive: true });
  writeFileSync(path.join(layout, 'engine', 'engine.mjs'), engine.code);
  log(`Motor: ${engine.inputs.length} módulos → engine/engine.mjs (${Math.round(engine.bundledBytes / 1024)} KB → ${Math.round(Buffer.byteLength(engine.code) / 1024)} KB ofuscado)`);
  await buildUi(path.join(layout, 'ui'), log);
  const node = await ensureNodeRuntime({ version: nodeVersion, log });
  mkdirSync(path.join(layout, 'node'), { recursive: true });
  copyFileSync(node.nodeExe, path.join(layout, 'node', 'node.exe'));
  log(`Node.js ${node.version}${node.cached ? ' (caché)' : ''} → node/node.exe`);

  if (sign) {
    log('\n▶ Firmando binarios internos (antes de empaquetar)');
    const results = await signFiles(layoutTargets(layout), { log });
    for (const r of results) log(`  ${r.status.padEnd(26)} ${r.rel}`);
    if (signFailed(results)) throw new Error('La firma de los binarios internos falló (ver docs/SIGNING.md)');
  }

  log('\n▶ Empaquetando e integrando el instalador');
  const payload = path.join(work, `payload-${v}.bin`);
  const { vxpack } = buildInstaller({ quiet: true });
  packLayout(vxpack, layout, payload, log);
  buildInstaller({ payload, out: setupOut, quiet: true });
  log(`Instalador: ${path.relative(ROOT, setupOut)} (${(statSync(setupOut).size / 1024 / 1024).toFixed(1)} MB)`);

  if (sign) {
    log('\n▶ Firmando el instalador');
    const results = await signFiles([setupOut], { log });
    for (const r of results) log(`  ${r.status.padEnd(26)} ${r.rel}`);
    if (signFailed(results)) throw new Error('La firma del instalador falló');
  }

  const setupBytes = readFileSync(setupOut);
  const summary = {
    product: 'VOXORA Meet',
    version: v,
    builtAt: new Date().toISOString(),
    signed: sign,
    node: { version: node.version, sha256: node.sha256 },
    installer: { file: path.basename(setupOut), size: setupBytes.length, sha256: sha256(setupBytes) },
    payload: { sha256: readFileSync(`${payload}.sha256`, 'utf8').trim(), size: statSync(payload).size },
    engineModules: engine.inputs,
    layout: walk(layout).map((rel) => ({ path: rel, size: statSync(path.join(layout, rel)).size })),
  };
  const summaryFile = path.join(dist, `VOXORA-Meet-${v}.release.json`);
  writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
  log(`Resumen: ${path.relative(ROOT, summaryFile)} (SHA256 del instalador ${summary.installer.sha256})`);

  if (verify) {
    log('\n▶ Verificando');
    await verifyRelease({ layout, installer: setupOut, expectSigned: sign, log });
  }
  log(`\n✔ Listo: ${path.relative(ROOT, setupOut)}${sign ? '' : ' (SIN FIRMA: no publicar)'}`);
  return { layout, installer: setupOut, summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--node-version');
  release({
    sign: !args.includes('--no-sign'),
    build: !args.includes('--no-build'),
    verify: !args.includes('--no-verify'),
    nodeVersion: i >= 0 ? args[i + 1] : undefined,
  }).catch((error) => {
    console.error(`\n✖ ${error.message}`);
    process.exit(1);
  });
}
