import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { JsonLinesServer, ProtocolError, createLineSplitter } from '../engine/protocol.mjs';

function makeServer(handlers) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on('data', (chunk) => {
    for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) lines.push(JSON.parse(line));
  });
  const server = new JsonLinesServer({ input, output, handlers }).start();
  const send = (msg) => input.write(`${typeof msg === 'string' ? msg : JSON.stringify(msg)}\n`);
  const flush = () => new Promise((r) => setImmediate(() => setImmediate(r)));
  return { server, input, output, lines, send, flush };
}

test('line splitter: maneja chunks parciales, CRLF y líneas vacías', () => {
  const got = [];
  const push = createLineSplitter((l) => got.push(l));
  push('{"a":1}\r\n{"b"');
  push(':2}\n\n  \n{"c":3}');
  assert.deepEqual(got, ['{"a":1}', '{"b":2}']);
  push('\n');
  assert.deepEqual(got, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test('comando correcto → { id, ok, result }; handlers async y sync', async () => {
  const { lines, send, flush } = makeServer({
    ping: () => ({ pong: true }),
    add: async ({ a, b }) => a + b,
    nothing: () => undefined,
  });
  send({ id: 1, cmd: 'ping' });
  send({ id: 'x', cmd: 'add', params: { a: 2, b: 3 } });
  send({ id: 3, cmd: 'nothing' });
  await flush();
  assert.deepEqual(lines.find((l) => l.id === 1), { id: 1, ok: true, result: { pong: true } });
  assert.deepEqual(lines.find((l) => l.id === 'x'), { id: 'x', ok: true, result: 5 });
  assert.deepEqual(lines.find((l) => l.id === 3), { id: 3, ok: true, result: null });
});

test('errores: JSON inválido, comando desconocido, excepción del handler (sin stack)', async () => {
  const { lines, send, flush } = makeServer({
    boom: () => { throw new ProtocolError('bad_state', 'no se puede', { state: 'running' }); },
    generic: () => { throw new Error('fallo interno'); },
  });
  send('{esto no es json');
  send({ id: 2, cmd: 'nope' });
  send({ id: 3, cmd: 'boom' });
  send({ id: 4, cmd: 'generic' });
  send({ id: 5 });
  await flush();
  assert.equal(lines[0].ok, false);
  assert.equal(lines[0].error.code, 'bad_json');
  assert.deepEqual(lines.find((l) => l.id === 2).error.code, 'unknown_command');
  const boom = lines.find((l) => l.id === 3);
  assert.deepEqual(boom, { id: 3, ok: false, error: { code: 'bad_state', message: 'no se puede', details: { state: 'running' } } });
  const generic = lines.find((l) => l.id === 4);
  assert.equal(generic.error.code, 'internal');
  assert.equal(generic.error.message, 'fallo interno');
  assert.equal('stack' in generic.error, false);
  assert.equal(lines.find((l) => l.id === 5).error.code, 'bad_request');
});

test('emitEvent publica { event, data } y el cierre del input emite close', async () => {
  const { server, input, lines, flush } = makeServer({});
  let closed = false;
  server.on('close', () => { closed = true; });
  server.emitEvent('level', { rmsDb: -20, speaking: true });
  server.emitEvent('status');
  await flush();
  assert.deepEqual(lines, [
    { event: 'level', data: { rmsDb: -20, speaking: true } },
    { event: 'status', data: null },
  ]);
  input.end();
  await flush();
  assert.equal(closed, true);
  assert.equal(server.write({ x: 1 }), false);
});
