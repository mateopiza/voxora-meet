// Protocolo JSON-lines por stdio entre el shell nativo y el motor.
//
//   entrada : { id, cmd, params }            → una línea JSON por comando
//   salida  : { id, ok: true, result }       → respuesta correcta
//             { id, ok: false, error: { code, message } }
//             { event, data }                → evento asíncrono del motor
//
// Sin dependencias: `input` es cualquier Readable (stdin), `output` cualquier
// Writable (stdout). Los handlers pueden ser síncronos o devolver promesas.

import { EventEmitter } from 'node:events';
import { friendlyError } from './errors.mjs';

export class ProtocolError extends Error {
  constructor(code, message, details) {
    super(message ?? code);
    this.name = 'ProtocolError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** Serializa un error a la forma del protocolo (nunca filtra stacks al shell). */
export function serializeError(error) {
  if (error instanceof ProtocolError) {
    return { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) };
  }
  // Errores de proveedores/helpers → código estable + mensaje en español.
  const { code, message } = friendlyError(error);
  return { code, message };
}

/**
 * Divide un flujo de bytes en líneas completas (sin el salto de línea).
 * Devuelve una función que recibe chunks y llama `onLine` por cada línea.
 */
export function createLineSplitter(onLine, { maxLineBytes = 64 * 1024 * 1024 } = {}) {
  let pending = '';
  return (chunk) => {
    pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (pending.length > maxLineBytes) {
      pending = '';
      throw new ProtocolError('line_too_long', `línea mayor a ${maxLineBytes} bytes`);
    }
    let index;
    while ((index = pending.indexOf('\n')) !== -1) {
      let line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim()) onLine(line);
    }
  };
}

export class JsonLinesServer extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('node:stream').Readable} options.input
   * @param {import('node:stream').Writable} options.output
   * @param {Record<string, (params: any, ctx: { id: any, server: JsonLinesServer }) => any>} options.handlers
   */
  constructor({ input, output, handlers = {} }) {
    super();
    this.input = input;
    this.output = output;
    this.handlers = handlers;
    this.inFlight = 0;
    this.closed = false;
    this.#splitter = createLineSplitter((line) => this.#onLine(line));
    this.#onData = (chunk) => {
      try {
        this.#splitter(chunk);
      } catch (error) {
        this.write({ id: null, ok: false, error: serializeError(error) });
      }
    };
    this.#onEnd = () => {
      this.closed = true;
      this.emit('close');
    };
  }

  #splitter;
  #onData;
  #onEnd;

  start() {
    this.input.on('data', this.#onData);
    this.input.on('end', this.#onEnd);
    this.input.on('close', this.#onEnd);
    if (typeof this.input.resume === 'function') this.input.resume();
    return this;
  }

  stop() {
    this.input.off('data', this.#onData);
    this.input.off('end', this.#onEnd);
    this.input.off('close', this.#onEnd);
  }

  /** Escribe una línea JSON. Los errores de escritura (pipe roto) cierran el servidor. */
  write(message) {
    if (this.closed) return false;
    try {
      return this.output.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.closed = true;
      this.emit('close', error);
      return false;
    }
  }

  /** Publica un evento `{ event, data }`. */
  emitEvent(event, data) {
    return this.write({ event, data: data ?? null });
  }

  /** Procesa una línea (expuesto para tests). */
  async handleLine(line) {
    return this.#onLine(line);
  }

  async #onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.write({ id: null, ok: false, error: { code: 'bad_json', message: 'línea JSON inválida' } });
      return;
    }
    if (!message || typeof message !== 'object' || typeof message.cmd !== 'string') {
      this.write({ id: message?.id ?? null, ok: false, error: { code: 'bad_request', message: 'se esperaba { id, cmd, params }' } });
      return;
    }
    const { id = null, cmd, params = {} } = message;
    const handler = this.handlers[cmd];
    if (typeof handler !== 'function') {
      this.write({ id, ok: false, error: { code: 'unknown_command', message: `comando desconocido: ${cmd}` } });
      return;
    }
    this.inFlight += 1;
    try {
      const result = await handler(params ?? {}, { id, server: this });
      this.write({ id, ok: true, result: result === undefined ? null : result });
    } catch (error) {
      this.emit('handlerError', { cmd, error });
      this.write({ id, ok: false, error: serializeError(error) });
    } finally {
      this.inFlight -= 1;
    }
  }
}

export default JsonLinesServer;
