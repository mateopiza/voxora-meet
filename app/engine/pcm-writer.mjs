// One consumer per endpoint. A slow monitor never blocks the meeting output.
// On overload stop this destination instead of playing increasingly stale speech.
export class PcmWriter {
  constructor(sink, { sampleRate = 48000, channels = 1, maxQueuedMs = 500, writeTimeoutMs = 2000, onError = () => {}, onWritten = () => {} } = {}) {
    this.sink = sink;
    this.bytesPerMs = sampleRate * channels * 2 / 1000;
    this.maxBytes = Math.ceil(maxQueuedMs * this.bytesPerMs);
    this.writeTimeoutMs = writeTimeoutMs;
    this.onError = onError;
    this.onWritten = onWritten;
    this.queue = [];
    this.bytes = 0;
    this.peakBytes = 0;
    this.active = false;
    this.closed = false;
    this.onSinkError = (error) => this.fail(error);
    this.onSinkClose = () => this.fail(Object.assign(new Error('La salida de audio se desconectó.'), { code: 'audio_output_closed' }));
    sink.on?.('error', this.onSinkError);
    sink.on?.('close', this.onSinkClose);
  }

  enqueue(pcm, metadata) {
    if (this.closed || !pcm.length) return false;
    if (this.bytes + pcm.length > this.maxBytes) {
      this.fail(Object.assign(new Error('La salida de audio no puede seguir el ritmo. El doblaje se detuvo para evitar reproducir voz atrasada.'), { code: 'audio_output_overload' }));
      return false;
    }
    this.queue.push({ pcm, metadata });
    this.bytes += pcm.length;
    this.peakBytes = Math.max(this.peakBytes, this.bytes);
    void this.pump();
    return true;
  }

  async pump() {
    if (this.active || this.closed) return;
    this.active = true;
    try {
      while (!this.closed && this.queue.length) {
        const { pcm, metadata } = this.queue.shift();
        let timer;
        try {
          await Promise.race([
            Promise.resolve().then(() => { if (!this.closed) return this.sink.write(pcm); }),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(Object.assign(new Error('La salida de audio dejó de responder.'), { code: 'audio_output_timeout' })), this.writeTimeoutMs);
              timer.unref?.();
            }),
          ]);
        } finally { clearTimeout(timer); }
        if (!this.closed) {
          this.bytes -= pcm.length;
          this.onWritten(metadata);
        }
      }
    } catch (error) { this.fail(error); }
    finally { this.active = false; }
  }

  fail(error) {
    if (this.closed) return;
    this.stop();
    this.onError(error);
  }

  stop() {
    this.closed = true;
    this.queue.length = 0;
    this.bytes = 0;
  }

  // Call after closing the sink: errors during shutdown must still be consumed.
  dispose() {
    this.stop();
    this.sink.off?.('error', this.onSinkError);
    this.sink.off?.('close', this.onSinkClose);
  }

  stats() { return { queuedMs: this.bytes / this.bytesPerMs, peakQueuedMs: this.peakBytes / this.bytesPerMs, closed: this.closed }; }
}
