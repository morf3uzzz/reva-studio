"use strict";
const { spawn } = require("node:child_process");
const { object, string, number, integer, boolean, choice } = require("./core.cjs");
const { CameraEffectsControl } = require("./camera-effects-control.cjs");

const MAX_JPEG_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 4 * Math.ceil(MAX_JPEG_BYTES / 3) + 16 * 1024;
const PERMISSION_STATES = ["granted", "denied", "restricted", "not-determined", "unknown"];
function inputErrorData(error) {
  if (!error || typeof error !== "object") error = { message: String(error) };
  return { message: error.message, ...(error.code ? { code: error.code } : {}), recoverable: !!error.recoverable,
    ...(error.deviceID ? { deviceID: error.deviceID } : {}), ...(error.mediaType ? { mediaType: error.mediaType } : {}) };
}
function parseDeviceID(value, label = "Input device ID") {
  const id = string(value, 4096, label);
  if (!id || Buffer.byteLength(id) > 4096) throw new Error(`${label} must not be empty or exceed 4096 bytes.`);
  return id;
}
function parseOptionalDeviceID(value, label) { return value == null ? null : parseDeviceID(value, label); }
function parseLevels(value) {
  const v = object(value, "Input levels");
  const level = { deviceID: parseDeviceID(v.deviceID), rms: number(v.rms, 0, 1, "Input RMS"), peak: number(v.peak, 0, 1, "Input peak") };
  if (level.rms > level.peak + 1e-6) throw new Error("Input RMS cannot exceed its peak.");
  return level;
}
function jpegSize(bytes) {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9)
    throw new Error("The camera helper returned an invalid JPEG envelope.");
  let offset = 2, size;
  while (offset + 3 < bytes.length) {
    if (bytes[offset++] !== 0xff) throw new Error("The camera helper returned an invalid JPEG marker.");
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) throw new Error("The camera helper returned a truncated JPEG.");
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw new Error("The camera helper returned an invalid JPEG segment.");
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8 || size) throw new Error("The camera helper returned an ambiguous JPEG frame.");
      size = { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  if (!size) throw new Error("The camera helper returned a JPEG without dimensions.");
  return size;
}
function parseCameraFrame(value) {
  const v = object(value, "Camera frame"), id = parseDeviceID(v.deviceID);
  const width = integer(v.width, 1, 360, "Camera preview width"), height = integer(v.height, 1, 360, "Camera preview height");
  const jpegBase64 = string(v.jpegBase64, 4 * Math.ceil(MAX_JPEG_BYTES / 3), "Camera JPEG");
  if (!jpegBase64 || jpegBase64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(jpegBase64))
    throw new Error("The camera helper returned invalid JPEG base64.");
  const bytes = Buffer.from(jpegBase64, "base64");
  if (bytes.length > MAX_JPEG_BYTES || bytes.toString("base64") !== jpegBase64)
    throw new Error("The camera helper returned a noncanonical or oversized JPEG.");
  const actual = jpegSize(bytes);
  if (actual.width !== width || actual.height !== height) throw new Error("Camera JPEG dimensions do not match the declared preview.");
  return { deviceID: id, jpegBase64, width, height };
}
function parseInputError(value) {
  const v = object(value, "Input error");
  const error = new Error(string(v.message, 32768, "Input error message"));
  error.code = string(v.code, 256, "Input error code");
  error.recoverable = v.recoverable === undefined ? false : boolean(v.recoverable, "Recoverable input error");
  if (v.deviceID != null) error.deviceID = parseDeviceID(v.deviceID);
  if (v.mediaType != null) error.mediaType = choice(v.mediaType, ["camera", "microphone"], "Input media type");
  return error;
}
function parseReady(value, options) {
  const v = object(value, "Input monitor readiness");
  if (v.kind !== "input-monitor" || !Array.isArray(v.microphoneDeviceIDs) || v.microphoneDeviceIDs.length > 32)
    throw new Error("The input helper returned invalid monitor readiness.");
  const microphoneDeviceIDs = v.microphoneDeviceIDs.map(id => parseDeviceID(id));
  if (new Set(microphoneDeviceIDs).size !== microphoneDeviceIDs.length ||
      (options.microphones === "none" && microphoneDeviceIDs.length) ||
      (options.microphones === "selected" && (microphoneDeviceIDs.length > 1 || (options.microphoneDeviceID !== null && microphoneDeviceIDs.some(id => id !== options.microphoneDeviceID)))) ||
      microphoneDeviceIDs.includes(options.excludeMicrophoneDeviceID))
    throw new Error("The input helper reported an unrequested microphone identity.");
  const cameraDeviceID = parseOptionalDeviceID(v.cameraDeviceID, "Camera preview device");
  if ((!options.camera && cameraDeviceID !== null) || (cameraDeviceID !== null && options.cameraDeviceID !== null && cameraDeviceID !== options.cameraDeviceID))
    throw new Error("The input helper reported an unrequested camera identity.");
  return { cameraDeviceID, microphoneDeviceIDs };
}
function monitorOptions(value) {
  const v = object(value, "Input monitor options");
  return {
    camera: boolean(v.camera ?? false, "Camera preview"),
    microphones: choice(v.microphones ?? "all", ["all", "selected", "none"], "Microphone monitoring"),
    microphoneDeviceID: parseOptionalDeviceID(v.microphoneDeviceID, "Monitored microphone device"),
    cameraDeviceID: parseOptionalDeviceID(v.cameraDeviceID, "Camera preview device"),
    excludeMicrophoneDeviceID: parseOptionalDeviceID(v.excludeMicrophoneDeviceID, "Excluded microphone device"),
  };
}

/** Own the exact ChildProcess until close (including pipe drain). Late handshakes
 * cannot resurrect a cancelled monitor, and failed shutdown remains retryable. */
class InputMonitor {
  constructor({ helper, onInputLevels, onCameraFrame, onError, onState, spawnProcess = spawn, readyTimeoutMs = 120000, stopTimeoutMs = 5000, killTimeoutMs = 2000, exitTimeoutMs = 2000 }) {
    Object.assign(this, { helper, onInputLevels, onCameraFrame, onError, onState, spawnProcess, readyTimeoutMs, stopTimeoutMs, killTimeoutMs, exitTimeoutMs });
    this.session = null; this.disposed = false;
    this.state = { phase: "idle", camera: false, cameraDeviceID: null, activeCameraDeviceID: null, microphones: "none", microphoneDeviceID: null, microphonePermission: "unknown", microphoneDeviceIDs: [], errors: [], updatedAt: Date.now() };
  }
  get active() { return this.session !== null; }
  setState(patch) { this.state = { ...this.state, ...patch, updatedAt: Date.now() }; this.onState?.(this.state); }
  rememberError(error) {
    const data = inputErrorData(error);
    this.setState({ errors: [...this.state.errors.filter(item => item.deviceID !== data.deviceID || item.mediaType !== data.mediaType), data].slice(-34) });
  }
  async start(value = {}) {
    if (this.disposed) throw new Error("The input monitor has been disposed.");
    if (this.active) throw new Error("Live input monitoring is already active.");
    const options = monitorOptions(value);
    const args = ["monitor-inputs", "--microphones", options.microphones, "--camera", String(options.camera)];
    if (options.microphones === "selected" && options.microphoneDeviceID !== null) args.push("--microphone-device-id", options.microphoneDeviceID);
    if (options.cameraDeviceID !== null) args.push("--camera-device-id", options.cameraDeviceID);
    if (options.excludeMicrophoneDeviceID !== null) args.push("--exclude-microphone-device-id", options.excludeMicrophoneDeviceID);
    const child = this.spawnProcess(this.helper, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const s = { child, options, pending: "", stderr: "", ready: null, stopped: false, stopping: false, closed: false, failure: null, timers: [], readySettled: false, stopAttempt: null };
    s.effects = new CameraEffectsControl({ deviceID: () => s.ready?.cameraDeviceID, active: () => !!s.ready && !s.stopping && !s.closed && !s.failure, write: (value, callback) => child.stdin.write(value, callback) });
    const clearTimers = () => { for (const timer of s.timers) clearTimeout(timer); s.timers = []; };
    s.readyPromise = new Promise((resolve, reject) => { s.resolveReady = resolve; s.rejectReady = reject; });
    s.completion = new Promise((resolve, reject) => { s.resolveClose = resolve; s.rejectClose = reject; });
    s.completion.catch(() => {});
    const rejectReady = error => { if (!s.readySettled) { s.readySettled = true; s.rejectReady(error); } };
    const fail = error => {
      const first = !s.failure;
      s.failure ||= error; rejectReady(s.failure);
      if (first) { this.rememberError(s.failure); this.setState({ phase: "error" }); }
      if (first && s.ready && !s.stopping) this.onError?.(s.failure);
      if (!s.stopping && !s.closed) void this.stop().catch(() => {});
    };
    const accept = line => {
      if (!line.trim()) return;
      const message = object(JSON.parse(line), "Live input event");
      if (s.effects.accept(message)) return;
      if (s.stopped) throw new Error("The input helper emitted data after its terminal event.");
      if (message.type === "ready") {
        if (s.ready) throw new Error("The input helper emitted duplicate readiness.");
        const ready = parseReady(message, options);
        if (s.stopping) return;
        s.ready = ready; clearTimeout(s.readyTimer);
        this.setState({ phase: "ready", activeCameraDeviceID: ready.cameraDeviceID, microphoneDeviceIDs: ready.microphoneDeviceIDs,
          ...(message.microphonePermission === undefined ? {} : { microphonePermission: choice(message.microphonePermission, PERMISSION_STATES, "Microphone permission") }) });
        s.readySettled = true; s.resolveReady(ready);
      } else if (message.type === "permission") {
        if (s.stopping) return;
        if (message.mediaType !== "microphone") throw new Error("The input helper returned an unknown permission event.");
        this.setState({ microphonePermission: choice(message.status, PERMISSION_STATES, "Microphone permission") });
      } else if (message.type === "levels" || message.type === "camera-frame") {
        if (s.stopping) return;
        if (!s.ready) throw new Error("The input helper emitted samples before readiness.");
        if (message.type === "levels") {
          const level = parseLevels(message);
          if (!s.ready.microphoneDeviceIDs.includes(level.deviceID)) throw new Error("A meter sample belongs to an unrequested microphone.");
          this.onInputLevels?.(level);
        } else {
          const frame = parseCameraFrame(message);
          if (frame.deviceID !== s.ready.cameraDeviceID) throw new Error("A preview frame belongs to an unrequested camera.");
          this.onCameraFrame?.(frame);
        }
      } else if (message.type === "error") {
        const error = parseInputError(message);
        if (error.mediaType === "camera") s.effects.reject(error);
        if (error.recoverable) { if (!s.stopping) { this.rememberError(error); this.onError?.(error); } }
        else fail(error);
      } else if (message.type === "stopped" && message.kind === "input-monitor") s.stopped = true;
      else throw new Error("The input helper returned an unknown event.");
    };
    this.session = s;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      try {
        // Bound each line before joining a new transport chunk. A chunk may hold
        // many valid events; aggregate chunk size is not a per-event limit.
        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf("\n", offset), end = newline < 0 ? chunk.length : newline;
          const segment = chunk.slice(offset, end);
          if (Buffer.byteLength(s.pending) + Buffer.byteLength(segment) > MAX_LINE_BYTES) throw new Error("Live input output exceeded its line budget.");
          s.pending += segment;
          if (newline < 0) break;
          const line = s.pending; s.pending = ""; accept(line); offset = newline + 1;
        }
      } catch (error) { fail(error); }
    });
    child.stderr.on("data", chunk => { s.stderr = (s.stderr + chunk.toString()).slice(-32768); });
    child.stdin.on("error", error => { if (!s.stopping && !s.closed) fail(error); });
    child.on("error", fail);
    child.once("close", code => {
      s.closed = true; clearTimers();
      s.effects.reject(new Error("The live camera helper stopped."));
      try {
        if (s.pending.trim()) accept(s.pending);
        if (s.failure) throw s.failure;
        if (code !== 0) throw new Error(s.stderr || `Input monitor stopped with code ${code}.`);
        if (!s.stopped) throw new Error("The input monitor did not acknowledge cleanup.");
        if (!s.ready && !s.stopping) throw new Error("The input monitor ended before readiness.");
        rejectReady(new Error("Live input monitoring was cancelled before readiness."));
        s.resolveClose();
      } catch (error) { rejectReady(error); s.rejectClose(error); if (!s.stopping) this.onError?.(error); }
      finally { if (this.session === s) { this.session = null; this.setState({ phase: s.failure ? "error" : "idle", activeCameraDeviceID: null, microphoneDeviceIDs: [] }); } }
    });
    this.setState({ phase: "starting", camera: options.camera, cameraDeviceID: options.cameraDeviceID, activeCameraDeviceID: null, microphones: options.microphones, microphoneDeviceID: options.microphoneDeviceID, microphoneDeviceIDs: [], errors: [] });
    s.readyTimer = setTimeout(() => fail(new Error("Live inputs did not become ready. Check camera and microphone permissions.")), this.readyTimeoutMs);
    s.timers.push(s.readyTimer);
    return s.readyPromise;
  }
  async stop() {
    const s = this.session;
    if (!s) return;
    if (s.stopAttempt) return s.stopAttempt;
    s.stopping = true;
    s.effects.reject(new Error("Live camera preview is stopping."));
    this.setState({ phase: "stopping" });
    clearTimeout(s.readyTimer);
    if (!s.readySettled) { s.readySettled = true; s.rejectReady(new Error("Live input monitoring was cancelled before readiness.")); }
    const signal = name => { if (!s.closed) { try { s.child.kill(name); } catch (error) { s.failure ||= error; } } };
    s.stopAttempt = (async () => {
      if (!s.closed) {
        try { s.child.stdin.end("stop\n"); } catch (error) { s.failure ||= error; signal("SIGTERM"); }
      }
      let rejectDeadline;
      const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
      const timeout = setTimeout(() => {
        signal("SIGTERM");
        const kill = setTimeout(() => {
          signal("SIGKILL");
          const exit = setTimeout(() => rejectDeadline(new Error("Live inputs could not stop. Their owned helper is still retained for cleanup retry.")), this.exitTimeoutMs);
          s.timers.push(exit);
        }, this.killTimeoutMs); s.timers.push(kill);
      }, this.stopTimeoutMs); s.timers.push(timeout);
      try { await Promise.race([s.completion, deadline]); }
      finally {
        for (const timer of s.timers) clearTimeout(timer); s.timers = [];
        s.stopAttempt = null;
      }
    })();
    return s.stopAttempt;
  }
  async dispose() { this.disposed = true; await this.stop(); }
  showCameraEffects() { return this.session?.effects ? this.session.effects.request() : Promise.reject(new Error("No live camera preview is active.")); }
}
module.exports = { InputMonitor, parseDeviceID, parseOptionalDeviceID, parseLevels, parseCameraFrame, parseInputError, monitorOptions, inputErrorData, MAX_LINE_BYTES };
