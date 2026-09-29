// Ejecuta un .cmd con el entorno de MSVC (vcvars64). vcvars64 emite avisos que rompen un
// `call … && script` inline y falla desde Git Bash: un .cmd envoltorio con `call` en líneas
// separadas, ejecutado por cmd.exe, es lo único fiable (ver scripts/build-native.mjs).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const VCVARS = process.env.VOXORA_VCVARS
  || String.raw`C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat`;

let wrapperDir = null;

export function runWithVcvars(cwd, script, args = [], { quiet = false } = {}) {
  if (process.platform !== 'win32') throw new Error('Los binarios nativos solo se compilan en Windows.');
  if (!existsSync(VCVARS)) throw new Error(`No se encontró vcvars64.bat en ${VCVARS}. Define VOXORA_VCVARS.`);
  wrapperDir ??= mkdtempSync(path.join(tmpdir(), 'voxora-build-'));
  const wrapper = path.join(wrapperDir, `${path.basename(cwd).replace(/\W+/g, '_')}-${Date.now()}.cmd`);
  writeFileSync(wrapper, [
    '@echo off',
    `call "${VCVARS}" >nul 2>&1`,
    `cd /d "${cwd}"`,
    `call "${path.join(cwd, script)}" ${args.map((a) => `"${a}"`).join(' ')}`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n'));
  const res = spawnSync('cmd.exe', ['/c', wrapper], { cwd, stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (quiet && res.status !== 0) process.stderr.write(`${res.stdout ?? ''}${res.stderr ?? ''}`);
  return res.status ?? 1;
}
