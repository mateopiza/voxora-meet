import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetryRecorder } from '../engine/engine.mjs';

test('registra turnos y el resumen de la sesión sin texto', () => {
  const lines = [];
  const record = createTelemetryRecorder({ info: (l) => lines.push(JSON.parse(l)) });
  record('status', { state: 'running' });
  record('transcript', { text: 'secreto' });
  record('dub', { turnId: 1, durationMs: 900, late: false, driftMs: 0, metrics: { sttMs: 300, totalMs: 1200 } });
  record('warn', { kind: 'provider', message: 'Groq falló' });
  record('warn', { kind: 'monitor', message: 'ignorado' });
  record('stats', { delayMs: 3000, latencyP95Ms: 1500, lateDubs: 0 });
  record('status', { state: 'idle', reason: 'stopped' });
  assert.deepEqual(lines.map((l) => l.type), ['session-start', 'turn', 'warn', 'session-end']);
  assert.equal(lines[1].timings.sttMs, 300);
  assert.equal(lines[3].latencyP95Ms, 1500);
  assert.ok(!JSON.stringify(lines).includes('secreto'));
});
