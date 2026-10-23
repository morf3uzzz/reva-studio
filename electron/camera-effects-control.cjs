"use strict";
/** A single acknowledged, bounded command owned by its live helper session. */
class CameraEffectsControl {
  constructor({ deviceID, active, write, timeoutMs = 5000 }) { Object.assign(this, { deviceID, active, write, timeoutMs }); this.pending = null; }
  request() {
    if (!this.active() || !this.deviceID()) return Promise.reject(new Error("Start a live camera preview or recording to open macOS camera effects."));
    if (this.pending) return this.pending.promise;
    const deviceID = this.deviceID(); let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => this.reject(new Error("macOS camera effects did not acknowledge the request.")), this.timeoutMs);
    this.pending = { deviceID, promise, resolve, reject, timer };
    try { this.write("camera-effects\n", error => { if (error) this.reject(error); }); } catch (error) { this.reject(error); }
    return promise;
  }
  accept(message) {
    if (message.type !== "camera-effects") return false;
    if (!this.active() || typeof message.deviceID !== "string" || message.deviceID !== this.deviceID()) throw new Error("macOS camera effects acknowledged a different or inactive camera.");
    if (this.pending) { const pending = this.pending; this.pending = null; clearTimeout(pending.timer); pending.resolve({ deviceID: pending.deviceID }); }
    return true;
  }
  reject(error) { if (this.pending) { const pending = this.pending; this.pending = null; clearTimeout(pending.timer); pending.reject(error); } }
}
module.exports = { CameraEffectsControl };
