"use strict";

/** A preview belongs to one requested device and one ready producer. Native
 * defaults become concrete only at readiness; a previous image is never used
 * as a fallback for a changed or unavailable camera. Inputs are already parsed
 * by Capture/InputMonitor before reaching this owner. */
class CameraPreviewFrames {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.requested = { enabled: false, source: "monitor", deviceID: null };
    this.actualDeviceID = null;
    this.frame = null;
  }
  request(enabled, source, deviceID) {
    const previous = this.requested;
    if (previous.enabled === enabled && previous.source === source && previous.deviceID === deviceID) return;
    this.requested = { enabled, source, deviceID };
    this.actualDeviceID = null;
    this.frame = null;
    this.onFrame?.(null);
  }
  matches(source, requestedDeviceID) {
    return this.requested.enabled && this.requested.source === source && this.requested.deviceID === requestedDeviceID;
  }
  clear() {
    if (this.frame === null) return;
    this.frame = null;
    this.onFrame?.(null);
  }
  invalidate(source, requestedDeviceID) {
    if (!this.matches(source, requestedDeviceID)) return;
    this.actualDeviceID = null;
    this.clear();
  }
  ready(source, requestedDeviceID, actualDeviceID) {
    if (!this.matches(source, requestedDeviceID)) return false;
    if (actualDeviceID === null || (requestedDeviceID !== null && requestedDeviceID !== actualDeviceID)) {
      this.invalidate(source, requestedDeviceID);
      return false;
    }
    if (this.actualDeviceID !== actualDeviceID) this.clear();
    this.actualDeviceID = actualDeviceID;
    return true;
  }
  monitorState(state) {
    if (!state.camera) return;
    if (state.phase === "ready") this.ready("monitor", state.cameraDeviceID, state.activeCameraDeviceID);
    else this.invalidate("monitor", state.cameraDeviceID);
  }
  accept(frame, source) {
    if (!this.requested.enabled || this.requested.source !== source || !this.actualDeviceID || frame.deviceID !== this.actualDeviceID) return false;
    this.frame = frame;
    this.onFrame?.(frame);
    return true;
  }
}

module.exports = { CameraPreviewFrames };
