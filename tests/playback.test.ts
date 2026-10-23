import test from "node:test";
import assert from "node:assert/strict";
import { createPlaybackController, previewMediaRate, seekMedia } from "../src/core/playback.ts";

function track() {
  const pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
  let pauses = 0;
  return {
    pending,
    get pauses() { return pauses; },
    play: () => new Promise<void>((resolve, reject) => pending.push({ resolve, reject })),
    pause: () => { pauses++; },
  };
}
const settled = () => new Promise<void>(resolve => setImmediate(resolve));

test("preview speed composes with edited slice speed within the media backend range", () => {
  assert.equal(previewMediaRate(2, .5), 1);
  assert.equal(previewMediaRate(.5, 4), 2);
  assert.equal(previewMediaRate(24, 8), 16);
  assert.equal(previewMediaRate(.1, .25), 1 / 16);
});

test("resume and repeated seeks to the same timestamp preserve the decoded frame", () => {
  let time = 3.03, readyState = 2, seeks = 0;
  const video = {
    get currentTime() { return time; },
    set currentTime(value: number) { time = value; readyState = 1; seeks++; },
  };
  seekMedia(video, 3.03);
  seekMedia(video, 3.03 + Number.EPSILON);
  assert.equal(seeks, 0);
  assert.equal(readyState, 2);
  seekMedia(video, 3.03 + 1 / 60);
  assert.equal(seeks, 1, "real scrubbing still seeks to the requested frame");
  assert.equal(readyState, 1);
});

test("rapid Play/Pause/Play ignores cancelled promises and pauses every companion", async () => {
  const states: boolean[] = [], errors: unknown[] = [];
  const controller = createPlaybackController(value => states.push(value), error => errors.push(error));
  const video = track(), camera = track(), microphone = track();
  controller.play(video, [camera, microphone]);
  assert.equal(controller.requested, true, "pending play can already be cancelled");
  controller.pause();
  assert.deepEqual([video.pauses, camera.pauses, microphone.pauses], [1, 1, 1]);
  controller.play(video, [camera, microphone]);
  video.pending[0].reject(Object.assign(new Error("interrupted by pause"), { name: "AbortError" }));
  video.pending[1].resolve();
  await settled();
  assert.deepEqual(states, [false, true]);
  assert.deepEqual(errors, []);
  controller.pause();
  assert.equal(controller.requested, false);
  assert.deepEqual(states, [false, true, false]);
});

test("late successful play cannot revive a paused or replaced project", async () => {
  const states: boolean[] = [], errors: unknown[] = [];
  const controller = createPlaybackController(value => states.push(value), error => errors.push(error));
  const old = track(), current = track();
  controller.play(old);
  controller.pause();
  controller.play(current);
  current.pending[0].resolve();
  await settled();
  controller.pause();
  old.pending[0].resolve();
  await settled();
  assert.deepEqual(states, [false, true, false]);
  assert.equal(controller.requested, false);
  assert.deepEqual(errors, []);
});

test("a current playback failure stops all tracks and reports the genuine error", async () => {
  const states: boolean[] = [], errors: unknown[] = [];
  const controller = createPlaybackController(value => states.push(value), error => errors.push(error));
  const video = track(), microphone = track(), error = new Error("decode failed");
  controller.play(video, [microphone]);
  video.pending[0].reject(error);
  await settled();
  assert.equal(controller.requested, false);
  assert.deepEqual([video.pauses, microphone.pauses], [1, 1]);
  assert.deepEqual(states, [false]);
  assert.deepEqual(errors, [error]);
});
test("decoder source clock retains a delayed camera's final real seekable frame", async () => {
  const { mediaTimelineEnd, mediaSeekTarget } = await import("../src/core/playback.ts");
  const camera = { duration: 1.766667, seekable: { length: 1, end: () => 1.983333 } };
  assert.equal(mediaTimelineEnd(camera), 1.983333); assert.equal(mediaSeekTarget(camera, 2), 1.983333);
  assert.equal(mediaSeekTarget({ duration: 2, seekable: { length: 1, end: () => 2 } }, 2), 1.99999);
});
