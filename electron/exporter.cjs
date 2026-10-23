"use strict";

const fs = require("node:fs").promises;
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const {
  validateExport,
  exportCodecs,
  projectAssets,
  buildEncoderArgs,
  validatePng,
  verifyProjectSources,
} = require("./core.cjs");
const { probe, runProcess } = require("./media.cjs");
const { writeCursorAudio, CursorAudioFileOwner } = require("./cursor-audio.cjs");
const { audioTracks } = require("../shared/audio.mjs");
const { cameraSourceOffsetSeconds } = require("../shared/camera-effects.cjs");

async function outputIdentity(file) {
  try {
    const s = await fs.lstat(file);
    if (!s.isFile() || s.isSymbolicLink())
      throw new Error("The export destination must be a regular file.");
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Check the encoder's actual container and decoded first frame before any
 * selected destination changes. This bounded probe does not decode the entire
 * export a second time; declared frame counts are checked when available. */
async function verifyEncodedOutput(file, options, codec, ffprobe) {
  try {
    const data = JSON.parse(await runProcess(ffprobe, [
      "-v", "error", "-protocol_whitelist", "file,pipe",
      "-format_whitelist", options.format === "gif" ? "gif" : "mov",
      "-select_streams", "v:0", "-read_intervals", "%+#1",
      "-show_entries", "format=duration:stream=codec_name,width,height,duration,nb_frames:frame=width,height",
      "-of", "json", file,
    ], { maxBytes: 16384 }));
    const video = data.streams?.[0], frame = data.frames?.[0];
    const expectedCodec = options.format === "gif" ? "gif" : options.format === "prores" ? "prores" : codec;
    if (!video || !frame || video.codec_name !== expectedCodec ||
        video.width !== options.width || video.height !== options.height ||
        frame.width !== options.width || frame.height !== options.height)
      throw new Error("The container or decoded first frame does not match the selected codec and dimensions.");
    const actualDuration = Number(video.duration ?? data.format?.duration);
    // A partial final video frame and GIF's centisecond timebase can round the
    // declared endpoint. Neither permits a missing encoded frame count.
    const tolerance = 1 / options.fps + (options.format === "gif" ? .01 : .001);
    if (!Number.isFinite(actualDuration) || actualDuration <= 0 || Math.abs(actualDuration - options.duration) > tolerance ||
        (video.nb_frames !== undefined && video.nb_frames !== "N/A" && Number(video.nb_frames) !== options.frameCount))
      throw new Error("The encoded duration or frame count does not match the edited timeline.");
  } catch (error) {
    throw new Error(`Could not validate the encoded export: ${error.message}`, { cause: error });
  }
}

class Exporter {
  constructor({ grants, ffmpeg, ffprobe, renderCursorAudio = writeCursorAudio }) {
    this.grants = grants;
    this.ffmpeg = ffmpeg;
    this.ffprobe = ffprobe;
    this.renderCursorAudio = renderCursorAudio;
    this.session = null;
    this.starting = false;
    this.lastCancelledID = null;
    this.preparation = null;
    this.disposal = null;
  }
  get active() {
    return this.starting || this.session !== null || this.preparation !== null || this.disposal !== null;
  }
  async start(input, choosePath) {
    if (this.active) throw new Error("Another export is already active.");
    this.starting = true;
    const controller = new AbortController();
    let finishPreparation;
    const preparation = {
      controller,
      directory: null,
      fileOwner: new CursorAudioFileOwner(),
      completion: new Promise(resolve => { finishPreparation = resolve; }),
    };
    this.preparation = preparation;
    const checkCancellation = () => { if (controller.signal.aborted) throw new Error("Export cancelled."); };
    try {
      const options = validateExport(input);
      for (const asset of projectAssets(options.project)) {
        checkCancellation();
        await this.grants.assert(asset);
      }
      await verifyProjectSources(options.project);
      checkCancellation();
      const chosen = await choosePath(options);
      checkCancellation();
      if (!chosen) return null;
      const output = path.resolve(chosen);
      const outputs = exportCodecs(options).map((codec, index) => ({
        output: index === 0 ? output : path.join(path.dirname(output), `${path.basename(output, path.extname(output))}-hevc${path.extname(output)}`),
        codec, identity: null, temporary: null, backup: null, installedIdentity: null,
      }));
      for (const [index, item] of outputs.entries()) {
        if (projectAssets(options.project).includes(item.output)) throw new Error("Choose a destination different from the source recording.");
        item.identity = await outputIdentity(item.output);
        // The Save dialog approves replacing only its explicit filename. Never
        // overwrite a pre-existing companion inferred from that selection.
        if (index > 0 && item.identity !== null) throw new Error(`The companion export already exists: ${item.output}. Choose another filename.`);
        checkCancellation();
      }
      const tracks = [];
      if (options.format !== "gif") {
        for (const track of audioTracks(options.project, -cameraSourceOffsetSeconds(options.project))) {
          checkCancellation();
          if ((await probe(track.path, this.ffprobe)).hasAudio) tracks.push(track);
          checkCancellation();
        }
      }
      const temporaryDirectory = await fs.mkdtemp(
        path.join(path.dirname(output), ".reva-export-"),
      );
      preparation.directory = temporaryDirectory;
      checkCancellation();
      if (options.format !== "gif") {
        const cursorAudio = await this.renderCursorAudio(options.project, options.duration, temporaryDirectory, { signal: controller.signal, fileOwner: preparation.fileOwner });
        checkCancellation();
        if (cursorAudio) tracks.push(cursorAudio);
      }
      for (const [index, item] of outputs.entries()) item.temporary = path.join(temporaryDirectory, `video-${index}.${options.format === "prores" ? "mov" : options.format}`);
      const args = buildEncoderArgs(options, outputs.map(item => item.temporary), tracks);
      const child = spawn(this.ffmpeg, args, {
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
      });
      const session = {
        id: crypto.randomUUID(),
        outputs,
        temporaryDirectory,
        options,
        child,
        frames: 0,
        writing: false,
        finishing: false,
        cancelled: false,
        error: null,
        stderr: "",
        exited: false,
        committed: false,
      };
      session.completion = new Promise((resolve, reject) => {
        child.once("error", (error) => {
          session.error = error;
        });
        child.stdin.on("error", (error) => {
          if (!session.cancelled) session.error ||= error;
        });
        child.stderr.on("data", (chunk) => {
          session.stderr = (session.stderr + chunk.toString()).slice(-32768);
        });
        child.once("close", (code) => {
          session.exited = true;
          if (session.cancelled) reject(new Error("Export cancelled."));
          else if (session.error || code !== 0) {
            session.error = new Error(
              session.stderr.trim() ||
                session.error?.message ||
                `FFmpeg exited with code ${code}.`,
            );
            reject(session.error);
          } else resolve();
        });
      });
      session.completion.catch(() => {});
      this.session = session;
      preparation.directory = null; // The live encoder now owns the directory.
      return { id: session.id, path: output, paths: outputs.map(item => item.output) };
    } catch (error) {
      // A failed descriptor close keeps the entire preparation. Do not remove
      // its root until dispose retries and confirms that the descriptor closed.
      if (!preparation.fileOwner.handle) {
        try { await this.cleanupPreparation(preparation); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], `${error.message} Export preparation cleanup also failed: ${preparation.directory}`); }
      }
      throw error;
    } finally {
      this.starting = false;
      if (this.preparation === preparation && !preparation.directory && !preparation.fileOwner.handle) this.preparation = null;
      finishPreparation();
    }
  }
  getSession(id) {
    if (typeof id !== "string" || !this.session || this.session.id !== id)
      throw new Error("This export session is no longer active.");
    return this.session;
  }
  async frame(id, input) {
    const s = this.getSession(id);
    if (s.cancelled || s.finishing || s.error || s.exited || s.committed)
      throw s.error || new Error("This export no longer accepts frames.");
    if (s.writing)
      throw new Error(
        "Wait for the previous export frame before sending another.",
      );
    if (s.frames >= s.options.frameCount)
      throw new Error("Too many export frames were sent.");
    const png = validatePng(input, s.options.width, s.options.height);
    s.writing = true;
    try {
      await new Promise((resolve, reject) =>
        s.child.stdin.write(png, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
      if (s.cancelled) throw new Error("Export cancelled.");
      s.frames++;
    } finally {
      s.writing = false;
    }
  }
  async finish(id) {
    const s = this.getSession(id);
    if (s.writing || s.finishing)
      throw new Error("An export frame or finalization is still in progress.");
    if (s.cancelled) throw new Error("Export cancelled.");
    if (s.frames !== s.options.frameCount)
      throw new Error(
        `The export is incomplete (${s.frames} of ${s.options.frameCount} frames).`,
      );
    s.finishing = true;
    s.finalization = (async () => {
      try {
        if (!s.committed) {
          if (!s.exited) s.child.stdin.end();
          await s.completion;
          if (s.cancelled) throw new Error("Export cancelled.");
          // Validate the entire group before changing any selected destination.
          for (const item of s.outputs) {
            const stat = await fs.stat(item.temporary);
            if (!stat.isFile() || stat.size === 0) throw new Error("FFmpeg did not produce every selected output file.");
            if (s.cancelled) throw new Error("Export cancelled.");
            await verifyEncodedOutput(item.temporary, s.options, item.codec, this.ffprobe);
            if (s.cancelled) throw new Error("Export cancelled.");
            if ((await outputIdentity(item.output)) !== item.identity) throw new Error("The export destination changed while exporting. Choose a new destination.");
          }
          try {
            for (const [index, item] of s.outputs.entries()) {
              if (s.cancelled) throw new Error("Export cancelled.");
              if (item.identity !== null) {
                const backup = path.join(s.temporaryDirectory, `previous-${index}`);
                await fs.rename(item.output, backup);
                item.backup = backup;
                if ((await outputIdentity(backup)) !== item.identity) throw new Error("The export destination changed during installation.");
              }
              // Exclusive link installation detects a late new destination.
              // Files are staged on the same filesystem as the chosen output.
              const installedIdentity = await outputIdentity(item.temporary);
              await fs.link(item.temporary, item.output);
              item.installedIdentity = installedIdentity;
              await this.grants.grant(item.output);
            }
            if (s.cancelled) throw new Error("Export cancelled.");
            s.committed = true;
          } catch (error) {
            try { await this.rollback(s); }
            catch (rollbackError) { throw new AggregateError([error, rollbackError], `${error.message} Destination rollback is incomplete; retained files: ${s.temporaryDirectory}`); }
            throw error;
          }
        }
        await this.cleanup(s);
        return s.outputs[0].output;
      } finally {
        s.finishing = false;
      }
    })();
    return s.finalization;
  }
  async rollback(s) {
    const errors = [];
    for (const item of [...s.outputs].reverse()) {
      try {
        if (item.installedIdentity !== null) {
          const identity = await outputIdentity(item.output);
          if (identity !== null && identity !== item.installedIdentity) throw new Error(`An installed export changed; retained its prior file: ${item.output}`);
          if (identity !== null) await fs.unlink(item.output);
          item.installedIdentity = null;
        }
        if (item.backup !== null) {
          if ((await outputIdentity(item.output)) !== (await outputIdentity(item.backup))) await fs.link(item.backup, item.output);
          await fs.unlink(item.backup);
          item.backup = null;
        }
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Could not restore every export destination.");
  }
  cleanup(s) {
    if (s.cleanupPromise) return s.cleanupPromise;
    s.cleanupPromise = (async () => {
      // Retain the owner and backups if installation rollback or cleanup fails.
      if (!s.committed) await this.rollback(s);
      await fs.rm(s.temporaryDirectory, { recursive: true, force: true });
      if (this.session === s) this.session = null;
    })().finally(() => { s.cleanupPromise = null; });
    return s.cleanupPromise;
  }
  async cleanupPreparation(preparation) {
    await preparation.fileOwner.close();
    if (preparation.directory) {
      await fs.rm(preparation.directory, { recursive: true, force: true });
      preparation.directory = null;
    }
    if (this.preparation === preparation) this.preparation = null;
  }
  async cancel(id) {
    if (typeof id === "string" && id === this.lastCancelledID) return;
    const s = this.getSession(id);
    s.cancelled = true;
    if (!s.exited) {
      s.child.stdin.destroy();
      s.child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (!s.exited) s.child.kill("SIGKILL");
      }, 5000);
      try {
        await s.completion.catch(() => {});
      } finally {
        clearTimeout(timer);
      }
    }
    // A finishing transaction owns installation until its rollback/commit has
    // settled. Cancellation cannot remove files from underneath that owner.
    await s.finalization?.catch(() => {});
    await this.cleanup(s);
    this.lastCancelledID = id;
  }
  dispose() {
    if (this.disposal) return this.disposal;
    this.disposal = (async () => {
      const preparation = this.preparation;
      if (preparation) {
        preparation.controller.abort();
        await preparation.completion;
        await this.cleanupPreparation(preparation);
      }
      if (this.session) await this.cancel(this.session.id);
    })().finally(() => { this.disposal = null; });
    return this.disposal;
  }
}

module.exports = { Exporter, outputIdentity };
