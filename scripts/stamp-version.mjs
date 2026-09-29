// Estampa la versión del package.json raíz en native-common/voxora_version.h,
// que incluyen los .rc (VERSIONINFO) de todos los binarios nativos y el shell
// (versión visible en la UI y usada por el actualizador).
//
// Uso: node scripts/stamp-version.mjs   (idempotente: solo reescribe si cambió)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, productVersion, versionHeader } from './lib/version.mjs';

export function stampVersion({ root = ROOT, quiet = false } = {}) {
  const version = productVersion(root);
  const file = path.join(root, 'native-common', 'voxora_version.h');
  const next = versionHeader(version);
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  // El año del copyright no fuerza recompilaciones: se compara sin esa línea.
  const strip = (s) => s.replace(/^#define VOXORA_COPYRIGHT .*$/m, '');
  if (strip(current) !== strip(next)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, next);
    if (!quiet) console.log(`Versión ${version.text} estampada en ${path.relative(root, file)}`);
  } else if (!quiet) {
    console.log(`Versión ${version.text} (sin cambios en ${path.relative(root, file)})`);
  }
  return version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stampVersion();
}
