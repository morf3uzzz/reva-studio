"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { object, boolean, number, string } = require("./core.cjs");
const { parseCameraAnalysis } = require("../shared/camera-effects.cjs");
const { LocalVideoJob } = require("./local-video-job.cjs");

class CameraAnalyzer extends LocalVideoJob {
  constructor(options) { super({...options, label: "Camera"}); }
  analyze(file, input) {
    if (this.active) throw new Error("Camera analysis is already running.");
    const settings = object(input, "Camera settings");
    const faces = boolean(settings.faces, "Camera face detector");
    const silence = boolean(settings.silence, "Camera silence detector");
    if (!silence && !faces) throw new Error("Select a camera detector first.");
    const audioPath = settings.audioPath === undefined ? file : string(settings.audioPath, 32768, "Camera audio source");
    const silenceThresholdDB = number(settings.silenceThresholdDB ?? -40, -96, -6, "Silence threshold");
    const silenceMinimumSeconds = number(settings.silenceMinimumSeconds ?? 1, 0.1, 60, "Silence minimum duration");
    const s = { cancelled: false, child: null, exited: false, directory: null, directoryIdentity: null,
      terminateTimer: null, killTimer: null, handles: new Set() };
    this.session = s;
    // Cancellation remains meaningful through asynchronous final cleanup.
    s.done = this.run(s, file, { faces, silence, audioPath, silenceThresholdDB, silenceMinimumSeconds }).then((result) => s.cancelled ? null : result);
    return s.done;
  }

  async run(s, file, settings) {
    let runFailure;
    try {
      const source = await this.grants.assert(file);
      const audioSource = settings.silence ? await this.grants.assert(settings.audioPath) : source;
      if (s.cancelled) return null;
      await fs.mkdir(this.cacheRoot, { recursive: true, mode: 0o700 });
      s.directory = await fs.mkdtemp(path.join(this.cacheRoot, "Camera-"));
      s.directoryIdentity = await fs.lstat(s.directory);
      await this.assertDirectory(s);
      if (s.cancelled) return null;
      const output = path.join(s.directory, "analysis.json");
      await this.runHelper(s, ["analyze-camera", "--input", source, "--output", output, "--faces", String(settings.faces), "--silence", String(settings.silence), "--audio-input", audioSource, "--silence-threshold-db", String(settings.silenceThresholdDB), "--silence-minimum-seconds", String(settings.silenceMinimumSeconds)], output);
      await this.grants.assert(file);
      if (s.cancelled) return null;
      const raw = await this.readResult(s, output);
      if (s.cancelled) return null;
      const analysis = parseCameraAnalysis(raw);
      if (Boolean(analysis.faceTrack) !== settings.faces || Boolean(analysis.silence) !== settings.silence)
        throw new Error("Camera analysis did not return the requested detectors.");
      const checks = [];
      if (analysis.faceTrack) checks.push([analysis.faceTrack, file, source]);
      if (analysis.silence) checks.push([analysis.silence, settings.audioPath, audioSource]);
      for (const [result, original, expectedSource] of checks) {
        if (!result.coverage.complete || result.source.path !== expectedSource)
          throw new Error("Camera analysis belongs to another recording or has incomplete coverage.");
        await this.verifySource(s, original, expectedSource, result.source.sha256);
      }
      return s.cancelled ? null : analysis;
    } catch (error) {
      runFailure = error;
      throw error;
    } finally {
      // The child is closed before its owned temporary directory is removed.
      // A failed cleanup keeps this session reachable for dispose() to retry.
      try { await this.cleanup(s); } catch (error) {
        if (runFailure) throw new AggregateError([runFailure, error], `${runFailure.message} Cleanup: ${error.message}`);
        throw error;
      }
      if (this.session === s) this.session = null;
    }
  }

  }
module.exports = { CameraAnalyzer };
