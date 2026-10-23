export type WaveformPyramid = readonly Float32Array[];

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

// The shipped renderer reduces pairs with max, then interpolates between
// pyramid levels. Keeping this separate from canvas makes the source-clock
// mapping and envelope sampling independent of the display pixel ratio.
export function waveformPyramid(peaks: ArrayLike<number>): WaveformPyramid {
  if (!peaks.length) return [];
  const levels = [Float32Array.from(peaks, value => Number.isFinite(value) ? clamp01(value) : 0)];
  while (levels.at(-1)!.length > 1) {
    const previous = levels.at(-1)!;
    const next = new Float32Array(Math.ceil(previous.length / 2));
    for (let index = 0; index < next.length; index++)
      next[index] = Math.max(previous[index * 2], previous[Math.min(index * 2 + 1, previous.length - 1)]);
    levels.push(next);
  }
  return levels;
}

function readLevel(levels: WaveformPyramid, level: number, position: number): number {
  const samples = levels[level];
  const bin = position / 2 ** level - 0.5, left = Math.floor(bin), t = bin - left;
  const at = (index: number) => index >= 0 && index < samples.length ? samples[index] : 0;
  const before = at(left - 1), a = at(left), b = at(left + 1), after = at(left + 2);
  return clamp01(a + 0.5 * t * ((b - before) + t * (2 * before - 5 * a + 4 * b - after + t * (3 * (a - b) + after - before))));
}

export function waveformEnvelope(levels: WaveformPyramid, position: number, samplesPerBin: number): number {
  if (!levels.length || !Number.isFinite(position) || !Number.isFinite(samplesPerBin)) return 0;
  const level = Math.max(0, Math.min(levels.length - 1, Math.log2(Math.max(1, samplesPerBin))));
  const lower = Math.floor(level), upper = Math.min(lower + 1, levels.length - 1);
  const a = readLevel(levels, lower, position), b = readLevel(levels, upper, position);
  return a + (b - a) * (level - lower);
}

function fillUnder(height: number, fromBottom: number, pixelsPerUnit: number): number {
  if (height <= 0) return 0;
  const coverage = clamp01((height - fromBottom) * pixelsPerUnit + 0.5);
  const fade = 0.5 + 0.5 * clamp01(fromBottom / Math.max(height, 1));
  return coverage * fade;
}

export function waveformAlpha(amplitude: number, volume: number, fromBottom: number, pixelsPerUnit: number, opacity: number): number {
  const height = clamp01(amplitude) * 32;
  const fill = opacity * fillUnder(height * Math.max(0, volume), fromBottom, pixelsPerUnit);
  const outline = volume < 0.999 ? 0.1 * fillUnder(height, fromBottom, pixelsPerUnit) : 0;
  return fill + outline * (1 - fill);
}

export interface TimelineWaveformLayer {
  kind: "microphone" | "system";
  duration: number;
  pyramid: WaveformPyramid;
  volume: number;
}

export function rasterizeTimelineWaveform(
  layers: readonly TimelineWaveformLayer[],
  sourceStart: number,
  sourceEnd: number,
  width: number,
  height: number,
  pixelsPerUnit: number,
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const cssWidth = width / pixelsPerUnit;
  // Microphone is the first source layer in the original renderer.
  const ordered = [...layers].sort((a, b) => Number(a.kind === "system") - Number(b.kind === "system"));
  for (const layer of ordered) {
    const count = layer.pyramid[0]?.length ?? 0;
    if (!count || layer.duration <= 0) continue;
    const sourceSpan = sourceEnd - sourceStart;
    const samplesPerBin = sourceSpan / cssWidth * count / layer.duration * 5;
    const color = layer.kind === "microphone" ? [255, 255, 255] : [77, 47, 245];
    const opacity = layer.kind === "microphone" ? 0.35 : 0.5;
    for (let x = 0; x < width; x++) {
      const source = sourceStart + (x + 0.5) / width * sourceSpan;
      if (source < 0 || source >= layer.duration) continue;
      const amplitude = waveformEnvelope(layer.pyramid, source / layer.duration * count, samplesPerBin);
      for (let y = height - 1; y >= 0; y--) {
        const fromBottom = (height - y - 0.5) / pixelsPerUnit;
        const alpha = waveformAlpha(amplitude, layer.volume, fromBottom, pixelsPerUnit, opacity);
        if (alpha <= 0) break;
        const index = (y * width + x) * 4, previousAlpha = pixels[index + 3] / 255;
        const outputAlpha = alpha + previousAlpha * (1 - alpha);
        for (let channel = 0; channel < 3; channel++)
          pixels[index + channel] = (color[channel] * alpha + pixels[index + channel] * previousAlpha * (1 - alpha)) / outputAlpha;
        pixels[index + 3] = outputAlpha * 255;
      }
    }
  }
  return pixels;
}
