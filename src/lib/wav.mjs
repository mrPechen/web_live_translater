// Сборка WAV (PCM16, моно) из сырых сэмплов — без AudioEncoder и MediaRecorder.

function writeStr(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

/**
 * @param {Int16Array} pcm
 * @param {number} sampleRate
 * @returns {Uint8Array} готовый .wav файл
 */
export function encodeWav(pcm, sampleRate = 16000) {
  const channels = 1;
  const blockAlign = channels * 2;
  const dataSize = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeStr(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(view, 8, 'WAVE');
  writeStr(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // размер fmt-блока
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeStr(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  new Int16Array(buffer, 44).set(pcm);
  return new Uint8Array(buffer);
}

/** Склеивает куски Int16Array в один. */
export function concatPCM(pieces, totalLength) {
  const out = new Int16Array(totalLength);
  let offset = 0;
  for (const piece of pieces) {
    out.set(piece, offset);
    offset += piece.length;
  }
  return out;
}
