import test from "node:test";
import assert from "node:assert/strict";
import { rasterizeTimelineWaveform, waveformAlpha, waveformEnvelope, waveformPyramid } from "../src/core/timeline-waveform.ts";

test("waveform max pyramid preserves an isolated transient and the odd final sample", () => {
  const peaks = [0, 0.25, 1, 0.5, 0.125];
  const levels = waveformPyramid(peaks);
  assert.deepEqual(levels.map(level => [...level]), [peaks, [0.25, 1, 0.125], [1, 0.125], [1]]);
  assert.deepEqual(peaks, [0, 0.25, 1, 0.5, 0.125]);
  const impulse = waveformPyramid([0, 0, 0, 1, 0, 0, 0, 0]);
  assert.equal(waveformEnvelope(impulse, 2, 1), 0);
  assert.equal(waveformEnvelope(impulse, 2, 4), 1);
});

test("source envelope uses sample centers and a clamped cubic curve, with continuous LOD", () => {
  const levels = waveformPyramid([0, 0, 1, 0]);
  assert.equal(waveformEnvelope(levels, 2.5, 1), 1);
  assert.equal(waveformEnvelope(levels, 2, 1), 0.5625);
  for (let x = -2; x < 8; x += 0.1) {
    const value = waveformEnvelope(levels, x, 1);
    assert.ok(value >= 0 && value <= 1);
  }
  assert.ok(Math.abs(waveformEnvelope(levels, 2, 2 - 1e-6) - waveformEnvelope(levels, 2, 2 + 1e-6)) < 1e-6);
  assert.equal(waveformEnvelope([], 0, 1), 0);
});

test("fade follows each local envelope height and muted audio keeps its faint outline", () => {
  assert.equal(waveformAlpha(1, 1, 8, 2, 0.35), 0.21875);
  assert.equal(waveformAlpha(0.5, 1, 8, 2, 0.35), 0.26249999999999996);
  assert.equal(waveformAlpha(1, 0, 16, 2, 0.35), 0.07500000000000001);
  assert.equal(waveformAlpha(0, 1, 0.25, 2, 0.35), 0);
  assert.equal(waveformAlpha(1, 1, 33, 2, 0.35), 0);
});

test("cut and speed geometry sample the source interval instead of stretching the whole recording", () => {
  const peaks = Array.from({ length: 80 }, (_, i) => [0.1, 0, 0.9, 0.2][Math.floor(i / 20)]);
  const layer = { kind: "microphone" as const, duration: 8, pyramid: waveformPyramid(peaks), volume: 1 };
  const full = rasterizeTimelineWaveform([layer], 0, 8, 160, 48, 1);
  const trimmed = rasterizeTimelineWaveform([layer], 4, 6, 40, 48, 1);
  for (let y = 0; y < 48; y++)
    assert.deepEqual(trimmed.slice(y * 40 * 4, (y + 1) * 40 * 4), full.slice((y * 160 + 80) * 4, (y * 160 + 120) * 4));
  const fast = rasterizeTimelineWaveform([layer], 4, 6, 20, 48, 1);
  assert.ok(fast[(40 * 20 + 10) * 4 + 3] > 0);
  const removedSilence = rasterizeTimelineWaveform([layer], 2.5, 3.5, 20, 48, 1);
  assert.ok(removedSilence.every(value => value === 0));
});

test("Retina rasterization preserves 32 CSS pixel height and the source channel colors", () => {
  const layer = { kind: "microphone" as const, duration: 2, pyramid: waveformPyramid(Array(200).fill(1)), volume: 1 };
  const normal = rasterizeTimelineWaveform([layer], 0.5, 1.5, 40, 48, 1);
  const retina = rasterizeTimelineWaveform([layer], 0.5, 1.5, 80, 96, 2);
  const rows = (pixels: Uint8ClampedArray, width: number, height: number) => Array.from({ length: height }, (_, y) => pixels[(y * width + width / 2) * 4 + 3]).filter(alpha => alpha > 0).length;
  assert.equal(rows(normal, 40, 48), 32);
  assert.equal(rows(retina, 80, 96), 64);
  assert.deepEqual([...normal.slice((40 * 40 + 20) * 4, (40 * 40 + 20) * 4 + 3)], [255, 255, 255]);
  const system = rasterizeTimelineWaveform([{ ...layer, kind: "system" }], 0.5, 1.5, 40, 48, 1);
  assert.deepEqual([...system.slice((40 * 40 + 20) * 4, (40 * 40 + 20) * 4 + 3)], [77, 47, 245]);
});

test("channel composition has stable source order and never invents missing audio", () => {
  const base = { duration: 1, pyramid: waveformPyramid(Array(100).fill(0.5)), volume: 1 };
  const mic = { ...base, kind: "microphone" as const }, system = { ...base, kind: "system" as const };
  assert.deepEqual(rasterizeTimelineWaveform([system, mic], 0, 1, 20, 48, 1), rasterizeTimelineWaveform([mic, system], 0, 1, 20, 48, 1));
  assert.ok(rasterizeTimelineWaveform([], 0, 1, 20, 48, 1).every(value => value === 0));
  assert.ok(rasterizeTimelineWaveform([mic], 2, 3, 20, 48, 1).every(value => value === 0));
});
