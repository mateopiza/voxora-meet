// One consumer per endpoint. A slow monitor never blocks the meeting output.
// Speech often arrives in bursts faster than realtime. That audio waits here
// and is written in short slices so the device clock stays the playback pace.
// Only a queue past maxQueuedMs drops the oldest unsent audio. A stalled
// device still stops the destination (write timeout, sink error, or close).
export class PcmWriter {
  constructor(sink, { sampleRate = 48000, channels = 1, maxQueuedMs = 20000, maxWriteMs = 40, writeTimeoutMs = 2000, onError = () => {}, onOverrun = () => {}, onWritten = () => {} } = {}) {
    this.sink = sink;
    this.bytesPerMs = sampleRate * channels * 2 / 1000;
    this.blockAlign = channels * 2;
    this.maxBytes = Math.max(this.blockAlign, Math.ceil(maxQueuedMs * this.bytesPerMs));
    this.maxWriteBytes = Math.max(this.blockAlign, Math.floor(maxWriteMs * this.bytesPerMs / this.blockAlign) * this.blockAlign);
    this.writeTimeoutMs = writeTimeoutMs;
    this.onError = onError;
    this.onOverrun = onOverrun;
    this.onWritten = onWritten;
    this.queue = [];
    this.queuedBytes = 0;
    this.inflightBytes = 0;
    this.droppedBytes = 0;
    this.peakBytes = 0;
    this.lastOverrunAt = 0;
    this.active = false;
    this.closed = false;
    this.onSinkError = (error) => this.fail(error);
    this.onSinkClose = () => this.fail(Object.assign(new Error('La salida de audio se desconectó.'), { code: 'audio_output_closed' }));
    sink.on?.('error', this.onSinkError);
    sink.on?.('close', this.onSinkClose);
  }

  enqueue(pcm, metadata) {
    if (this.closed || !pcm?.length) return false;
    let dropped = 0;
    while (this.queue.length && this.queuedBytes + pcm.length > this.maxBytes) {
      const old = this.queue.shift();
      this.queuedBytes -= old.pcm.length;
      dropped += old.pcm.length;
    }
    this.queue.push({ pcm, metadata });
    this.queuedBytes += pcm.length;
    this.peakBytes = Math.max(this.peakBytes, this.queuedBytes + this.inflightBytes);
    if (dropped) this.noteDrop(dropped);
    void this.pump();
    return true;
  }

  noteDrop(bytes) {
    this.droppedBytes += bytes;
    const now = Date.now();
    if (this.lastOverrunAt && now - this.lastOverrunAt < 15000) return;
    this.lastOverrunAt = now;
    try { this.onOverrun({ droppedMs: bytes / this.bytesPerMs, queuedMs: this.queuedBytes / this.bytesPerMs }); }
    catch { /* el aviso no puede tumbar la reproducción */ }
  }

  async pump() {
    if (this.active || this.closed) return;
    this.active = true;
    try {
      while (!this.closed && this.queue.length) {
        const { pcm, metadata } = this.queue.shift();
        this.queuedBytes -= pcm.length;
        this.inflightBytes += pcm.length;
        let pending = pcm;
        while (pending.length && !this.closed) {
          const slice = pending.subarray(0, Math.min(pending.length, this.maxWriteBytes));
          let timer;
          try {
            await Promise.race([
              Promise.resolve().then(() => { if (!this.closed) return this.sink.write(slice); }),
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(Object.assign(new Error('La salida de audio dejó de responder.'), { code: 'audio_output_timeout' })), this.writeTimeoutMs);
                timer.unref?.();
              }),
            ]);
          } finally { clearTimeout(timer); }
          if (this.closed) return;
          pending = pending.subarray(slice.length);
          this.inflightBytes -= slice.length;
        }
        if (!this.closed) this.onWritten(metadata);
      }
    } catch (error) { this.fail(error); }
    finally {
      this.active = false;
      if (!this.closed && this.queue.length) void this.pump();
    }
  }

  fail(error) {
    if (this.closed) return;
    this.stop();
    this.onError(error);
  }

  stop() {
    this.closed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.inflightBytes = 0;
  }

  // Call after closing the sink: errors during shutdown must still be consumed.
  dispose() {
    this.stop();
    this.sink.off?.('error', this.onSinkError);
    this.sink.off?.('close', this.onSinkClose);
  }

  stats() {
    const queued = this.queuedBytes + this.inflightBytes;
    return {
      queuedMs: queued / this.bytesPerMs,
      peakQueuedMs: this.peakBytes / this.bytesPerMs,
      droppedMs: this.droppedBytes / this.bytesPerMs,
      closed: this.closed,
    };
  }
}
