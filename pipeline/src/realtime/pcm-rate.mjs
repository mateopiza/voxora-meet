// Remuestreo lineal con estado, para audio que llega en trozos (Realtime).

export class PcmRate {
  constructor(fromRate, toRate) {
    this.fromRate = fromRate;
    this.toRate = toRate;
    this.pos = 0;
    this.prev = 0;
    this.hasPrev = false;
  }

  process(pcm) {
    if (!pcm?.byteLength) return Buffer.alloc(0);
    const bytes = pcm.byteLength - (pcm.byteLength % 2);
    if (this.fromRate === this.toRate) return Buffer.from(pcm.subarray(0, bytes));
    const input = new Int16Array(pcm.buffer, pcm.byteOffset, bytes >> 1);
    const step = this.fromRate / this.toRate;
    const out = [];
    let pos = this.pos;
    const at = (index) => {
      if (index >= 0) return input[index];
      return this.hasPrev ? this.prev : input[0] ?? 0;
    };
    const last = input.length - 1;
    while (pos < last) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const sample = at(i) * (1 - frac) + at(i + 1) * frac;
      out.push(Math.max(-32768, Math.min(32767, Math.round(sample))));
      pos += step;
    }
    if (input.length) {
      this.prev = input[input.length - 1];
      this.hasPrev = true;
    }
    this.pos = pos - input.length;
    const buf = Buffer.alloc(out.length * 2);
    for (let n = 0; n < out.length; n += 1) buf.writeInt16LE(out[n], n * 2);
    return buf;
  }
}
