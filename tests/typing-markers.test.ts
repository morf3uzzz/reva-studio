import assert from "node:assert/strict";
import test from "node:test";
import { deriveTypingRanges } from "../shared/typing-markers.mjs";
import { createProject } from "../src/core/model.ts";
import { applyTypingSuggestions, canApplyTypingSpeed, duration, resolveTypingSuggestion, sourceRangeOutputSpans, timeToOutput, typingSuggestionSpans, unresolvedTypingRanges } from "../src/core/timeline.ts";
import type { Project } from "../src/types.ts";

const samples = (times: number[]) => times.map(time => ({ time, count: 1 }));
function example(): Project {
  return {
    ...createProject({ path: "/sample.mp4", name: "sample.mp4", duration: 12, width: 1440, height: 900 }),
    slices: [
      { id: "first", start: 0, end: 3, speed: 1, volume: 0.7, cursorHidden: true },
      { id: "second", start: 4, end: 8, speed: 2, volume: 0.5, cursorSmooth: false },
      { id: "third", start: 9, end: 12, speed: 1, volume: 1 },
    ],
    pauseMarkers: [{ time: 3.5, duration: 17 }, { time: 6, duration: 9 }],
    typingRanges: [{ start: 1, end: 5, count: 15 }, { start: 6, end: 7.5, count: 7 }, { start: 9.5, end: 11, count: 7 }],
  };
}

test("source grouping requires 1500ms and joins only adjacent gaps strictly below 500ms", () => {
  assert.deepEqual(deriveTypingRanges([]), []);
  assert.deepEqual(deriveTypingRanges(samples([0, 0.3, 0.6, 0.9, 1.2, 1.499])), []);
  assert.deepEqual(deriveTypingRanges(samples([0, 0.3, 0.6, 0.9, 1.2, 1.5])), [{ start: 0, end: 1.5, count: 6 }]);
  // 0.7 - 0.2 is slightly below 0.5 in IEEE754; the original unit is milliseconds.
  assert.deepEqual(deriveTypingRanges(samples([0.2, 0.7, 1, 1.3, 1.6, 1.9, 2.2])), [{ start: 0.7, end: 2.2, count: 6 }]);
  assert.deepEqual(deriveTypingRanges(samples([0, 0.3, 0.6, 0.9, 1.2, 1.5, 2, 2.3, 2.6, 2.9, 3.2, 3.5])), [{ start: 0, end: 1.5, count: 6 }, { start: 2, end: 3.5, count: 6 }]);
});

test("aggregate activity counts produce timing-only suggestions with duplicate observations retained", () => {
  const input = samples([0, 0.3, 0.6, 0.9, 1.2, 1.5]);
  input[2].count = 4;
  input.splice(3, 0, { time: 0.6, count: 2 });
  const before = structuredClone(input);
  assert.deepEqual(deriveTypingRanges(input), [{ start: 0, end: 1.5, count: 11 }]);
  assert.deepEqual(input, before);
});

test("pause points and typing spans follow retained source clips and their independent speeds", () => {
  const project = example();
  assert.equal(timeToOutput(project, project.pauseMarkers![0].time), null);
  assert.equal(timeToOutput(project, project.pauseMarkers![1].time), 4);
  assert.deepEqual(sourceRangeOutputSpans(project, 1, 5), [{ start: 1, end: 3, sliceId: "first" }, { start: 3, end: 3.5, sliceId: "second" }]);
  assert.deepEqual(sourceRangeOutputSpans(project, 3.1, 3.9), []);
  const absent = { start: 8.1, end: 8.9, count: 4 };
  project.typingRanges!.splice(2, 0, absent);
  project.resolvedTypingSuggestions = [6];
  assert.deepEqual(unresolvedTypingRanges(project).map(range => range.start), [1, 9.5]);
  assert.deepEqual(typingSuggestionSpans(project).map(({ start, end, canApply }) => ({ start, end, canApply })), [{ start: 1, end: 3.5, canApply: true }, { start: 5.5, end: 7, canApply: true }]);
});

test("one typing edit speeds every retained intersection while preserving source gaps, flags, volumes and history input", () => {
  const project = example(), before = structuredClone(project);
  const changed = applyTypingSuggestions(project, [project.typingRanges![0]], 3);
  assert.deepEqual(changed.slices, [
    { ...project.slices![0], end: 1 },
    { ...project.slices![0], id: "typing-1", start: 1, speed: 3 },
    { ...project.slices![1], end: 5, speed: 3 },
    { ...project.slices![1], id: "typing-2", start: 5 },
    project.slices![2],
  ]);
  assert.deepEqual(changed.resolvedTypingSuggestions, [1]);
  assert.deepEqual(changed.pauseMarkers, project.pauseMarkers);
  assert.equal(timeToOutput(changed, 3.5), null);
  assert.equal(duration(changed), 6.5);
  assert.deepEqual(project, before, "the single history snapshot remains intact for Undo");
  assert.equal(applyTypingSuggestions(changed, [project.typingRanges![0]], 4), changed);
});

test("apply all returns one immutable result, resolves all applied starts and retains sorted unique IDs", () => {
  const project = example();
  project.slices![0].id = "typing-1";
  const changed = applyTypingSuggestions(project, project.typingRanges!, 3);
  assert.deepEqual(changed.resolvedTypingSuggestions, [1, 6, 9.5]);
  assert.equal(unresolvedTypingRanges(changed).length, 0);
  assert.equal(new Set(changed.slices!.map(slice => slice.id)).size, changed.slices!.length);
  assert.ok(changed.slices!.every(slice => slice.id.length <= 256));
  assert.equal(changed.slices!.filter(slice => slice.speed === 3).length, 4);
  assert.equal(project.resolvedTypingSuggestions, undefined);
  const removed = resolveTypingSuggestion(project, 6);
  assert.equal(removed.slices, project.slices, "removing the suggestion does not edit media");
  assert.deepEqual(unresolvedTypingRanges(removed).map(range => range.start), [1, 9.5]);
  assert.equal(resolveTypingSuggestion(removed, 6), removed);
});

test("typing cuts enforce the manual 50ms minimum without rejecting existing clip edges", () => {
  const project = example();
  for (const range of [{ start: 0.049, end: 2, count: 8 }, { start: 1, end: 2.951, count: 8 }, { start: 2.98, end: 4.01, count: 8 }, { start: 3.1, end: 3.9, count: 8 }]) {
    assert.equal(canApplyTypingSpeed(project, range), false);
    assert.equal(applyTypingSuggestions(project, [range], 3), project);
  }
  assert.equal(canApplyTypingSpeed(project, { start: 0.05, end: 2.95, count: 8 }), true);
  assert.equal(canApplyTypingSpeed(project, { start: 0, end: 3, count: 8 }), true);
  project.slices![0].end = 0.02;
  assert.equal(canApplyTypingSpeed(project, { start: 0, end: 0.02, count: 1 }), true);
  for (const speed of [NaN, Infinity, 1, 8.1]) assert.throws(() => applyTypingSuggestions(project, [], speed), RangeError);
});

test("apply all accounts for boundaries created by earlier suggestions without partial range edits", () => {
  const project = example();
  project.typingRanges = [{ start: 0.1, end: 1.5, count: 8 }, { start: 1.52, end: 5, count: 8 }, { start: 6, end: 7.5, count: 8 }];
  const changed = applyTypingSuggestions(project, project.typingRanges, 3);
  assert.deepEqual(changed.resolvedTypingSuggestions, [0.1, 6]);
  assert.equal(changed.slices!.find(slice => slice.start === 4)!.speed, 2, "the rejected range does not change its second retained intersection");
  const expected = applyTypingSuggestions(applyTypingSuggestions(project, [project.typingRanges[0]], 3), [project.typingRanges[2]], 3);
  const shape = (p: Project) => p.slices!.map(({ id: _id, ...slice }) => slice);
  assert.deepEqual(shape(changed), shape(expected));
});
