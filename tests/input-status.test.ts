import test from "node:test";
import assert from "node:assert/strict";
import { microphoneStatus } from "../src/core/input-status.ts";
import type { InputMonitorState } from "../src/types.ts";

const ready: InputMonitorState = { phase: "ready", camera: false, cameraDeviceID: null, activeCameraDeviceID: null, microphones: "selected", microphoneDeviceID: "mic:one", microphonePermission: "granted", microphoneDeviceIDs: ["mic:one"], errors: [], updatedAt: 1000 };
test("meter distinguishes actual zero PCM, missing packets, startup and expired input", () => {
  const silent = { deviceID: "mic:one", rms: 0, peak: 0, timestamp: 3000 };
  assert.equal(microphoneStatus(ready, "mic:one", silent, 3100), "silent");
  assert.equal(microphoneStatus(ready, "mic:one", { ...silent, rms: .03, peak: .05 }, 3100), "live");
  assert.equal(microphoneStatus(ready, "mic:one", undefined, 1200), "starting");
  assert.equal(microphoneStatus(ready, "mic:one", undefined, 3100), "no-input");
  assert.equal(microphoneStatus(ready, "mic:one", silent, 3500), "no-input");
  assert.equal(microphoneStatus(ready, "mic:other", silent, 3100), "unavailable");
});
test("persistent permission and device errors survive absent samples without inventing a level", () => {
  for (const microphonePermission of ["denied", "restricted", "not-determined"] as const)
    assert.equal(microphoneStatus({ ...ready, microphonePermission, microphoneDeviceIDs: [] }, "mic:one", undefined, 9000), microphonePermission);
  assert.equal(microphoneStatus({ ...ready, errors: [{ message: "Device disappeared", mediaType: "microphone", deviceID: "mic:one" }] }, "mic:one", undefined, 9000), "error");
  assert.equal(microphoneStatus({ ...ready, errors: [{ message: "Other input unavailable", mediaType: "microphone", deviceID: "mic:other" }] }, "mic:one", undefined, 9000), "no-input");
  assert.equal(microphoneStatus({ ...ready, phase: "idle", microphoneDeviceIDs: [] }, "mic:one", undefined, 9000), "inactive");
});
