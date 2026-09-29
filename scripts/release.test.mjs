// Pruebas de las piezas puras del release: versión, manifiesto del canal, firma SigV4, política
// pública y detección de JS legible. (El flujo completo: npm run release / test:update-flow.)
import assert from 'node:assert/strict';
import test from 'node:test';
import { obfuscate } from './lib/obfuscate.mjs';
import { signRequest } from './lib/s3.mjs';
import { compareVersions, parseVersion, versionHeader } from './lib/version.mjs';
import { buildManifest, publicReadPolicy } from './publish.mjs';
import { readabilityProblem } from './verify-release.mjs';

test('versiones: semver con prerelease y campo VERSIONINFO', () => {
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  assert.equal(compareVersions('0.2.1', '0.2.0'), 1);
  assert.equal(compareVersions('0.3.0-beta.2', '0.3.0'), -1);
  assert.equal(compareVersions('0.3.0-beta.10', '0.3.0-beta.2'), 1);
  assert.equal(parseVersion('1.2.3-rc.4').build, 4);
  assert.throws(() => parseVersion('1.2'));
  assert.match(versionHeader('1.2.3'), /#define VOXORA_VERSION_RC 1,2,3,0/);
});

test('latest.json: campos, validaciones y URL permitidas', () => {
  const m = buildManifest({ version: '0.3.0', url: 'https://s3.g.megas4.com/voixa/voxora-meet-updates/VOXORA-Meet-Setup-0.3.0.exe', sha256: 'a'.repeat(64), size: 10, publishedAt: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(Object.keys(m), ['version', 'url', 'sha256', 'size', 'releaseNotes', 'minSupportedVersion', 'publishedAt']);
  assert.equal(m.minSupportedVersion, '0.0.0');
  assert.throws(() => buildManifest({ ...m, url: 'http://evil.example/x.exe' }), /https/);
  assert.doesNotThrow(() => buildManifest({ ...m, url: 'http://127.0.0.1:8080/x.exe' }));
  assert.throws(() => buildManifest({ ...m, minSupportedVersion: '0.4.0' }), /mayor/);
  assert.throws(() => buildManifest({ ...m, sha256: 'xyz' }), /sha256/);
});

test('SigV4: cabeceras y firma deterministas, estilo de ruta', () => {
  const cfg = { endpoint: 'https://s3.example.com', bucket: 'b', region: 'us-east-1', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', hasCredentials: true };
  const now = new Date('2026-01-02T03:04:05Z');
  const a = signRequest(cfg, { method: 'GET', key: 'p/VOXORA Meet.json', query: { 'list-type': '2' }, now });
  const b = signRequest(cfg, { method: 'GET', key: 'p/VOXORA Meet.json', query: { 'list-type': '2' }, now });
  assert.equal(a.url, 'https://s3.example.com/b/p/VOXORA%20Meet.json?list-type=2');
  assert.equal(a.headers['x-amz-date'], '20260102T030405Z');
  assert.match(a.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260102\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(a.headers.authorization, b.headers.authorization);
  assert.throws(() => signRequest({ ...cfg, hasCredentials: false }), /S3_ACCESS_KEY_ID/);
});

test('política pública: solo el prefijo y sin duplicar ni pisar reglas', () => {
  const cfg = { bucket: 'voixa', prefix: 'voxora-meet-updates/' };
  const p1 = JSON.parse(publicReadPolicy(cfg, null));
  assert.equal(p1.Statement.length, 1);
  assert.deepEqual(p1.Statement[0].Resource, ['arn:aws:s3:::voixa/voxora-meet-updates/*']);
  const other = JSON.stringify({ Version: '2012-10-17', Statement: [{ Sid: 'Otra', Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: 'x' }] });
  const p2 = JSON.parse(publicReadPolicy(cfg, publicReadPolicy(cfg, other)));
  assert.deepEqual(p2.Statement.map((s) => s.Sid), ['Otra', 'VoxoraMeetUpdatesPublicRead']);
});

test('verify-release distingue código legible de ofuscado', () => {
  const source = [0, 1, 2, 3].map((i) => `// Módulo de ejemplo ${i}\nexport function sumaPrecios${i}(items) {\n  let total = ${i};\n  for (const item of items) total += item.precio * ${i + 1};\n  return total;\n}\nexport const nombre${i} = 'VOXORA Meet ${i}';\n`).join('');
  assert.match(readabilityProblem(source), /líneas/);
  assert.equal(readabilityProblem(obfuscate(source.replace(/^\/\/.*$/gm, ''), 'ui/test.js', { target: 'browser' })), null);
  assert.match(readabilityProblem('var a=1;\n//# sourceMappingURL=a.js.map'), /sourceMappingURL/);
});
