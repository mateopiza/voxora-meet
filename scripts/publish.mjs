// Publica una versión de VOXORA Meet en el canal de actualizaciones (docs/RELEASE.md):
//
//   s3://<bucket>/voxora-meet-updates/VOXORA-Meet-Setup-<versión>.exe   (inmutable, caché larga)
//   s3://<bucket>/voxora-meet-updates/VOXORA-Meet-<versión>.json         (historial del manifiesto)
//   s3://<bucket>/voxora-meet-updates/latest.json                        (lo que consultan las apps, sin caché)
//
// latest.json = { version, url, sha256, size, releaseNotes, minSupportedVersion, publishedAt }
// La app (app/native-shell/src/updater.cpp) lo descarga por HTTPS sin credenciales, así que los objetos
// se suben con lectura pública y al final se comprueba con un GET anónimo que el canal responde.
//
// Uso:
//   node scripts/publish.mjs --dry-run                 comprueba todo (firma, SHA256, credenciales y estado
//                                                      remoto con operaciones de solo lectura) sin subir nada
//   node scripts/publish.mjs [--notes "…" | --notes-file notas.md] [--min-supported 0.2.0]
//   opciones: --installer <exe>  --force (republicar la misma versión)  --allow-unsigned (solo pruebas)
//             --apply-public-policy (añade al bucket la política de lectura pública del prefijo si el GET
//             anónimo falla; no toca otras reglas)  --skip-download-check
//
// Credenciales: S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY en CORE/.env (nunca se imprimen).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getObject, headBucket, listObjects, loadS3Config, objectUrl, putObject, signRequest } from './lib/s3.mjs';
import { ROOT, compareVersions, parseVersion, productVersion, readPackage } from './lib/version.mjs';
import { SIGNTOOL, isSignedByUs } from './sign.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export const installerName = (version) => `VOXORA-Meet-Setup-${version}.exe`;

/** Manifiesto del canal (el mismo formato que valida updater.cpp: parseManifest). */
export function buildManifest({ version, url, sha256: hash, size, releaseNotes = '', minSupportedVersion = '0.0.0', publishedAt = new Date().toISOString() }) {
  parseVersion(version);
  parseVersion(minSupportedVersion);
  if (compareVersions(minSupportedVersion, version) > 0) throw new Error(`minSupportedVersion ${minSupportedVersion} es mayor que la versión ${version}`);
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('sha256 no válido');
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('size no válido');
  // Igual que updater.cpp (isAllowedUrl): https, o http solo hacia 127.0.0.1/localhost (pruebas).
  if (!/^https:\/\//.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) throw new Error(`url debe ser https: ${url}`);
  return { version, url, sha256: hash, size, releaseNotes: String(releaseNotes).trim(), minSupportedVersion, publishedAt };
}

/** GET anónimo (como la app). Devuelve { status, body? }. */
async function anonymousGet(url, { asBuffer = false } = {}) {
  try {
    const res = await fetch(url, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(10 * 60_000) });
    const body = asBuffer ? Buffer.from(await res.arrayBuffer()) : await res.text();
    return { status: res.status, body };
  } catch (error) {
    return { status: 0, error: error.message };
  }
}

export function publicReadPolicy(cfg, existing) {
  const resource = `arn:aws:s3:::${cfg.bucket}/${cfg.prefix}*`;
  const policy = existing ? JSON.parse(existing) : { Version: '2012-10-17', Statement: [] };
  policy.Statement = Array.isArray(policy.Statement) ? policy.Statement : [policy.Statement].filter(Boolean);
  if (!policy.Statement.some((s) => s.Sid === 'VoxoraMeetUpdatesPublicRead')) {
    policy.Statement.push({ Sid: 'VoxoraMeetUpdatesPublicRead', Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: [resource] });
  }
  return JSON.stringify(policy);
}

async function applyPublicPolicy(cfg, log) {
  const get = signRequest(cfg, { method: 'GET', query: { policy: '' } });
  const cur = await fetch(get.url, { headers: get.headers });
  const existing = cur.status === 200 ? await cur.text() : null;
  if (cur.status !== 200 && cur.status !== 404) throw new Error(`GetBucketPolicy → HTTP ${cur.status}`);
  const body = Buffer.from(publicReadPolicy(cfg, existing));
  const md5 = createHash('md5').update(body).digest('base64');
  const put = signRequest(cfg, { method: 'PUT', query: { policy: '' }, headers: { 'content-type': 'application/json', 'content-md5': md5 }, payloadHash: sha256(body) });
  const res = await fetch(put.url, { method: 'PUT', headers: put.headers, body });
  if (!res.ok) throw new Error(`PutBucketPolicy → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  log(`  política de lectura pública añadida para ${cfg.bucket}/${cfg.prefix}*`);
}

export async function publish({
  dryRun = false, installer, notes = '', minSupported, force = false, allowUnsigned = false,
  applyPolicy = false, downloadCheck = true, log = console.log,
} = {}) {
  const version = productVersion().text;
  const file = path.resolve(installer || path.join(ROOT, 'dist', installerName(version)));
  const cfg = loadS3Config();
  log(`▶ Publicar VOXORA Meet ${version}${dryRun ? ' (--dry-run: no se sube nada)' : ''}`);
  const channel = objectUrl(cfg, `${cfg.prefix}latest.json`);
  log(`  canal: ${channel}`);
  const appFeed = readPackage().config?.updateFeed;
  if (appFeed && appFeed !== channel) {
    const testChannel = ['ENDPOINT', 'BUCKET', 'PREFIX'].some((k) => process.env[`VOXORA_UPDATE_S3_${k}`]);
    if (!testChannel) throw new Error(`Las apps leen ${appFeed} (package.json config.updateFeed / updater.cpp), no ${channel}`);
    log(`  ! canal de pruebas (VOXORA_UPDATE_S3_*): las apps instaladas leen ${appFeed}`);
  }

  // 1. Instalador local
  if (!existsSync(file)) throw new Error(`No existe ${path.relative(ROOT, file)} (npm run release)`);
  const bytes = readFileSync(file);
  const hash = sha256(bytes);
  log(`  instalador: ${path.basename(file)} · ${(bytes.length / 1024 / 1024).toFixed(1)} MB · SHA256 ${hash}`);
  let signed = false;
  if (process.platform === 'win32' && existsSync(SIGNTOOL)) signed = isSignedByUs(file);
  if (signed) log('  firma Authenticode de VOXORA: verificada');
  else if (allowUnsigned || dryRun) log(`  ! el instalador NO está firmado por VOXORA: las apps lo rechazarían${dryRun ? ' (en --dry-run solo se avisa)' : ''}`);
  else throw new Error('El instalador no está firmado por VOXORA (npm run release, con OTP). Las apps rechazan instaladores sin firma.');

  // 2. Credenciales y estado remoto (solo lectura)
  if (!cfg.hasCredentials) throw new Error('Faltan S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY en CORE/.env');
  await headBucket(cfg);
  log(`  credenciales: válidas (HeadBucket ${cfg.bucket} OK)`);
  const existing = await listObjects(cfg, cfg.prefix);
  log(`  ${cfg.prefix}: ${existing.length} objeto(s)${existing.length ? ` (${existing.slice(-4).map((o) => o.key.slice(cfg.prefix.length)).join(', ')})` : ''}`);
  const remoteText = await getObject(cfg, `${cfg.prefix}latest.json`);
  let remote = null;
  if (remoteText) {
    try { remote = JSON.parse(remoteText); } catch { log('  ! el latest.json remoto no es JSON válido: se reemplazará'); }
  }
  if (remote?.version) {
    log(`  versión publicada: ${remote.version} (${remote.publishedAt || 'sin fecha'})`);
    const cmp = compareVersions(version, remote.version);
    if (cmp < 0) throw new Error(`La versión local ${version} es menor que la publicada ${remote.version}: sube la versión en package.json`);
    if (cmp === 0 && !force) {
      if (remote.sha256 === hash) log('  ! esa versión ya está publicada con este mismo instalador (usa --force para republicar)');
      else throw new Error(`La versión ${version} ya está publicada con otro instalador: sube la versión en package.json (o --force)`);
      if (!dryRun) return { skipped: true };
    }
  } else {
    log('  canal vacío: esta será la primera publicación');
  }
  const latestUrl = objectUrl(cfg, `${cfg.prefix}latest.json`);
  const probe = await anonymousGet(latestUrl);
  log(`  GET anónimo de latest.json hoy: HTTP ${probe.status || probe.error}`);

  // 3. Plan
  const setupKey = `${cfg.prefix}${installerName(version)}`;
  const manifest = buildManifest({
    version,
    url: objectUrl(cfg, setupKey),
    sha256: hash,
    size: bytes.length,
    releaseNotes: notes,
    minSupportedVersion: minSupported || remote?.minSupportedVersion || '0.0.0',
  });
  const manifestBody = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const uploads = [
    { key: setupKey, body: bytes, contentType: 'application/vnd.microsoft.portable-executable', cacheControl: 'public, max-age=31536000, immutable' },
    { key: `${cfg.prefix}VOXORA-Meet-${version}.json`, body: manifestBody, contentType: 'application/json', cacheControl: 'public, max-age=31536000, immutable' },
    { key: `${cfg.prefix}latest.json`, body: manifestBody, contentType: 'application/json', cacheControl: 'no-cache, max-age=0' },
  ];
  log('  latest.json:');
  for (const line of manifestBody.toString('utf8').trim().split('\n')) log(`    ${line}`);
  if (dryRun) {
    for (const u of uploads) log(`  se subiría ${u.key} (${u.body.length} bytes, ${u.cacheControl}, lectura pública)`);
    log('✔ --dry-run completo: nada se ha subido');
    return { dryRun: true, manifest };
  }

  // 4. Subida: primero el instalador, al final latest.json (las apps nunca ven un manifiesto sin archivo).
  let aclEverywhere = true;
  for (const u of uploads) {
    log(`  subiendo ${u.key}…`);
    const r = await putObject(cfg, u.key, u.body, { contentType: u.contentType, cacheControl: u.cacheControl });
    aclEverywhere &&= r.aclApplied;
  }
  if (!aclEverywhere) log('  ! S4 no aceptó la ACL public-read: la lectura pública depende de la política del bucket');

  // 5. Comprobación como cliente: GET anónimo de latest.json y del instalador.
  let check = await anonymousGet(latestUrl);
  if (check.status === 403 && applyPolicy) {
    await applyPublicPolicy(cfg, log);
    check = await anonymousGet(latestUrl);
  }
  if (check.status !== 200) {
    throw new Error(`Subido, pero latest.json no es público (GET anónimo → HTTP ${check.status || check.error}). ` +
      'Vuelve a ejecutar con --apply-public-policy o habilita la lectura pública del prefijo en la consola de MEGA S4 (docs/RELEASE.md).');
  }
  const seen = JSON.parse(check.body);
  if (seen.version !== version || seen.sha256 !== hash) throw new Error(`latest.json público no coincide (versión ${seen.version})`);
  log('  latest.json público: OK');
  if (downloadCheck) {
    const dl = await anonymousGet(manifest.url, { asBuffer: true });
    if (dl.status !== 200 || sha256(dl.body) !== hash) throw new Error(`El instalador público no coincide (HTTP ${dl.status})`);
    log('  instalador público descargado y verificado (SHA256)');
  }
  log(`✔ Publicado ${version}. Las apps instaladas lo detectan en ≤ 6 h (o al abrirse, a los 30 s).`);
  return { manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const notesFile = opt('--notes-file');
  if (notesFile && !existsSync(notesFile)) {
    console.error(`No existe ${notesFile}`);
    process.exit(1);
  }
  publish({
    dryRun: args.includes('--dry-run'),
    installer: opt('--installer'),
    notes: notesFile ? readFileSync(notesFile, 'utf8') : (opt('--notes') ?? ''),
    minSupported: opt('--min-supported'),
    force: args.includes('--force'),
    allowUnsigned: args.includes('--allow-unsigned'),
    applyPolicy: args.includes('--apply-public-policy'),
    downloadCheck: !args.includes('--skip-download-check'),
  }).catch((error) => {
    console.error(`✖ ${error.message}`);
    process.exit(1);
  });
}

