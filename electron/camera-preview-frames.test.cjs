"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { CameraPreviewFrames } = require("./camera-preview-frames.cjs");
const { InputMonitor } = require("./input-monitor.cjs");
const frame = deviceID => ({ deviceID, width: 3, height: 2, jpegBase64: Buffer.from([255,216,255,192,0,17,8,0,2,0,3,3,1,17,0,2,17,0,3,17,0,255,217]).toString("base64") });

test("switching from MacBook to unavailable Desk View clears the snapshot and rejects old frames/readiness", () => {
  const events = [], preview = new CameraPreviewFrames(value => events.push(value));
  preview.request(true, "monitor", "MacBook");
  assert.equal(preview.accept(frame("MacBook"), "monitor"), false, "requested identity alone is not readiness");
  preview.ready("monitor", "MacBook", "MacBook");
  preview.accept(frame("MacBook"), "monitor");
  assert.equal(preview.frame.deviceID, "MacBook");
  preview.request(true, "monitor", "Desk View");
  assert.equal(preview.frame, null);
  assert.equal(events.at(-1), null);
  assert.equal(preview.ready("monitor", "MacBook", "MacBook"), false);
  assert.equal(preview.accept(frame("MacBook"), "monitor"), false);
  assert.equal(preview.ready("monitor", "Desk View", "MacBook"), false, "another device must never become a fallback");
  const eventCount = events.length;
  assert.equal(preview.ready("monitor", "Desk View", null), false);
  assert.equal(events.length, eventCount, "empty readiness must not clear a camera error already shown by the renderer");
  assert.equal(preview.frame, null);
  preview.ready("monitor", "Desk View", "Desk View");
  assert.equal(preview.accept(frame("Desk View"), "monitor"), true);
  assert.equal(preview.accept(frame("MacBook"), "monitor"), false);
  preview.request(true, "monitor", "Desk View");
  assert.equal(preview.frame.deviceID, "Desk View", "unchanged preferences preserve a healthy preview");
});

test("default camera binds its actual identity and monitor/recording handoff cannot reuse old frames", () => {
  const preview = new CameraPreviewFrames();
  preview.request(true, "monitor", null);
  preview.ready("monitor", null, "system default camera");
  assert.equal(preview.accept(frame("system default camera"), "monitor"), true);
  assert.equal(preview.accept(frame("unselected camera"), "monitor"), false);
  preview.request(true, "recording", null);
  assert.equal(preview.frame, null);
  assert.equal(preview.accept(frame("system default camera"), "monitor"), false);
  assert.equal(preview.ready("monitor", null, "system default camera"), false);
  preview.ready("recording", null, "recorded camera");
  assert.equal(preview.accept(frame("recorded camera"), "recording"), true);
  preview.monitorState({ camera: true, cameraDeviceID: null, phase: "idle", activeCameraDeviceID: null });
  assert.equal(preview.frame.deviceID, "recorded camera", "old monitor cleanup cannot clear a recording frame");
  preview.request(false, "recording", null);
  assert.equal(preview.frame, null);
  assert.equal(preview.accept(frame("recorded camera"), "recording"), false);
});

test("real InputMonitor parsing binds camera readiness before frames and clears on owned shutdown", async t => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.stdout.setEncoding = () => {};
  const emit = value => child.stdout.emit("data", JSON.stringify(value) + "\n");
  child.stdin.end = () => queueMicrotask(() => { emit({ type: "stopped", kind: "input-monitor" }); child.emit("close", 0); });
  child.kill = () => true;
  const events = [], preview = new CameraPreviewFrames(value => events.push(value));
  preview.request(true, "monitor", "Desk View");
  const monitor = new InputMonitor({ helper: "controlled camera helper", spawnProcess: () => child,
    onState: state => preview.monitorState(state), onCameraFrame: value => preview.accept(value, "monitor") });
  t.after(() => monitor.dispose());
  const start = monitor.start({ camera: true, cameraDeviceID: "Desk View", microphones: "none" });
  assert.equal(monitor.state.activeCameraDeviceID, null);
  emit({ type: "ready", kind: "input-monitor", cameraDeviceID: "Desk View", microphoneDeviceIDs: [] });
  emit({ type: "camera-frame", ...frame("Desk View") });
  await start;
  assert.equal(monitor.state.activeCameraDeviceID, "Desk View");
  assert.equal(preview.frame.deviceID, "Desk View");
  const stop = monitor.stop();
  assert.equal(preview.frame, null, "stopping invalidates the snapshot before awaiting child close");
  emit({ type: "camera-frame", ...frame("Desk View") });
  await stop;
  assert.equal(monitor.state.activeCameraDeviceID, null);
  assert.equal(events.at(-1), null);
  assert.equal(preview.frame, null);
});
