// Compila todos los binarios nativos user-mode del proyecto (helpers WASAPI,
// cámara virtual MF, shell Win32, instalador/desinstalador). El driver de kernel NO se compila aquí:
// usa windows-driver/build-driver.cmd (WDK de NuGet; ver windows-driver/README.md).
//
// Antes estampa la versión del package.json raíz en native-common/voxora_version.h (VERSIONINFO).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInstaller } from './build-installer.mjs';
import { runWithVcvars, VCVARS } from './lib/msvc.mjs';
import { stampVersion } from './stamp-version.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const targets = [
  ['capture/native', 'build.cmd'],
  ['windows-driver/native', 'build.cmd'],
  ['windows-camera/native', 'build.cmd'],
  ['app/native-shell', 'build.cmd'],
];

export function buildNative({ log = console.log } = {}) {
  if (process.platform !== 'win32') throw new Error('Los binarios nativos solo se compilan en Windows.');
  if (!existsSync(VCVARS)) throw new Error(`No se encontró vcvars64.bat en ${VCVARS}. Define VOXORA_VCVARS.`);
  const version = stampVersion({ quiet: true });
  log(`Versión ${version.text}`);
  const failed = [];
  for (const [dir, script] of targets) {
    const cwd = path.join(root, dir);
    if (!existsSync(path.join(cwd, script))) {
      log(`[skip] ${dir}: no existe ${script}`);
      continue;
    }
    log(`\n=== ${dir} ===`);
    const status = runWithVcvars(cwd, script);
    if (status !== 0) {
      failed.push(dir);
      console.error(`[fail] ${dir} (exit ${status})`);
    }
  }
  log('\n=== installer (vxpack + desinstalador) ===');
  try {
    buildInstaller();
  } catch (error) {
    failed.push('installer');
    console.error(`[fail] installer: ${error.message}`);
  }
  return failed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(buildNative().length ? 1 : 0);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
