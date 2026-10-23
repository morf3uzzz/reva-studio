import assert from "node:assert/strict";
import test from "node:test";
import type { CursorPoint, Zoom } from "../src/types.ts";
import {
  BACKGROUNDS,
  createProject,
  defaultAppearance,
  formatTime,
  formatTimecode,
  generateAutoZooms,
  getAutoZoomFocus,
  getCameraRect,
  getCursorAtTime,
  getDuration,
  getFadeOpacity,
  getMediaTime,
  getOutputSize,
  getOutputSizeForHeight,
  getOutputTime,
  getScreenGeometry,
  getScreenTarget,
  getScreenRect,
  getZoomTarget,
  normalizeCrop,
  sourcePointToScreen,
} from "../src/core/model.ts";
import {
  advanceSpring,
  createSpringState,
  DEFAULT_SPRING,
  getEffectiveDamping,
  getSpringSettleTime,
  integrateSpring,
  setSpringTarget,
} from "../src/core/spring.ts";

const media = {
  path: "/example/recording.mov",
  name: "Recording.mov",
  duration: 10,
  width: 1920,
  height: 1080,
};
const close = (actual: number, expected: number, epsilon = 1e-8) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
const zoom = (patch: Partial<Zoom> = {}): Zoom => ({
  id: "zoom-1",
  start: 1,
  end: 5,
  scale: 2,
  x: 0.5,
  y: 0.5,
  mode: "manual",
  ...patch,
});

test("new projects have independent defaults and empty media never acquires a fictitious duration", () => {
  const first = createProject(),
    second = createProject();
  assert.equal(first.mediaPath, null);
  assert.equal(first.duration, 0);
  assert.equal(getDuration(first), 0);
  first.appearance.crop.x = 0.2;
  assert.equal(second.appearance.crop.x, 0);
  assert.equal(second.appearance.padding, 0.1);
  assert.equal(second.appearance.zoomDuration, 0.55);
  assert.equal(second.appearance.cursorSize, 48);
  assert.equal(second.appearance.clickEffect, "none");
  assert.equal(second.appearance.cameraMirror, false);
  assert.equal(createProject(media).trimEnd, 10);
  assert.equal(createProject(media).name, "Recording");
  assert.equal(BACKGROUNDS.length, 12);
});

test("trim and speed share one source-time/output-time mapping, including the last export frame", () => {
  const project = createProject(media);
  project.trimStart = 2;
  project.trimEnd = 8;
  project.speed = 2;
  assert.equal(getDuration(project), 3);
  assert.equal(getMediaTime(project, 1.25), 4.5);
  assert.equal(getOutputTime(project, 4.5), 1.25);
  assert.equal(getMediaTime(project, -4), 2);
  assert.equal(getMediaTime(project, 10), 8);
  close(getMediaTime(project, 89 / 30), 2 + 89 / 15);
  project.appearance.fadeIn = 1;
  project.appearance.fadeOut = 0.5;
  assert.equal(getFadeOpacity(project, 2), 0);
  assert.equal(getFadeOpacity(project, 3), 0.5);
  assert.equal(getFadeOpacity(project, 4), 1);
  assert.equal(getFadeOpacity(project, 7.5), 0.5);
  assert.equal(getFadeOpacity(project, 8), 0);
});

test("output dimensions are even and follow cropped source or selected aspect ratio", () => {
  const project = createProject(media);
  project.appearance.padding = 0;
  assert.deepEqual(getOutputSize(project), { width: 1920, height: 1080 });
  project.appearance.crop.width = 0.5;
  const cropOutput = getOutputSize(project);
  assert.deepEqual(cropOutput, { width: 1706, height: 1920 });
  project.appearance.aspect = "9:16";
  assert.deepEqual(getOutputSize(project), { width: 1080, height: 1920 });
  project.appearance.aspect = "1:1";
  assert.deepEqual(getOutputSize(project, 1921), { width: 1922, height: 1922 });
  assert.deepEqual(getOutputSize(project, 1), { width: 2, height: 2 });
});

test("automatic output geometry matches the observed 1440 × 900 baseline with source-relative padding", () => {
  const project = createProject({ ...media, width: 1440, height: 900 });
  assert.deepEqual(getOutputSizeForHeight(project, 1080), {
    width: 1620,
    height: 1080,
  });
  assert.deepEqual(getOutputSize(project, 1476), { width: 1476, height: 984 });
  const baseline = getScreenRect(project, 1476, 984);
  for (const [key, value] of Object.entries({ x: 82, y: 82, width: 1312, height: 820 })) close(baseline[key as keyof typeof baseline], value);
  project.width = 900;
  project.height = 1440;
  const portrait = getScreenRect(project, 984, 1476);
  for (const [key, value] of Object.entries({ x: 82, y: 82, width: 820, height: 1312 })) close(portrait[key as keyof typeof portrait], value);
  project.appearance.crop.height = 0.5;
  const cropped = getOutputSizeForHeight(project);
  assert.deepEqual(cropped, { width: 1304, height: 1080 });
});

test("export resolutions denote height, round down to even pixels, and respect the 4K canvas limit", () => {
  const project = createProject(media);
  project.appearance.aspect = "16:9";
  assert.deepEqual(getOutputSizeForHeight(project, 720), {
    width: 1280,
    height: 720,
  });
  assert.deepEqual(getOutputSizeForHeight(project, 1081), {
    width: 1920,
    height: 1080,
  });
  assert.deepEqual(getOutputSizeForHeight(project, 1079.9999999), {
    width: 1920,
    height: 1080,
  });
  assert.deepEqual(getOutputSizeForHeight(project, 4320), {
    width: 3840,
    height: 2160,
  });
  project.appearance.aspect = "1:1";
  assert.deepEqual(getOutputSizeForHeight(project, 4320), {
    width: 2160,
    height: 2160,
  });
  project.appearance.aspect = "9:16";
  assert.deepEqual(getOutputSizeForHeight(project, 2160), {
    width: 1214,
    height: 2160,
  });
});

test("millisecond spring integration matches independent source-derived numerical vectors", () => {
  // Independently calculated spring-equation reference values.
  // These are source-derived vectors, not claims of original runtime execution.
  const vectors = [
    [1, 0.00008333333333333333, 0.08333333333333333],
    [50, 0.09199976565328034, 3.326888854550929],
    [50.25, 0.09452252380533306, 3.3636775360702935],
    [100, 0.3072913016454731, 4.990153721354621],
    [200, 0.8165837122973465, 4.5477905323559265],
    [400, 1.2125617398418969, -0.2965501655996807],
    [800, 0.9558643683319233, 0.11771594823240962],
    [1500, 0.9979260469747544, -0.005830608720775772],
  ];
  for (const [milliseconds, position, velocity] of vectors) {
    const state = integrateSpring(createSpringState(0, 1), milliseconds);
    close(state.position, position, 1e-12);
    close(state.velocity, velocity, 1e-12);
  }
  const scaled = integrateSpring(createSpringState(0, 1000), 100);
  close(scaled.position, 307.291301645473, 1e-10);
  close(scaled.velocity, 4990.1537213546235, 1e-10);
});

test("spring clamp adapts damping without clipping overshoot and target changes retain momentum", () => {
  const start = { ...createSpringState(0, 1), velocity: 50 };
  close(getEffectiveDamping(start, DEFAULT_SPRING), 2 * Math.sqrt(125 * 1.5));
  const damped = integrateSpring(start, 100);
  close(damped.position, 2.2092676733176204, 1e-12);
  close(damped.velocity, 5.054788108090301, 1e-12);
  const unclamped = integrateSpring(start, 100, { clamp: false });
  close(unclamped.position, 3.2774307965957443, 1e-12);
  assert.ok(damped.position > 1 && unclamped.position > damped.position);
  assert.equal(
    getEffectiveDamping({ ...start, velocity: -50 }, DEFAULT_SPRING),
    12,
  );
  const retargeted = setSpringTarget(damped, 1000);
  assert.equal(retargeted.velocity, damped.velocity);
  close(retargeted.tolerance, (1000 - damped.position) * 0.002);
  assert.equal(setSpringTarget(retargeted, 1000), retargeted);
});

test("spring wrapper preserves rest, zero-mass and coarse-settling semantics with bounded integration", () => {
  const resting = createSpringState(4);
  assert.equal(advanceSpring(resting, 100), resting);
  const active = createSpringState(0, 1);
  assert.deepEqual(advanceSpring(active, 1, { mass: 0 }), {
    ...active,
    position: 1,
    velocity: 0,
  });
  close(getSpringSettleTime(), 1483.3333333333344, 1e-8);
  assert.equal(advanceSpring(active, 1500).position, 1);
  assert.notEqual(integrateSpring(active, 1500).position, 1);
  assert.throws(() => integrateSpring(active, -1), RangeError);
  assert.throws(() => integrateSpring(active, 10001), RangeError);
  assert.throws(() => createSpringState(0, 1, { mass: -1 }), RangeError);
});

test("screen fit retains source geometry within portrait and wide output canvases", () => {
  const project = createProject(media);
  for (const [width, height] of [
    [1920, 1080],
    [1080, 1920],
    [320, 240],
  ]) {
    project.appearance.inset = 12;
    const rectangle = getScreenRect(project, width, height);
    assert.ok(rectangle.x > 0 && rectangle.y > 0);
    assert.ok(rectangle.x + rectangle.width < width);
    assert.ok(rectangle.y + rectangle.height < height);
    close(rectangle.width / rectangle.height, 16 / 9);
    project.appearance.inset = 0;
    assert.deepEqual(getScreenRect(project, width, height), rectangle);
  }
});

test("zoom targets use inclusive source intervals and animation lead-in stays in source time", () => {
  const ranges = [
    zoom(),
    zoom({ id: "zoom-2", start: 6, end: 7, scale: 3, x: 0.9, y: 0.1 }),
  ];
  assert.equal(getZoomTarget(ranges, 0.999).scale, 1);
  assert.equal(getZoomTarget(ranges, 1).scale, 2);
  assert.equal(getZoomTarget(ranges, 5).scale, 2);
  assert.equal(getZoomTarget(ranges, 5.001).scale, 1);
  assert.equal(getZoomTarget(ranges, 6).scale, 3);
  assert.equal(getZoomTarget(ranges, 7.001).scale, 1);
  assert.equal(getZoomTarget(ranges, 0.649, [], true).scale, 1);
  assert.equal(getZoomTarget(ranges, 0.65, [], true).scale, 2);
  const instant = [zoom({ instant: true })];
  assert.equal(getZoomTarget(instant, 0.65, [], true).scale, 1);
  assert.equal(getZoomTarget(instant, 1).instant, true);
  assert.equal(getZoomTarget(instant, 5.05).instant, true);
  assert.equal(getZoomTarget(instant, 5.051).instant, false);
});

test("whole-screen zoom enlarges past the stage without changing the source crop", () => {
  const project = createProject({ ...media, width: 1440, height: 900 });
  project.zooms = [zoom({ scale: 3.357 })];
  const frame = getScreenTarget(project, 1.883, 1620, 1080);
  close(frame.scale, 3.357);
  close(frame.rect.width, 4834.08);
  close(frame.rect.height, 3021.3);
  // Source-derived Pa/Fa chooses x555 rather than x810 even without camera media.
  close(frame.rect.x, -1862.04);
  close(frame.rect.y, -970.65);
  assert.deepEqual(frame.crop, { x: 0, y: 0, width: 1, height: 1 });
  assert.ok(frame.rect.x < 0 && frame.rect.y < 0);
  assert.ok(frame.rect.x + frame.rect.width > 1620);
  assert.ok(frame.rect.y + frame.rect.height > 1080);
  const animated = getScreenGeometry(project, 1.883, 1620, 1080);
  assert.ok(animated.rect.x < 0 && animated.rect.y < 0);
  assert.ok(animated.rect.x + animated.rect.width > 1620);
  assert.ok(animated.rect.y + animated.rect.height > 1080);
  assert.deepEqual(
    getScreenGeometry(project, 0, 1620, 1080).rect,
    getScreenRect(project, 1620, 1080),
  );
});

test("corner zooms retain the source crop and clamp the enlarged frame against the padded zoom area", () => {
  const project = createProject(media);
  project.appearance.cameraHidden = true;
  project.appearance.crop = { x: 0.2, y: 0.1, width: 0.6, height: 0.7 };
  const base = project.appearance.crop;
  for (const x of [0, 0.5, 1])
    for (const y of [0, 0.5, 1]) {
      project.zooms = [zoom({ x, y, scale: 5 })];
      for (const time of [0, 1, 1.01, 1.3, 2, 4.9, 5, 6]) {
        const { rect, crop } = getScreenTarget(project, time, 1620, 1080);
        assert.deepEqual(crop, base);
        close(rect.width / rect.height, (1920 * 0.6) / (1080 * 0.7));
        if (rect.width >= 1440) {
          assert.ok(rect.x <= 90 + 1e-10);
          assert.ok(rect.x + rect.width >= 1530 - 1e-10);
        } else close(rect.x + rect.width / 2, 810);
        if (rect.height >= 900) {
          assert.ok(rect.y <= 90 + 1e-10);
          assert.ok(rect.y + rect.height >= 990 - 1e-10);
        } else close(rect.y + rect.height / 2, 540);
      }
    }
  project.zooms = [zoom({ x: 0.5, y: 0.45, scale: 3 })];
  const centered = getScreenTarget(project, 2, 1620, 1080);
  const mapped = sourcePointToScreen(
    { x: 0.5, y: 0.45 },
    centered.crop,
    centered.rect,
  );
  close(mapped.x, 810);
  close(mapped.y, 540);
  const repaired = normalizeCrop({ x: 2, y: -1, width: 5, height: -10 });
  assert.ok(
    repaired.x >= 0 &&
      repaired.y >= 0 &&
      repaired.width > 0 &&
      repaired.height > 0,
  );
  assert.ok(
    repaired.x + repaired.width <= 1 && repaired.y + repaired.height <= 1,
  );
});

test("auto zoom follows the recorded cursor with smooth panning while manual focus stays fixed", () => {
  const project = createProject(media);
  project.cursor = [
    { t: 0, x: 0.1, y: 0.2, click: false },
    { t: 1, x: 0.1, y: 0.2, click: false },
    { t: 2, x: 0.9, y: 0.8, click: false },
    { t: 3, x: 0.9, y: 0.8, click: false },
  ];
  const automatic = zoom({
    mode: "auto",
    start: 0,
    end: 4,
    scale: 3,
    x: 0.4,
    y: 0.4,
  });
  project.zooms = [automatic];
  const earlier = getScreenGeometry(project, 0.8, 1920, 1080),
    later = getScreenGeometry(project, 2.2, 1920, 1080);
  assert.ok(
    earlier.rect.x - later.rect.x > 1920 && earlier.rect.y > later.rect.y,
  );
  assert.deepEqual(earlier.crop, later.crop);
  const before = getAutoZoomFocus(project.cursor, 1.5 - 0.0001, automatic);
  const after = getAutoZoomFocus(project.cursor, 1.5 + 0.0001, automatic);
  assert.ok(Math.abs(after.x - before.x) < 0.001);
  close(getAutoZoomFocus(project.cursor, 1.5, automatic).x, 0.5);
  const suddenMove: CursorPoint[] = [
    { t: 0, x: 0.1, y: 0.5, click: false },
    { t: 0.999, x: 0.1, y: 0.5, click: false },
    { t: 1, x: 0.9, y: 0.5, click: false },
    { t: 2, x: 0.9, y: 0.5, click: false },
  ];
  assert.ok(getAutoZoomFocus(suddenMove, 1, automatic).x < 0.8);
  assert.deepEqual(
    getAutoZoomFocus(
      suddenMove.map((point) => ({ ...point, visible: false })),
      1,
      automatic,
    ),
    { x: 0.4, y: 0.4 },
  );

  project.zooms = [{ ...automatic, mode: "manual" }];
  assert.deepEqual(
    getScreenGeometry(project, 0.8, 1920, 1080),
    getScreenGeometry(project, 2.2, 1920, 1080),
  );
  project.zooms = [automatic];
  project.cursor = [];
  assert.deepEqual(getZoomTarget(project.zooms, 2, []), {
    scale: 3,
    x: 0.4,
    y: 0.4,
    instant: false,
  });
});

test("cursor lookup interpolates real samples, preserves visibility, and keeps click position while moving", () => {
  const points: CursorPoint[] = [
    { t: 0, x: 0, y: 0.2, click: false },
    { t: 0.2, x: 0.2, y: 0.2, click: true },
    { t: 0.4, x: 0.6, y: 0.6, click: false },
    { t: 0.6, x: 1, y: 1, click: false },
  ];
  assert.equal(getCursorAtTime([], 0), null);
  assert.equal(getCursorAtTime(points, -1)?.visible, false);
  const interpolated = getCursorAtTime(points, 0.5, false)!;
  close(interpolated.x, 0.8);
  close(interpolated.y, 0.8);
  assert.deepEqual(interpolated.lastClick, { t: 0.2, x: 0.2, y: 0.2 });
  assert.equal(interpolated.idleSeconds, 0);
  assert.equal(getCursorAtTime(points, 4)?.idleSeconds, 2.5);
  const hidden = [
    { ...points[0], visible: false },
    { ...points[1], visible: true },
  ];
  assert.equal(getCursorAtTime(hidden, 0.1)?.visible, false);
  assert.equal(getCursorAtTime(hidden, 0.2)?.visible, true);
});

test("cursor mapping and camera placement respect the visible output bounds", () => {
  const screen = { x: 100, y: 50, width: 800, height: 400 };
  const crop = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
  assert.deepEqual(sourcePointToScreen({ x: 0.5, y: 0.5 }, crop, screen), {
    x: 500,
    y: 250,
    inside: true,
  });
  assert.equal(sourcePointToScreen({ x: 0, y: 0 }, crop, screen).inside, false);
  const appearance = defaultAppearance();
  appearance.cameraX = 2;
  appearance.cameraY = -1;
  const camera = getCameraRect(appearance, 1080, 1920);
  close(camera.x + camera.width, 1080);
  close(camera.y, 0);
  close(camera.width / camera.height, 16 / 9);
});

test("automatic zooms cluster clicks, remain bounded, and never manufacture a track without cursor evidence", () => {
  const points: CursorPoint[] = [
    { t: 0.1, x: 0.2, y: 0.2, click: true },
    { t: 0.8, x: 0.22, y: 0.21, click: true },
    { t: 3.9, x: 0.9, y: 0.8, click: true },
  ];
  const original = JSON.stringify(points);
  const ranges = generateAutoZooms(points, 4);
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0].start, 0);
  assert.equal(ranges[1].end, 4);
  assert.ok(
    ranges.every((range) => range.start < range.end && range.mode === "auto"),
  );
  assert.equal(JSON.stringify(points), original);
  assert.deepEqual(generateAutoZooms([], 10), []);
  assert.deepEqual(generateAutoZooms(points, 0), []);
});

test("clock labels use hundredths without floating-point rollover", () => {
  assert.equal(formatTime(0, true), "0:00.00");
  assert.equal(formatTime(65.129, true), "1:05.12");
  assert.equal(formatTime(59.999, true), "0:59.99");
  assert.equal(formatTime(3601), "1:00:01");
  assert.equal(formatTime(-2), "0:00");
});

test("transport timecode displays frame indices instead of hundredths", () => {
  assert.equal(formatTimecode(3.5), "00:03.30");
  assert.equal(formatTimecode(3.5, 30), "00:03.15");
  assert.equal(formatTimecode(59.999, 60), "00:59.59");
  assert.equal(formatTimecode(60, 60), "01:00.00");
  assert.equal(formatTimecode(3601.5, 60), "1:00:01.30");
  assert.equal(formatTimecode(-1), "00:00.00");
});
