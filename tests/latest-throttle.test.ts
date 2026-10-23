import test from "node:test";
import assert from "node:assert/strict";
import { createLatestThrottle } from "../src/core/latest-throttle.ts";
function clock() {
  let now = 0, id = 0; const tasks = new Map<number, { callback: () => void; time: number }>();
  return { now: () => now, schedule: (callback: () => void, delay: number) => { tasks.set(++id, { callback, time: now + delay }); return id; }, unschedule: (handle: unknown) => { tasks.delete(handle as number); }, async advance(milliseconds: number) { for (let tick = 0; tick < milliseconds; tick++) { now++; for (const [id, task] of tasks) if (task.time <= now) { tasks.delete(id); task.callback(); } await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); } } };
}
test("continuous 60Hz dragging starts bounded audio samples while movement continues", async () => {
  const time = clock(), samples: { value: number; time: number }[] = [], owner = createLatestThrottle<number>({ ...time, onError: error => { throw error; }, sample: async read => { const latest = read()!; samples.push({ value: latest.value, time: time.now() }); return latest.revision; } });
  for (let event = 0; event < 10; event++) { owner.offer(event); await time.advance(16); }
  assert.ok(samples.length >= 4, "samples occur before mouseUp instead of waiting for input to stop"); assert.ok(samples.every((sample, index) => index === 0 || sample.time - samples[index - 1].time >= 35));
  owner.dispose(); const before = samples.length; await time.advance(100); assert.equal(samples.length, before);
});
test("pending PCM work is shared and its ready sample uses the latest pointer target", async () => {
  const time = clock(), values: number[] = []; let ready: (() => void) | null = null, calls = 0;
  const owner = createLatestThrottle<number>({ ...time, onError: error => { throw error; }, sample: async read => { calls++; await new Promise<void>(resolve => { ready = resolve; }); const latest = read(); if (latest) { values.push(latest.value); return latest.revision; } } });
  owner.offer(1); await time.advance(1); owner.offer(2); await time.advance(16); owner.offer(3); await time.advance(16); assert.equal(calls, 1);
  (ready as unknown as () => void)(); await time.advance(40); assert.deepEqual(values, [3]); assert.equal(calls, 1);
  owner.offer(4); await time.advance(35); owner.dispose(); (ready as unknown as () => void)(); await time.advance(50); assert.deepEqual(values, [3]);
});
