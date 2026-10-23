"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { CameraEffectsControl } = require("./camera-effects-control.cjs");
test("macOS effects waits for the same live camera acknowledgement and shares concurrent requests", async () => {
  let active = true, writes = 0;
  const control = new CameraEffectsControl({ deviceID: () => "opaque camera", active: () => active, write: (text, callback) => { assert.equal(text, "camera-effects\n"); writes++; callback(); } });
  const request = control.request(); assert.equal(control.request(), request); assert.equal(writes, 1);
  assert.throws(() => control.accept({ type: "camera-effects", deviceID: "other" }), /different/);
  assert.equal(control.accept({ type: "camera-effects", deviceID: "opaque camera" }), true); assert.deepEqual(await request, { deviceID: "opaque camera" });
  active = false; await assert.rejects(control.request(), /live camera/);
});
test("camera shutdown, native error and a missing acknowledgement reject without claiming OS UI opened", async () => {
  const control = new CameraEffectsControl({ deviceID: () => "camera", active: () => true, write: (_text, callback) => callback(), timeoutMs: 10 });
  const stopped = control.request(); control.reject(new Error("helper stopped")); await assert.rejects(stopped, /helper stopped/);
  const failed = control.request(); control.reject(new Error("macOS unavailable")); await assert.rejects(failed, /macOS unavailable/);
  await assert.rejects(control.request(), /did not acknowledge/); assert.equal(control.pending, null);
});
