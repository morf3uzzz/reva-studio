import test from "node:test";
import assert from "node:assert/strict";
import { fittedPreviewHeight, nextPreviewHeight, previewBackingSize } from "../src/core/preview.ts";

test("preview size buttons skip steps that cannot change a canvas fitted into the viewport", () => {
  assert.equal(nextPreviewHeight(900, 500, 16 / 9, 1080, "larger"), null);
  assert.equal(nextPreviewHeight(900, 500, 16 / 9, 1080, "smaller"), 480);
  assert.equal(nextPreviewHeight(900, 500, 16 / 9, 480, "larger"), 720);
  assert.equal(nextPreviewHeight(900, 450, 16 / 9, 1080, "smaller"), null);
});
test("portrait and width-limited previews stay fitted and ignore subpixel-only size changes", () => {
  assert.equal(fittedPreviewHeight(300, 1000, 16 / 9, 1080), 168.75);
  assert.equal(fittedPreviewHeight(300, 1000, 9 / 16, 1080), 300 / (9 / 16));
  assert.equal(nextPreviewHeight(2000, 720.5, 1, 720, "larger"), null);
  assert.equal(nextPreviewHeight(2000, 721, 1, 720, "larger"), 1080);
});

test("full preview covers Retina physical pixels without changing the fitted layout", () => {
  const height = fittedPreviewHeight(900, 500, 1.5, 480);
  const width = height * 1.5;
  assert.deepEqual(previewBackingSize(width, height, 1, 1), { width: 720, height: 480 });
  assert.deepEqual(previewBackingSize(width, height, 2, 1), { width: 1440, height: 960 });
  assert.deepEqual(previewBackingSize(width, height, 2, .5), { width: 720, height: 480 });
  assert.deepEqual(previewBackingSize(width, height, 2, .25), { width: 360, height: 240 });
  assert.equal(width, 720);
  assert.equal(height, 480);
});

test("fractional scaling preserves pixel coverage and portrait preview is independent of export caps", () => {
  assert.deepEqual(previewBackingSize(300.25, 500.5, 1.5, 1), { width: 451, height: 751 });
  assert.deepEqual(previewBackingSize(1600, 2160, 2, 1), { width: 3200, height: 4320 });
  assert.deepEqual(previewBackingSize(0, 0, NaN, 0), { width: 1, height: 1 });
});
