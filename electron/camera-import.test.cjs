"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { originalCameraLayout, importCameraScenes, importCameraAppearance } = require("./camera-import.cjs");

test("original camera defaults and ranges share one canonical source decoder", () => {
  const source = { type: "split-screen", cameraOverlay: { overlayCameraSizeRatio01: .33 }, splitScreen: { splitDirection: "vertical", splitFlip: true }, cutoutCamera: { cutoutCameraPositionX01: .2 } };
  const camera = { background: { edgeFalloff01: .1234, edgeInsetPx: 2.5 } }, expected = originalCameraLayout(source, camera);
  const scenes = importCameraScenes([{ id: "split", version: 2, sourceStartMs: 500.25, sourceEndMs: 2500.75, ...source }], 4, camera);
  assert.deepEqual(scenes[0].layout, expected);
  assert.equal(scenes[0].start, .50025); assert.equal(scenes[0].end, 2.50075);
  assert.equal(expected.overlay.sizeRatio, .33); assert.equal(expected.cutout.edgeSoftness, .1234);
  assert.throws(() => originalCameraLayout({ ...source, cameraOverlay: { overlayCameraSizeRatio01: null } }, camera));
});
test("all five original camera scene types preserve disabled state and inactive variants", () => {
  const types = ["camera-overlay", "split-screen", "cutout-camera", "fullscreen-camera", "screen-only"];
  const scenes = importCameraScenes(types.map((type, index) => ({ id: String(index), type, version: 2, sourceStartMs: index * 1000, sourceEndMs: (index + 1) * 1000, cameraOverlay: { overlayCameraSizeRatio01: .275 }, isDisabled: index === 4 })), 5);
  assert.deepEqual(scenes.map(scene => scene.layout.type), types);
  assert.equal(scenes[4].disabled, true);
  assert.equal(scenes[3].layout.cameraLayout.overlay.sizeRatio, .275);
  assert.throws(() => importCameraScenes([{ id: "new", type: "screen-only", version: 3, sourceStartMs: 0, sourceEndMs: 1000 }], 1), /version/);
  assert.throws(() => importCameraScenes([{ id: "unknown", type: "fullscreen-camera", version: 2, sourceStartMs: 0, sourceEndMs: 1000, fullscreenCamera: { unsupported: true } }], 1), /not been verified/);
});
test("original face/silence settings and known look choices are preserved without inventing analysis", () => {
  const warnings = [], appearance = importCameraAppearance({ camera: { enableFaceTracking: true, hideDuringSilenceMs: 7500, lut: "Cinema", lutIntensity: .8, sharpen01: .2, grain: .1 }, output: { avoidEmptyZoomArea: true } }, warnings);
  assert.equal(appearance.cameraFollowFace, true); assert.equal(appearance.cameraSilenceMinimumSeconds, 7.5); assert.equal(appearance.cameraProcessing.look, "cinematic"); assert.equal(appearance.cameraProcessing.lutIntensity, .8); assert.equal(appearance.avoidEmptyZoomArea, true);
  assert.equal(Object.hasOwn(appearance, "cameraFaceTrack"), false); assert.ok(warnings.some(value => value.includes("local camera analysis")));
  const opaqueWarnings = []; importCameraAppearance({ camera: { lut: { id: "opaque-source-lut", file: "color.png" } } }, opaqueWarnings);
  assert.ok(opaqueWarnings.some(value => value.includes("opaque-source-lut")));
});
