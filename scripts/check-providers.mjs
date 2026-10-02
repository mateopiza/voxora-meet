// Verifica que las keys de proveedor respondan (sin gastar créditos de TTS).
// Lee GROQ_API_KEY, ELEVENLABS_API_KEY y OPENAI_API_KEY (opcional) del entorno o de ../.env (CORE).
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envFile = path.join(root, '..', '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
}

async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`[ok]   ${name}${detail ? ` — ${detail}` : ''}`);
    return true;
  } catch (error) {
    console.log(`[fail] ${name} — ${error.message}`);
    return false;
  }
}

const results = await Promise.all([
  check('Groq (STT + traducción)', async () => {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error('GROQ_API_KEY ausente');
    const res = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const ids = new Set((data.data || []).map((m) => m.id));
    const need = ['whisper-large-v3', process.env.VOXORA_MEET_GROQ_MODEL || 'openai/gpt-oss-120b'];
    const missing = need.filter((id) => !ids.has(id));
    if (missing.length) throw new Error(`modelos no disponibles: ${missing.join(', ')}`);
    return need.join(' + ');
  }),
  check('ElevenLabs (TTS + clonación)', async () => {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error('ELEVENLABS_API_KEY ausente');
    const res = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': key } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const sub = await res.json();
    return `tier ${sub.tier}, ${sub.character_count}/${sub.character_limit} chars, IVC=${sub.can_use_instant_voice_cloning}, PVC=${sub.can_use_professional_voice_cloning}`;
  }),
  // Opcional: solo hace falta si se elige OpenAI como proveedor de transcripción o traducción.
  ...(process.env.OPENAI_API_KEY ? [check('OpenAI (traducción + STT, opcional)', async () => {
    const res = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const ids = new Set((data.data || []).map((m) => m.id));
    const need = ['gpt-4o-transcribe', process.env.VOXORA_MEET_OPENAI_MODEL || 'gpt-4.1'];
    const missing = need.filter((id) => !ids.has(id));
    if (missing.length) throw new Error(`modelos no disponibles: ${missing.join(', ')}`);
    return need.join(' + ');
  })] : []),
]);
process.exit(results.every(Boolean) ? 0 : 1);
