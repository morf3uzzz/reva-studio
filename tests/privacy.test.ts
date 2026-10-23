import test from "node:test";
import assert from "node:assert/strict";
import { createProject } from "../src/core/model.ts";
import { privacyRegionsAtTime, privacyRect } from "../src/core/privacy.ts";
import type { PrivacyAnalysis, PrivacyRegion } from "../src/types.ts";

const region = (
  start: number,
  end: number,
  kind: PrivacyRegion["kind"],
): PrivacyRegion => ({
  start,
  end,
  kind,
  x: 0.2,
  y: 0.3,
  width: 0.4,
  height: 0.1,
  confidence: 0.9,
});

test("privacy masks follow source intervals across seeks and independently enable faces and text", () => {
  const p = createProject({
    path: "/selected/video.mp4",
    name: "Example",
    duration: 6,
    width: 1440,
    height: 900,
  });
  const analysis: PrivacyAnalysis = {
    version: 1,
    source: { sha256: "a".repeat(64), width: 1440, height: 900, duration: 6 },
    coordinateSpace: "oriented-top-left-normalized",
    settings: { sensitive: true, faces: true, sampleInterval: 0.5 },
    coverage: {
      complete: true,
      sampledFrames: 12,
      intervals: [{ start: 0, end: 6 }],
      limitations: [],
    },
    regions: [
      region(3, 4, "face"),
      region(1, 2, "email"),
      region(1.5, 2.5, "key"),
    ],
  };
  p.privacy = { sensitive: true, faces: false, analysis };
  assert.deepEqual(
    privacyRegionsAtTime(p, 1.8).map((r) => r.kind),
    ["email", "key"],
  );
  assert.equal(privacyRegionsAtTime(p, 3.5).length, 0);
  assert.deepEqual(
    privacyRegionsAtTime(p, 2).map((r) => r.kind),
    ["key"],
  );
  assert.equal(privacyRegionsAtTime(p, 0).length, 0);
  p.privacy.faces = true;
  assert.deepEqual(
    privacyRegionsAtTime(p, 3.5).map((r) => r.kind),
    ["face"],
  );
  assert.equal(privacyRegionsAtTime(p, 4).length, 0);
  // Results do not depend on forward playback or a stale scan cursor.
  assert.equal(privacyRegionsAtTime(p, 1.8).length, 2);
});

test("privacy boxes stay aligned to cropped and zoomed video, including partially visible text", () => {
  const mask = region(0, 1, "email");
  const crop = { x: 0.4, y: 0.2, width: 0.4, height: 0.4 };
  const screen = { x: 100, y: 200, width: 800, height: 500 };
  const r = privacyRect(mask, crop, screen)!;
  assert.ok(Math.abs(r.x - 100) < 1e-9);
  assert.ok(Math.abs(r.y - 325) < 1e-9);
  assert.ok(Math.abs(r.width - 400) < 1e-9);
  assert.ok(Math.abs(r.height - 125) < 1e-9);
  assert.equal(
    privacyRect({ ...mask, x: 0.85, width: 0.1 }, crop, screen),
    null,
  );
});
