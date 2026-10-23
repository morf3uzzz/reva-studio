import test from "node:test";
import assert from "node:assert/strict";
import { createProject } from "../src/core/model.ts";
import { nextShuttleRate, shuttlePosition } from "../src/core/shuttle.ts";
import { matchesShortcut } from "../src/core/shortcuts.ts";
test("shuttle doubles to sixteen and reverse walks the edited output clock across cuts", () => {
  assert.deepEqual([0, 1, 2, 4, 8, 16].map(rate => nextShuttleRate(rate, 1)), [1, 2, 4, 8, 16, 16]); assert.equal(nextShuttleRate(8, -1), -1);
  const p = createProject({ path: "/video", name: "Timing", width: 1920, height: 1080, duration: 10 }); p.slices = [{ id: "a", start: 1, end: 3, speed: 1, volume: 1 }, { id: "b", start: 7, end: 9, speed: 2, volume: 1 }];
  assert.equal(shuttlePosition(p, 8, .75, -1).sourceTime, 2.75); assert.equal(shuttlePosition(p, 2, 20, -16).sourceTime, 1); assert.equal(shuttlePosition(p, 2, 20, -16).atEnd, true);
});
test("custom editor shortcuts match their complete modifier namespace", () => {
  const event = { key: "j", code: "KeyJ", metaKey: true, ctrlKey: false, altKey: true, shiftKey: false };
  assert.equal(matchesShortcut(event, ["Meta", "Alt", "J"]), true); assert.equal(matchesShortcut(event, ["J"]), false); assert.equal(matchesShortcut(event, null), false);
});
