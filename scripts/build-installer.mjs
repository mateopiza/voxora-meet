// Compila el instalador propio (installer/): genera la UI autocontenida y, con --payload, incrusta la
// carga útil VXPK en VoxoraMeetSetup.exe.
//
//   node scripts/build-installer.mjs                       vxpack.exe + VoxoraMeetUninstall.exe
//   node scripts/build-installer.mjs --payload <bin> [--out <exe>]
//                                                         + VoxoraMeetSetup.exe con esa carga útil
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWithVcvars } from './lib/msvc.mjs';
import { buildSetupUi } from './lib/setup-ui.mjs';
import { stampVersion } from './stamp-version.mjs';
import { ROOT } from './lib/version.mjs';

export const INSTALLER_DIR = path.join(ROOT, 'installer');

export function buildInstaller({ payload, out, quiet = false } = {}) {
  stampVersion({ quiet: true });
  const ui = buildSetupUi();
  if (!quiet) console.log(`UI del instalador: ${path.relative(ROOT, ui.file)} (${Math.round(ui.bytes / 1024)} KB)`);
  const gen = path.join(INSTALLER_DIR, 'build', 'gen');
  mkdirSync(gen, { recursive: true });
  if (payload) {
    const abs = path.resolve(payload);
    const sha = `${abs}.sha256`;
    if (!existsSync(abs) || !existsSync(sha)) throw new Error(`Falta la carga útil o su .sha256: ${abs}`);
    if (!/^[0-9a-f]{64}$/.test(readFileSync(sha, 'utf8').trim())) throw new Error(`SHA256 inválido en ${sha}`);
    const rcPath = (p) => p.replace(/\\/g, '/');
    writeFileSync(path.join(gen, 'payload.rc'), [
      '// Generado por scripts/build-installer.mjs: carga útil VXPK del layout y su SHA256.',
      `PAYLOAD RCDATA "${rcPath(abs)}"`,
      `PAYLOAD_SHA256 RCDATA "${rcPath(sha)}"`,
      '',
    ].join('\r\n'));
  }
  const status = runWithVcvars(INSTALLER_DIR, 'build.cmd', payload ? ['setup'] : [], { quiet });
  if (status !== 0) throw new Error(`installer/build.cmd falló (código ${status})`);
  const bin = path.join(INSTALLER_DIR, 'bin');
  const result = { vxpack: path.join(bin, 'vxpack.exe'), uninstaller: path.join(bin, 'VoxoraMeetUninstall.exe') };
  if (payload) {
    result.setup = path.join(bin, 'VoxoraMeetSetup.exe');
    if (out) {
      mkdirSync(path.dirname(out), { recursive: true });
      copyFileSync(result.setup, out);
      result.setup = out;
    }
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  try {
    const r = buildInstaller({ payload: opt('--payload'), out: opt('--out') });
    for (const [k, v] of Object.entries(r)) console.log(`${k.padEnd(12)} ${path.relative(ROOT, v)}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
