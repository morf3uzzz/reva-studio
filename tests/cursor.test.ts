import assert from "node:assert/strict";
import test from "node:test";
import { createProject } from "../src/core/model.ts";
import { DEFAULT_SPRING } from "../src/core/spring.ts";
import { RecordedCursorPath, planCursorMotion } from "../src/core/cursor-motion.ts";
import { cursorAsset, cursorVisibleHeight } from "../src/core/cursor-render.ts";
import { cursorAudioCues, cursorCircleState, cursorFrameAt, cursorRippleOffset, cursorRotationKeyframes, defaultCursorSettings, optimizedCursorTypes, removeCursorShakes, resolveCursorSettings, type RecordedCursorPoint } from "../src/core/cursor.ts";

const close = (value: number, expected: number, epsilon = 1e-7) => assert.ok(Math.abs(value - expected) <= epsilon, `${value} != ${expected}`);
function project() {
  const p = createProject({ path: "/sample.mov", name: "Sample", duration: 5, width: 1000, height: 1000 });
  p.appearance.cursorSettings = defaultCursorSettings();
  return p;
}
const sample = (t: number, x: number, patch: Partial<RecordedCursorPoint> = {}): RecordedCursorPoint => ({ t, x, y: 0.5, click: false, event: "mouseMoved", cursorType: "pointer", ...patch });

test("legacy fallback preserves caller choices without creating or mutating settings", () => {
  const p = createProject();
  p.appearance.cursorSize = 27; p.appearance.cursorHidden = true; p.appearance.cursorHideIdle = true; p.appearance.clickEffect = "ripple";
  const settings = resolveCursorSettings(p.appearance);
  assert.equal(settings.size, 27); assert.equal(settings.hidden, true); assert.equal(settings.hideNotMovingAfterMs, 2000); assert.equal(settings.clickEffect, "ripple");
  assert.equal(p.appearance.cursorSettings, undefined);
  settings.set.variants.pointer = "pointer-2";
  assert.deepEqual(defaultCursorSettings().set.variants, {});
  p.appearance.cursorSettings = { ...defaultCursorSettings(), size: 56, hidden: false };
  assert.equal(resolveCursorSettings(p.appearance).size, 56); assert.equal(resolveCursorSettings(p.appearance).hidden, false);
});

test("shake removal uses two following L1 pixel distances and removes the matching release", () => {
  const points = [sample(0, 0.1), sample(0.02, 0.95, { click: true, event: "mouseDown", button: "left" }), sample(0.03, 0.1, { event: "mouseUp" }), sample(0.04, 0.1), sample(0.05, 0.11, { hover: true })];
  assert.deepEqual(removeCursorShakes(points, 500, 1000, 1000), [points[0], points[3], points[4]]);
  assert.deepEqual(removeCursorShakes(points, 1000, 1000, 1000), points);
  assert.deepEqual(removeCursorShakes(points, 0, 1000, 1000), points);
  assert.deepEqual(removeCursorShakes(points, 500, 100, 100), points, "the threshold is recording pixels, not milliseconds");
  assert.equal(points[1].event, "mouseDown", "input samples remain intact");
});

test("shape optimization retains a deliberate click/drag choice and drops incidental hover flicker", () => {
  const points = [sample(0, 0.1), sample(0.1, 0.2, { cursorType: "ibeam" }), sample(0.2, 0.3), sample(0.3, 0.4, { cursorType: "pointingHand", event: "mouseDown", click: true }), sample(0.4, 0.4, { cursorType: "pointingHand", event: "mouseUp" }), sample(0.8, 0.5, { cursorType: "ibeam" })];
  assert.deepEqual(optimizedCursorTypes(points).map(p => p.cursorType), ["pointingHand", "pointingHand", "pointer"]);
});

test("recorded interpolation holds across gaps over 40ms and respects the first same-time cut anchor", () => {
  const path = new RecordedCursorPath([{ timeMs: 0, x: 0, y: 0 }, { timeMs: 20, x: 20, y: 10 }, { timeMs: 100, x: 80, y: 40 }, { timeMs: 100, x: 500, y: 400 }]);
  assert.deepEqual(path.positionAt(10), { x: 10, y: 5 });
  assert.deepEqual(path.positionAt(60), { x: 20, y: 10 });
  assert.deepEqual(path.positionAt(100), { x: 80, y: 40 });
  assert.deepEqual(path.positionAt(100.001), { x: 500, y: 400 });
  assert.equal(path.stillBetween(30, 80), true); assert.equal(path.stillBetween(10, 80), false);
});

test("cursor integrator has a real fractional lookup and mass-zero instant path", () => {
  const input = { points: [{ timeMs: 0, x: 0, y: 0 }, { timeMs: 100, x: 10, y: 0 }], syncPoints: [], spring: { ...DEFAULT_SPRING, stiffness: 100, damping: 10, mass: 1, clamp: false }, durationMs: 300, instantRanges: [], cutTimesMs: [] };
  const path = planCursorMotion(input);
  close(path.positionAt(99).x, 0); close(path.positionAt(100).x, 0.001); close(path.positionAt(101).x, 0.0029899);
  close(path.positionAt(100.5).x, (0.001 + 0.0029899) / 2);
  const instant = planCursorMotion({ ...input, spring: { ...input.spring, mass: 0 } });
  close(instant.positionAt(100).x, 10);
  const sliceInstant = planCursorMotion({ ...input, instantRanges: [{ startMs: 100, endMs: 110 }] });
  close(sliceInstant.positionAt(100).x, 10);
});

test("sync planning reaches a click with measured tolerance and lead stays within 600ms", () => {
  const points = Array.from({ length: 51 }, (_, i) => ({ timeMs: i * 20, x: i * 8, y: 50 }));
  const input = { points, syncPoints: [], spring: DEFAULT_SPRING, durationMs: 1200, instantRanges: [], cutTimesMs: [] };
  const raw = planCursorMotion(input), planned = planCursorMotion({ ...input, syncPoints: [{ timeMs: 800, tolerance: 2, reason: "click" }] });
  assert.ok(Math.abs(planned.positionAt(800).x - 320) < 1.51);
  assert.ok(Math.abs(raw.positionAt(800).x - 320) > 10);
  assert.ok(planned.groups[0].error <= 0.75);
  const target = planned.targetTimeAt(800); assert.ok(target <= 800 && target >= 200);
});

test("tilt follows horizontal velocity, follow retains its bearing after movement", () => {
  const points = Array.from({ length: 101 }, (_, i) => ({ timeMs: i * 20, x: i * 20, y: 0 }));
  const tilt = cursorRotationKeyframes(points, "velocity", 0.5);
  const atMiddle = tilt.find(p => p.timeMs >= 1500)!; close(atMiddle.radians, Math.PI / 30, 1e-5);
  close(tilt.at(-1)!.radians, 0);
  assert.deepEqual(cursorRotationKeyframes(points, "velocity", 0), []);
  const follow = cursorRotationKeyframes(points, "directional", 0.5);
  assert.ok(Math.abs(follow.at(-1)!.radians) > 0.5);
  assert.ok(follow.every(p => Math.abs(p.radians) <= Math.PI * 0.75));
});

test("frame lookup honors legacy/per-slice smoothing and exposes recorded shapes without mutation", () => {
  const p = project(); p.appearance.cursorSmooth = false; p.appearance.cursorSettings!.shakeThreshold = 0; p.appearance.cursorSettings!.optimizeChanges = false;
  p.cursor = [sample(0, 0.1), sample(1, 0.8, { cursorType: "iBeam" }), sample(1.03, 0.9)];
  const instant = cursorFrameAt(p, 1.02)!; close(instant.x, 0.8 + 0.1 * 2 / 3, 1e-6); assert.equal(instant.type, "ibeamstroke");
  assert.deepEqual(cursorFrameAt(p, 1.02), instant, "warm lookup and arbitrary seek agree");
  const smooth = structuredClone(p); smooth.appearance.cursorSmooth = true; smooth.cursor = smooth.cursor.map(point => ({ ...point, cursorType: "pointer" }));
  assert.ok(cursorFrameAt(smooth, 1.02)!.x < instant.x - 0.2);
  smooth.slices = [{ id: "raw", start: 0, end: 5, speed: 1, volume: 1, cursorSmooth: false }];
  const changed = structuredClone(smooth); close(cursorFrameAt(changed, 1.02)!.x, instant.x, 1e-6);
});

test("idle delay, end stop and loop affect deterministic output position and opacity", () => {
  const p = project(); p.appearance.cursorSmooth = false; p.appearance.cursorSettings!.shakeThreshold = 0;
  p.cursor = [sample(0, 0.1), sample(1, 0.3), sample(3.9, 0.8), sample(4.8, 0.9)];
  p.appearance.cursorSettings!.hideNotMovingAfterMs = 500;
  assert.ok(cursorFrameAt(p, 2)!.opacity < 0.1);
  const stopped = structuredClone(p); stopped.appearance.cursorSettings!.stopMovementInLastPartMs = 1000;
  close(cursorFrameAt(stopped, 4.9)!.x, 0.8, 1e-6);
  const looped = structuredClone(stopped); looped.appearance.cursorSettings!.loopPositionBeforeEndMs = 1000;
  close(cursorFrameAt(looped, 4.9)!.x, 0.1, 1e-6);
});

test("follow direction survives a long pause and a random seek into a later cache chunk", () => {
  const p = project(); p.duration = 25; p.trimEnd = 25;
  p.appearance.cursorSettings!.shakeThreshold = 0; p.appearance.cursorSettings!.rotationMode = "directional";
  p.cursor = [sample(0, 0.1, { y: 0.1 }), sample(1, 0.1, { y: 0.5 }), sample(2, 0.1, { y: 0.8 })];
  const late = cursorFrameAt(p, 23)!;
  assert.ok(Math.abs(late.rotation) > 1);
  close(late.rotation, cursorFrameAt(p, 8)!.rotation, 1e-4);
});

test("recorded hover synchronization changes the planned path only when enabled", () => {
  const p = project(); p.appearance.cursorSettings!.shakeThreshold = 0;
  p.cursor = Array.from({ length: 101 }, (_, i) => sample(i * 0.02, 0.1 + i * 0.005, { hover: i === 70 }));
  const synced = cursorFrameAt(p, 1.4)!;
  const disabled = structuredClone(p); disabled.appearance.cursorSettings!.syncWithHovers = false;
  const raw = cursorFrameAt(disabled, 1.4)!;
  assert.ok(Math.abs(synced.x - 0.45) < 0.004);
  assert.ok(raw.x < synced.x - 0.01);
});

test("source-derived click circle and ripple are distinct effects", () => {
  assert.equal(cursorCircleState(0, 1000), null); assert.equal(cursorCircleState(451, 1000), null);
  const circle = cursorCircleState(67.5, 1000)!; close(circle.radius, 12.8045); close(circle.alpha, 0.6); close(circle.rimWidth, 0.7);
  assert.deepEqual(cursorRippleOffset(0, 40, 1000), { displacement: 0, chromatic: 0 });
  const ripple = cursorRippleOffset(100, 60, 1000); close(ripple.displacement, Math.exp(-0.3) * Math.sin(0.94) * 15); close(ripple.chromatic, 0);
  assert.deepEqual(cursorRippleOffset(1001, 60, 1000), { displacement: 0, chromatic: 0 });
});

test("fixed cursor variants and alpha measurement preserve hotspot-sized artwork", () => {
  const settings = defaultCursorSettings(); settings.set = { id: "custom-2", variants: { pointer: "pointer-2" } };
  assert.equal(cursorAsset(settings, "ibeam")!.id, "pointer-2");
  assert.equal(cursorAsset(settings, "pointer")!.hotspot.x, 0.04);
  const pixels = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 5;
  pixels[(1 * 4 + 1) * 4 + 3] = 255; pixels[(2 * 4 + 1) * 4 + 3] = 255;
  close(cursorVisibleHeight(pixels, 4, 4), 0.5);
});

test("audio cues pair short clicks, retain holds, respect cuts, and omit speed over 2x", () => {
  const p = project();
  p.cursor = [sample(0.2, 0.1, { click: true, event: "mouseDown" }), sample(0.3, 0.1, { event: "mouseUp" }), sample(1, 0.2, { click: true, event: "mouseDown" }), sample(1.7, 0.2, { event: "mouseUp" }), sample(2.2, 0.3, { click: true, event: "mouseDown" }), sample(2.3, 0.3, { event: "mouseUp" })];
  assert.deepEqual(cursorAudioCues(p).map(c => [c.outputTime, c.type]), [[0.2, "click"], [1, "down"], [1.7, "up"], [2.2, "click"]]);
  p.slices = [{ id: "slow", start: 0, end: 2, speed: 2, volume: 1 }, { id: "fast", start: 2, end: 5, speed: 3, volume: 1 }];
  assert.deepEqual(cursorAudioCues(p).map(c => c.outputTime), [0.1, 0.5, 0.85]);
  const legacy = project(); legacy.cursor = [{ t: 0.5, x: 0.3, y: 0.4, click: true }];
  assert.deepEqual(cursorAudioCues(legacy), [{ sourceTime: 0.5, outputTime: 0.5, type: "click" }]);
});
