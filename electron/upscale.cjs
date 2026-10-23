"use strict";
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { object, number, integer, string } = require("./core.cjs");
const { parseScreenEnhancement } = require("../shared/camera-effects.cjs");
const { LocalVideoJob } = require("./local-video-job.cjs");

const PIPER_ATTRIBUTION = "PiperSR by Ben Racicot / ModelPiper (https://modelpiper.com). Model weights: CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Independent local CoreML tiling/stitch inference; no upstream inference source used. Video processed with the model; model weights unmodified.";

class ScreenUpscaler extends LocalVideoJob {
  constructor({ modelPath, attribution, ...options }) { super({ ...options, label: "Screen enhancement" }); Object.assign(this, { modelPath, attribution: attribution ?? (typeof modelPath === "string" && path.basename(modelPath).startsWith("PiperSR") ? PIPER_ATTRIBUTION : undefined) }); }
  upscale(file) {
    if (this.active) throw new Error("Screen enhancement is already running.");
    if (typeof this.modelPath !== "string" || !path.isAbsolute(this.modelPath)) throw new Error("Select an available compatible local CoreML enhancement model.");
    const s = { cancelled: false, child: null, exited: false, directory: null, directoryIdentity: null, terminateTimer: null, killTimer: null, handles: new Set(), handedOff: false };
    this.session = s; s.done = this.run(s, file); return s.done;
  }
  async run(s, file) {
    let failure;
    try {
      const source = await this.grants.assert(file);
      if (s.cancelled) return null;
      const model = await fs.lstat(this.modelPath);
      if (model.isSymbolicLink() || !(model.isFile() || model.isDirectory())) throw new Error("The selected CoreML model is not a local regular model file/package.");
      await fs.mkdir(this.cacheRoot, { recursive: true, mode: 0o700 });
      const cache = await fs.realpath(this.cacheRoot);
      s.directory = await fs.mkdtemp(path.join(cache, "Upscale-")); s.directoryIdentity = await fs.lstat(s.directory);
      await this.assertDirectory(s); if (s.cancelled) return null;
      const resultDirectory = path.join(s.directory, "result");
      const handshake = await this.runHelper(s, ["upscale-video", "--input", source, "--model", this.modelPath, "--output-directory", resultDirectory], resultDirectory, ready => ({ width: integer(ready.width, 1, 3840, "Enhanced startup width"), height: integer(ready.height, 1, 3840, "Enhanced startup height"), duration: number(ready.duration, .001, 86400, "Enhanced startup duration"), scale: integer(ready.scale, 2, 4, "Enhanced startup scale"), model: string(ready.model, 4096, "Enhanced startup model") }));
      if (s.cancelled) return null;
      const directory = await fs.lstat(resultDirectory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("The enhancement output is not an owned local directory.");
      const raw = await this.readResult(s, path.join(resultDirectory, "manifest.json"));
      if (s.cancelled) return null;
      const manifest = object(raw, "Enhancement manifest"), input = object(manifest.source, "Enhancement source"), modelInfo = object(manifest.model, "Enhancement model"), video = object(manifest.video, "Enhanced video"), timing = object(manifest.timing, "Enhanced timing");
      if (manifest.version !== 1 || input.path !== source || modelInfo.path !== this.modelPath || video.file !== "enhanced.mp4" || video.codec !== "h264" || timing.preservesVariableFrameRate !== true) throw new Error("Enhancement result does not match the selected source, model, encoding or timeline.");
      const sourceWidth = integer(input.width, 1, 32768, "Enhancement source width"), sourceHeight = integer(input.height, 1, 32768, "Enhancement source height"), duration = number(input.duration, .001, 86400, "Enhancement source duration");
      const scale = integer(modelInfo.scale, 2, 4, "Neural enhancement scale"), tileWidth = integer(modelInfo.inputWidth, 32, 512, "Model input width"), tileHeight = integer(modelInfo.inputHeight, 32, 512, "Model input height");
      if (integer(modelInfo.outputWidth, 64, 2048, "Model output width") !== tileWidth * scale || integer(modelInfo.outputHeight, 64, 2048, "Model output height") !== tileHeight * scale || modelInfo.name !== handshake.ready.model) throw new Error("Enhancement model contract changed after startup.");
      string(modelInfo.inputName, 4096, "Model input name"); string(modelInfo.outputName, 4096, "Model output name");
      const frames = integer(timing.frames, 1, Number.MAX_SAFE_INTEGER, "Enhanced frame count"), first = number(timing.firstPTS, 0, duration, "Enhanced first time"), last = number(timing.lastPTS, first, duration, "Enhanced last time");
      const end = number(timing.endTime, Number.MIN_VALUE, 86400, "Enhanced end time");
      if (!frames || last >= end || end < input.duration || timing.duration !== input.duration || handshake.ready.duration !== input.duration) throw new Error("Enhanced video timing is inconsistent.");
      if (video.width !== sourceWidth * scale || video.height !== sourceHeight * scale || video.width !== handshake.ready.width || video.height !== handshake.ready.height || scale !== handshake.ready.scale) throw new Error("Enhanced video dimensions do not match the neural model scale.");
      const asset = parseScreenEnhancement({ path: path.join(resultDirectory, video.file), sourcePath: source, sourceSHA256: input.sha256, modelSHA256: modelInfo.sha256, modelName: modelInfo.name, width: video.width, height: video.height, duration: input.duration, sourceStartTime: first, scale: modelInfo.scale, enabled: true, ...(this.attribution ? { attribution: this.attribution } : {}) });
      await this.verifySource(s, file, source, asset.sourceSHA256); if (s.cancelled) return null;
      const handle = await fs.open(asset.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); s.handles.add(handle);
      const info = await handle.stat(), header = Buffer.alloc(8); const read = await handle.read(header, 0, 8, 0);
      if (!info.isFile() || info.size < 8 || read.bytesRead !== 8 || header.toString("ascii", 4, 8) !== "ftyp") throw new Error("The native enhancement did not produce a regular local MP4 video.");
      await handle.close(); s.handles.delete(handle);
      await this.grants.grant(asset.path);
      const granted = await fs.lstat(asset.path);
      if (!granted.isFile() || granted.dev !== info.dev || granted.ino !== info.ino || granted.size !== info.size || granted.mtimeMs !== info.mtimeMs) throw new Error("The owned enhanced video changed during publication.");
      if (s.cancelled) return null;
      // Everything asynchronous is complete. Transfer derived media ownership
      // to the project/cache without a cancellation gap after this point.
      s.handedOff = true; return asset;
    } catch (error) { if (s.cancelled) return null; failure = error; throw error; }
    finally {
      try { if (!s.handedOff) await this.cleanup(s); }
      catch (error) { if (failure) throw new AggregateError([failure, error], `${failure.message} Cleanup: ${error.message}`); throw error; }
      if (this.session === s) this.session = null;
    }
  }
}
module.exports = { ScreenUpscaler, PIPER_ATTRIBUTION };
