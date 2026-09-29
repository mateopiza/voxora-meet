// Prueba de extremo a extremo del actualizador REAL del shell (app/native-shell/src/updater.cpp, vía
// build/tools/updater_selftest.exe) contra un servidor HTTP local que imita el canal de S3:
// latest.json generado con la misma función que scripts/publish.mjs (buildManifest).
//
// Escenarios: al día · firma ausente rechazada · firma de otro emisor rechazada · SHA256 alterado ·
// 404 · versión obligatoria (minSupportedVersion) · URL relativa + aplicar (lanza el «instalador» de
// prueba fake_setup.exe con /S /relaunch y la app pide salir) · aplicar durante una sesión (rechazado) ·
// descarga del instalador real de dist/ (sin aplicarlo). No instala nada ni toca S3.
//
// Uso: node scripts/test-update-flow.mjs   (requiere npm run build:native)
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { buildManifest, installerName } from './publish.mjs';
import { ROOT, productVersion } from './lib/version.mjs';

const TOOLS = path.join(ROOT, 'app', 'native-shell', 'build', 'tools');
const SELFTEST = path.join(TOOLS, 'updater_selftest.exe');
const FAKE_SETUP = path.join(TOOLS, 'fake_setup.exe');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

for (const f of [SELFTEST, FAKE_SETUP]) {
  if (!existsSync(f)) {
    console.error(`Falta ${path.relative(ROOT, f)}: npm run build:native`);
    process.exit(1);
  }
}

const current = productVersion().text;
const NEXT = '99.0.0';
const files = new Map();  // ruta servida → Buffer
const manifests = new Map();  // escenario → objeto latest.json
const requests = [];

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  requests.push(url.pathname);
  const [, scenario, name] = url.pathname.split('/');
  if (name === 'latest.json' && manifests.has(scenario)) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    return res.end(JSON.stringify(manifests.get(scenario)));
  }
  const body = files.get(url.pathname);
  if (!body) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const tmp = mkdtempSync(path.join(os.tmpdir(), 'vx-update-flow-'));

function addScenario(name, { file, version = NEXT, minSupportedVersion, tamper = false, relative = false, missing = false } = {}) {
  const body = readFileSync(file);
  const servedName = installerName(version);
  const servedPath = `/${name}/${servedName}`;
  if (!missing) files.set(servedPath, body);
  const m = buildManifest({
    version,
    url: `${base}${servedPath}`,
    sha256: tamper ? sha256(Buffer.concat([body, Buffer.from('x')])) : sha256(body),
    size: body.length,
    releaseNotes: `Prueba ${name}`,
    ...(minSupportedVersion ? { minSupportedVersion } : {}),
  });
  if (relative) m.url = servedName;  // updater.cpp la resuelve contra la URL del manifiesto
  manifests.set(name, m);
}

function runSelftest(name, { allowUnsigned = false, apply = false, sessionRunning = false, timeoutMs = 120_000 } = {}) {
  const dir = path.join(tmp, name);
  const out = path.join(tmp, `${name}.cmdline.txt`);
  const env = {
    ...process.env,
    VOXORA_UPDATE_FEED: `${base}/${name}/latest.json`,
    VOXORA_UPDATE_DIR: dir,
    VOXORA_UPDATE_DELAY_MS: '10',
    VOXORA_UPDATE_TEST_NO_ELEVATE: '1',
    VOXORA_FAKE_SETUP_OUT: out,
  };
  delete env.VOXORA_UPDATE_DISABLE;
  if (allowUnsigned) env.VOXORA_UPDATE_ALLOW_UNSIGNED = '1'; else delete env.VOXORA_UPDATE_ALLOW_UNSIGNED;
  const args = ['--timeout-ms', String(timeoutMs)];
  if (apply) args.push('--apply');
  if (sessionRunning) args.push('--session-running');
  return new Promise((resolve, reject) => {
    const child = spawn(SELFTEST, args, { env, windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', reject);
    child.on('exit', async (code) => {
      const lines = stdout.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const byKind = (k) => lines.filter((l) => l.kind === k).map((l) => l.data);
      // fake_setup.exe corre aparte: se le da un momento para dejar su línea de comandos.
      for (let i = 0; i < 40 && apply && !existsSync(out); i += 1) await new Promise((r) => setTimeout(r, 100));
      resolve({
        code,
        final: byKind('final').at(-1) ?? byKind('timeout').at(-1) ?? byKind('status').at(-1),
        states: byKind('status').map((s) => s.state),
        apply: byKind('apply').at(-1),
        quit: byKind('quit').at(-1)?.quit,
        setupCmdline: existsSync(out) ? readFileSync(out, 'utf8') : null,
        downloaded: existsSync(dir) ? dir : null,
      });
    });
  });
}

const results = [];
async function check(name, run, expectations) {
  const r = await run();
  const problems = [];
  for (const [label, ok] of expectations(r)) if (!ok) problems.push(label);
  results.push({ name, ok: problems.length === 0 });
  const detail = `estado ${r.final?.state}${r.final?.error?.code ? ` (${r.final.error.code})` : ''}`;
  console.log(`${problems.length ? '✖' : '✔'} ${name}: ${detail}${problems.length ? ` → falla: ${problems.join('; ')}` : ''}`);
  if (problems.length) console.log(`    estados: ${r.states.join(' → ')}; apply: ${JSON.stringify(r.apply)}; salida ${r.code}`);
  return r;
}

const nodeSigned = process.execPath;  // node.exe oficial: firma válida de OpenJS, no de VOXORA
const distSetup = path.join(ROOT, 'dist', installerName(current));

addScenario('uptodate', { file: FAKE_SETUP, version: current });
addScenario('unsigned', { file: FAKE_SETUP });
addScenario('foreign', { file: nodeSigned });
addScenario('tampered', { file: FAKE_SETUP, tamper: true });
addScenario('notfound', { file: FAKE_SETUP, missing: true });
addScenario('mandatory', { file: FAKE_SETUP, minSupportedVersion: '98.0.0' });
addScenario('apply', { file: FAKE_SETUP, relative: true });
addScenario('session', { file: FAKE_SETUP });
if (existsSync(distSetup)) addScenario('real', { file: distSetup });

// Registro del shell: el stderr del motor (OutputDebugString) queda una vez en el .log, sin depurador.
async function logCapture() {
  const logFile = path.join(process.env.LOCALAPPDATA || os.homedir(), 'VOXORA Meet', 'logs', 'log-capture-selftest.log');
  rmSync(logFile, { force: true });
  const code = await new Promise((resolve) => spawn(SELFTEST, ['--log-capture-test'], { windowsHide: true, stdio: 'ignore' }).on('exit', resolve));
  const text = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  rmSync(logFile, { force: true });
  const count = (s) => text.split(s).length - 1;
  return { code, final: { state: code === 0 ? 'ok' : 'error' }, states: [], ansi: count('[stderr] vx-capture-ansi'), wide: count('[engine] vx-capture-wide ñ') };
}

try {
  console.log(`Actualizador ${current} contra ${base} (canal local)\n`);
  await check('registro: stderr del motor capturado en el .log del shell', logCapture, (r) => [
    ['línea ANSI una vez', r.ansi === 1],
    ['línea UTF-16 una vez (sin duplicar)', r.wide === 1],
  ]);
  await check('al día (misma versión)', () => runSelftest('uptodate'), (r) => [
    ['estado uptodate', r.final?.state === 'uptodate'],
    ['no descarga nada', !requests.some((p) => p.startsWith('/uptodate/') && !p.endsWith('latest.json'))],
  ]);
  await check('sin firma → rechazado', () => runSelftest('unsigned'), (r) => [
    ['estado error', r.final?.state === 'error'],
    ['bad_signature', r.final?.error?.code === 'bad_signature'],
  ]);
  await check('firmado por otro emisor (node.exe) → rechazado', () => runSelftest('foreign'), (r) => [
    ['bad_signature', r.final?.error?.code === 'bad_signature'],
    ['menciona otro emisor', /otro emisor/.test(r.final?.error?.message ?? '')],
  ]);
  await check('SHA256 alterado → rechazado', () => runSelftest('tampered', { allowUnsigned: true }), (r) => [
    ['hash_mismatch', r.final?.error?.code === 'hash_mismatch'],
  ]);
  await check('instalador inexistente (404) → error', () => runSelftest('notfound', { allowUnsigned: true }), (r) => [
    ['estado error', r.final?.state === 'error'],
  ]);
  await check('minSupportedVersion > actual → obligatoria', () => runSelftest('mandatory', { allowUnsigned: true }), (r) => [
    ['estado ready', r.final?.state === 'ready'],
    ['mandatory', r.final?.mandatory === true],
  ]);
  await check('URL relativa + aplicar → lanza /S /relaunch y sale', () => runSelftest('apply', { allowUnsigned: true, apply: true }), (r) => [
    ['estado ready', r.states.includes('ready')],
    ['apply ok', r.apply?.ok === true],
    ['la app pide salir', r.quit === true],
    ['instalador lanzado con /S /relaunch', /\s\/S\s+\/relaunch\b/.test(r.setupCmdline ?? '')],
  ]);
  await check('aplicar durante una sesión → rechazado', () => runSelftest('session', { allowUnsigned: true, apply: true, sessionRunning: true }), (r) => [
    ['apply rechazado', r.apply?.ok === false && r.apply?.value?.code === 'session_running'],
    ['no sale', r.quit === false],
    ['no lanza el instalador', r.setupCmdline === null],
  ]);
  if (existsSync(distSetup)) {
    const mb = (statSync(distSetup).size / 1024 / 1024).toFixed(1);
    await check(`instalador real de dist/ (${mb} MB, sin firma → permitido por variable)`, () => runSelftest('real', { allowUnsigned: true }), (r) => [
      ['estado ready', r.final?.state === 'ready'],
      ['versión 99.0.0 disponible', r.final?.available?.version === NEXT],
    ]);
  } else {
    console.log(`- (sin ${path.relative(ROOT, distSetup)}: se omite la descarga del instalador real)`);
  }
} finally {
  server.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? '✖' : '✔'} ${results.length - failed.length}/${results.length} escenarios correctos`);
process.exit(failed.length ? 1 : 0);
