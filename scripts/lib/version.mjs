// Versión única del producto: la del package.json raíz. De aquí salen el
// recurso VERSIONINFO de los binarios nativos (native-common/voxora_version.h),
// el nombre del layout y del instalador, y el `latest.json` de actualizaciones.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Descompone una versión semver `M.m.p[-pre][+build]`. Lanza si no es válida. */
export function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text ?? '').trim());
  if (!m) throw new Error(`Versión no válida (se espera semver M.m.p): ${text}`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if ([major, minor, patch].some((n) => n > 65535)) throw new Error(`Versión fuera de rango para VERSIONINFO: ${text}`);
  const prerelease = m[4] ?? '';
  // 4.º campo numérico de VERSIONINFO: el último número del prerelease (beta.3 → 3), 0 si es final.
  const build = prerelease ? Number(/(\d+)(?!.*\d)/.exec(prerelease)?.[1] ?? 0) % 65536 : 0;
  return { text: m[0], major, minor, patch, prerelease, build };
}

/**
 * Compara dos versiones semver (precedencia de semver 2.0: el prerelease es menor que la final).
 * @returns {-1|0|1}
 */
export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  for (const k of ['major', 'minor', 'patch']) {
    if (va[k] !== vb[k]) return va[k] < vb[k] ? -1 : 1;
  }
  if (va.prerelease === vb.prerelease) return 0;
  if (!va.prerelease) return 1;
  if (!vb.prerelease) return -1;
  const pa = va.prerelease.split('.');
  const pb = vb.prerelease.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]);
    const nb = /^\d+$/.test(pb[i]);
    if (na && nb) {
      if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) < Number(pb[i]) ? -1 : 1;
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}

export function readPackage(root = ROOT) {
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
}

/** Versión del package.json raíz, validada. */
export function productVersion(root = ROOT) {
  return parseVersion(readPackage(root).version);
}

/** Contenido de native-common/voxora_version.h para una versión. */
export function versionHeader(version) {
  const v = typeof version === 'string' ? parseVersion(version) : version;
  const year = new Date().getUTCFullYear();
  return [
    '// Generado por scripts/stamp-version.mjs desde package.json (versión única del producto).',
    '// No editar a mano: `npm run stamp-version` (lo hacen build:native y release).',
    '#pragma once',
    '',
    `#define VOXORA_VERSION_MAJOR ${v.major}`,
    `#define VOXORA_VERSION_MINOR ${v.minor}`,
    `#define VOXORA_VERSION_PATCH ${v.patch}`,
    `#define VOXORA_VERSION_BUILD ${v.build}`,
    `#define VOXORA_VERSION_RC ${v.major},${v.minor},${v.patch},${v.build}`,
    `#define VOXORA_VERSION_STR "${v.text}"`,
    `#define VOXORA_VERSION_WSTR L"${v.text}"`,
    '#define VOXORA_COMPANY "VOXORA"',
    '#define VOXORA_PRODUCT "VOXORA Meet"',
    `#define VOXORA_COPYRIGHT "Copyright (C) ${year} VOXORA"`,
    '',
  ].join('\r\n');
}
