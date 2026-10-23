import assert from "node:assert/strict";
import test from "node:test";
import { pinchTimeline, timelineAnchoredScroll, timelineSliderSeconds, timelineSliderValue, timelineVisibleSeconds, timelineMarkInterval, timelineMarks, timelineZoomLabel, visibleSliceWindow } from "../src/core/timeline-viewport.ts";

test("pinching keeps the same timeline point under the pointer and reverses without drift", () => {
  const start = { scale: 2, scrollLeft: 350, width: 1000, anchor: 630, duration: 60 };
  const enlarged = pinchTimeline(start, -25);
  assert.ok(enlarged.scale > start.scale);
  assert.ok(Math.abs((enlarged.scrollLeft + start.anchor) / enlarged.scale - (start.scrollLeft + start.anchor) / start.scale) < 1e-9);
  const restored = pinchTimeline({ ...start, ...enlarged }, 25);
  assert.ok(Math.abs(restored.scale - start.scale) < 1e-9);
  assert.ok(Math.abs(restored.scrollLeft - start.scrollLeft) < 1e-9);
});

test("gesture units and bounds agree with the slider without horizontal overscroll", () => {
  const start = { scale: 2, scrollLeft: 700, width: 1000, anchor: 300, duration: 60 };
  assert.deepEqual(pinchTimeline(start, -16), pinchTimeline(start, -1, 1));
  assert.deepEqual(pinchTimeline(start, -188), pinchTimeline(start, -1, 2));
  const small = pinchTimeline(start, 10000), large = pinchTimeline(start, -10000);
  assert.deepEqual(small, { scale: 1, scrollLeft: 0 });
  assert.equal(large.scale, 30);
  assert.ok(large.scrollLeft >= 0 && large.scrollLeft <= start.width * (large.scale - 1));
  assert.equal(pinchTimeline(start, NaN).scale, start.scale);
});

test("zooming out from two seconds keeps the committed playhead position despite DOM scroll clamping", () => {
  const width = 1472, duration = 1232, playhead = 222.95, anchor = 290;
  const oldScale = duration / 2, nextScale = duration / 19;
  const oldScroll = playhead / duration * width * oldScale - anchor;
  assert.ok(oldScroll > width * (nextScale - 1), "the browser would clamp this old offset after shrinking content");
  const scroll = timelineAnchoredScroll(oldScale, nextScale, oldScroll, width, anchor);
  assert.ok(Math.abs(playhead / duration * width * nextScale - scroll - anchor) < 1e-9);
  assert.ok(Math.abs(timelineAnchoredScroll(nextScale, oldScale, scroll, width, anchor) - oldScroll) < 1e-9);
});

test("the zoom slider spans 10 minutes to 2 seconds and round trips with cubic easing", () => {
  assert.equal(timelineSliderSeconds(1225, 0), 600);
  assert.equal(timelineSliderSeconds(1225, 1), 2);
  for (const seconds of [2, 19, 60, 120, 600]) {
    assert.ok(Math.abs(timelineSliderSeconds(1225, timelineSliderValue(1225, seconds)) - seconds) < 1e-9);
  }
  assert.equal(timelineSliderSeconds(6, 0), 6);
  assert.equal(timelineSliderSeconds(.4, 1), .4);
  assert.equal(timelineVisibleSeconds(6, 30), 6);
});

test("ruler label density follows the reference and remains bounded on long timelines", () => {
  assert.deepEqual([600, 120, 60, 19, 2].map(seconds => timelineMarkInterval(1488 / seconds)), [30, 10, 5, 2.5, .5]);
  const marks = timelineMarks(220, 225, .5, 86400);
  assert.equal(marks.length, 11);
  assert.deepEqual(marks.filter(Number.isInteger), [220, 221, 222, 223, 224, 225]);
  assert.ok(timelineMarks(0, 2, .5, 86400).every(time => time > 0));
});

test("zoom tooltip updates units, values and both interface languages", () => {
  assert.equal(timelineZoomLabel(600, "en"), "Timeline zoom — 10 minutes visible");
  assert.equal(timelineZoomLabel(60, "en"), "Timeline zoom — 1 minute visible");
  assert.equal(timelineZoomLabel(19.9, "en"), "Timeline zoom — 19 seconds visible");
  assert.equal(timelineZoomLabel(2, "ru"), "Масштаб таймлайна — 2 секунды на экране");
  assert.equal(timelineZoomLabel(21, "ru"), "Масштаб таймлайна — 21 секунда на экране");
  assert.equal(timelineZoomLabel(11, "ru"), "Масштаб таймлайна — 11 секунд на экране");
});

test("waveform windows stay viewport-sized and retain source timing after trims and speed changes", () => {
  const slice = { start: 600, end: 86400, speed: 2 };
  assert.deepEqual(visibleSliceWindow(slice, 100, 220, 222, 744), { left: 89280, width: 1488, sourceStart: 840, sourceEnd: 844 });
  assert.equal(visibleSliceWindow(slice, 100, 0, 2, 744), null);
  assert.deepEqual(visibleSliceWindow({ start: 10, end: 12, speed: 1 }, 5, 4, 6, 100), { left: 0, width: 100, sourceStart: 10, sourceEnd: 11 });
});
