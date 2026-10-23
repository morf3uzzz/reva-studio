import assert from "node:assert/strict";
import test from "node:test";
import {
  cropToNormalized,
  cropToPixels,
  fitCropAspect,
  movePixelCrop,
  resizePixelCrop,
  setCropDimension,
  type CropHandle,
  type CropRect,
} from "../src/crop-geometry.ts";

const source = { width: 1512, height: 982 };
const sample = { x: 200, y: 100, width: 800, height: 500 };
const close = (a: number, b: number) =>
  assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
function inBounds(crop: CropRect) {
  assert.ok(crop.x >= -1e-8 && crop.y >= -1e-8);
  assert.ok(crop.width >= 1 - 1e-8 && crop.height >= 1 - 1e-8);
  assert.ok(
    crop.x + crop.width <= source.width + 1e-8 &&
      crop.y + crop.height <= source.height + 1e-8,
  );
}
test("source-pixel crop roundtrips normalized persistence including a one-pixel crop", () => {
  for (const crop of [sample, { x: 1511, y: 981, width: 1, height: 1 }]) {
    const result = cropToPixels(cropToNormalized(crop, source), source);
    for (const key of ["x", "y", "width", "height"] as const)
      close(result[key], crop[key]);
  }
});
test("dragging beyond the source translates the frame without changing its size", () => {
  assert.deepEqual(movePixelCrop(sample, -5000, 5000, source), {
    x: 0,
    y: 482,
    width: 800,
    height: 500,
  });
});
test("all eight handles preserve bounds and prevent inversion across their fixed anchor", () => {
  for (const handle of [
    "n",
    "ne",
    "e",
    "se",
    "s",
    "sw",
    "w",
    "nw",
  ] as CropHandle[]) {
    for (const dx of [-5000, -50, 0, 50, 5000])
      for (const dy of [-5000, -50, 0, 50, 5000]) {
        const crop = resizePixelCrop(sample, handle, dx, dy, source);
        inBounds(crop);
        if (handle.includes("w"))
          close(crop.x + crop.width, sample.x + sample.width);
        if (handle.includes("e")) close(crop.x, sample.x);
        if (handle.includes("n"))
          close(crop.y + crop.height, sample.y + sample.height);
        if (handle.includes("s")) close(crop.y, sample.y);
      }
  }
});
test("aspect-locked corners and side handles keep their anchor at source edges", () => {
  const initial = { x: 200, y: 100, width: 800, height: 450 };
  for (const handle of [
    "n",
    "ne",
    "e",
    "se",
    "s",
    "sw",
    "w",
    "nw",
  ] as CropHandle[]) {
    for (const dx of [-5000, 35, 5000])
      for (const dy of [-5000, 50, 5000]) {
        const crop = resizePixelCrop(initial, handle, dx, dy, source, 16 / 9);
        inBounds(crop);
        close(crop.width / crop.height, 16 / 9);
        if (handle.includes("w"))
          close(crop.x + crop.width, initial.x + initial.width);
        if (handle.includes("e")) close(crop.x, initial.x);
        if (handle.includes("n"))
          close(crop.y + crop.height, initial.y + initial.height);
        if (handle.includes("s")) close(crop.y, initial.y);
        if (handle === "n" || handle === "s")
          close(crop.x + crop.width / 2, initial.x + initial.width / 2);
        if (handle === "e" || handle === "w")
          close(crop.y + crop.height / 2, initial.y + initial.height / 2);
      }
  }
});
test("portrait presets stay centered and numeric sizes retain the chosen aspect", () => {
  const portrait = fitCropAspect(sample, 9 / 16, source);
  close(portrait.width / portrait.height, 9 / 16);
  close(portrait.x + portrait.width / 2, sample.x + sample.width / 2);
  close(portrait.y + portrait.height / 2, sample.y + sample.height / 2);
  const resized = setCropDimension(portrait, "width", 5000, source, 9 / 16);
  inBounds(resized);
  close(resized.width / resized.height, 9 / 16);
  close(resized.height, source.height);
});
