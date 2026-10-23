import test from "node:test";
import assert from "node:assert/strict";
import { createProject, getScreenTarget } from "../src/core/model.ts";
import { sourceRangeOutputSpans } from "../src/core/timeline.ts";
import { editFeatureRange, featureInsertionRange } from "../src/core/feature-ranges.ts";
import { addManualMask, newCameraScene, sceneLayout } from "../src/core/editor-insert.ts";
import { cameraSceneAt } from "../src/core/camera-effects.ts";

function fixture() {
  const p = createProject({ path: "/fixture/screen.mp4", name: "Feature editing", duration: 12, width: 1280, height: 720 });
  p.slices = [{ id: "a", start: 0, end: 4, speed: 2, volume: 1 }, { id: "b", start: 6, end: 12, speed: 1, volume: 1 }];
  p.cameraScenes = [{ id: "layout", start: 2, end: 8, layout: { type: "screen-only" } }];
  p.masks = [{ id: "mask", start: 2, end: 8, type: "highlight", opacity: .5, blur: 32, bounds: [{ x: .1, y: .1, width: .2, height: .2 }] }];
  return p;
}
test("hover insertion stops at the next occupied range and uses cut-sided source endpoints", () => {
  const p = fixture();
  assert.deepEqual(featureInsertionRange(p, "masks", 0), { start: 0, end: 2 });
  assert.equal(featureInsertionRange(p, "masks", 1.5), null);
  assert.deepEqual(featureInsertionRange(p, "masks", 4), { start: 8, end: 11 });
  assert.equal(featureInsertionRange(p, "masks", 8), null);
  assert.equal(featureInsertionRange(p, "masks", NaN), null);
  const atCut = { ...p, masks: [{ ...p.masks![0], start: 6, end: 8 }] };
  assert.deepEqual(featureInsertionRange(atCut, "masks", 1), { start: 2, end: 4 });
});
test("layout and mask moves preserve visible length through cuts and variable clip speeds", () => {
  for (const kind of ["layouts", "masks"] as const) {
    const p = fixture(), item = kind === "layouts" ? p.cameraScenes![0] : p.masks![0];
    const moved = editFeatureRange(p, kind, item, 1);
    const actual = kind === "layouts" ? moved.cameraScenes![0] : moved.masks![0];
    assert.deepEqual([actual.start, actual.end], [6, 9]);
    assert.equal(sourceRangeOutputSpans(moved, actual.start, actual.end).reduce((s, v) => s + v.end - v.start, 0), 3);
    assert.deepEqual([item.start, item.end], [2, 8], "input snapshot remains unchanged");
  }
});
test("range ends at a cut use the left clip, starts use the right clip", () => {
  const p = fixture(), item = p.cameraScenes![0];
  assert.deepEqual(editFeatureRange(p, "layouts", item, -2, "end").cameraScenes![0], { ...item, end: 4 });
  assert.equal(editFeatureRange(p, "layouts", item, 1, "start").cameraScenes![0].start, 6);
});
test("range trims clamp to retained media and cannot collapse or invert", () => {
  const p = fixture(), item = p.cameraScenes![0];
  assert.equal(editFeatureRange(p, "layouts", item, -100, "start").cameraScenes![0].start, 0);
  assert.equal(editFeatureRange(p, "layouts", item, 100, "end").cameraScenes![0].end, 12);
  const tiny = editFeatureRange(p, "layouts", item, 100, "start").cameraScenes![0];
  assert.ok(Math.abs(tiny.end - tiny.start - .05) < 1e-8);
  const right = editFeatureRange(p, "layouts", item, 100).cameraScenes![0];
  assert.deepEqual([right.start, right.end], [9, 12]);
});
test("mask edits reject unlike enabled overlap while layouts and disabled masks remain editable", () => {
  const p = fixture();
  p.masks!.push({ ...p.masks![0], id: "privacy", start: 9, end: 11, type: "sensitive-data" });
  assert.equal(editFeatureRange(p, "masks", p.masks![0], 2), p);
  const disabled = { ...p, masks: p.masks!.map(item => item.id === "privacy" ? { ...item, disabled: true } : item) };
  assert.notEqual(editFeatureRange(disabled, "masks", disabled.masks[0], 2), disabled);
  assert.equal(editFeatureRange(p, "layouts", p.cameraScenes![0], 2).cameraScenes![0].end, 10);
});
test("removed, hidden and invalid range gestures are no-ops", () => {
  const p = fixture();
  assert.equal(editFeatureRange(p, "layouts", { id: "deleted", start: 2, end: 8 }, 1), p);
  assert.equal(editFeatureRange(p, "layouts", { ...p.cameraScenes![0], start: 4.1, end: 5.9 }, 1), p);
  assert.equal(editFeatureRange(p, "layouts", p.cameraScenes![0], NaN), p);
});
test("palette scene placement is independent of global defaults and reaches the shared compositor", () => {
  const p = fixture(); p.cameraPath = "/fixture/camera.mp4";
  const scene = newCameraScene(p, 6, "camera-overlay", { x: .1, y: .9 })!;
  assert.equal(scene.layout.type, "camera-overlay");
  if (scene.layout.type !== "camera-overlay") throw new Error("Wrong scene type");
  assert.deepEqual(scene.layout.overlay.position, { x: .1, y: .9 });
  assert.notDeepEqual(p.appearance.cameraLayout?.overlay.position, scene.layout.overlay.position);
  const full = { ...scene, layout: sceneLayout("fullscreen-camera") };
  const result = { ...p, cameraScenes: [full] };
  assert.equal(cameraSceneAt(result, 7)?.id, scene.id);
  const frame = getScreenTarget(result, 7, 1280, 720);
  assert.equal(frame.cameraOpacity, 1); assert.equal(frame.screenOpacity, 0);
  assert.deepEqual([scene.start, scene.end], [6, 9]);
});
test("palette mask placement stays in source coordinates at edges and rejects unsupported overlap", () => {
  const p = fixture(), mask = addManualMask(p, 8, "sensitive-data", { x: 1, y: 1 })!;
  assert.deepEqual(mask.bounds, [{ x: .5, y: .7, width: .5, height: .3 }]);
  assert.equal(addManualMask(p, 7, "sensitive-data"), null);
  assert.ok(addManualMask(p, 7, "highlight"));
  assert.equal(addManualMask({ ...p, duration: 0 }, 0, "highlight"), null);
});
