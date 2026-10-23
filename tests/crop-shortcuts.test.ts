import assert from "node:assert/strict";
import test from "node:test";
import { applyCropShortcut, CROP_SHORTCUTS, cropShortcutForKey } from "../src/crop-shortcuts.ts";
import { cropToNormalized, cropToPixels } from "../src/crop-geometry.ts";

const source = { width: 1512, height: 982 };
const crop = { x: 200, y: 100, width: 800, height: 500 };
const key = (key: string, metaKey = false, shiftKey = false) => ({ key, metaKey, shiftKey, altKey: false, ctrlKey: false });

test("all 16 displayed crop chords perform their individual 1px and 10px actions", () => {
  const outcomes = [
    ["ArrowLeft", false, "x", -1],
    ["ArrowRight", false, "x", 1],
    ["ArrowUp", false, "y", -1],
    ["ArrowDown", false, "y", 1],
    ["ArrowLeft", true, "width", -1],
    ["ArrowRight", true, "width", 1],
    ["ArrowUp", true, "height", 1],
    ["ArrowDown", true, "height", -1],
  ] as const;
  const exercised = new Set();
  for (const [arrow, command, dimension, delta] of outcomes) {
    for (const step of [1, 10]) {
      const shortcut = cropShortcutForKey(key(arrow, command, step === 10));
      assert.ok(shortcut, `${arrow}, command=${command}, step=${step}`);
      assert.deepEqual(applyCropShortcut(crop, shortcut, source), {
        ...crop, [dimension]: crop[dimension] + delta * step,
      });
      exercised.add(shortcut);
    }
  }
  assert.equal(exercised.size, 16);
  assert.deepEqual(new Set(CROP_SHORTCUTS), exercised, "the popup contains exactly the commands exercised above");
});

test("unadvertised Alt/Control combinations and non-arrow keys do not move the crop", () => {
  for (const event of [
    { ...key("ArrowUp"), altKey: true },
    { ...key("ArrowDown", true), altKey: true },
    { ...key("ArrowLeft"), ctrlKey: true },
    { ...key("ArrowRight", true), ctrlKey: true },
    key("Enter"), key("a", true),
  ]) assert.equal(cropShortcutForKey(event), undefined);
});

test("keyboard resizing and movement clamp at source edges without inversion or a drifting anchor", () => {
  const full = { x: 0, y: 0, ...source };
  const pixel = { x: 1511, y: 981, width: 1, height: 1 };
  for (const arrow of ["ArrowUp", "ArrowRight"]) {
    assert.deepEqual(applyCropShortcut(full, cropShortcutForKey(key(arrow, true, true))!, source), full);
  }
  for (const arrow of ["ArrowDown", "ArrowLeft"]) {
    assert.deepEqual(applyCropShortcut(pixel, cropShortcutForKey(key(arrow, true, true))!, source), pixel);
  }
  assert.deepEqual(applyCropShortcut(pixel, cropShortcutForKey(key("ArrowDown", false, true))!, source), pixel);
  const result = applyCropShortcut(crop, cropShortcutForKey(key("ArrowUp", true, true))!, source);
  assert.equal(result.x, crop.x);
  assert.equal(result.y, crop.y);
  const restored = cropToPixels(cropToNormalized(result, source), source);
  for (const field of ["x", "y", "width", "height"] as const)
    assert.ok(Math.abs(restored[field] - result[field]) < 1e-8);
});

test("Command resizing retains the selected aspect and the side handle's fixed anchors", () => {
  const initial = { x: 200, y: 100, width: 800, height: 450 };
  const taller = applyCropShortcut(initial, cropShortcutForKey(key("ArrowUp", true, true))!, source, 16 / 9);
  assert.equal(taller.height, 460);
  assert.equal(taller.y, initial.y);
  assert.ok(Math.abs(taller.width / taller.height - 16 / 9) < 1e-8);
  assert.ok(Math.abs(taller.x + taller.width / 2 - (initial.x + initial.width / 2)) < 1e-8);
  const wider = applyCropShortcut(initial, cropShortcutForKey(key("ArrowRight", true, true))!, source, 16 / 9);
  assert.equal(wider.width, 810);
  assert.equal(wider.x, initial.x);
  assert.ok(Math.abs(wider.y + wider.height / 2 - (initial.y + initial.height / 2)) < 1e-8);
});
