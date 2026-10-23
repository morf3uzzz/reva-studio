"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { object, number, integer, string, choice, validateCameraMask, MEDIA_FORMATS } = require("./core.cjs");

// These are transport/memory budgets, not limits on a source recording's size.
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 65536;
const OPEN_READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CANCELLED = Symbol("camera-segmentation-cancelled");

function check(s) { if (s.cancelled) throw CANCELLED; }
function stamp(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":"); }
function duration(value, label) { return number(value, Number.MIN_VALUE, 86400, label); }
function finite(value, label) { return number(value, -Number.MAX_VALUE, Number.MAX_VALUE, label); }
function near(a, b, tolerance, label) {
  if (Math.abs(a - b) > tolerance) throw new Error(`${label} is inconsistent.`);
}
function rational(value) {
  if (typeof value !== "string" || !/^\d+\/\d+$/.test(value)) return null;
  const [a, b] = value.split("/").map(Number), n = a / b;
  return Number.isFinite(n) && n > 0 ? n : null;
}
function timestamp(input, label) {
  const t = object(input, label);
  const value = integer(t.value, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, `${label} value`);
  const timescale = integer(t.timescale, 1, 2147483647, `${label} timescale`);
  const seconds = finite(t.seconds, `${label} seconds`);
  near(seconds, value / timescale, Math.max(1e-9, Math.abs(seconds) * Number.EPSILON * 4), label);
  return seconds;
}

function parseProbe(raw, label) {
  const value = object(raw, `${label} metadata`);
  if (!Array.isArray(value.streams) || value.streams.length > 64)
    throw new Error(`${label} stream metadata is invalid.`);
  const videos = value.streams.filter(s => s.codec_type === "video");
  if (videos.length !== 1) throw new Error(`${label} must contain exactly one video stream.`);
  const v = videos[0];
  const width = integer(v.width, 1, 32768, `${label} width`);
  const height = integer(v.height, 1, 32768, `${label} height`);
  const containerDuration = duration(Number(value.format?.duration ?? v.duration), `${label} duration`);
  const start = finite(Number(v.start_time ?? 0), `${label} start time`);
  const streamDuration = duration(Number(v.duration ?? containerDuration), `${label} track duration`);
  // Fragmented camera MP4s report a track length as format.duration even when
  // their first sample follows an empty edit. Native AVAsset timestamps include
  // that leading gap. Validate progress and masks on that same source clock.
  const seconds = duration(Math.max(containerDuration, start + streamDuration), `${label} timeline end`);
  const fps = [rational(v.avg_frame_rate), rational(v.r_frame_rate)].filter(Boolean);
  if (!fps.length) throw new Error(`${label} has no valid frame clock.`);
  const frameTolerance = Math.max(...fps.map(n => 1 / n), 0.000001);
  const rotation = Number(v.side_data_list?.find(s => s.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0);
  if (!Number.isFinite(rotation) || Math.abs(rotation / 90 - Math.round(rotation / 90)) > 0.00001)
    throw new Error(`${label} has an unsupported orientation.`);
  const swap = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  const frames = v.nb_frames === undefined || v.nb_frames === "N/A" ? null : integer(Number(v.nb_frames), 1, Number.MAX_SAFE_INTEGER, `${label} frame count`);
  return {
    width: swap ? height : width, height: swap ? width : height,
    codedWidth: width, codedHeight: height, rotation, frames,
    duration: seconds, streamDuration, start,
    frameTolerance, codec: v.codec_name, streamCount: value.streams.length,
  };
}

function parseManifest(raw, { source, sourceProbe, quality, ready, completed, output }) {
  const m = object(raw, "Camera mask manifest");
  if (m.version !== 1 || m.coordinateSpace !== "oriented-top-left-normalized")
    throw new Error("This camera mask manifest format is not supported.");
  const input = object(m.source, "Camera mask source");
  if (input.path !== source) throw new Error("Camera mask belongs to another source file.");
  integer(input.orientation, 1, 8, "Camera source orientation");
  const width = integer(input.width, 1, 32768, "Camera source width");
  const height = integer(input.height, 1, 32768, "Camera source height");
  near(width, sourceProbe.width, 1, "Camera source width");
  near(height, sourceProbe.height, 1, "Camera source height");
  near(duration(input.duration, "Camera source duration"), sourceProbe.duration, sourceProbe.frameTolerance, "Camera source duration");
  near(ready.duration, input.duration, 0.000001, "Camera startup duration");
  if (ready.width !== width || ready.height !== height || ready.quality !== quality)
    throw new Error("Camera startup metadata does not match the completed result.");
  const mask = object(m.mask, "Camera mask encoding");
  if (mask.file !== "camera-mask.mp4" || mask.codec !== "h264" || mask.channel !== "red" || mask.background !== 0 || mask.foreground !== 1)
    throw new Error("Camera mask encoding is not supported.");
  // Vision can output a 4:3 mask for a 16:9 camera. Its normalized coordinates
  // are stretched over the entire oriented source; aspect equality is invalid.
  integer(mask.width, 1, 4096, "Camera mask width");
  integer(mask.height, 1, 4096, "Camera mask height");
  const timing = object(m.timing, "Camera mask timing");
  const origin = finite(timing.sourceTimeOrigin, "Camera mask time origin");
  const length = duration(timing.duration, "Camera mask duration");
  const first = timestamp(timing.firstPTS, "First camera timestamp");
  const last = timestamp(timing.lastPTS, "Last camera timestamp");
  const end = timestamp(timing.sourceEnd, "Camera end timestamp");
  const frames = integer(timing.frameCount, 1, Number.MAX_SAFE_INTEGER, "Camera mask frame count");
  if (timing.preservesVariableFrameRate !== true || last < first || last >= end)
    throw new Error("Camera mask timing is incomplete or inconsistent.");
  near(first, origin, 0.000001, "Camera mask time origin");
  near(origin, sourceProbe.start, sourceProbe.frameTolerance, "First camera source timestamp");
  near(end - origin, length, 0.000001, "Camera mask source range");
  if (end > sourceProbe.duration + sourceProbe.frameTolerance || end < -sourceProbe.frameTolerance)
    throw new Error("Camera mask extends beyond the camera source duration.");
  if (sourceProbe.frames !== null && frames !== sourceProbe.frames)
    throw new Error("Camera mask does not cover every source video frame.");
  if (frames !== completed.frames) throw new Error("Camera helper reported a conflicting frame count.");
  near(length, completed.duration, 0.000001, "Camera helper result duration");
  const settings = object(m.settings, "Camera mask settings");
  if (settings.visionRevision !== 1 || settings.quality !== quality || settings.outputPixelFormat !== "OneComponent8")
    throw new Error("Camera mask settings do not match this request.");
  return {
    mask: validateCameraMask({ path: path.join(output, mask.file), sourcePath: source,
      sourceSHA256: input.sha256, sourceTimeOrigin: origin, duration: length,
      width: mask.width, height: mask.height }, source),
    frames,
  };
}

// Owns one job through source checks, helper exit, result validation and cleanup.
// Successful artifacts transfer to the caller's project/cache ownership. They
// remain available after dispose(); failed/cancelled jobs retain no artifacts.
class CameraSegmenter {
  constructor({ helper, cacheRoot, grants, ffprobe, onProgress = () => {}, idleTimeout = 120000 }) {
    Object.assign(this, { helper, cacheRoot, grants, ffprobe, onProgress, idleTimeout });
    this.session = null;
  }
  get active() { return this.session !== null; }

  segment(file, input = {}) {
    if (this.active) throw new Error("Camera background removal is already running.");
    const settings = object(input, "Camera segmentation settings");
    const quality = choice(settings.quality ?? "balanced", ["balanced", "accurate"], "Camera segmentation quality");
    const s = { cancelled: false, child: null, exited: true, directory: null, directoryIdentity: null,
      terminateTimer: null, killTimer: null, handedOff: false, handles: new Set() };
    this.session = s;
    s.done = this.run(s, file, quality);
    return s.done;
  }

  terminate(s) {
    if (!s.child || s.exited || s.killTimer) return;
    if (s.kind === "helper") {
      if (!s.child.stdin.destroyed && !s.child.stdin.writableEnded) s.child.stdin.end("cancel\n");
      s.terminateTimer = setTimeout(() => { if (!s.exited) s.child.kill("SIGTERM"); }, 1000);
      s.killTimer = setTimeout(() => { if (!s.exited) s.child.kill("SIGKILL"); }, 5000);
    } else {
      s.child.kill("SIGTERM");
      s.killTimer = setTimeout(() => { if (!s.exited) s.child.kill("SIGKILL"); }, 500);
    }
  }

  runChild(s, command, args, { kind, fd, timeout, onData, onClose = () => {} }) {
    check(s);
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true,
        stdio: kind === "helper" ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe", fd] });
      s.child = child; s.kind = kind; s.exited = false;
      let failure, stderr = "", timer;
      const stop = (error) => { failure ??= error; this.terminate(s); };
      const touch = () => {
        clearTimeout(timer);
        timer = setTimeout(() => stop(new Error("Camera background removal stopped responding.")), timeout);
      };
      child.stdin?.on("error", () => {});
      if (kind === "helper") child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        if (failure || s.cancelled) return;
        try { onData(chunk, touch); } catch (error) { stop(error); }
      });
      child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-16384); });
      child.once("error", error => { failure ??= error; });
      child.once("close", code => {
        s.exited = true;
        clearTimeout(timer); clearTimeout(s.terminateTimer); clearTimeout(s.killTimer);
        s.terminateTimer = null; s.killTimer = null;
        if (!failure && !s.cancelled) {
          try { onClose(); } catch (error) { failure = error; }
        }
        clearTimeout(timer);
        if (failure) reject(failure); else resolve({ code, stderr });
      });
      touch();
      if (s.cancelled) this.terminate(s);
    });
  }

  async probe(s, handle, label) {
    const chunks = []; let size = 0;
    const { code, stderr } = await this.runChild(s, this.ffprobe, [
      "-v", "error", "-protocol_whitelist", "fd,pipe", "-format_whitelist", MEDIA_FORMATS, "-fd", "3",
      "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,start_time,duration,avg_frame_rate,r_frame_rate,nb_frames:stream_side_data=rotation:stream_tags=rotate",
      "-of", "json", "fd:",
    ], { kind: "probe", fd: handle.fd, timeout: 30000, onData(chunk) {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) throw new Error("Camera metadata exceeds its memory budget.");
      chunks.push(chunk);
    } });
    check(s);
    if (code !== 0) throw new Error(stderr.trim() || `${label} metadata could not be read.`);
    return parseProbe(JSON.parse(Buffer.concat(chunks).toString("utf8")), label);
  }

  async helperResult(s, source, output, quality, sourceProbe) {
    let pending = "", ready, completed, terminal, progress = 0;
    const accept = line => {
      if (!line.trim()) return;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error("Camera helper returned an oversized message.");
      const m = object(JSON.parse(line), "Camera segmentation message");
      if (terminal) throw new Error("Camera helper sent a message after its terminal result.");
      if (m.type === "ready") {
        if (ready) throw new Error("Camera helper repeated its ready message.");
        ready = { duration: duration(m.duration, "Camera startup duration"),
          width: integer(m.width, 1, 32768, "Camera startup width"), height: integer(m.height, 1, 32768, "Camera startup height"),
          quality: choice(m.quality, ["balanced", "accurate"], "Camera startup quality") };
      } else if (m.type === "progress") {
        if (!ready) throw new Error("Camera progress arrived before startup.");
        choice(m.phase, ["segmenting", "finalizing"], "Camera processing phase");
        const next = number(m.progress, progress, 0.95, "Camera processing progress");
        const time = finite(m.t, "Camera progress time");
        if (time > sourceProbe.duration + sourceProbe.frameTolerance)
          throw new Error("Camera progress extends beyond the source duration.");
        integer(m.frames, 1, Number.MAX_SAFE_INTEGER, "Camera progress frames");
        progress = next; this.onProgress(next);
      } else if (m.type === "completed") {
        if (!ready || m.outputDirectory !== output || m.manifestPath !== path.join(output, "manifest.json") || m.maskPath !== path.join(output, "camera-mask.mp4"))
          throw new Error("Camera helper reported an unexpected result location.");
        completed = { frames: integer(m.frames, 1, Number.MAX_SAFE_INTEGER, "Camera completed frame count"), duration: duration(m.duration, "Camera completed duration") };
        terminal = "completed";
      } else if (m.type === "cancelled") {
        terminal = "cancelled";
      } else if (m.type === "error") {
        const error = new Error(string(m.message, 32768, "Camera helper error"));
        if (typeof m.code === "string") error.code = string(m.code, 256, "Camera helper error code");
        // Native paths are diagnostic only. Cleanup always uses our own parent
        // directory identity; a message cannot grant deletion authority.
        throw error;
      } else throw new Error("Camera helper returned an unknown message.");
    };
    const { code, stderr } = await this.runChild(s, this.helper, [
      "segment-camera", "--input", source, "--output-directory", output, "--quality", quality,
    ], { kind: "helper", timeout: this.idleTimeout, onData: (chunk, touch) => {
      pending += chunk.toString("utf8");
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        accept(line); touch();
      }
      if (Buffer.byteLength(pending) > MAX_LINE_BYTES) throw new Error("Camera helper returned an oversized message.");
    }, onClose: () => { if (pending.trim()) accept(pending); } });
    check(s);
    if (code !== 0 || !completed) throw new Error(stderr.trim() || "Camera segmentation did not produce a complete result.");
    return { ready, completed };
  }

  async assertDirectory(s) {
    const stat = await fs.lstat(s.directory);
    if (!s.directoryIdentity || !stat.isDirectory() || stat.dev !== s.directoryIdentity.dev || stat.ino !== s.directoryIdentity.ino)
      throw new Error("The owned camera directory was replaced; cleanup needs attention.");
  }

  async readManifest(s, output) {
    await this.assertDirectory(s);
    const folder = await fs.lstat(output);
    if (!folder.isDirectory() || (await fs.realpath(output)) !== output)
      throw new Error("Camera result directory is not a regular owned directory.");
    const file = path.join(output, "manifest.json"), handle = await this.open(s, file);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAX_JSON_BYTES) throw new Error("Camera manifest is invalid or exceeds its memory budget.");
      const buffer = Buffer.alloc(before.size + 1); let count = 0;
      while (count < buffer.length) {
        check(s);
        const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
        if (!bytesRead) break;
        count += bytesRead;
      }
      const after = await handle.stat(), current = await fs.lstat(file);
      if (count !== before.size || stamp(before) !== stamp(after) || stamp(current) !== stamp(before) || !current.isFile())
        throw new Error("Camera manifest changed during validation.");
      return { raw: JSON.parse(buffer.subarray(0, count).toString("utf8")), folder };
    } finally { await this.close(s, handle); }
  }

  async open(s, file) {
    const handle = await fs.open(file, OPEN_READ);
    s.handles.add(handle);
    return handle;
  }
  async close(s, handle) { await handle.close(); s.handles.delete(handle); }
  async closeHandles(s) {
    const errors = [];
    for (const handle of s.handles) {
      try { await this.close(s, handle); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Camera source handles could not be closed.");
  }

  async verifySource(s, file, source, handle, initial, expectedHash) {
    check(s);
    if ((await this.grants.assert(file)) !== source) throw new Error("The selected camera source changed.");
    const before = await handle.stat();
    if (stamp(before) !== stamp(initial)) throw new Error("The camera source changed during segmentation.");
    const hash = crypto.createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    for (let position = 0; position < initial.size;) {
      check(s);
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, initial.size - position), position);
      if (!bytesRead) throw new Error("The camera source changed during segmentation.");
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    const after = await handle.stat(), current = await fs.lstat(source);
    if (!current.isFile() || stamp(after) !== stamp(initial) || stamp(current) !== stamp(initial))
      throw new Error("The camera source changed during segmentation.");
    if (hash.digest("hex") !== expectedHash) throw new Error("Camera mask does not match the source file's SHA256.");
    if ((await this.grants.assert(file)) !== source) throw new Error("The selected camera source changed.");
    check(s);
  }

  async run(s, file, quality) {
    let sourceHandle, maskHandle, runFailure;
    try {
      const source = await this.grants.assert(file);
      check(s);
      if (typeof source !== "string" || !path.isAbsolute(source) || source.includes("\0"))
        throw new Error("Camera segmentation requires a granted local file.");
      sourceHandle = await this.open(s, source);
      const initial = await sourceHandle.stat();
      if (!initial.isFile()) throw new Error("Camera source must be a regular file.");
      if (stamp(await fs.lstat(source)) !== stamp(initial)) throw new Error("The selected camera source changed.");
      const sourceProbe = await this.probe(s, sourceHandle, "Camera source");
      await fs.mkdir(this.cacheRoot, { recursive: true, mode: 0o700 });
      // Use the real parent so /tmp versus /private/tmp aliases do not produce
      // false containment failures in helper output validation.
      const cacheRoot = await fs.realpath(this.cacheRoot);
      check(s);
      s.directory = await fs.mkdtemp(path.join(cacheRoot, "CameraMask-"));
      s.directoryIdentity = await fs.lstat(s.directory);
      await this.assertDirectory(s);
      check(s);
      const output = path.join(s.directory, "result");
      const handshake = await this.helperResult(s, source, output, quality, sourceProbe);
      const { raw, folder } = await this.readManifest(s, output);
      const parsed = parseManifest(raw, { source, sourceProbe, quality, output, ...handshake });
      check(s);
      maskHandle = await this.open(s, parsed.mask.path);
      const maskStat = await maskHandle.stat();
      if (!maskStat.isFile()) throw new Error("Camera mask is not a regular media file.");
      const maskProbe = await this.probe(s, maskHandle, "Camera mask");
      if (maskProbe.codec !== "h264" || maskProbe.streamCount !== 1 || maskProbe.rotation !== 0 ||
          maskProbe.codedWidth !== parsed.mask.width || maskProbe.codedHeight !== parsed.mask.height || maskProbe.frames !== parsed.frames)
        throw new Error("Camera mask encoding or frame coverage does not match its manifest.");
      near(maskProbe.start, 0, 0.000001, "Camera mask starting timestamp");
      near(maskProbe.duration, parsed.mask.duration, maskProbe.frameTolerance, "Camera mask encoded duration");
      near(maskProbe.streamDuration, parsed.mask.duration, maskProbe.frameTolerance, "Camera mask track duration");
      await this.verifySource(s, file, source, sourceHandle, initial, parsed.mask.sourceSHA256);
      await this.assertDirectory(s);
      const currentFolder = await fs.lstat(output), currentMask = await fs.lstat(parsed.mask.path);
      if (!currentFolder.isDirectory() || currentFolder.dev !== folder.dev || currentFolder.ino !== folder.ino ||
          !currentMask.isFile() || stamp(currentMask) !== stamp(maskStat) || stamp(await maskHandle.stat()) !== stamp(maskStat))
        throw new Error("Camera result changed during validation.");
      await this.close(s, maskHandle); maskHandle = null;
      await this.close(s, sourceHandle); sourceHandle = null;
      check(s);
      // No await between the final cancellation check and ownership transfer.
      s.handedOff = true;
      return parsed.mask;
    } catch (error) {
      if (s.cancelled || error === CANCELLED) return null;
      runFailure = error; throw error;
    } finally {
      try {
        await this.closeHandles(s);
        if (!s.handedOff) await this.cleanup(s);
      } catch (error) {
        const errors = [runFailure, error].filter(Boolean);
        throw errors.length > 1 ? new AggregateError(errors, errors.map(e => e.message).join(" Cleanup: ")) : error;
      }
      if (this.session === s) this.session = null;
    }
  }

  async cleanup(s) {
    if (s.cleanupPromise) return s.cleanupPromise;
    const cleanup = this.removeDirectory(s); s.cleanupPromise = cleanup;
    try { await cleanup; } finally { if (s.cleanupPromise === cleanup) s.cleanupPromise = null; }
  }
  async removeDirectory(s) {
    if (!s.directory) return;
    if (s.child && !s.exited) throw new Error("The camera helper must exit before cleanup.");
    try { await this.assertDirectory(s); } catch (error) {
      if (error.code === "ENOENT") { s.directory = null; return; }
      throw error;
    }
    await fs.rm(s.directory, { recursive: true, force: true });
    s.directory = null;
  }
  async cancel() {
    const s = this.session;
    if (!s || s.handedOff) return;
    s.cancelled = true; this.terminate(s);
    try { await s.done; } catch (error) {
      if (this.session === s && (!s.child || s.exited)) {
        await this.closeHandles(s);
        await this.cleanup(s);
        if (this.session === s) this.session = null;
      } else if (this.session === s) throw error;
    }
  }
  async dispose() { await this.cancel(); }
}

module.exports = { CameraSegmenter };
