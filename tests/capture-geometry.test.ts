import assert from "node:assert/strict";
import test from "node:test";
import { globalRectToViewport, viewportPointToGlobal, sourceRectToGlobal, globalPointToSource } from "../src/capture-geometry.ts";

test("window highlight and pointer agree when macOS shifts the picker below the menu bar", () => {
  const frame = { x: 0, y: 33, width: 1512, height: 982 }, viewport = { width: 1512, height: 982 };
  const window = { x: 4, y: 33, width: 1504, height: 863 };
  assert.deepEqual(globalRectToViewport(window, frame, viewport), { x: 4, y: 0, width: 1504, height: 863 });
  assert.deepEqual(viewportPointToGlobal({ x: 15, y: 10 }, frame, viewport), { x: 15, y: 43 });
});

test("area source pixels survive negative display origins, Retina scaling and a shifted viewport", () => {
  const display = { x: -1512, y: -400, width: 1512, height: 982 }, source = { width: 3024, height: 1964 };
  const frame = { ...display, y: -367 }, viewport = { width: 756, height: 491 }, area = { x: 200, y: 100, width: 800, height: 500 };
  const projected = globalRectToViewport(sourceRectToGlobal(area, source, display), frame, viewport);
  assert.deepEqual(projected, { x: 50, y: 8.5, width: 200, height: 125 });
  const origin = globalPointToSource(viewportPointToGlobal({ x: projected.x, y: projected.y }, frame, viewport), source, display);
  assert.deepEqual(origin, { x: 200, y: 100 });
});
