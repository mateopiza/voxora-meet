// Humo REAL del pipeline (gasta ~1 s de Groq y ~60 caracteres de ElevenLabs):
// genera una frase en español con SAPI (gratis), la transcribe con Groq Whisper,
// la traduce con Groq y sintetiza la traducción con ElevenLabs. Uso:
//   node scripts/smoke-pipeline.mjs [--voice <voiceId>] [--no-tts]
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GroqWhisperStt, ContextTranslator, ElevenLabsTts, wavToPcm, DubbingPipeline,
} from '../pipeline/src/index.mjs';
import { resamplePcm16 } from '../capture/src/resample.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envFile = path.join(root, '..', '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
}
const args = process.argv.slice(2);
const voiceId = args.includes('--voice') ? args[args.indexOf('--voice') + 1] : process.env.ELEVENLABS_VOICE_ID;
const withTts = !args.includes('--no-tts');
const PHRASE = 'Buenos días a todos. Hoy revisaremos el presupuesto del tercer trimestre y los plazos de entrega.';

// 1) Audio de entrada con SAPI (voz es-ES) a 16 kHz mono.
const dir = mkdtempSync(path.join(tmpdir(), 'voxora-meet-smoke-'));
const wavPath = path.join(dir, 'in.wav');
execFileSync('powershell', ['-NoProfile', '-Command', `
  Add-Type -AssemblyName System.Speech
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $v = $s.GetInstalledVoices() | ? { $_.VoiceInfo.Culture.Name -like 'es-*' } | select -First 1
  if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $s.SetOutputToWaveFile('${wavPath.replace(/'/g, "''")}', $fmt)
  $s.Speak('${PHRASE.replace(/'/g, "''")}')
  $s.Dispose()
`], { stdio: 'inherit' });
const wav = wavToPcm(readFileSync(wavPath));
let pcm = wav.pcm;
if (wav.sampleRate !== 16000) pcm = resamplePcm16(pcm, wav.sampleRate, 16000);
const startedAt = performance.now();
const turn = { pcm, sampleRate: 16000, startedAt, endedAt: startedAt + (pcm.byteLength / 32), voicedMs: pcm.byteLength / 32, rmsDb: -20 };
console.log(`Entrada: "${PHRASE}" (${Math.round(turn.voicedMs)} ms de audio SAPI)`);

// 2) Pipeline real.
const stt = new GroqWhisperStt({ language: 'es' });
const translator = new ContextTranslator({ sourceLanguage: 'es', targetLanguage: 'en', tone: 'professional' });
const tts = withTts ? new ElevenLabsTts() : { synthesize: async () => { throw new Error('TTS desactivado (--no-tts)'); } };
if (withTts && !voiceId) { console.error('Falta --voice o ELEVENLABS_VOICE_ID'); process.exit(2); }

const t0 = performance.now();
const transcript = await stt.transcribeTurn({ pcm, sampleRate: 16000 });
const t1 = performance.now();
console.log(`STT (${Math.round(t1 - t0)} ms): "${transcript.text}" conf=${transcript.confidence?.toFixed?.(2) ?? '-'} descartado=${Boolean(transcript.discarded)}`);
if (!transcript.text) process.exit(1);
const translated = await translator.translate({ text: transcript.text });
const t2 = performance.now();
console.log(`Traducción (${Math.round(t2 - t1)} ms, ${translated.model}): "${translated.translation}" tokens=${JSON.stringify(translated.usage)}`);
if (!withTts) process.exit(0);

const pipeline = new DubbingPipeline({ stt, translator, tts, voiceId, sourceLanguage: 'es', targetLanguage: 'en' });
const result = await pipeline.processTurn(turn);
console.log(`Pipeline completo: ${result ? `${result.audioDub.byteLength} bytes PCM @${result.sampleRate} Hz` : 'null'}; costo=${JSON.stringify(result?.cost)}; métricas=${JSON.stringify(pipeline.metrics.last)}`);
