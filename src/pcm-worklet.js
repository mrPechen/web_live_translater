// AudioWorklet: микширует вход в моно, ресэмплирует в 16 кГц и отдаёт Int16 блоками.

class PCM16Worklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    this.ratio = sampleRate / this.targetRate;
    this.readPos = 0;
    this.out = [];
    this.outLen = 0;
    this.chunk = opts.chunkSize || 2048;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0]) return true;

    const frameLen = input[0].length;

    let mono;
    if (input.length === 1) {
      mono = input[0];
    } else {
      mono = new Float32Array(frameLen);
      for (let c = 0; c < input.length; c++) {
        const ch = input[c];
        for (let i = 0; i < frameLen; i++) mono[i] += ch[i];
      }
      for (let i = 0; i < frameLen; i++) mono[i] /= input.length;
    }

    // линейный ресэмплер с сохранением дробной позиции между блоками
    while (this.readPos < frameLen) {
      const i0 = Math.floor(this.readPos);
      const frac = this.readPos - i0;
      const s0 = mono[i0] !== undefined ? mono[i0] : 0;
      const s1 = i0 + 1 < frameLen ? mono[i0 + 1] : s0;
      this.out.push(s0 + (s1 - s0) * frac);
      this.readPos += this.ratio;
    }
    this.readPos -= frameLen;
    if (this.readPos < 0) this.readPos = 0;

    this.outLen = this.out.length;
    if (this.outLen < this.chunk) return true;

    const pcm = new Int16Array(this.outLen);
    for (let i = 0; i < this.outLen; i++) {
      let s = this.out[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.out = [];
    this.outLen = 0;
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    return true;
  }
}

registerProcessor('pcm16', PCM16Worklet);
