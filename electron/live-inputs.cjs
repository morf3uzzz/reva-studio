"use strict";

const { monitorOptions } = require("./input-monitor.cjs");

/** Serializes input reconfiguration and cancels an obsolete readiness wait. */
class LiveInputs {
  constructor({ InputMonitor, helper, onCameraFrame, onInputLevels, onError, onState }) {
    this.onError = onError;
    this.generation = 0;
    this.key = null;
    this.disposed = false;
    this.pending = Promise.resolve();
    this.monitor = new InputMonitor({ helper, onCameraFrame, onInputLevels, onState, onError: error => {
      if (!error.recoverable) this.key = null;
      this.onError?.(error);
    } });
  }
  configure(value, { force = false } = {}) {
    if (this.disposed) return Promise.reject(new Error("Live inputs have been disposed."));
    // Share the protocol owner's interpretation and retain an accepted snapshot
    // while earlier readiness and cleanup complete.
    const options = monitorOptions(value);
    const key = JSON.stringify(options);
    if (!force && this.key === key) return this.pending;
    this.key = key;
    const generation = ++this.generation;
    const stopped = this.monitor.stop();
    stopped.catch(() => {});
    this.pending = this.pending.catch(() => {}).then(async () => {
      await stopped;
      if (this.generation !== generation) return;
      if (!options.camera && options.microphones === "none") return;
      await this.monitor.start(options);
    }).catch(error => {
      if (this.generation === generation) { this.key = null; this.onError?.(error); }
    });
    return this.pending;
  }
  async stop() {
    this.generation++; this.key = null;
    const pending = this.pending;
    await this.monitor.stop();
    await pending;
  }
  async dispose() { this.disposed = true; await this.stop(); await this.monitor.dispose(); }
}
module.exports = { LiveInputs };
