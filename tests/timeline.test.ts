import assert from "node:assert/strict";
import test from "node:test";
import {
  createProject,
  getDuration,
  getMediaTime,
  getOutputTime,
  getZoomTarget,
} from "../src/core/model.ts";
import {
  duration,
  getSlices,
  nearestOutputTime,
  outputToSource,
  removeSlice,
  selectSlice,
  SLICE_SPEEDS,
  splitSlice,
  splitZoom,
  restoreSliceTrim,
  joinNextSlice,
  timeToOutput,
  newZoomRange,
} from "../src/core/timeline.ts";
import type { Project } from "../src/types.ts";

const close = (a: number, b: number, epsilon = 1e-9) =>
  assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);
function example(): Project {
  return {
    ...createProject({
      path: "/sample.mp4",
      name: "sample.mp4",
      duration: 6,
      width: 1440,
      height: 900,
    }),
    slices: [
      { id: "first", start: 0, end: 2, speed: 1, volume: 1 },
      { id: "second", start: 3, end: 6, speed: 2, volume: 0.5 },
    ],
  };
}

test("zoom insertion preview and creation use three output seconds, fit gaps and reject occupied or tiny ranges", () => {
  const project = example();
  project.zooms = [];
  assert.deepEqual(newZoomRange(project, 1), { start: 1, end: 6 });
  assert.deepEqual(newZoomRange(project, 3), { start: 3, end: 6 });
  assert.equal(newZoomRange(project, 2.5), null);
  assert.equal(newZoomRange(project, 5.95), null);
  assert.deepEqual(newZoomRange(project, 5.9), { start: 5.9, end: 6 });
  project.zooms = [{ id: "occupied", start: 4, end: 5, scale: 2, x: .5, y: .5, mode: "auto" }];
  assert.deepEqual(newZoomRange(project, 3), { start: 3, end: 4 });
  assert.deepEqual(newZoomRange(project, 3.75), { start: 3.75, end: 4 });
  assert.equal(newZoomRange(project, 4.5), null);
  assert.deepEqual(newZoomRange(project, 5), { start: 5, end: 6 });
});

test("gap restoration restores source time into the left clip, then joining keeps its settings", () => {
  const original = example();
  const restored = {
    ...original,
    slices: restoreSliceTrim(original, "first", "end"),
  };
  assert.equal(duration(restored), 4.5);
  assert.equal(outputToSource(restored, 2.5), 2.5);
  assert.equal(outputToSource(restored, 3.5), 4);
  assert.deepEqual(restored.slices[1], original.slices![1]);
  const joined = { ...restored, slices: joinNextSlice(restored, "first") };
  assert.equal(duration(joined), 6);
  assert.equal(outputToSource(joined, 4), 4);
  assert.deepEqual(joined.slices, [{ ...original.slices![0], end: 6 }]);
  assert.deepEqual(joinNextSlice(original, "first"), original.slices);
  assert.deepEqual(original.slices, example().slices);
});

test("outer trim markers restore only the source edges and preserve the remaining edits", () => {
  const project = example();
  project.slices![0].start = 0.5;
  project.slices![1].end = 5;
  const start = {
    ...project,
    slices: restoreSliceTrim(project, "first", "start"),
  };
  assert.equal(start.slices[0].start, 0);
  assert.equal(start.slices[1].end, 5);
  const end = { ...start, slices: restoreSliceTrim(start, "second", "end") };
  assert.equal(duration(end), 3.5);
  assert.equal(end.slices[1].speed, 2);
  assert.equal(end.slices[1].volume, 0.5);
  assert.deepEqual(joinNextSlice(end, "second"), end.slices);
});

test("two source slices with a removed gap and independent speeds produce 3.5 seconds", () => {
  const project = example();
  assert.equal(duration(project), 3.5);
  assert.equal(getDuration(project), 3.5);
  assert.equal(outputToSource(project, 1.25), 1.25);
  assert.equal(outputToSource(project, 2), 3);
  assert.equal(outputToSource(project, 2.5), 4);
  assert.equal(outputToSource(project, 3.5), 6);
  assert.equal(outputToSource(project, 20), 6);
  assert.equal(outputToSource(project, -1), 0);
  assert.equal(getMediaTime(project, 2.5), 4);
  assert.equal(timeToOutput(project, 4), 2.5);
  assert.equal(getOutputTime(project, 4), 2.5);
  assert.deepEqual(selectSlice(project, 2), {
    slice: project.slices![1],
    index: 1,
    sourceTime: 3,
    outputTime: 2,
    outputStart: 2,
    outputEnd: 3.5,
  });
});

test("cut boundaries select the next slice and each valid output frame round-trips", () => {
  const project = example();
  assert.equal(selectSlice(project, 2 - 1e-9)?.slice.id, "first");
  assert.equal(selectSlice(project, 2)?.slice.id, "second");
  assert.equal(selectSlice(project, 3.5)?.sourceTime, 6);
  for (let frame = 0; frame < 210; frame++) {
    const output = frame / 60;
    const selected = selectSlice(project, output)!;
    close(
      timeToOutput(project, selected.sourceTime, selected.slice.id)!,
      output,
    );
  }
});

test("timeline queries keep editable copies detached and observe mutable source changes", () => {
  const project = example();
  const editable = getSlices(project);
  const selected = selectSlice(project, 2)!;
  editable[0].end = 1;
  selected.slice.speed = 4;
  assert.equal(project.slices![0].end, 2);
  assert.equal(project.slices![1].speed, 2);
  project.slices![1].speed = 1;
  assert.equal(duration(project), 5);
  assert.equal(outputToSource(project, 3), 4);
  assert.equal(timeToOutput(project, 4), 3);
});

test("source gaps are absent unless callers explicitly request a nearest-boundary seek", () => {
  const project = example();
  assert.equal(timeToOutput(project, 2.25), null);
  assert.equal(timeToOutput(project, -1), null);
  assert.equal(timeToOutput(project, 7), null);
  assert.equal(timeToOutput(project, 1, "second"), null);
  assert.equal(nearestOutputTime(project, 2.25), 2);
  assert.equal(nearestOutputTime(project, 2.75), 2);
  assert.equal(nearestOutputTime(project, -1), 0);
  assert.equal(nearestOutputTime(project, 7), 3.5);
  assert.equal(getOutputTime(project, 2.5), 2);
});

test("legacy trim and speed become one slice, while explicit empty slices stay empty", () => {
  const project = example();
  delete project.slices;
  project.trimStart = 1;
  project.trimEnd = 5;
  project.speed = 0.5;
  assert.deepEqual(getSlices(project), [
    { id: "legacy-slice", start: 1, end: 5, speed: 0.5, volume: 1 },
  ]);
  assert.equal(duration(project), 8);
  assert.equal(getMediaTime(project, 4), 3);
  assert.equal(getOutputTime(project, 3), 4);
  project.slices = [];
  assert.equal(duration(project), 0);
  assert.equal(outputToSource(project, 1), null);
  assert.equal(selectSlice(project, 0), null);
  assert.equal(timeToOutput(project, 3), null);
  assert.equal(getMediaTime(project, 1), 0);
  assert.deepEqual(getSlices(createProject()), []);
});

test("splitting preserves media mapping, speed and volume and enforces 50ms minimum pieces", () => {
  const project = example();
  const before = JSON.stringify(project);
  const slices = splitSlice(project, "second", 4, "right");
  assert.deepEqual(slices, [
    project.slices![0],
    { id: "second", start: 3, end: 4, speed: 2, volume: 0.5 },
    { id: "right", start: 4, end: 6, speed: 2, volume: 0.5 },
  ]);
  const splitProject = { ...project, slices };
  assert.equal(duration(splitProject), 3.5);
  assert.equal(selectSlice(splitProject, 2.5)?.slice.id, "right");
  for (let frame = 0; frame < 210; frame++)
    close(
      outputToSource(splitProject, frame / 60)!,
      outputToSource(project, frame / 60)!,
    );
  assert.deepEqual(splitSlice(project, "first", 0.049), project.slices);
  assert.equal(splitSlice(project, "first", 0.05).length, 3);
  assert.deepEqual(splitSlice(project, "first", 1.951), project.slices);
  assert.throws(() => splitSlice(project, "second", 4, "first"), RangeError);
  assert.equal(JSON.stringify(project), before);
});

test("removing a slice closes its output interval and the available speed choices include the observed values", () => {
  const project = example();
  const remaining = { ...project, slices: removeSlice(project, "first") };
  assert.equal(duration(remaining), 1.5);
  assert.equal(outputToSource(remaining, 0), 3);
  assert.equal(outputToSource(remaining, 1.5), 6);
  assert.deepEqual(
    SLICE_SPEEDS,
    [0.5, 0.75, 1, 1.2, 1.4, 1.6, 1.8, 2, 3, 4, 8, 16, 24],
  );
  remaining.slices![0].speed = 24;
  close(duration(remaining), 0.125);
  remaining.slices![0].speed = 0.75;
  close(duration(remaining), 4);
});

test("a zoom cut follows source time across trimmed and accelerated video, preserving settings and continuous framing", () => {
  const project = example();
  project.zooms = [
    { id: "earlier", start: 0, end: 1, scale: 2, x: 0.5, y: 0.5, mode: "auto" },
    { id: "zoom", start: 3.1, end: 5.9, scale: 3.4, x: 0.3, y: 0.6, mode: "manual", instant: true },
  ];
  const before = JSON.stringify(project);
  const cut = outputToSource(project, 2.5)!;
  assert.equal(cut, 4);
  const zooms = splitZoom(project, "zoom", cut);
  assert.equal(zooms.length, 3);
  assert.equal(zooms[0], project.zooms[0]);
  assert.equal(zooms[1].end, zooms[2].start);
  assert.notEqual(zooms[1].id, zooms[2].id);
  for (let frame = 0; frame < 360; frame++)
    assert.deepEqual(getZoomTarget(zooms, frame / 60), getZoomTarget(project.zooms, frame / 60));
  assert.equal(duration({ ...project, zooms }), duration(project));
  assert.equal(JSON.stringify(project), before);
  assert.equal(splitZoom(project, "zoom", 3.149), project.zooms);
  assert.equal(splitZoom(project, "zoom", NaN), project.zooms);
  assert.equal(splitZoom(project, "missing", 4), project.zooms);
  assert.equal(splitZoom(project, "zoom", 3.15).length, 3);
  assert.throws(() => splitZoom(project, "zoom", cut, "earlier"), RangeError);
  const twice = splitZoom({ ...project, zooms }, "zoom-2", 5);
  assert.equal(new Set(twice.map(item => item.id)).size, 4);
});
