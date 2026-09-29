// Verifica una versión generada por scripts/release.mjs (docs/RELEASE.md) sin tocar el sistema:
//
//   1. layout completo y limpio: binarios, engine/engine.mjs, ui/, node/node.exe; sin .pdb/.map/.ilk/.lib/
//      .exp/.obj, pruebas, fuentes TypeScript ni node_modules
//   2. ningún JS legible: todo .js/.mjs compacto, sin comentarios ni sourceMappingURL y con marcas de
//      javascript-obfuscator; ninguna credencial S3 del .env aparece en el layout ni en el instalador
//   3. VERSIONINFO de los .exe/.dll propios = versión del package.json
//   4. el motor empaquetado arranca con el node\node.exe incluido y responde `ping`
//   5. la UI ofuscada carga en Edge headless (servidor local, modo simulado del puente) sin errores
//      nuevos respecto de app/ui ni recursos 404
//   6. node\node.exe conserva la firma oficial; con --signed, además todo lo propio firmado por nosotros
//   7. el instalador extrae (/extract, sin elevar) exactamente el layout (SHA256 por archivo)
//
// Uso: node scripts/verify-release.mjs [--layout <dir>] [--installer <exe>] [--signed] [--no-ui]
//      (por defecto, dist/VOXORA-Meet-<versión>/ y dist/VOXORA-Meet-Setup-<versión>.exe)
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { loadS3Config, objectUrl } from './lib/s3.mjs';
import { ROOT, productVersion, readPackage } from './lib/version.mjs';
import { SIGNTOOL, isSignedByUs, verify as signtoolVerify } from './sign.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export const REQUIRED = [
  'VoxoraMeet.exe',
  'VoxoraMeetUninstall.exe',
  'wasapi-capture.exe',
  'wasapi-render.exe',
  'VoxoraMeetVCam.dll',
  'VoxoraMeetVCamHost.exe',
  'VoxoraMeetFrameWriter.exe',
  'engine/engine.mjs',
  'ui/index.html',
  'ui/app.js',
  'node/node.exe',
];

export const FORBIDDEN = [
  /\.(pdb|map|ilk|lib|exp|obj|iobj|ipdb|ts|tsx|cjs\.map)$/i,
  /\.(test|spec)\.[cm]?js$/i,
  /(^|\/)node_modules\//i,
  /(^|\/)\.env/i,
  /(^|\/)(package-lock\.json|\.git.*)$/i,
];

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out.sort();
}

/**
 * ¿Parece código ofuscado por javascript-obfuscator (compact) y no fuente legible?
 * @returns {string|null} motivo si es legible
 */
export function readabilityProblem(code) {
  if (/\/\/[#@]\s*sourceMappingURL/.test(code)) return 'incluye sourceMappingURL';
  const lines = code.split('\n').filter((l) => l.trim());
  if (lines.length > 3) return `${lines.length} líneas (se espera código compacto)`;
  // Comentarios reales (no URLs ni regex): `/* … */` o `// ` al inicio de una línea.
  if (/\/\*[\s\S]{2,}?\*\//.test(code.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""'))) return 'contiene comentarios de bloque';
  if (code.length > 400 && !/_vx_[0-9a-f]{8}_0x[0-9a-f]+/.test(code)) return 'sin identificadores ofuscados (_vx_…_0x…)';
  return null;
}

function secretsFrom(cfg) {
  return [cfg.accessKeyId, cfg.secretAccessKey].filter((s) => typeof s === 'string' && s.length >= 12);
}

function versionInfo(files) {
  if (!files.length) return {};
  const script = "$ErrorActionPreference='Stop'; foreach($f in ($env:VX_FILES -split '\\|')) { $v=(Get-Item -LiteralPath $f).VersionInfo; '{0}|{1}|{2}' -f $f,$v.ProductVersion,$v.FileVersion }";
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', env: { ...process.env, VX_FILES: files.join('|') }, timeout: 60_000, windowsHide: true,
  });
  const out = {};
  for (const line of (res.stdout || '').split(/\r?\n/)) {
    const [f, product, file] = line.split('|');
    if (f && product !== undefined) out[f] = { product: product.trim(), file: (file || '').trim() };
  }
  return out;
}

/** Arranca `node engine.mjs` y comprueba `ping`. */
export function pingEngine(nodeExe, engineScript, { timeoutMs = 20_000 } = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'vx-verify-engine-'));
  return new Promise((resolve, reject) => {
    const child = spawn(nodeExe, [engineScript, '--data-dir', path.join(tmp, 'data'), '--log-dir', path.join(tmp, 'logs')], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, LOCALAPPDATA: tmp, APPDATA: tmp },
    });
    let buf = '';
    let stderr = '';
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      const killer = setTimeout(() => child.kill(), 3000);
      child.once('exit', () => {
        clearTimeout(killer);
        rmSync(tmp, { recursive: true, force: true });
        if (err) reject(err); else resolve(value);
      });
      if (child.exitCode !== null) child.emit('exit', child.exitCode);
    };
    const timer = setTimeout(() => finish(new Error(`el motor no respondió a ping en ${timeoutMs / 1000} s. stderr: ${stderr.slice(-400)}`)), timeoutMs);
    child.on('error', (e) => finish(e));
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 'verify-ping') {
          if (msg.ok && msg.result?.pong) finish(null, msg.result);
          else finish(new Error(`ping respondió ${JSON.stringify(msg).slice(0, 300)}`));
        }
      }
    });
    child.on('exit', (code) => {
      if (!done) finish(new Error(`el motor terminó (código ${code}) antes de responder. stderr: ${stderr.slice(-400)}`));
    });
    child.stdin.write(`${JSON.stringify({ id: 'verify-ping', cmd: 'ping', params: {} })}\n`);
  });
}

// ── UI en Edge headless ─────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.webp': 'image/webp', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
};
// La sonda se inyecta antes que app.js (script externo: la CSP solo admite 'self'), recoge errores de
// JS, promesas y recursos, y a los 6 s envía el resultado al servidor local (connect-src 'self').
const PROBE = `(() => {
  const errors = [];
  const push = (m) => { if (errors.length < 50) errors.push(String(m).slice(0, 300)); };
  addEventListener('error', (e) => {
    const t = e.target;
    if (t && t !== window && (t.src || t.href)) push('recurso: ' + (t.src || t.href));
    else push((e.message || e.error) + (e.filename ? ' @ ' + e.filename.split('/').pop() + ':' + e.lineno : ''));
  }, true);
  addEventListener('unhandledrejection', (e) => push('promesa: ' + ((e.reason && (e.reason.message || e.reason)) || '')));
  setTimeout(() => {
    const body = document.body;
    fetch('/__vx_result', { method: 'POST', body: JSON.stringify({
      errors, elements: document.getElementsByTagName('*').length, text: body ? body.innerText.length : 0,
    }) });
  }, 6000);
})();`;

function serveDir(dir, onResult) {
  const missing = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__vx_probe.js') {
      res.writeHead(200, { 'content-type': MIME['.js'] });
      return res.end(PROBE);
    }
    if (url.pathname === '/__vx_result' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        res.writeHead(204);
        res.end();
        try { onResult(JSON.parse(body)); } catch { onResult({ errors: ['resultado ilegible de la sonda'], elements: 0, text: 0 }); }
      });
      return undefined;
    }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(dir, rel);
    if (!file.startsWith(path.resolve(dir)) || !existsSync(file) || statSync(file).isDirectory()) {
      if (!/favicon/.test(rel)) missing.push(rel);
      res.writeHead(404);
      return res.end();
    }
    let body = readFileSync(file);
    if (rel === 'index.html') {
      body = Buffer.from(body.toString('utf8').replace(/<head>/i, '<head><script src="/__vx_probe.js"></script>'));
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, missing })));
}

export function findEdge() {
  const candidates = [
    process.env.VOXORA_EDGE,
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  return candidates.find((p) => p && existsSync(p));
}

function killTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGKILL');
}

/** Carga `dir/index.html` en Edge headless y devuelve { errors, elements, text, missing }. */
export async function probeUi(dir, { edge = findEdge(), timeoutMs = 60_000 } = {}) {
  if (!edge) throw new Error('No se encontró Microsoft Edge (define VOXORA_EDGE)');
  let deliver;
  const result = new Promise((resolve) => { deliver = resolve; });
  const { server, port, missing } = await serveDir(dir, (r) => deliver(r));
  const profile = mkdtempSync(path.join(os.tmpdir(), 'vx-verify-edge-'));
  const child = spawn(edge, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-sync',
    `--user-data-dir=${profile}`, '--window-size=1400,900', `http://127.0.0.1:${port}/index.html`,
  ], { windowsHide: true, stdio: 'ignore' });
  let timer;
  try {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const r = await Promise.race([
      result,
      exited.then(() => ({ errors: ['Edge headless terminó antes de que la sonda respondiera'], elements: 0, text: 0 })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ errors: ['la sonda no respondió (¿la página no cargó?)'], elements: 0, text: 0 }), timeoutMs); }),
    ]);
    return { ...r, missing };
  } finally {
    clearTimeout(timer);
    killTree(child);
    server.close();
    await new Promise((r) => setTimeout(r, 1500));
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* Edge aún suelta archivos: queda en %TEMP% */ }
  }
}

/** Todos los imports relativos de la UI resuelven dentro del layout y el código es JS válido. */
async function checkUiGraph(uiDir) {
  await build({
    entryPoints: [path.join(uiDir, 'app.js')],
    bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent',
    loader: { '.woff2': 'empty', '.svg': 'empty', '.png': 'empty', '.ico': 'empty', '.css': 'empty' },
  });
}

// ── Instalador ──────────────────────────────────────────────────────────────
function runExtract(installer, dir, timeoutMs = 180_000) {
  const res = spawnSync(installer, ['/extract', dir], {
    env: { ...process.env, __COMPAT_LAYER: 'RunAsInvoker' }, timeout: timeoutMs, windowsHide: true,
  });
  if (res.error) throw new Error(`/extract no se pudo ejecutar: ${res.error.message}`);
  return res.status;
}

function treeHashes(dir) {
  return Object.fromEntries(walk(dir).map((rel) => [rel, sha256(readFileSync(path.join(dir, rel)))]));
}

export async function verifyRelease({ layout, installer, expectSigned = false, ui = true, log = console.log } = {}) {
  const version = productVersion().text;
  layout ??= path.join(ROOT, 'dist', `VOXORA-Meet-${version}`);
  installer ??= path.join(ROOT, 'dist', `VOXORA-Meet-Setup-${version}.exe`);
  const failures = [];
  const warnings = [];
  const ok = (m) => log(`  ✔ ${m}`);
  const fail = (m) => { failures.push(m); log(`  ✖ ${m}`); };
  const warn = (m) => { warnings.push(m); log(`  ! ${m}`); };

  if (!existsSync(layout)) throw new Error(`No existe el layout ${layout} (npm run release)`);
  const files = walk(layout);

  // 1. Estructura
  const missing = REQUIRED.filter((f) => !files.includes(f));
  if (missing.length) fail(`faltan en el layout: ${missing.join(', ')}`); else ok(`layout completo (${files.length} archivos)`);
  const forbidden = files.filter((f) => FORBIDDEN.some((re) => re.test(f)));
  if (forbidden.length) fail(`archivos que no deben distribuirse: ${forbidden.slice(0, 10).join(', ')}`); else ok('sin pdb/map/pruebas/fuentes');

  // 2. JS ofuscado y sin secretos
  const jsFiles = files.filter((f) => /\.[cm]?js$/i.test(f));
  const readable = jsFiles.map((f) => [f, readabilityProblem(readFileSync(path.join(layout, f), 'utf8'))]).filter(([, p]) => p);
  if (readable.length) fail(`JS legible: ${readable.map(([f, p]) => `${f} (${p})`).join('; ')}`);
  else ok(`${jsFiles.length} archivos JS, todos ofuscados`);
  const secrets = secretsFrom(loadS3Config());
  if (secrets.length) {
    const scan = files.map((f) => path.join(layout, f)).concat(existsSync(installer) ? [installer] : []);
    const leaks = scan.filter((f) => { const b = readFileSync(f); return secrets.some((s) => b.includes(s) || b.includes(Buffer.from(s, 'utf16le'))); });
    if (leaks.length) fail(`credenciales S3 dentro de: ${leaks.map((f) => path.basename(f)).join(', ')}`);
    else ok('ninguna credencial S3 en el layout ni en el instalador');
  }

  // 2b. Canal de actualizaciones compilado en el shell = config.updateFeed = destino de publish.mjs
  const feed = readPackage().config?.updateFeed;
  const shellExe = path.join(layout, 'VoxoraMeet.exe');
  if (feed && existsSync(shellExe)) {
    const cfg = loadS3Config();
    const publishTarget = objectUrl(cfg, `${cfg.prefix}latest.json`);
    if (!readFileSync(shellExe).includes(Buffer.from(feed, 'utf16le'))) fail(`VoxoraMeet.exe no apunta al canal ${feed}`);
    else if (publishTarget !== feed) fail(`publish.mjs subiría a ${publishTarget}, pero la app lee ${feed}`);
    else ok(`canal de actualizaciones: ${feed}`);
  }

  // 3. VERSIONINFO
  if (process.platform === 'win32') {
    const own = files.filter((f) => /\.(exe|dll)$/i.test(f) && !f.startsWith('node/')).map((f) => path.join(layout, f));
    if (existsSync(installer)) own.push(installer);
    const info = versionInfo(own);
    const bad = own.filter((f) => info[f]?.product !== version);
    if (bad.length) fail(`VERSIONINFO distinto de ${version}: ${bad.map((f) => `${path.basename(f)}=${info[f]?.product || '∅'}`).join(', ')}`);
    else ok(`VERSIONINFO ${version} en ${own.length} binarios`);
  }

  // 4. Motor
  const nodeExe = path.join(layout, 'node', 'node.exe');
  if (existsSync(nodeExe) && existsSync(path.join(layout, 'engine', 'engine.mjs'))) {
    try {
      const pong = await pingEngine(nodeExe, path.join(layout, 'engine', 'engine.mjs'));
      ok(`motor empaquetado responde ping (Node ${pong.node})`);
    } catch (error) {
      fail(`motor empaquetado: ${error.message}`);
    }
  }

  // 5. UI
  if (ui && existsSync(path.join(layout, 'ui', 'app.js'))) {
    try {
      await checkUiGraph(path.join(layout, 'ui'));
      ok('grafo de módulos de la UI completo y sintácticamente válido');
    } catch (error) {
      fail(`grafo de módulos de la UI: ${error.message.split('\n').slice(0, 3).join(' ')}`);
    }
    if (findEdge()) {
      try {
        const packed = await probeUi(path.join(layout, 'ui'));
        const source = await probeUi(path.join(ROOT, 'app', 'ui')).catch(() => null);
        const known = new Set(source?.errors ?? []);
        const norm = (e) => e.replace(/_vx_[0-9a-f]{8}_0x[0-9a-f]+/g, '_').replace(/:\d+$/, '');
        const knownNorm = new Set([...known].map(norm));
        const fresh = packed.errors.filter((e) => !knownNorm.has(norm(e)));
        if (packed.missing.length) fail(`la UI empaquetada pide recursos inexistentes: ${packed.missing.join(', ')}`);
        if (fresh.length) fail(`errores de la UI empaquetada que no tiene app/ui: ${fresh.join(' | ')}`);
        else if (packed.elements < 30 || packed.text < 20) fail(`la UI empaquetada no llegó a renderizar (${packed.elements} elementos)`);
        else ok(`UI empaquetada carga en Edge headless (${packed.elements} elementos${source ? `; app/ui: ${source.elements}` : ''})`);
        if (known.size) warn(`app/ui también registra: ${[...known].join(' | ')}`);
        if (source && Math.abs(source.elements - packed.elements) > Math.max(5, source.elements * 0.02)) {
          warn(`la UI empaquetada (${packed.elements} elementos) difiere de app/ui (${source.elements}); ¿cambió app/ui después del release?`);
        }
      } catch (error) {
        fail(`UI en Edge headless: ${error.message}`);
      }
    } else {
      warn('sin Microsoft Edge: solo se verificó el grafo de módulos de la UI');
    }
  }

  // 6. Firmas
  if (process.platform === 'win32' && existsSync(SIGNTOOL)) {
    if (existsSync(nodeExe)) {
      const r = signtoolVerify(nodeExe);
      if (r.code === 0) ok('node\\node.exe conserva la firma oficial de Node.js'); else fail('node\\node.exe sin firma válida');
    }
    const ownSigned = files.filter((f) => /\.(exe|dll)$/i.test(f) && !f.startsWith('node/')).map((f) => path.join(layout, f));
    if (existsSync(installer)) ownSigned.push(installer);
    const unsigned = ownSigned.filter((f) => !isSignedByUs(f));
    if (expectSigned) {
      if (unsigned.length) fail(`sin firma de VOXORA: ${unsigned.map((f) => path.basename(f)).join(', ')}`);
      else ok(`${ownSigned.length} binarios firmados con el certificado de VOXORA`);
    } else if (unsigned.length) {
      warn(`${unsigned.length}/${ownSigned.length} binarios propios sin firmar (build --no-sign: no publicar)`);
    }
  } else if (expectSigned) {
    fail(`no se encontró signtool (${SIGNTOOL}) para verificar las firmas`);
  }

  // 7. Instalador
  if (existsSync(installer)) {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'vx-verify-extract-'));
    try {
      const code = runExtract(installer, tmp);
      if (code !== 0) {
        fail(`${path.basename(installer)} /extract terminó con código ${code}`);
      } else {
        const expected = treeHashes(layout);
        const got = treeHashes(tmp);
        const diff = [...new Set([...Object.keys(expected), ...Object.keys(got)])].filter((k) => expected[k] !== got[k]);
        if (diff.length) fail(`la carga útil del instalador no coincide con el layout: ${diff.slice(0, 8).join(', ')}`);
        else ok(`el instalador extrae exactamente el layout (${Object.keys(got).length} archivos, SHA256 verificado)`);
      }
    } catch (error) {
      fail(`instalador: ${error.message}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  } else {
    warn(`no existe ${path.basename(installer)}: no se verificó el instalador`);
  }

  if (failures.length) throw new Error(`verify-release: ${failures.length} problema(s)`);
  log(`  verify-release OK${warnings.length ? ` (${warnings.length} aviso(s))` : ''}`);
  return { warnings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? path.resolve(args[i + 1]) : undefined; };
  verifyRelease({ layout: opt('--layout'), installer: opt('--installer'), expectSigned: args.includes('--signed'), ui: !args.includes('--no-ui') })
    .catch((error) => { console.error(`✖ ${error.message}`); process.exit(1); });
}
