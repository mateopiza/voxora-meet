// Cliente S3 mínimo (AWS Signature V4, estilo de ruta) para el bucket de actualizaciones.
// Sin dependencias: solo node:crypto + fetch. Lo usan scripts/publish.mjs y sus pruebas.
//
// Credenciales: VOXORA_UPDATE_S3_ACCESS_KEY_ID / VOXORA_UPDATE_S3_SECRET_ACCESS_KEY (o S3_* / AWS_*) de, por orden de prioridad,
// process.env > <proyecto>/.env > CORE/.env. Nunca se imprimen ni viajan al cliente: la app solo
// descarga por HTTPS (updater.cpp) lo que publish.mjs deja con lectura pública.
import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './version.mjs';

export const DEFAULTS = {
  endpoint: '',
  bucket: '',
  region: 'us-east-1',
  prefix: 'voxora-meet-updates/',
};

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

export function parseEnvFile(file) {
  const env = {};
  if (!existsSync(file)) return env;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[line.slice(0, eq).trim()] = value;
  }
  return env;
}

/** Configuración S3 (sin validar credenciales). `hasCredentials` indica si están. */
export function loadS3Config({ root = ROOT, env = process.env } = {}) {
  const merged = { ...parseEnvFile(path.join(root, '..', '.env')), ...parseEnvFile(path.join(root, '.env')), ...env };
  const pick = (...names) => names.map((n) => merged[n]).find((v) => typeof v === 'string' && v.trim() !== '')?.trim();
  const cfg = {
    endpoint: (pick('VOXORA_UPDATE_S3_ENDPOINT') || DEFAULTS.endpoint).replace(/\/+$/, ''),
    bucket: pick('VOXORA_UPDATE_S3_BUCKET') || DEFAULTS.bucket,
    region: pick('VOXORA_UPDATE_S3_REGION') || DEFAULTS.region,
    prefix: (pick('VOXORA_UPDATE_S3_PREFIX') || DEFAULTS.prefix).replace(/^\/+/, '').replace(/\/?$/, '/'),
    accessKeyId: pick('VOXORA_UPDATE_S3_ACCESS_KEY_ID', 'S3_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID'),
    secretAccessKey: pick('VOXORA_UPDATE_S3_SECRET_ACCESS_KEY', 'S3_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY'),
  };
  cfg.hasCredentials = Boolean(cfg.accessKeyId && cfg.secretAccessKey);
  return cfg;
}

/** URL pública (estilo de ruta) de una clave del bucket. */
export function objectUrl(cfg, key) {
  return `${cfg.endpoint}/${cfg.bucket}/${encodeKey(key)}`;
}

const encodeRfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encodeKey = (key) => String(key).split('/').map(encodeRfc3986).join('/');

function canonicalQuery(query) {
  return Object.keys(query)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(query[k] ?? '')}`)
    .join('&');
}

/**
 * Firma una petición SigV4. Devuelve { url, headers }.
 * @param {object} cfg  loadS3Config()
 * @param {object} req  { method, key?, query?, headers?, payloadHash?, now? }
 */
export function signRequest(cfg, { method = 'GET', key = '', query = {}, headers = {}, payloadHash, now = new Date() } = {}) {
  if (!cfg.hasCredentials) throw new Error('Faltan S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (CORE/.env)');
  const endpoint = new URL(cfg.endpoint);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const canonicalUri = `/${cfg.bucket}${key ? `/${encodeKey(key)}` : ''}`;
  const hash = payloadHash || sha256Hex('');
  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
    host: endpoint.host, 'x-amz-content-sha256': hash, 'x-amz-date': amzDate };
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((n) => `${n}:${all[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const qs = canonicalQuery(query);
  const canonicalRequest = [method, canonicalUri, qs, canonicalHeaders, signedHeaders, hash].join('\n');
  const scope = `${date}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  let k = hmac(`AWS4${cfg.secretAccessKey}`, date);
  k = hmac(k, cfg.region);
  k = hmac(k, 's3');
  k = hmac(k, 'aws4_request');
  const signature = createHmac('sha256', k).update(stringToSign).digest('hex');
  all.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  delete all.host;
  return { url: `${endpoint.origin}${canonicalUri}${qs ? `?${qs}` : ''}`, headers: all };
}

async function send(cfg, req, body) {
  const { url, headers } = signRequest(cfg, req);
  const res = await fetch(url, { method: req.method, headers, body, signal: AbortSignal.timeout(req.timeoutMs ?? 120_000) });
  const text = req.method === 'HEAD' ? '' : await res.text();
  return { status: res.status, ok: res.ok, headers: res.headers, text };
}

const s3Error = (op, r) => {
  const code = /<Code>([^<]+)<\/Code>/.exec(r.text)?.[1];
  const msg = /<Message>([^<]+)<\/Message>/.exec(r.text)?.[1];
  return new Error(`S3 ${op} → HTTP ${r.status}${code ? ` ${code}` : ''}${msg ? `: ${msg}` : ''}`);
};

/** HeadBucket (solo lectura). */
export async function headBucket(cfg) {
  const r = await send(cfg, { method: 'HEAD' });
  if (!r.ok) throw s3Error('HeadBucket', r);
  return true;
}

/** ListObjectsV2 (solo lectura). Devuelve [{ key, size, lastModified }]. */
export async function listObjects(cfg, prefix = cfg.prefix, { maxKeys = 1000 } = {}) {
  const r = await send(cfg, { method: 'GET', query: { 'list-type': '2', prefix, 'max-keys': String(maxKeys) } });
  if (!r.ok) throw s3Error('ListObjectsV2', r);
  return [...r.text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, c]) => ({
    key: /<Key>([^<]*)<\/Key>/.exec(c)?.[1],
    size: Number(/<Size>(\d+)<\/Size>/.exec(c)?.[1] ?? 0),
    lastModified: /<LastModified>([^<]*)<\/LastModified>/.exec(c)?.[1],
  }));
}

/** GetObject firmado (solo lectura). null si no existe. */
export async function getObject(cfg, key) {
  const r = await send(cfg, { method: 'GET', key });
  if (r.status === 404) return null;
  if (!r.ok) throw s3Error(`GetObject ${key}`, r);
  return r.text;
}

/**
 * PutObject con lectura pública. `body` Buffer. Solo lo usa publish.mjs sin --dry-run.
 * MEGA S4 no admite la cabecera x-amz-acl en todos los planes: si la rechaza (NotImplemented /
 * AccessControlListNotSupported) se reintenta sin ACL y se avisa (la lectura pública debe venir
 * entonces de la política del bucket; publish.mjs lo comprueba con un GET anónimo).
 */
export async function putObject(cfg, key, body, { contentType = 'application/octet-stream', cacheControl, acl = 'public-read' } = {}) {
  const base = { 'content-type': contentType, 'content-length': String(body.length) };
  if (cacheControl) base['cache-control'] = cacheControl;
  const payloadHash = sha256Hex(body);
  const attempt = (headers) => send(cfg, { method: 'PUT', key, headers, payloadHash, timeoutMs: 30 * 60_000 }, body);
  let r = await attempt(acl ? { ...base, 'x-amz-acl': acl } : base);
  let aclApplied = Boolean(acl);
  if (!r.ok && acl && /NotImplemented|AccessControlListNotSupported|InvalidArgument/.test(r.text)) {
    r = await attempt(base);
    aclApplied = false;
  }
  if (!r.ok) throw s3Error(`PutObject ${key}`, r);
  return { etag: r.headers.get('etag'), aclApplied };
}
