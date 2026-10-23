import test from "node:test";
import assert from "node:assert/strict";
import { previewLayerAt, previewLayerRect, type PreviewFrame } from "../src/core/preview-hit.ts";

const frame: PreviewFrame = {
  rect: { x: 100, y: 100, width: 800, height: 600 },
  screenClip: { x: 0, y: 0, width: 1000, height: 800 },
  camera: { x: 700, y: 500, width: 200, height: 200 },
  screenRadius: 20,
  cameraRadius: 20,
  cursor: { x: 400, y: 300, width: 60, height: 80 },
};

test("cursor has its own hit target and square highlight above the recorded screen", () => {
  assert.equal(previewLayerAt(frame, 420, 330, 1000, 800, true), "cursor");
  assert.deepEqual(previewLayerRect(frame, "cursor", 1000, 800), { rect: frame.cursor, radius: 0 });
  assert.equal(previewLayerAt(frame, 500, 330, 1000, 800, true), "screen");
  assert.equal(previewLayerAt(frame, 30, 30, 1000, 800, true), "background");
  assert.equal(previewLayerAt({ ...frame, cursor: null }, 420, 330, 1000, 800, true), "screen");
});

test("camera occlusion, rounded screen corners and split clipping constrain cursor selection", () => {
  const overlap = { ...frame, cursor: { x: 710, y: 510, width: 60, height: 80 } };
  assert.equal(previewLayerAt(overlap, 740, 540, 1000, 800, true), "camera");
  assert.equal(previewLayerAt(overlap, 740, 540, 1000, 800, false), "cursor");
  assert.equal(previewLayerAt({ ...frame, cursor: { x: 98, y: 98, width: 40, height: 40 } }, 101, 101, 1000, 800, true), "background");
  assert.equal(previewLayerAt({ ...frame, screenClip: { x: 0, y: 0, width: 410, height: 800 } }, 420, 330, 1000, 800, true), "background");
  assert.equal(previewLayerAt(frame, -1, 330, 1000, 800, true), null);
});
