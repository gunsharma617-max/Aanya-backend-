import "server-only";

export function pcm16ToWav(
  pcm: Uint8Array,
  sampleRate: number,
): Uint8Array {
  if (
    pcm.byteLength === 0 ||
    pcm.byteLength % 2 !== 0 ||
    pcm.byteLength > 0xffffffff - 36 ||
    !Number.isInteger(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > 192000
  ) {
    throw new Error("Invalid audio");
  }

  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;

  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);

  function writeAscii(offset: number, text: string): void {
    for (let i = 0; i < text.length; i += 1) {
      wav[offset + i] = text.charCodeAt(i);
    }
  }

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, pcm.byteLength, true);

  // Gemini PCM16 audio is treated as little-endian PCM.
  wav.set(pcm, 44);

  return wav;
}
