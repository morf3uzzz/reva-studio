"use strict";

const fs = require("node:fs").promises;
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { runProcess, probe } = require("./media.cjs");
const { CameraEffectsControl } = require("./camera-effects-control.cjs");
const { parseDeviceID, parseOptionalDeviceID, parseLevels, parseCameraFrame, parseInputError, MAX_LINE_BYTES } = require("./input-monitor.cjs");
const {
  object,
  string,
  number,
  integer,
  boolean,
  choice,
  contained,
  MAX_PROJECT_BYTES,
} = require("./core.cjs");

function parseSources(input) {
  if (!Array.isArray(input) || input.length > 10000)
    throw new Error("The capture helper returned an invalid source list.");
  const ids = new Set();
  return input.map((value) => {
    const source = object(value, "Capture source");
    const id = string(source.id, 4096, "Capture source ID");
    const kind = choice(
      source.kind,
      ["display", "window", "device"],
      "Capture source kind",
    );
    const identifier = Number(id.slice(kind.length + 1));
    if ((kind === "device" ? !id.startsWith("device:") || id.length <= 7 : !new RegExp(`^${kind}:\\d+$`).test(id) || !Number.isInteger(identifier) || identifier < 1 || identifier > 4294967295) || ids.has(id))
      throw new Error(
        "The capture helper returned an invalid source identity.",
      );
    ids.add(id);
    const width = number(source.width, 1, 32768, "Source width");
    const height = number(source.height, 1, 32768, "Source height");
    let bounds;
    if (source.bounds !== undefined) {
      const b = object(source.bounds, "Source bounds");
      bounds = {
        x: number(b.x, -Number.MAX_VALUE, Number.MAX_VALUE, "Source bounds x"),
        y: number(b.y, -Number.MAX_VALUE, Number.MAX_VALUE, "Source bounds y"),
        width: number(b.width, 1, 32768, "Source bounds width"),
        height: number(b.height, 1, 32768, "Source bounds height"),
      };
      // Source dimensions are integer logical points; a window's global frame
      // may contain a fractional point. Both describe the same capture area.
      if (Math.abs(bounds.width - width) >= 1 || Math.abs(bounds.height - height) >= 1)
        throw new Error("Capture source dimensions do not match its global bounds.");
    }
    return {
      id,
      kind,
      name: string(source.name, 4096, "Source name"),
      width,
      height,
      ...(bounds === undefined ? {} : { bounds }),
      ...(source.ownerPID === undefined ? {} : {
        ownerPID: integer(source.ownerPID, 1, 2147483647, "Source owner process ID"),
      }),
      ...(source.zIndex === undefined ? {} : {
        zIndex: integer(source.zIndex, 0, Number.MAX_SAFE_INTEGER, "Source stacking index"),
      }),
    };
  });
}

function parseDevices(input) {
  const value = object(input, "Capture devices");
  const parse = (items, label) => {
    if (!Array.isArray(items) || items.length > 10000)
      throw new Error(`The capture helper returned an invalid ${label} list.`);
    const ids = new Set(); let hasDefault = false;
    return items.map(item => {
      const d = object(item, label), id = parseDeviceID(d.id, "Capture device ID");
      if (ids.has(id)) throw new Error("The capture helper returned an invalid device identity.");
      ids.add(id);
      const isDefault = boolean(d.default, "Default capture device");
      if (isDefault && hasDefault) throw new Error("The capture helper reported more than one default device.");
      if (isDefault) hasDefault = true;
      return { id, name: string(d.name, 4096, "Capture device name"), default: isDefault };
    });
  };
  return { cameras: parse(value.cameras, "camera"), microphones: parse(value.microphones, "microphone"), ...(value.screenDevices === undefined ? {} : { screenDevices: parse(value.screenDevices, "screen device").map(device => { const source = value.screenDevices.find(item => item.id === device.id); return { ...device, width: number(source.width, 1, 32768, "Device width"), height: number(source.height, 1, 32768, "Device height") }; }) }), ...(value.screenDeviceIssue === undefined ? {} : { screenDeviceIssue: string(value.screenDeviceIssue, 4096, "Device discovery issue") }) };
}

class Capture {
  constructor({
    helper,
    recordingRoot,
    ffprobe,
    grants,
    onReady,
    onStopped,
    onError,
    onIdle,
    onInputLevels,
    onCameraFrame,
    onInputError,
    onState,
    spawnProcess = spawn,
    stopTimeoutMs = 30000,
    killTimeoutMs = 5000,
    exitTimeoutMs = 2000,
    stateTimeoutMs = 5000,
    excludeProcessID = null,
  }) {
    Object.assign(this, {
      helper,
      recordingRoot,
      ffprobe,
      grants,
      onReady,
      onStopped,
      onError,
      onIdle,
      onInputLevels,
      onCameraFrame,
      onInputError,
      onState, spawnProcess, stopTimeoutMs, killTimeoutMs, exitTimeoutMs, stateTimeoutMs,
    });
    this.excludeProcessID = excludeProcessID === null ? null : integer(excludeProcessID, 1, 2147483647, "Excluded process ID");
    this.session = null;
    this.starting = false;
    this.abortStarting = false;
    this.startingDone = null;
    this.disposed = false;
    this.restarting = null;
  }
  get active() {
    return this.starting || this.session !== null || this.restarting !== null;
  }
  async sources() {
    return parseSources(JSON.parse(await runProcess(this.helper, ["list", ...this.exclusionArgs()])));
  }
  async devices() {
    return parseDevices(JSON.parse(await runProcess(this.helper, ["list-devices"], { timeout: 10000 })));
  }
  async audioApplications() {
    const items = JSON.parse(await runProcess(this.helper, ["list-audio-applications"], { timeout: 10000 }));
    if (!Array.isArray(items) || items.length > 10000) throw new Error("The audio application list is invalid.");
    return items.map(value => { const app = object(value, "Audio application"); return { id: string(app.id, 4096, "Application identity"), name: string(app.name, 4096, "Application name"), processID: integer(app.processID, 1, 2147483647, "Application process ID") }; });
  }
  exclusionArgs() {
    return this.excludeProcessID === null ? [] : ["--exclude-process-id", String(this.excludeProcessID)];
  }
  async permissions() {
    const value = object(
      JSON.parse(
        await runProcess(this.helper, ["permissions"], { timeout: 5000 }),
      ),
      "Permissions",
    );
    const states = [
      "granted",
      "denied",
      "restricted",
      "not-determined",
      "unknown",
    ];
    // CoreGraphics preflight can only distinguish granted / not granted.
    // Unlike AVFoundation it cannot tell denied from never requested.
    const preflightStates = [...states, "not-granted"];
    return {
      screen: choice(value.screen, preflightStates, "Screen permission"),
      microphone: choice(value.microphone, states, "Microphone permission"),
      camera: choice(value.camera, states, "Camera permission"),
      ...(value.keyboard === undefined ? {} : { keyboard: choice(value.keyboard, preflightStates, "Keyboard permission") }),
    };
  }
  async start(input, restartToken = null) {
    if (this.disposed) throw new Error("The recorder has been disposed.");
    if (this.starting || this.session !== null || (this.restarting && this.restarting !== restartToken)) throw new Error("A recording is already in progress.");
    this.starting = true;
    let finishStarting;
    this.startingDone = new Promise(resolve => { finishStarting = resolve; });
    try {
      const o = object(input, "Capture options");
      const requested = object(o.source, "Capture source");
      const source = (await this.sources()).find((s) => s.id === requested.id);
      if (this.abortStarting)
        throw new Error("Recording startup was cancelled.");
      if (!source)
        throw new Error(
          "That source is no longer available. Select a source again.",
        );
      const fps = choice(o.fps, [24, 30, 60], "Recording frame rate");
      const systemAudio = boolean(o.systemAudio, "System audio");
      const recordShortcuts = boolean(o.recordShortcuts ?? false, "Record keyboard shortcuts");
      const systemAudioApplications = o.systemAudioApplications ?? null;
      if (systemAudioApplications !== null && (!Array.isArray(systemAudioApplications) || !systemAudioApplications.length || systemAudioApplications.length > 10000 || systemAudioApplications.some(id => typeof id !== "string" || !id || id.length > 4096 || id.includes("\0")))) throw new Error("Choose at least one application for selected audio.");
      if (source.kind === "device" && recordShortcuts) throw new Error("Mac keyboard shortcuts do not belong to a wired device recording.");
      if (source.kind === "device" && systemAudioApplications !== null) throw new Error("Mac application audio filters do not apply to wired device audio.");
      const microphone = boolean(o.microphone, "Microphone");
      const camera = boolean(o.camera, "Camera");
      const previewCamera = boolean(o.previewCamera ?? false, "Camera preview");
      const monitorMicrophone = boolean(o.monitorMicrophone ?? false, "Microphone monitoring");
      if ((previewCamera && !camera) || (monitorMicrophone && !microphone))
        throw new Error("Live previews require their corresponding recording input.");
      const cameraDeviceID = parseOptionalDeviceID(o.cameraDeviceID, "Camera device ID");
      const microphoneDeviceID = parseOptionalDeviceID(o.microphoneDeviceID, "Microphone device ID");
      const cameraMaxResolution = choice(o.cameraMaxResolution === undefined ? 1080 : o.cameraMaxResolution, [720, 1080, 2160], "Camera maximum resolution");
      if ((camera && cameraDeviceID !== null) || (microphone && microphoneDeviceID !== null)) {
        const devices = await this.devices();
        if (this.abortStarting) throw new Error("Recording startup was cancelled.");
        if (camera && cameraDeviceID !== null && !devices.cameras.some(d => d.id === cameraDeviceID))
          throw new Error("The selected camera is no longer available. Select a camera again.");
        if (microphone && microphoneDeviceID !== null && !devices.microphones.some(d => d.id === microphoneDeviceID))
          throw new Error("The selected microphone is no longer available. Select a microphone again.");
      }
      let area;
      if (o.area !== undefined) {
        const a = object(o.area, "Recording area");
        area = {
          x: number(a.x, 0, source.width, "Area x"),
          y: number(a.y, 0, source.height, "Area y"),
          width: number(a.width, 2, source.width, "Area width"),
          height: number(a.height, 2, source.height, "Area height"),
        };
        if (
          area.x + area.width > source.width ||
          area.y + area.height > source.height
        )
          throw new Error(
            "The recording area must fit inside the selected source.",
          );
      }
      await fs.mkdir(this.recordingRoot, { recursive: true, mode: 0o700 });
      const directory = await fs.mkdtemp(
        path.join(this.recordingRoot, "Recording-"),
      );
      const directoryIdentity = await fs.lstat(directory);
      if (this.abortStarting) {
        await fs.rm(directory, { recursive: true });
        throw new Error("Recording startup was cancelled.");
      }
      const output = path.join(directory, "screen.mp4");
      const cursorOutput = path.join(directory, "cursor.json");
      const recordingID = crypto.randomUUID();
      // Ownership is established before the helper can create media. Recovery
      // never infers ownership merely from a directory or a plausible journal.
      await fs.writeFile(path.join(directory, ".reva-recording-owner.json"), JSON.stringify({ type: "reva-recording-owner", version: 1, id: recordingID, directory: { dev: String(directoryIdentity.dev), ino: String(directoryIdentity.ino) }, source: source.id, output, cursorOutput, activityOutput: path.join(directory, "screen.activity.json"), createdAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
      const args = [
        "record",
        "--source",
        source.id,
        "--output",
        output,
        "--cursor-output",
        cursorOutput,
        "--fps",
        String(fps),
        "--system-audio",
        String(systemAudio),
        "--microphone",
        String(microphone),
        "--camera",
        String(camera),
        "--preview-camera",
        String(previewCamera),
        "--monitor-microphone",
        String(monitorMicrophone),
        ...this.exclusionArgs(),
      ];
      if (recordShortcuts) args.push("--record-shortcuts", "true");
      if (systemAudioApplications !== null) args.push("--audio-applications", JSON.stringify(systemAudioApplications));
      if (camera) {
        args.push("--camera-max-resolution", String(cameraMaxResolution));
        if (cameraDeviceID !== null) args.push("--camera-device-id", cameraDeviceID);
      }
      if (microphone && microphoneDeviceID !== null) args.push("--microphone-device-id", microphoneDeviceID);
      if (area)
        args.push(
          "--area",
          [area.x, area.y, area.width, area.height].join(","),
        );
      const child = this.spawnProcess(this.helper, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const s = {
        id: recordingID,
        directory, directoryIdentity,
        options: { source, fps, systemAudio, systemAudioApplications, recordShortcuts, microphone, camera, previewCamera, monitorMicrophone, cameraDeviceID, microphoneDeviceID, cameraMaxResolution, ...(area ? { area } : {}) },
        output,
        cursorOutput,
        child,
        camera,
        previewCamera,
        monitorMicrophone,
        cameraDeviceID: null,
        microphoneDeviceID: null,
        ready: false,
        stopRequested: false,
        exited: false,
        resultMessage: null,
        failure: null,
        stderr: "",
        pending: "",
        disposition: "keep", state: null, control: Promise.resolve(), stateWaiter: null, closeAttempt: null, released: false, deletePromise: null,
      };
      let readyResolve, readyReject, resultResolve, resultReject;
      s.effects = new CameraEffectsControl({ deviceID: () => s.cameraDeviceID, active: () => s.ready && !s.stopRequested && !s.exited && !s.failure, write: (value, callback) => s.child.stdin.write(value, callback), timeoutMs: this.stateTimeoutMs });
      s.readyPromise = new Promise((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      });
      s.resultPromise = new Promise((resolve, reject) => {
        resultResolve = resolve;
        resultReject = reject;
      });
      s.resultPromise.catch(() => {});
      s.closedPromise = new Promise(resolve => { s.resolveClosed = resolve; });
      s.rejectReady = readyReject;
      const readyTimer = setTimeout(() => {
        s.failure = new Error(
          "Recording did not start. Check macOS Screen & System Audio Recording permissions, then try again.",
        );
        readyReject(s.failure);
        this.requestStop(s);
        void this.awaitClose(s).catch(error => this.onError?.(error.message));
      }, 120000);
      s.readyTimer = readyTimer;
      const acceptLine = (line) => {
        if (!line.trim()) return;
        let message;
        try {
          message = object(JSON.parse(line), "Capture event");
        } catch {
          this.failSession(s, new Error(
            "The capture helper returned malformed output.",
          ));
          return;
        }
        if (message.type === "error") {
          if (message.recoverable === true) {
            const error = parseInputError(message);
            if (error.mediaType === "camera") s.effects.reject(error);
            if (!s.stopRequested) {
              if (this.onInputError) this.onInputError(error);
              else this.onError?.(error.message);
            }
            return;
          }
          const failure = new Error(string(message.message, 32768, "Capture error"));
          if (message.code !== undefined) failure.code = string(message.code, 256, "Capture error code");
          this.failSession(s, failure);
        }
        if (message.type === "ready" && !s.ready) {
          if (s.failure || s.stopRequested) return;
          if (
            message.output !== output ||
            message.cursorOutput !== cursorOutput
          ) {
            this.failSession(s, new Error(
              "The capture helper reported a different recording destination.",
            ));
            return;
          }
          s.cameraDeviceID = parseOptionalDeviceID(message.cameraDeviceID, "Ready camera device ID");
          s.microphoneDeviceID = parseOptionalDeviceID(message.microphoneDeviceID, "Ready microphone device ID");
          if ((cameraDeviceID !== null && s.cameraDeviceID !== null && s.cameraDeviceID !== cameraDeviceID) ||
              (microphoneDeviceID !== null && s.microphoneDeviceID !== null && s.microphoneDeviceID !== microphoneDeviceID) ||
              (previewCamera && s.cameraDeviceID === null) || (monitorMicrophone && s.microphoneDeviceID === null))
            throw new Error("The capture helper reported a different or missing live input identity.");
          s.ready = true;
          clearTimeout(readyTimer);
          this.onReady?.({ cameraDeviceID: s.cameraDeviceID, microphoneDeviceID: s.microphoneDeviceID });
          readyResolve();
        }
        if (s.effects.accept(message)) return;
        if (message.type === "state") {
          if (s.stopRequested || s.failure) return;
          if (!s.ready) throw new Error("The recorder emitted state before readiness.");
          const state = { status: choice(message.status, ["recording", "paused"], "Recording state"), elapsedMs: number(message.elapsedMs, s.state?.elapsedMs ?? 0, Number.MAX_SAFE_INTEGER, "Recording elapsed time") };
          s.state = state;
          this.onState?.(state);
          if (s.stateWaiter?.status === state.status) { clearTimeout(s.stateWaiter.timer); s.stateWaiter.resolve(state); s.stateWaiter = null; }
        }
        if (message.type === "flag") {
          if (!s.ready || s.exited) throw new Error("The recorder emitted a flag outside an active session.");
          const flag = { id: string(message.id, 256, "Recording flag identity"), time: number(message.time, 0, Number.MAX_SAFE_INTEGER, "Recording flag time") };
          if (s.flagWaiter) { clearTimeout(s.flagWaiter.timer); s.flagWaiter.resolve(flag); s.flagWaiter = null; }
        }
        if (message.type === "levels" || message.type === "camera-frame") {
          if (s.stopRequested || s.failure) return;
          if (!s.ready) throw new Error("The recorder emitted live samples before readiness.");
          if (message.type === "levels") {
            const level = parseLevels(message);
            if (!s.monitorMicrophone || level.deviceID !== s.microphoneDeviceID)
              throw new Error("The recorder emitted levels for an unrequested microphone.");
            this.onInputLevels?.(level);
          } else {
            const frame = parseCameraFrame(message);
            if (!s.camera || frame.deviceID !== s.cameraDeviceID)
              throw new Error("The recorder emitted a frame for an unrequested camera.");
            if (s.previewCamera) this.onCameraFrame?.(frame);
          }
        }
        if (message.type === "stopped") s.resultMessage = message;
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        try {
          let offset = 0;
          while (offset < chunk.length) {
            const newline = chunk.indexOf("\n", offset), end = newline < 0 ? chunk.length : newline;
            const part = chunk.slice(offset, end);
            if (Buffer.byteLength(s.pending) + Buffer.byteLength(part) > MAX_LINE_BYTES) throw new Error("Capture helper output exceeded its line budget.");
            s.pending += part;
            if (newline < 0) break;
            const line = s.pending; s.pending = ""; acceptLine(line); offset = newline + 1;
          }
        } catch (error) { this.failSession(s, error); }
      });
      child.stderr.on("data", (chunk) => {
        s.stderr = (s.stderr + chunk.toString()).slice(-32768);
      });
      child.stdin.on("error", (error) => {
        if (!s.exited && !s.resultMessage) s.failure ||= error;
      });
      child.on("error", (error) => {
        this.failSession(s, error);
      });
      child.once("close", (code) => {
        s.exited = true;
        s.effects.reject(new Error("The camera recording stopped."));
        s.resolveClosed();
        clearTimeout(readyTimer);
        this.rejectStateWaiter(s, new Error("The recording has stopped."));
        if (s.flagWaiter) { clearTimeout(s.flagWaiter.timer); s.flagWaiter.reject(new Error("The recording stopped before adding the flag.")); s.flagWaiter = null; }
        s.finalization = (async () => {
          try {
            if (s.pending.trim()) acceptLine(s.pending);
            if (s.disposition === "discard") {
              await this.removeDiscardedSession(s);
              readyReject(new Error("Recording was discarded before readiness."));
              resultResolve();
              return;
            }
            if (s.failure || code !== 0) throw s.failure || new Error(s.stderr || `Recording stopped with code ${code}.`);
            if (!s.ready) throw new Error("Recording ended before capture started.");
            if (!s.resultMessage) throw new Error("The recorder did not finalize its output.");
            const result = await this.readResult(s);
            // A discard may arrive while media probing or grants are awaiting I/O.
            if (s.disposition === "discard") { await this.removeDiscardedSession(s); resultResolve(); return; }
            this.releaseSession(s);
            this.onStopped?.(result);
            resultResolve(result);
          } catch (error) {
            readyReject(error); resultReject(error);
            if (s.disposition !== "discard") {
              this.releaseSession(s);
              if (s.ready) this.onError?.(error.message);
            }
          }
        })();
      });
      this.session = s;
      await s.readyPromise;
    } finally {
      this.starting = false;
      this.abortStarting = false;
      this.startingDone = null;
      finishStarting();
    }
  }
  async readResult(s) {
    const message = s.resultMessage;
    if (message.output !== s.output || message.cursorOutput !== s.cursorOutput)
      throw new Error("The finalized recording does not match this session.");
    const media = await probe(s.output, this.ffprobe);
    if (media.width < 1 || media.height < 1 || media.duration <= 0)
      throw new Error("The recording did not contain video frames.");
    await this.grants.grant(s.output);
    const cursorStat = await fs.stat(s.cursorOutput);
    if (!cursorStat.isFile() || cursorStat.size > MAX_PROJECT_BYTES)
      throw new Error("The cursor recording is invalid or exceeds 64 MiB.");
    const cursorData = JSON.parse(await fs.readFile(s.cursorOutput, "utf8"));
    if (!Array.isArray(cursorData) || cursorData.length > 2_000_000)
      throw new Error("The cursor recording has invalid samples.");
    let previous = -1;
    const cursor = cursorData.map((value) => {
      const v = object(value, "Cursor sample");
      const t = number(
        v.t,
        Math.max(0, previous),
        media.duration + 1,
        "Cursor time",
      );
      previous = t;
      return {
        t,
        x: number(v.x, 0, 1, "Cursor x"),
        y: number(v.y, 0, 1, "Cursor y"),
        click: boolean(v.click, "Cursor click"),
        ...(v.visible === undefined
          ? {}
          : { visible: boolean(v.visible, "Cursor visibility") }),
        ...(v.event === undefined ? {} : { event: choice(v.event, ["mouseMoved", "mouseDragged", "mouseDown", "mouseUp"], "Cursor event") }),
        ...(v.button === undefined ? {} : { button: choice(v.button, ["left", "right", "center"], "Cursor button") }),
      };
    });
    const result = {
      path: s.output,
      name: `Recording ${new Date().toLocaleString()}`,
      duration: media.duration,
      width: media.width,
      height: media.height,
      cursor,
    };
    if (message.activityOutput !== undefined) {
      const expected = path.join(s.directory, "screen.activity.json");
      if (message.activityOutput !== expected || await fs.realpath(expected) !== path.join(await fs.realpath(s.directory), "screen.activity.json"))
        throw new Error("The recording activity does not belong to this session.");
      const stat = await fs.stat(expected);
      if (!stat.isFile() || stat.size > MAX_PROJECT_BYTES) throw new Error("Recording activity is invalid or exceeds 64 MiB.");
      const activity = JSON.parse(await fs.readFile(expected, "utf8"));
      if (!Array.isArray(activity) || activity.length > 2_000_000) throw new Error("The recording activity has invalid samples.");
      const capturedDuration = number(message.duration, 0, media.duration + 1, "Captured duration");
      Object.assign(result, require("../shared/recording-activity.cjs").parseRecordingActivity(activity, capturedDuration, media.duration, s.options.fps));
    }
    if (message.cursorSourceSize !== undefined) {
      const size = object(message.cursorSourceSize, "Cursor source size");
      result.cursorSourceSize = {
        width: number(size.width, Number.MIN_VALUE, 32768, "Cursor source width"),
        height: number(size.height, Number.MIN_VALUE, 32768, "Cursor source height"),
      };
    }
    for (const key of ["microphonePath", "cameraPath"]) {
      if (message[key]) {
        const file = await fs.realpath(string(message[key], 32768, key));
        if (!contained(await fs.realpath(s.directory), file))
          throw new Error(
            "A recording sidecar is outside this recording session.",
          );
        await this.grants.grant(file);
        result[key] = file;
        if (key === "cameraPath") {
          const camera = await probe(file, this.ffprobe);
          if (camera.width < 1 || camera.height < 1 || camera.duration <= 0)
            throw new Error("The camera recording did not contain video frames.");
          result.cameraSource = { width: camera.width, height: camera.height };
          if (message.cameraEndTime !== undefined || camera.videoEndTime !== undefined) result.cameraEndTime = number(message.cameraEndTime ?? camera.videoEndTime, 0, result.duration + 1, "Camera end time");
          if (message.cameraStartTime !== undefined) result.cameraStartTime = number(message.cameraStartTime, 0, result.duration, "Camera start time");
        }
      }
    }
    return result;
  }
  releaseSession(s) {
    if (s.released) return;
    s.released = true;
    if (this.session === s) this.session = null;
    this.onIdle?.();
  }
  failSession(s, error) {
    s.failure ||= error;
    s.rejectReady(s.failure);
    this.requestStop(s);
    if (!s.exited) void this.awaitClose(s).catch(cleanupError => this.onError?.(cleanupError.message));
  }
  rejectStateWaiter(s, error) {
    if (!s.stateWaiter) return;
    clearTimeout(s.stateWaiter.timer); s.stateWaiter.reject(error); s.stateWaiter = null;
  }
  requestStop(s) {
    if (s.stopRequested) return;
    s.stopRequested = true;
    s.effects?.reject(new Error("The camera recording is stopping."));
    clearTimeout(s.readyTimer);
    this.rejectStateWaiter(s, new Error("The recording is stopping."));
    if (!s.ready) s.rejectReady(new Error("Recording startup was cancelled."));
    if (!s.exited) { try { s.child.stdin.end("stop\n"); } catch (error) { s.failure ||= error; } }
  }
  async awaitClose(s) {
    if (s.exited) return;
    if (s.closeAttempt) return s.closeAttempt;
    s.closeAttempt = (async () => {
      const timers = [], signal = name => { if (!s.exited) { try { s.child.kill(name); } catch (error) { s.failure ||= error; } } };
      const deadline = new Promise((_, reject) => {
        timers.push(setTimeout(() => {
          signal("SIGTERM");
          timers.push(setTimeout(() => {
            signal("SIGKILL");
            timers.push(setTimeout(() => reject(new Error("Recording cleanup did not finish. Its helper and current directory are retained for cleanup retry.")), this.exitTimeoutMs));
          }, this.killTimeoutMs));
        }, this.stopTimeoutMs));
      });
      try { await Promise.race([s.closedPromise, deadline]); }
      finally { timers.forEach(clearTimeout); s.closeAttempt = null; }
    })();
    return s.closeAttempt;
  }
  async stop() {
    const s = this.session;
    if (!s) throw new Error("No recording is active.");
    this.requestStop(s);
    await this.awaitClose(s);
    return s.resultPromise;
  }
  async changePaused(status) {
    const s = this.session;
    if (!s || !s.ready || s.exited || s.stopRequested) throw new Error("A recording must be active to pause or resume.");
    const change = s.control.then(async () => {
      if (s.exited || s.stopRequested) throw new Error("The recording is stopping.");
      if (s.state?.status === status) return s.state;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { s.stateWaiter = null; reject(new Error("The recorder did not acknowledge the requested pause state.")); }, this.stateTimeoutMs);
        s.stateWaiter = { status, resolve, reject, timer };
        try { s.child.stdin.write(status === "paused" ? "pause\n" : "resume\n", error => { if (error) this.rejectStateWaiter(s, error); }); }
        catch (error) { this.rejectStateWaiter(s, error); }
      });
    });
    s.control = change.catch(() => {});
    return change;
  }
  pause() { return this.changePaused("paused"); }
  resume() { return this.changePaused("recording"); }
  async addFlag() {
    const s = this.session;
    if (!s || !s.ready || s.exited || s.stopRequested || s.state?.status === "paused") throw new Error("A recording must be running to add a flag.");
    const operation = s.control.then(() => new Promise((resolve, reject) => {
      if (s.exited || s.stopRequested || s.state?.status === "paused") { reject(new Error("The recording is not running.")); return; }
      const timer = setTimeout(() => { if (s.flagWaiter?.timer === timer) s.flagWaiter = null; reject(new Error("The recorder did not acknowledge the flag.")); }, this.stateTimeoutMs);
      s.flagWaiter = { resolve, reject, timer };
      s.child.stdin.write("flag\n", error => { if (error && s.flagWaiter?.timer === timer) { clearTimeout(timer); s.flagWaiter = null; reject(error); } });
    })); s.control = operation.catch(() => {}); return operation;
  }
  async removeDiscardedSession(s) {
    if (s.released) return;
    if (!s.exited) throw new Error("Cannot remove a recording while its owned helper is running.");
    if (s.deletePromise) return s.deletePromise;
    s.deletePromise = (async () => {
      let identity;
      try { identity = await fs.lstat(s.directory); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (identity) {
        if (!identity.isDirectory() || identity.isSymbolicLink() || identity.dev !== s.directoryIdentity.dev || identity.ino !== s.directoryIdentity.ino)
          throw new Error("The current recording directory was replaced. It was preserved because ownership no longer matches.");
        await fs.rm(s.directory, { recursive: true });
      }
      this.releaseSession(s);
    })();
    try { await s.deletePromise; } finally { s.deletePromise = null; }
  }
  async discardSession(s) {
    s.disposition = "discard";
    this.requestStop(s);
    await this.awaitClose(s);
    if (s.finalization) await s.finalization;
    await this.removeDiscardedSession(s);
  }
  async discard() {
    if (this.restarting) this.restarting.cancelled = true;
    this.abortStarting = this.starting;
    const starting = this.startingDone, s = this.session;
    if (s) await this.discardSession(s);
    if (starting) await starting;
  }
  async restart() {
    if (this.disposed) throw new Error("The recorder has been disposed.");
    if (this.restarting) throw new Error("The recording is already restarting.");
    const s = this.session;
    if (!s || !s.ready || s.stopRequested) throw new Error("A recording must be active to restart.");
    const token = { cancelled: false };
    this.restarting = token;
    try {
      await this.discardSession(s);
      if (token.cancelled || this.disposed) throw new Error("Recording restart was cancelled.");
      await this.start(s.options, token);
    } finally { if (this.restarting === token) this.restarting = null; }
  }
  async setCameraPreview(enabled) {
    enabled = boolean(enabled, "Camera preview");
    const s = this.session;
    if (!s || !s.ready || s.exited || s.stopRequested || !s.camera)
      throw new Error("A camera recording must be active to change its preview.");
    const previous = s.previewCamera;
    s.previewCamera = enabled;
    try {
      await new Promise((resolve, reject) => s.child.stdin.write(`preview-camera ${enabled}\n`, error => error ? reject(error) : resolve()));
      s.options.previewCamera = enabled;
    } catch (error) { s.previewCamera = previous; throw error; }
  }
  showCameraEffects() { const s = this.session; return s?.effects ? s.effects.request() : Promise.reject(new Error("No camera recording is active.")); }
  async dispose() {
    this.disposed = true;
    if (this.restarting) this.restarting.cancelled = true;
    const starting = this.startingDone;
    this.abortStarting = this.starting;
    try { if (this.session) await this.stop(); }
    finally { if (starting) await starting; }
  }
}

module.exports = { Capture, parseSources, parseDevices };
