"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { validateProject, projectAssets, projectSlices } = require("./core.cjs");
const { probe } = require("./media.cjs");
const { audioTracks } = require("../shared/audio.mjs");
const { cameraSourceOffsetSeconds } = require("../shared/camera-effects.cjs");
const { buildAudioGraph } = require("./audio-mix.cjs");
const { writeCursorAudio, CursorAudioFileOwner } = require("./cursor-audio.cjs");
const { iterateCursorAudioCues } = require("../shared/cursor-audio.mjs");
const identity = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
class AudioPreview {
  constructor({ root, grants, ffmpeg, ffprobe, maxEntries = 8 }) { Object.assign(this, { root, grants, ffmpeg, ffprobe, maxEntries }); this.cache = new Map(); this.jobs = new Map(); this.disposed = false; this.cleanup = new Set(); }
  async remove(entry) { if (entry.fileOwner) await entry.fileOwner.close(); if (!entry.directory) return; const current = await fs.lstat(entry.directory).catch(error => { if (error.code === "ENOENT") return null; throw error; }); if (current && (!current.isDirectory() || current.isSymbolicLink() || current.dev !== entry.identity.dev || current.ino !== entry.identity.ino)) throw new Error("An owned audio preview directory was replaced; it was preserved."); if (current) await fs.rm(entry.directory, { recursive: true }); entry.directory = null; this.cleanup.delete(entry); }
  render(input, request) {
    if (this.disposed) throw new Error("Audio preview is closed.");
    if (!request || typeof request.id !== "string" || !/^[a-f0-9-]{36}$/.test(request.id) || !Number.isFinite(request.start) || !Number.isFinite(request.duration) || request.start < 0 || request.duration <= 0 || request.duration > 20) throw new Error("Choose an audio preview window of at most 20 seconds.");
    if (this.jobs.has(request.id)) throw new Error("This audio preview request is already running.");
    if (this.jobs.size >= 2) throw new Error("Wait for the current audio preview before requesting another.");
    const project = validateProject(input), job = { id: request.id, cancelled: false, child: null, exited: false, directory: null, killTimer: null, controller: new AbortController(), fileOwner: new CursorAudioFileOwner() };
    this.jobs.set(job.id, job);
    job.done = this.run(job, project, request).then(result => job.cancelled ? null : result).finally(() => { if (!job.directory) this.jobs.delete(job.id); }); return job.done;
  }
  async run(job, project, request) {
    const check = () => { if (job.cancelled) throw new Error("Audio preview cancelled."); };
    let failure;
    try {
      const duration = projectSlices(project).reduce((sum, slice) => sum + (slice.end - slice.start) / slice.speed, 0), start = Math.min(request.start, duration), end = Math.min(duration, start + request.duration);
      if (end <= start) return null;
      const tracks = [], facts = [];
      for (const track of audioTracks(project, -cameraSourceOffsetSeconds(project))) {
        check(); const real = await this.grants.assert(track.path), stat = await fs.stat(real); facts.push({ path: real, identity: identity(stat) });
        if ((await probe(real, this.ffprobe)).hasAudio) tracks.push({ ...track, path: real });
      }
      check();
      const click = project.appearance.cursorSettings, clicks = click && click.clickSound !== "none" && click.clickSoundVolume > 0 ? { sound: click.clickSound, volume: click.clickSoundVolume, cues: [...iterateCursorAudioCues(project.cursor, projectSlices(project))].map(({ outputTime, type }) => ({ outputTime, type })) } : null;
      if (!tracks.length && !clicks?.cues.length) return null;
      const fingerprint = { tracks, clicks, slices: projectSlices(project).map(({ start, end, speed, volume, systemVolume, cameraVolume }) => ({ start, end, speed, volume, systemVolume, cameraVolume })), duration, fadeIn: project.appearance.fadeIn, fadeOut: project.appearance.fadeOut, start, end, facts }, key = crypto.createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex");
      const existing = this.cache.get(key);
      if (existing) { this.cache.delete(key); this.cache.set(key, existing); return { key, path: await this.grants.assert(existing.path), start, duration: end - start }; }
      await fs.mkdir(this.root, { recursive: true, mode: 0o700 }); check(); job.directory = await fs.mkdtemp(path.join(this.root, "Preview-")); job.identity = await fs.lstat(job.directory); this.cleanup.add(job);
      const clickTrack = await writeCursorAudio(project, duration, job.directory, { signal: job.controller.signal, fileOwner: job.fileOwner });
      check(); if (clickTrack) tracks.push(clickTrack);
      const graph = buildAudioGraph(project, duration, tracks, { firstInputIndex: 0, start, end }); if (!graph.label) return null;
      const output = path.join(job.directory, "mix.wav"), args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-filter_complex_threads", "2", ...graph.inputArgs, "-filter_complex", graph.filters.join(";"), "-map", graph.label, "-vn", "-ar", "48000", "-ac", "2", "-c:a", "pcm_f32le", "-t", String(graph.duration), "-f", "wav", output];
      await new Promise((resolve, reject) => { const child = spawn(this.ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }); job.child = child; let stderr = "", error; const timeout = setTimeout(() => { error = new Error("Audio preview processing timed out."); child.kill("SIGKILL"); }, 120000); child.stderr.on("data", data => { stderr = (stderr + data.toString()).slice(-16384); }); child.once("error", value => { error = value; }); child.once("close", code => { job.exited = true; clearTimeout(timeout); clearTimeout(job.killTimer); if (job.cancelled) reject(new Error("Audio preview cancelled.")); else if (error || code !== 0) reject(error ?? new Error(stderr || `Audio preview exited with code ${code}.`)); else resolve(); }); if (job.cancelled) this.terminate(job); });
      check(); for (const fact of facts) if (identity(await fs.stat(fact.path)) !== fact.identity) throw new Error("An audio source changed during preview processing. Select it again.");
      const file = await this.grants.grant(output); check();
      const entry = { directory: job.directory, identity: job.identity, path: file }; job.directory = null; this.cleanup.delete(job); this.cache.set(key, entry);
      while (this.cache.size > this.maxEntries) { const [oldKey, old] = this.cache.entries().next().value; await this.remove(old); this.cache.delete(oldKey); }
      return { key, path: file, start, duration: end - start };
    } catch (error) { failure = error; }
    finally { if (job.directory && (!job.child || job.exited)) try { await this.remove(job); } catch (cleanup) { failure = failure ? new AggregateError([failure, cleanup], "Audio preview and its cleanup failed.") : cleanup; } }
    if (failure && !job.cancelled) throw failure; if (job.directory) throw failure; return null;
  }
  terminate(job) { job.controller.abort(); if (job.child && !job.exited) { job.child.kill("SIGTERM"); job.killTimer ??= setTimeout(() => { if (!job.exited) job.child.kill("SIGKILL"); }, 1000); } }
  async cancel(id) { const job = this.jobs.get(id); if (!job) return; job.cancelled = true; this.terminate(job); await job.done; if (job.directory) await this.remove(job); this.jobs.delete(id); }
  async dispose() { this.disposed = true; await Promise.all([...this.jobs.keys()].map(id => this.cancel(id))); for (const [key, entry] of this.cache) { await this.remove(entry); this.cache.delete(key); } for (const entry of this.cleanup) await this.remove(entry); }
}
module.exports = { AudioPreview };
