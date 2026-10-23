import test from "node:test";
import assert from "node:assert/strict";
import { cameraCoverCrop, cameraFaceFocus, cameraIsHidden, cameraSceneAt, cameraSourceTime, parseCameraLUT, sampleCameraLUT } from "../src/core/camera-effects.ts";
import { createProject, createScreenAnimator, getMediaTime, getOutputTime, getScreenGeometry, getScreenTarget } from "../src/core/model.ts";
import type { Project } from "../src/types.ts";

const project = (): Project => ({ ...createProject({ path: "/qa/screen.mp4", name: "Recording", width: 1920, height: 1080, duration: 8 }), cameraPath: "/qa/camera.mp4", cameraSource: { width: 1920, height: 1080 } });
const close = (actual: number, expected: number, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test("layout scenes retain source ranges across removed media, speed changes and overlapping disabled edits", () => {
  const p = project();
  p.cameraScenes = [
    { id: "full", start: 4, end: 6, layout: { type: "fullscreen-camera", enablePadding: false } },
    { id: "screen", start: 5, end: 7, layout: { type: "screen-only" } },
    { id: "disabled", start: 4, end: 8, layout: { type: "screen-only" }, disabled: true },
  ];
  p.slices = [{ id: "fast", start: 0, end: 2, speed: 2, volume: 1 }, { id: "last", start: 4, end: 8, speed: 1, volume: 1 }];
  assert.equal(getOutputTime(p, 4), 1);
  assert.equal(getMediaTime(p, 1), 4);
  assert.equal(cameraSceneAt(p, 4)?.id, "full");
  assert.equal(cameraSceneAt(p, 5)?.id, "screen");
  assert.equal(cameraSceneAt(p, 7), null, "scene ends are exclusive");
  const full = getScreenTarget(p, 4, 1920, 1080);
  assert.deepEqual(full.camera, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.equal(full.screenOpacity, 0);
  assert.equal(full.cameraOpacity, 1);
  const screen = getScreenTarget(p, 5, 1920, 1080);
  assert.equal(screen.screenOpacity, 1);
  assert.equal(screen.cameraOpacity, 0);
});

test("preview and export share output-clock scene transitions through a source-time cut", () => {
  const p = project();
  p.appearance.aspect = "16:9";
  p.cameraScenes = [{ id: "full", start: 4, end: 7, layout: { type: "fullscreen-camera", enablePadding: false } }];
  p.slices = [{ id: "fast", start: 0, end: 2, speed: 2, volume: 1 }, { id: "last", start: 4, end: 8, speed: 1, volume: 1 }];
  const preview = createScreenAnimator(60), exported = createScreenAnimator(60);
  const before = getScreenGeometry(p, 1.95, 960, 540, 60, preview);
  const transition = getScreenGeometry(p, 4.1, 960, 540, 60, preview);
  assert.ok(transition.camera!.width > before.camera!.width);
  assert.ok(transition.camera!.width < 960, "a range boundary animates instead of cutting instantly");
  const settled = getScreenGeometry(p, 5, 960, 540, 60, preview);
  assert.ok(Math.abs(settled.camera!.width - 960) < 10);
  assert.ok(settled.screenOpacity < .02);
  for (const sourceTime of [0, .5, 1, 1.95, 4, 4.1, 4.5, 5]) {
    const small = getScreenGeometry(p, sourceTime, 960, 540, 60, createScreenAnimator(60));
    const large = getScreenGeometry(p, sourceTime, 1920, 1080, 60, exported);
    close(large.camera!.width, small.camera!.width * 2);
    close(large.camera!.x, small.camera!.x * 2);
    close(large.cameraOpacity, small.cameraOpacity);
    close(large.screenOpacity, small.screenOpacity);
  }
});

test("only measured matching audio intervals hide the camera, with a real fade/shrink", () => {
  const p = project(); p.appearance.cameraHideDuringSilence = true;
  p.cameraSilence = { version: 1, source: { path: p.mediaPath!, sha256: "a".repeat(64), duration: 8 }, thresholdDB: -40, minimumSeconds: .1, windowSeconds: .02, intervals: [{ start: 1, end: 1.5 }], coverage: { complete: false, intervals: [{ start: 0, end: 1.5 }], limitations: ["Partial test measurement."] } };
  assert.equal(cameraIsHidden(p, .9), false);
  assert.equal(cameraIsHidden(p, 1.2), true);
  p.appearance.cameraSilenceMinimumSeconds = 1;
  assert.equal(cameraIsHidden(p, 1.2), false, "a short measured quiet range does not meet the selected minimum");
  p.appearance.cameraSilenceMinimumSeconds = .1;
  assert.equal(cameraIsHidden(p, 1.8), false);
  const animator = createScreenAnimator(60);
  const visible = getScreenGeometry(p, .9, 1920, 1080, 60, animator);
  const hidden = getScreenGeometry(p, 1.3, 1920, 1080, 60, animator);
  assert.ok(hidden.cameraOpacity < visible.cameraOpacity);
  assert.ok(hidden.camera!.width < visible.camera!.width);
  p.cameraSilence.source.path = "/qa/replaced.wav";
  assert.equal(cameraIsHidden(p, 1.2), false, "an unrelated file never supplies silence");
});

test("face following uses actual source observations and stops on explicit no-face or uncovered samples", () => {
  const p = project(); p.appearance.cameraFollowFace = true;
  p.cameraFaceTrack = { version: 1, source: { path: p.cameraPath!, sha256: "b".repeat(64), duration: 8, width: 1920, height: 1080 }, coordinateSpace: "oriented-top-left-normalized", sampleInterval: .2, samples: [{ t: 0, face: { x: .1, y: .2, width: .1, height: .2, confidence: .99 } }, { t: .2, face: null }, { t: 1, face: { x: .8, y: .2, width: .1, height: .2, confidence: .99 } }], coverage: { complete: false, intervals: [{ start: 0, end: 2 }], limitations: [] } };
  close(cameraFaceFocus(p, .1).x, .15);
  assert.deepEqual(cameraFaceFocus(p, .2), { x: .5, y: .5 });
  assert.deepEqual(cameraFaceFocus(p, .9), { x: .5, y: .5 });
  assert.deepEqual(cameraFaceFocus(p, 2), { x: .5, y: .5 });
  p.appearance.cameraDelayMs = 200;
  assert.deepEqual(cameraFaceFocus(p, 0), { x: .5, y: .5 }, "face lookup advances with the delayed camera image to its explicit no-face sample");
  p.appearance.cameraDelayMs = -200;
  close(cameraFaceFocus(p, .3).x, .15);
  p.appearance.cameraDelayMs = 0;
  const crop = cameraCoverCrop({ width: 1920, height: 1080 }, { width: 400, height: 400 }, { x: .15, y: .3 });
  assert.deepEqual(crop, { x: 0, y: 0, width: 1080, height: 1080 });
  const right = cameraCoverCrop({ width: 1920, height: 1080 }, { width: 400, height: 400 }, { x: .85, y: .3 });
  assert.equal(right.x, 840);
  p.cameraFaceTrack.source.path = "/qa/another.mp4";
  assert.deepEqual(cameraFaceFocus(p, .1), { x: .5, y: .5 });
});

test("signed camera sync and source crop preserve camera-only timing and full-source coordinates", () => {
  const p = project(); p.appearance.cameraDelayMs = 200;
  close(cameraSourceTime(p, 1), 1.2);
  close(cameraSourceTime(p, 1, 1), 1, 1e-8);
  p.appearance.cameraDelayMs = -200;
  close(cameraSourceTime(p, 1), .8); close(cameraSourceTime(p, 0), 0);
  p.cameraStartTime = .25;
  assert.equal(cameraIsHidden(p, .4), true, "a negative sync correction does not expose the first camera frame during its real leading gap");
  assert.equal(cameraIsHidden(p, .5), false);
  assert.equal(getMediaTime(p, 1), 1, "the screen/microphone clock does not move");
  assert.deepEqual(cameraCoverCrop({ width: 1920, height: 1080 }, { width: 400, height: 400 }, { x: 1, y: .5 }, { x: .25, y: 0, width: .5, height: 1 }), { x: 480, y: 60, width: 960, height: 960 });
});

test("3D .cube LUT parsing preserves red-fast ordering, domains and trilinear values", () => {
  const rows: string[] = [];
  for (let blue = 0; blue <= 1; blue++) for (let green = 0; green <= 1; green++) for (let red = 0; red <= 1; red++) rows.push(`${red} ${green} ${blue}`);
  const text = `TITLE "Identity"\nLUT_3D_SIZE 2\n${rows.join("\n")}\n`;
  const result = parseCameraLUT(text);
  assert.equal(result.ok, true); if (!result.ok) return;
  assert.deepEqual(sampleCameraLUT(result.value, [.25, .5, .75]), [.25, .5, .75]);
  assert.equal(parseCameraLUT(text.replace('"Identity"', '"Identity #1" # comment')).ok, true);
  assert.deepEqual(sampleCameraLUT({ ...result.value, domainMin: [-1, -1, -1], domainMax: [1, 1, 1] }, [0, -.5, 1]), [.5, .25, 1]);
  for (const malformed of ["LUT_1D_SIZE 2\n0 0 0", text.replace("SIZE 2", "SIZE 66"), text.replace("0 0 0", "NaN 0 0"), text + "1 1 1", text.replace("0 0 0\n", ""), `DOMAIN_MIN 1 0 0\nDOMAIN_MAX 0 1 1\n${text}`]) assert.equal(parseCameraLUT(malformed).ok, false);
});
