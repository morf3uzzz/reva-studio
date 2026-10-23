import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createProject,
  createScreenAnimator,
  getMediaTime,
  getScreenGeometry,
  getScreenTarget,
} from "../src/core/model.ts";
import { DEFAULT_SPRING } from "../src/core/spring.ts";
import {
  frameToMilliseconds,
  SpringTimeline,
} from "../src/core/spring-timeline.ts";

const close = (actual: number, expected: number, tolerance = 1e-10) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} != ${expected}`,
  );
const scalarTarget = (time: number) => ({
  values: [time >= 1000 && time <= 3000 ? 1 : 0],
});
const media = {
  path: "/sample.mov",
  name: "Sample",
  duration: 6,
  width: 1440,
  height: 900,
};

test("frame-stepped spring values match independent Python vectors at 24, 30 and 60 FPS", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/spring-motion-vectors.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    cases: { fps: number; vectors: { timeMs: number; position: number }[] }[];
  };
  for (const entry of fixture.cases) {
    const timeline = new SpringTimeline(entry.fps, scalarTarget);
    for (const vector of entry.vectors)
      close(timeline.at(vector.timeMs)[0], vector.position);
  }
});

test("fractional times interpolate completed frame values, and repeated reads never advance state", () => {
  const timeline = new SpringTimeline(60, scalarTarget);
  const start = timeline.at(1000)[0];
  const end = timeline.at(frameToMilliseconds(61, 60))[0];
  const halfway = timeline.at(frameToMilliseconds(60.5, 60));
  close(halfway[0], (start + end) / 2);
  const before = timeline.diagnostics;
  assert.equal(timeline.at(frameToMilliseconds(60.5, 60)), halfway);
  assert.deepEqual(timeline.diagnostics, before);
  assert.equal(frameToMilliseconds(60, 60), 1000);
});

test("uncached backward or distant seeks reset with one second of aligned warm-up; cached history does not", () => {
  const timeline = new SpringTimeline(60, scalarTarget);
  timeline.at(0);
  timeline.at(500);
  timeline.at(1500);
  const first = timeline.diagnostics;
  timeline.at(0);
  assert.deepEqual(timeline.diagnostics, first);
  timeline.at(5000);
  assert.equal(timeline.diagnostics.resets, first.resets + 1);
  assert.equal(timeline.diagnostics.cachedFrames, 61);
  const second = timeline.diagnostics;
  timeline.at(4500);
  assert.deepEqual(timeline.diagnostics, second);
  close(timeline.at(1500)[0], new SpringTimeline(60, scalarTarget).at(1500)[0]);
  assert.equal(timeline.diagnostics.resets, second.resets + 1);
});

test("slow custom springs retain the original distinction between continuous playback and an isolated seek", () => {
  const target = (time: number) => ({
    values: [time >= 1000 ? 1 : 0],
    config: { ...DEFAULT_SPRING, stiffness: 5, damping: 5, mass: 15 },
  });
  const playback = new SpringTimeline(60, target);
  for (let frame = 0; frame <= 180; frame++)
    playback.at(frameToMilliseconds(frame, 60));
  const seek = new SpringTimeline(60, target);
  assert.equal(seek.at(3000)[0], 1);
  assert.ok(playback.at(3000)[0] < 0.9);
});

test("structured path config is overridden once by the initial global config update", () => {
  const timeline = new SpringTimeline(60, (time) => ({
    values: [time > 0 ? 1 : 0],
    config: { ...DEFAULT_SPRING, mass: 0 },
  }));
  timeline.at(0);
  const first = timeline.at(frameToMilliseconds(1, 60))[0];
  assert.ok(first > 0 && first < 1);
  assert.equal(timeline.at(frameToMilliseconds(2, 60))[0], 1);
});

test("screen springs use output time across slice gaps and changed playback speed", () => {
  const project = createProject(media);
  project.slices = [
    { id: "first", start: 0, end: 2, speed: 1, volume: 1 },
    { id: "second", start: 3, end: 6, speed: 2, volume: 1 },
  ];
  project.zooms = [
    {
      id: "zoom",
      start: 3.5,
      end: 5.5,
      x: 0.5,
      y: 0.5,
      scale: 3,
      mode: "manual",
    },
  ];
  const outputProject = createProject({ ...media, duration: 3.5 });
  outputProject.zooms = [{ ...project.zooms[0], start: 2.25, end: 3.25 }];
  const slicedAnimator = createScreenAnimator(60);
  const outputAnimator = createScreenAnimator(60);
  for (let frame = 0; frame <= 210; frame++) {
    const output = frameToMilliseconds(frame, 60) / 1000;
    const sliced = getScreenGeometry(
      project,
      getMediaTime(project, output),
      1620,
      1080,
      60,
      slicedAnimator,
    );
    const straight = getScreenGeometry(
      outputProject,
      output,
      1620,
      1080,
      60,
      outputAnimator,
    );
    close(sliced.rect.x, straight.rect.x);
    close(sliced.rect.width, straight.rect.width);
  }
});

test("early zoom targets lead by 350 source milliseconds, while instant ranges snap the following exit frame", () => {
  const project = createProject(media);
  project.speed = 2;
  project.appearance.zoomStartEarly = true;
  project.zooms = [
    { id: "zoom", start: 2, end: 4, x: 0.5, y: 0.5, scale: 3, mode: "manual" },
  ];
  const animator = createScreenAnimator(60);
  close(getScreenGeometry(project, 1.6, 1620, 1080, 60, animator).scale, 1);
  assert.ok(
    getScreenGeometry(project, 1.7, 1620, 1080, 60, animator).scale > 1,
  );
  const instant = createProject(media);
  instant.zooms = [{ ...project.zooms[0], start: 1, end: 2, instant: true }];
  const instantAnimator = createScreenAnimator(60);
  close(
    getScreenGeometry(instant, 0.99, 1620, 1080, 60, instantAnimator).scale,
    1.8,
  );
  close(
    getScreenGeometry(instant, 1, 1620, 1080, 60, instantAnimator).scale,
    3,
  );
  close(
    getScreenGeometry(instant, 2 + 1 / 60, 1620, 1080, 60, instantAnimator)
      .scale,
    1,
  );
});

test("each renderer owns its state and editing a project invalidates its cached geometry", () => {
  const project = createProject(media);
  project.trimStart = 2;
  project.zooms = [
    { id: "zoom", start: 1, end: 4, x: 0.5, y: 0.5, scale: 3, mode: "manual" },
  ];
  const preview = createScreenAnimator(60);
  const exporting = createScreenAnimator(60);
  const start = getScreenGeometry(project, 2, 1620, 1080, 60, preview);
  close(start.scale, 3);
  assert.deepEqual(start.rect, getScreenTarget(project, 2, 1620, 1080).rect);
  assert.equal(exporting.diagnostics, null);
  const small = getScreenGeometry(project, 2.2, 810, 540, 60, preview);
  const large = getScreenGeometry(project, 2.2, 1620, 1080, 60, preview);
  close(small.rect.width * 2, large.rect.width);
  const edited = { ...project, zooms: [] };
  close(getScreenGeometry(edited, 2.2, 1620, 1080, 60, preview).scale, 1);
  assert.throws(() => createScreenAnimator(0), RangeError);
});
