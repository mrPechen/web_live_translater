// Простая энергетическая сегментация: режем поток на фразы по паузам.
// Работает на Int16 PCM при 16 кГц.

import { concatPCM } from './wav.mjs';

function rms(pcm, from, to) {
  let sum = 0;
  for (let i = from; i < to; i++) {
    const v = pcm[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / Math.max(1, to - from));
}

export class Segmenter {
  constructor(opts = {}) {
    this.sampleRate = opts.sampleRate ?? 16000;
    this.frameSize = Math.round(this.sampleRate * 0.02); // 20 мс
    this.frameMs = 20;
    this.threshold = opts.threshold ?? 0.012; // ~ -38 dBFS
    this.silenceMs = opts.silenceMs ?? 600; // сколько тишины завершает фразу
    this.minSpeechMs = opts.minSpeechMs ?? 700; // короче — шум, не отправляем
    this.maxChunkMs = opts.maxChunkMs ?? 12000; // принудительный разрез
    this.reset();
  }

  reset() {
    this.pieces = [];
    this.length = 0;
    this.speechMs = 0;
    this.silenceRun = 0;
    this.hasSpeech = false;
  }

  /**
   * @param {Int16Array} int16
   * @returns {Int16Array[]} готовые фразы (0 или 1 обычно)
   */
  push(int16) {
    if (!int16 || !int16.length) return [];
    this.pieces.push(int16);
    this.length += int16.length;

    for (let i = 0; i + this.frameSize <= int16.length; i += this.frameSize) {
      const level = rms(int16, i, i + this.frameSize);
      if (level >= this.threshold) {
        this.hasSpeech = true;
        this.speechMs += this.frameMs;
        this.silenceRun = 0;
      } else {
        this.silenceRun += this.frameMs;
      }
    }

    const totalMs = (this.length / this.sampleRate) * 1000;

    if (this.hasSpeech && this.silenceRun >= this.silenceMs && this.speechMs >= this.minSpeechMs) {
      return [this.take()];
    }
    if (this.hasSpeech && totalMs >= this.maxChunkMs) {
      return [this.take()];
    }
    if (!this.hasSpeech && totalMs > this.maxChunkMs) {
      this.reset(); // сплошная тишина — просто выбрасываем
    }
    return [];
  }

  /** Сколько миллисекунд уже накоплено в текущей фразе. */
  get pendingMs() {
    return (this.length / this.sampleRate) * 1000;
  }

  take() {
    const pcm = concatPCM(this.pieces, this.length);
    this.reset();
    return pcm;
  }
}
