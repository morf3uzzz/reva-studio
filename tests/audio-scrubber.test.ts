import assert from "node:assert/strict";
import test from "node:test";
import { createAudioScrubber, type ScrubMedia, type ScrubTrack } from "../src/core/audio-scrubber.ts";

const settled = () => new Promise<void>(resolve => setImmediate(resolve));
const source = (changes: Partial<ScrubTrack> = {}): ScrubTrack => ({ id: "system", path: "screen.mp4", time: 3, rate: 2, volume: .4, duration: 10, ...changes });
function harness() {
  const media: (ScrubMedia & { path: string; pauses: number; disposed: boolean; pending: { resolve: () => void; reject: (error: Error) => void }[] })[] = [];
  const timers = new Map<number, { fn: () => void; delay: number }>(), errors: unknown[] = [];
  let nextTimer = 0;
  const controller = createAudioScrubber(path => {
    const track = { path, currentTime: 0, playbackRate: 1, volume: 1, pauses: 0, disposed: false, pending: [] as { resolve: () => void; reject: (error: Error) => void }[],
      play: () => new Promise<void>((resolve, reject) => track.pending.push({ resolve, reject })),
      pause: () => { track.pauses++; }, dispose: () => { track.disposed = true; },
    };
    media.push(track); return track;
  }, error => errors.push(error), (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return () => { timers.delete(id); }; });
  return { controller, media, timers, errors };
}

test("a late audition cannot start audio after Stop or after the source was replaced", async () => {
  const h = harness();
  h.controller.audition([source()]);
  h.controller.stop();
  h.media[0].pending[0].resolve(); await settled();
  assert.equal(h.media[0].pauses, 2);
  assert.equal(h.timers.size, 0);
  h.controller.audition([source()]);
  h.controller.audition([source({ path: "new.mp4" })]);
  assert.equal(h.media[0].disposed, true);
  h.media[1].pending[0].resolve(); await settled();
  h.media[0].pending[1].resolve(); await settled();
  assert.equal(h.media[1].pauses, 0, "old completion never pauses the new source");
  assert.equal(h.timers.size, 1);
  h.controller.reset();
  assert.ok(h.media.every(track => track.disposed));
  assert.equal(h.timers.size, 0);
});

test("continuous scrubbing reuses the decoder and only the latest audition owns its deadline", async () => {
  const h = harness();
  h.controller.audition([source()]);
  h.controller.audition([source({ time: 5, rate: .5, volume: .8 })]);
  assert.equal(h.media.length, 1);
  h.media[0].pending[1].resolve(); await settled();
  const oldStop = [...h.timers.values()][0].fn;
  h.media[0].pending[0].resolve(); await settled();
  assert.equal(h.media[0].pauses, 0);
  assert.equal(h.timers.size, 1);
  assert.deepEqual([h.media[0].currentTime, h.media[0].playbackRate, h.media[0].volume], [5, .5, .8]);
  h.controller.audition([source({ time: 8, duration: .04 })]);
  oldStop();
  assert.equal(h.media[0].pauses, 0, "stale timeout cannot cut off a later audition");
  h.media[0].pending[2].resolve(); await settled();
  const timer = [...h.timers.values()][0];
  assert.equal(timer.delay, 20, "audition stops at the end of the retained slice");
  timer.fn();
  assert.equal(h.media[0].pauses, 1);
  assert.equal(h.timers.size, 0);
});

test("track gains stay independent, muted tracks are released, and decoder failures report once", async () => {
  const h = harness();
  h.controller.audition([source(), source({ id: "microphone", path: "mic.wav", volume: .75 })]);
  assert.deepEqual(h.media.map(track => track.volume), [.4, .75]);
  h.controller.audition([source({ volume: 0 }), source({ id: "microphone", path: "mic.wav", volume: .6 })]);
  assert.ok(h.media[0].disposed);
  const error = new Error("decode failure");
  h.media[1].pending[1].reject(error); await settled();
  h.media[1].pending[0].reject(new Error("obsolete failure")); await settled();
  assert.deepEqual(h.errors, [error]);
  h.controller.audition([source({ id: "microphone", path: "mic.wav" })]);
  assert.equal(h.media[1].pending.length, 2, "failed stream is not retried on every pointer event");
  h.controller.reset();
  h.controller.audition([source({ id: "microphone", path: "mic.wav" })]);
  assert.equal(h.media.length, 3, "enabling again allows an explicit retry");
  h.controller.reset();
});
