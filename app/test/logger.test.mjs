import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFileLogger, defaultLogsDir } from '../engine/logger.mjs';
import { vcamHostPath } from '../engine/engine.mjs';

test('defaultLogsDir cuelga de %LOCALAPPDATA%\\VOXORA Meet\\logs (la misma carpeta que el shell)', () => {
  assert.equal(defaultLogsDir({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }), path.join('C:\\Users\\x\\AppData\\Local', 'VOXORA Meet', 'logs'));
});

test('createFileLogger escribe líneas con fecha y nivel y rota por tamaño', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'voxora-log-'));
  try {
    const log = createFileLogger({ dir, name: 'engine', maxBytes: 200, keep: 2, now: () => new Date(2026, 8, 28, 10, 5, 6, 7) });
    log.info('arranque');
    log.error('fallo\nsegunda línea');
    const first = await readFile(path.join(dir, 'engine.log'), 'utf8');
    assert.match(first, /^2026-09-28 10:05:06\.007 \[INFO\] \[pid \d+\] arranque\r\n/);
    assert.match(first, /\[ERROR\] .*fallo\r\n {4}segunda línea\r\n$/);
    for (let i = 0; i < 20; i += 1) log.warn(`línea ${i} ${'x'.repeat(40)}`);
    const files = (await readdir(dir)).sort();
    assert.deepEqual(files, ['engine.1.log', 'engine.2.log', 'engine.log']);
    const current = await readFile(path.join(dir, 'engine.log'), 'utf8');
    assert.ok(Buffer.byteLength(current) < 400, 'el archivo actual se mantiene acotado');
    assert.match(current, /línea 19/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createFileLogger nunca lanza aunque la carpeta no se pueda crear', () => {
  const log = createFileLogger({ dir: path.join('\\\\?\\Z:\\no-existe\0', 'x') });
  assert.doesNotThrow(() => log.info('hola'));
});

test('vcamHostPath apunta al árbol de desarrollo cuando no hay instalación', () => {
  assert.match(vcamHostPath().replaceAll('\\', '/'), /windows-camera\/native\/bin\/VoxoraMeetVCamHost\.exe$/);
});
