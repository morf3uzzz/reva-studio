"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { parseRecordingActivity } = require("../shared/recording-activity.cjs");
const { MEDIA_FORMATS } = require("./core.cjs");

const OWNER_FILE = ".reva-recording-owner.json";
const RECEIPT_FILE = ".reva-recovery-receipt.json";
const MAX_JOURNAL_BYTES = 1024 * 1024;
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_PREFIX_BYTES = 64 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const issue = (code, message, file) => ({ code, message, ...(file ? { path: file } : {}) });
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a, b) => sameIdentity(identity(a), identity(b)) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const fileFact = stat => ({ ...identity(stat), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
const sameFileFact = (stat, fact) => stat.isFile() && !stat.isSymbolicLink() && sameIdentity(identity(stat), fact ?? {}) && stat.size === fact.size && stat.mtimeMs === fact.mtimeMs && stat.ctimeMs === fact.ctimeMs;
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

class RecoveryFailure extends Error {
  constructor(code, message) { super(message); this.name = "RecoveryFailure"; this.code = code; }
}
function fail(code, message) { throw new RecoveryFailure(code, message); }
function text(value, label, max = 32768) {
  if (typeof value !== "string" || !value || value.length > max || value.includes("\0")) fail("invalid-journal", `${label} is invalid.`);
  return value;
}
function finite(value, min, max, label, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail("invalid-journal", `${label} is invalid.`);
  return value;
}
function timestamp(value, label) {
  const result = text(value, label, 256);
  if (!Number.isFinite(Date.parse(result))) fail("invalid-journal", `${label} is invalid.`);
  return result;
}
function parseJournal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.type !== "reva-recording-recovery" || value.schemaVersion !== 1) fail("invalid-journal", "This is not a supported REVA recording journal.");
  if (!UUID.test(value.id)) fail("invalid-journal", "The recording journal identity is invalid.");
  if (!["recording", "finalizing", "complete", "failed"].includes(value.status)) fail("invalid-journal", "The recording journal status is invalid.");
  return {
    type: value.type, schemaVersion: 1, id: value.id,
    createdAt: timestamp(value.createdAt, "Recording creation time"), updatedAt: timestamp(value.updatedAt, "Recording checkpoint time"), status: value.status,
    source: text(value.source, "Recording source"), output: text(value.output, "Recording output"), cursorOutput: text(value.cursorOutput, "Cursor output"), activityOutput: text(value.activityOutput, "Activity output"),
    fps: finite(value.fps, 1, 240, "Recording frame rate", true), width: finite(value.width, 1, 32768, "Recording width", true), height: finite(value.height, 1, 32768, "Recording height", true),
    duration: finite(value.duration, 0, 86400, "Recording checkpoint duration"),
    cursorPrefixBytes: finite(value.cursorPrefixBytes, 1, Number.MAX_SAFE_INTEGER, "Committed cursor prefix", true), activityPrefixBytes: finite(value.activityPrefixBytes, 1, Number.MAX_SAFE_INTEGER, "Committed activity prefix", true),
    ...(value.cameraPath == null ? {} : { cameraPath: text(value.cameraPath, "Camera output") }),
    ...(value.microphonePath == null ? {} : { microphonePath: text(value.microphonePath, "Microphone output") }),
    ...(value.cameraStartTime == null ? {} : { cameraStartTime: finite(value.cameraStartTime, 0, 86400, "First camera frame time") }),
    ...(value.error == null ? {} : { error: text(value.error, "Recording error", 16384) }),
  };
}

async function regularHandle(file) {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail("invalid-file", "Recording recovery requires regular local files.");
    return { handle, stat };
  } catch (error) { await handle.close(); throw error; }
}
async function readBounded(file, maximum) {
  const { handle, stat } = await regularHandle(file);
  try {
    if (stat.size > maximum) fail("capacity", "The recording metadata exceeds its supported size.");
    const buffer = Buffer.alloc(stat.size); let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!result.bytesRead) fail("changed-source", "Recording metadata changed while it was being read.");
      offset += result.bytesRead;
    }
    if (!unchanged(stat, await handle.stat())) fail("changed-source", "Recording metadata changed while it was being read.");
    return { buffer, stat };
  } finally { await handle.close(); }
}
const decodeJSON = buffer => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));

/** Native checkpoints end immediately before the array's closing bracket. */
async function readCommittedPrefix(file, bytes) {
  finite(bytes, 1, MAX_PREFIX_BYTES, "Committed metadata prefix", true);
  const { handle, stat } = await regularHandle(file);
  try {
    if (bytes > stat.size) fail("invalid-prefix", "The committed metadata prefix exceeds the remaining file bytes.");
    const buffer = Buffer.alloc(bytes + 1); let offset = 0;
    while (offset < bytes) {
      const result = await handle.read(buffer, offset, bytes - offset, offset);
      if (!result.bytesRead) fail("invalid-prefix", "The committed metadata prefix is incomplete.");
      offset += result.bytesRead;
    }
    buffer[bytes] = 93;
    const result = decodeJSON(buffer);
    if (!Array.isArray(result) || result.length > 2_000_000) fail("invalid-prefix", "The committed metadata has invalid samples.");
    return result;
  } finally { await handle.close(); }
}

async function localPath(directory, value) {
  if (!path.isAbsolute(value)) fail("unowned-journal", "A recording path is not absolute.");
  const parent = await fs.realpath(path.dirname(value));
  if (parent !== directory || [".", "..", OWNER_FILE].includes(path.basename(value))) fail("unowned-journal", "A recording path is outside its owned directory.");
  return path.join(directory, path.basename(value));
}

/** One operation owns its processes, copies and cleanup until transfer succeeds. */
class RecordingRecovery {
  constructor({ root, ffmpeg, ffprobe, grants, currentDirectory = () => null, helper, spawnProcess = spawn, unlink = file => fs.unlink(file) }) {
    Object.assign(this, { root, ffmpeg, ffprobe, grants, currentDirectory, helper, spawnProcess, unlink });
    this.session = null; this.disposed = false; this.candidates = new Map();
  }
  get active() { return this.session !== null; }
  async rootPath() {
    try {
      const real = await fs.realpath(this.root), stat = await fs.lstat(real);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("invalid-root", "The recording recovery folder is invalid.");
      return real;
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  async currentPath() {
    const value = await this.currentDirectory();
    if (value == null) return null;
    if (typeof value !== "string" || !path.isAbsolute(value)) fail("invalid-active-recording", "The active recording directory is unknown; recovery is unavailable.");
    return fs.realpath(value).catch(error => { if (error.code === "ENOENT") return path.resolve(value); throw error; });
  }
  async inspect(directory, journalPath) {
    const dirStat = await fs.lstat(directory);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) fail("unowned-journal", "The recording directory was replaced.");
    const { buffer: journalBytes } = await readBounded(journalPath, MAX_JOURNAL_BYTES);
    const journal = parseJournal(decodeJSON(journalBytes));
    if (journal.status === "complete") return null;
    let ownerBytes;
    try { ({ buffer: ownerBytes } = await readBounded(path.join(directory, OWNER_FILE), MAX_JOURNAL_BYTES)); }
    catch (error) { fail("unowned-journal", `The interrupted recording has no readable ownership marker: ${error.message}`); }
    const owner = decodeJSON(ownerBytes);
    if (!owner || owner.type !== "reva-recording-owner" || owner.version !== 1 || !UUID.test(owner.id) || !sameIdentity(owner.directory ?? {}, identity(dirStat))) fail("unowned-journal", "The recording ownership marker does not match this directory.");
    timestamp(owner.createdAt, "Ownership creation time");
    if (owner.source !== journal.source) fail("unowned-journal", "The recording ownership marker has a different source.");
    const paths = {};
    for (const key of ["output", "cursorOutput", "activityOutput"]) {
      paths[key] = await localPath(directory, journal[key]);
      if (typeof owner[key] !== "string" || await localPath(directory, owner[key]) !== paths[key]) fail("unowned-journal", "The recording paths do not match the ownership marker.");
    }
    for (const key of ["cameraPath", "microphonePath"]) if (journal[key]) paths[key] = await localPath(directory, journal[key]);
    if (new Set(Object.values(paths)).size !== Object.values(paths).length) fail("invalid-journal", "Recording outputs share the same path.");
    const expectedJournal = paths.output.replace(/\.[^.]+$/, "") + ".recovery.json";
    if (expectedJournal !== journalPath) fail("unowned-journal", "The journal is not adjacent to its recording output.");
    return { directory, identity: identity(dirStat), journalPath, journal, journalBytes, owner, ownerBytes, paths };
  }
  async receipt(directory) {
    const dirStat = await fs.lstat(directory);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) fail("invalid-receipt", "The previous recovery folder was replaced; it was preserved.");
    const { buffer } = await readBounded(path.join(directory, RECEIPT_FILE), MAX_JOURNAL_BYTES), receipt = decodeJSON(buffer);
    if (!receipt || receipt.type !== "reva-recovery-receipt" || receipt.version !== 1 || !UUID.test(receipt.id) || !UUID.test(receipt.ownerId) || !UUID.test(receipt.journalId) || !/^[a-f0-9]{64}$/.test(receipt.journalSHA256) || !sameIdentity(identity(dirStat), receipt.directory ?? {})) fail("invalid-receipt", "The recovery receipt does not match its owned directory.");
    timestamp(receipt.createdAt, "Recovery time");
    const output = path.join(directory, "screen.mp4"), reportPath = path.join(directory, "recovery-report.json");
    if (!sameFileFact(await fs.lstat(output), receipt.output)) fail("invalid-receipt", "The previously recovered screen changed; its receipt is no longer current.");
    const reportFile = await readBounded(reportPath, MAX_REPORT_BYTES);
    if (!sameFileFact(reportFile.stat, receipt.report) || sha256(reportFile.buffer) !== receipt.reportSHA256) fail("invalid-receipt", "The previous recovery report changed; its receipt is no longer current.");
    const report = decodeJSON(reportFile.buffer);
    if (report.type !== "reva-recording-recovery-report" || report.schemaVersion !== 1 || report.recoverySource?.ownerId !== receipt.ownerId || report.recoverySource?.journalId !== receipt.journalId || report.sourceFiles?.journal?.sha256 !== receipt.journalSHA256 || report.result?.path !== output || !Number.isFinite(report.result?.duration) || report.result.duration <= 0) fail("invalid-receipt", "The recovery receipt and report describe different recordings.");
    return { key: `${receipt.ownerId}:${receipt.journalSHA256}`, path: output, createdAt: receipt.createdAt };
  }
  async list() {
    if (this.disposed) fail("closed", "Recording recovery is closed.");
    const recordings = [], issues = [], candidates = new Map(), receipts = new Map(), ambiguous = new Set(), root = await this.rootPath();
    if (!root) { this.candidates = candidates; return { recordings, issues }; }
    const current = await this.currentPath(), entries = await fs.opendir(root); let count = 0;
    for await (const entry of entries) {
      if (++count > 10000) { issues.push(issue("capacity", "Only the first 10,000 recording folder entries were examined.", root)); break; }
      const directory = path.join(root, entry.name);
      if (entry.name.startsWith("Recovered-")) {
        if (directory === this.session?.directory) continue;
        try {
          const receipt = await this.receipt(directory), previous = receipts.get(receipt.key);
          if (!previous || Date.parse(receipt.createdAt) > Date.parse(previous.createdAt)) receipts.set(receipt.key, receipt);
        } catch (error) { issues.push(issue("recovery-receipt-unavailable", `A previous recovery cannot be confirmed: ${error.message}`, directory)); }
        continue;
      }
      if (!entry.name.startsWith("Recording-")) continue;
      if (directory === current) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) { issues.push(issue("unowned-directory", "A recording folder is not a regular owned directory; it was preserved.", directory)); continue; }
      try {
        const files = await fs.opendir(directory); let found = [], examined = 0, completeCoverage = true;
        for await (const file of files) {
          if (++examined > 1000) { completeCoverage = false; issues.push(issue("capacity", "This recording folder has too many entries to inspect completely.", directory)); break; }
          if (file.name.endsWith(".recovery.json")) found.push(path.join(directory, file.name));
        }
        if (!completeCoverage) continue;
        const unfinished = [];
        for (const journalPath of found) {
          try { const candidate = await this.inspect(directory, journalPath); if (candidate) unfinished.push(candidate); }
          catch (error) { issues.push(issue(error.code ?? "invalid-journal", error.message, journalPath)); }
          if (unfinished.length > 1) break;
        }
        if (unfinished.length > 1) { issues.push(issue("ambiguous-journal", "This owned recording contains multiple unfinished journals; select the original files for manual recovery.", directory)); continue; }
        for (const candidate of unfinished) {
          if (candidates.has(candidate.owner.id) || ambiguous.has(candidate.owner.id)) { ambiguous.add(candidate.owner.id); issues.push(issue("ambiguous-owner", "A recording ownership identity occurs in more than one directory.", directory)); candidates.delete(candidate.owner.id); const index = recordings.findIndex(value => value.id === candidate.owner.id); if (index >= 0) recordings.splice(index, 1); continue; }
          const { journal, owner } = candidate;
          candidates.set(owner.id, { directory, journalPath: candidate.journalPath, identity: candidate.identity, journalSHA256: sha256(candidate.journalBytes), owner: { id: owner.id } });
          recordings.push({ id: owner.id, journalId: journal.id, name: `Interrupted recording — ${new Date(journal.createdAt).toLocaleString()}`, directory, journalPath: candidate.journalPath, source: journal.source, createdAt: journal.createdAt, updatedAt: journal.updatedAt, status: journal.status, checkpointDuration: journal.duration, width: journal.width, height: journal.height, hasCamera: Boolean(journal.cameraPath), hasMicrophone: Boolean(journal.microphonePath), ...(journal.error ? { error: journal.error } : {}) });
        }
      } catch (error) { issues.push(issue(error.code ?? "unreadable-directory", error.message, directory)); }
    }
    for (const recording of recordings) {
      const previous = receipts.get(`${recording.id}:${candidates.get(recording.id).journalSHA256}`);
      if (previous) recording.recoveredPath = previous.path;
    }
    recordings.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)); this.candidates = candidates;
    return { recordings, issues };
  }
  recover(id) {
    if (this.disposed) fail("closed", "Recording recovery is closed.");
    if (this.active) fail("busy", "A recording recovery or its cleanup is already running.");
    if (typeof id !== "string" || !UUID.test(id) || !this.candidates.has(id)) fail("not-listed", "Choose an interrupted recording from the current recovery list.");
    const candidate = this.candidates.get(id), session = { cancelled: false, directory: null, resources: [], child: null, exited: true, killTimer: null };
    this.session = session;
    session.done = this.run(session, candidate);
    return session.done;
  }
  check(session) { if (session.cancelled) fail("cancelled", "Recording recovery was cancelled."); }
  async ownDirectory(session, directory) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("changed-output", "A recovery output folder was replaced.");
    const resource = { path: directory, identity: identity(stat), directory: true }; session.resources.push(resource); return directory;
  }
  async createFile(session, file) {
    this.check(session);
    const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    session.resources.push({ path: file, identity: identity(await handle.stat()), directory: false }); return handle;
  }
  async writeFile(session, file, data) {
    const handle = await this.createFile(session, file);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    this.check(session);
  }
  async copySource(session, source, output, expectedBytes) {
    this.check(session);
    const { handle: input, stat } = await regularHandle(source); let dest;
    try {
      dest = await this.createFile(session, output);
      const hash = crypto.createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024); let bytes = 0;
      while (bytes < stat.size) {
        this.check(session);
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, stat.size - bytes), bytes);
        if (!bytesRead) fail("changed-source", "An interrupted recording changed while it was being copied.");
        const chunk = buffer.subarray(0, bytesRead); hash.update(chunk);
        let written = 0;
        while (written < bytesRead) { this.check(session); const result = await dest.write(chunk, written, bytesRead - written); if (!result.bytesWritten) fail("copy-failed", "The recovered source copy could not be completed."); written += result.bytesWritten; }
        bytes += bytesRead;
      }
      if (!unchanged(stat, await input.stat()) || !unchanged(stat, await fs.lstat(source))) fail("changed-source", "An interrupted recording changed while it was being copied.");
      const sha256 = hash.digest("hex");
      if (expectedBytes && sha256 !== crypto.createHash("sha256").update(expectedBytes).digest("hex")) fail("changed-source", "The recording journal or ownership marker changed after inspection.");
      await dest.sync();
      return { path: source, copyPath: output, sha256, bytes, identity: identity(stat), mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
    } finally { await input.close(); if (dest) await dest.close(); }
  }
  terminate(session) {
    if (session.child && !session.exited) {
      session.child.kill("SIGTERM");
      session.killTimer ??= setTimeout(() => { if (!session.exited) session.child.kill("SIGKILL"); }, 1000);
    }
  }
  async process(session, command, args, timeout = 120000) {
    this.check(session);
    return new Promise((resolve, reject) => {
      let child;
      try { child = this.spawnProcess(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); }
      catch (error) { reject(error); return; }
      session.child = child; session.exited = false; let stdout = "", stderr = "", failure;
      const timer = setTimeout(() => { failure = new RecoveryFailure("process-timeout", "The local recovery tool timed out."); child.kill("SIGKILL"); }, timeout);
      child.stdout.on("data", chunk => { if (Buffer.byteLength(stdout) + chunk.length > 1024 * 1024) { failure = new RecoveryFailure("process-capacity", "The local recovery tool returned too much metadata."); child.kill("SIGKILL"); } else stdout += chunk.toString("utf8"); });
      child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-16384); });
      child.once("error", error => { failure = error; });
      child.once("close", code => {
        clearTimeout(timer); clearTimeout(session.killTimer); session.killTimer = null; session.exited = true; session.child = null;
        if (session.cancelled) reject(new RecoveryFailure("cancelled", "Recording recovery was cancelled."));
        else if (failure) reject(failure);
        else if (code !== 0) reject(new RecoveryFailure("media-tool-failed", stderr.trim() || `The local recovery tool exited with code ${code}.`));
        else resolve(stdout);
      });
      if (session.cancelled) this.terminate(session);
    });
  }
  async probe(session, file, kind) {
    const parsed = JSON.parse(await this.process(session, this.ffprobe, ["-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", MEDIA_FORMATS, "-show_entries", "format=duration,start_time:stream=index,codec_type,width,height,start_time,duration,time_base", "-of", "json", file], 30000));
    if (!Array.isArray(parsed.streams) || parsed.streams.length > 32) fail("invalid-media", "The interrupted media has invalid streams.");
    const streams = parsed.streams.map(stream => ({ type: stream.codec_type, width: Number(stream.width || 0), height: Number(stream.height || 0), start: Number.isFinite(Number(stream.start_time)) ? Number(stream.start_time) : null, duration: Number.isFinite(Number(stream.duration)) ? Number(stream.duration) : null, timeBase: stream.time_base ?? null }));
    const wanted = streams.find(stream => stream.type === kind), formatDuration = Number(parsed.format?.duration);
    // Finalized MP4s with a leading empty edit can expose only their media
    // segment's length as ffprobe format.duration. Their stream end retains
    // the source clock. Raw fragmented headers are recorded separately and
    // are never used as the recovered project's duration.
    const duration = Math.max(formatDuration, ...streams.map(stream => stream.start !== null && stream.duration !== null ? stream.start + stream.duration : 0));
    if (!wanted || !Number.isFinite(duration) || duration <= 0 || duration > 86400 || (kind === "video" && (!Number.isInteger(wanted.width) || !Number.isInteger(wanted.height) || wanted.width < 1 || wanted.height < 1 || wanted.width > 32768 || wanted.height > 32768))) fail("invalid-media", `The interrupted ${kind} has no usable completed fragments.`);
    return { duration, formatDuration, width: wanted.width, height: wanted.height, streams };
  }
  async toolOutput(session, file, run) {
    // The child is the sole producer in this new mode-0700 owned directory.
    // Register its file immediately on close, including nonzero exits.
    let failure, mayOwn = false;
    try { await fs.lstat(file).then(() => fail("existing-output", "The recovery output already exists."), error => { if (error.code !== "ENOENT") throw error; }); mayOwn = true; await run(); }
    catch (error) { failure = error; }
    finally {
      const stat = await fs.lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (stat && mayOwn) {
        if (!stat.isFile() || stat.isSymbolicLink()) fail("changed-output", "A recovery output file was replaced; it was preserved.");
        session.resources.push({ path: file, identity: identity(stat), directory: false });
      }
    }
    if (failure) throw failure; this.check(session);
  }
  async remux(session, source, output) {
    await this.toolOutput(session, output, () => this.process(session, this.ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-n", "-copyts", "-protocol_whitelist", "file,pipe", "-format_whitelist", MEDIA_FORMATS, "-i", source, "-map", "0:v?", "-map", "0:a?", "-c", "copy", "-avoid_negative_ts", "disabled", "-use_editlist", "1", "-movie_timescale", "600000", "-movflags", "+faststart", output], 600000));
  }
  async cleanup(session) {
    if (session.child && !session.exited) fail("cleanup-pending", "Recovery output cannot be removed before its media tool exits.");
    const failures = [];
    for (let index = session.resources.length - 1; index >= 0; index--) {
      const resource = session.resources[index];
      try {
        const stat = await fs.lstat(resource.path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
        if (stat) {
          if (!sameIdentity(identity(stat), resource.identity) || stat.isSymbolicLink() || (resource.directory ? !stat.isDirectory() : !stat.isFile())) fail("changed-output", "An owned recovery output was replaced; it was preserved.");
          if (resource.directory) await fs.rmdir(resource.path); else await this.unlink(resource.path);
        }
        session.resources.splice(index, 1);
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Recovery cleanup is incomplete; its owned resources are retained for retry.");
    session.directory = null;
  }
  async run(session, selected) {
    let result, failure;
    try {
      if (await this.currentPath() === selected.directory) fail("active-recording", "The recording is still active and cannot be recovered.");
      const current = await this.inspect(selected.directory, selected.journalPath);
      if (!current || current.owner.id !== selected.owner.id || !sameIdentity(current.identity, selected.identity)) fail("changed-source", "The interrupted recording changed after selection. Refresh the recovery list.");
      this.check(session);
      const root = await this.rootPath();
      if (!root || path.dirname(current.directory) !== root) fail("changed-source", "The recording recovery root changed after selection.");
      session.directory = await fs.mkdtemp(path.join(root, "Recovered-")); await this.ownDirectory(session, session.directory);
      const rawDirectory = path.join(session.directory, "Source"); await fs.mkdir(rawDirectory, { mode: 0o700 }); await this.ownDirectory(session, rawDirectory);
      const raw = {}, issues = [], journal = current.journal;
      for (const [kind, source, bytes] of [["owner", path.join(current.directory, OWNER_FILE), current.ownerBytes], ["journal", current.journalPath, current.journalBytes], ...Object.entries(current.paths).map(([kind, source]) => [kind, source, undefined])]) {
        try { raw[kind] = await this.copySource(session, source, path.join(rawDirectory, path.basename(source)), bytes); }
        catch (error) { if (session.cancelled || ["owner", "journal", "output"].includes(kind)) throw error; issues.push(issue(`${kind}-source-unavailable`, `The original ${kind} could not be preserved: ${error.message}`, source)); }
      }
      this.check(session);
      const screenPath = path.join(session.directory, "screen.mp4"), sourceProbe = await this.probe(session, raw.output.copyPath, "video");
      await this.remux(session, raw.output.copyPath, screenPath);
      const screen = await this.probe(session, screenPath, "video"), duration = screen.duration;
      if (Math.abs(duration - journal.duration) > 1 / journal.fps) issues.push(issue("incomplete-media", `The last checkpoint was ${journal.duration.toFixed(3)} s; completed media ends at ${duration.toFixed(3)} s. Unwritten fragments cannot be restored.`, current.paths.output));
      if (screen.width !== journal.width || screen.height !== journal.height) issues.push(issue("dimension-checkpoint-mismatch", "Recovered frame dimensions differ from the checkpoint; the media dimensions are used.", current.journalPath));
      const recovered = { path: screenPath, name: `Recovered recording — ${new Date(journal.createdAt).toLocaleString()}`, duration, width: screen.width, height: screen.height, cursor: [], pauseMarkers: [], typingRanges: [] }, probes = { originalScreen: sourceProbe, screen };
      if (raw.microphonePath) {
        try {
          const output = path.join(session.directory, "microphone.m4a"); await this.remux(session, raw.microphonePath.copyPath, output); probes.microphone = await this.probe(session, output, "audio"); recovered.microphonePath = output;
          if (probes.microphone.duration + 1 / journal.fps < duration) issues.push(issue("microphone-shorter", "The microphone has fewer completed fragments than the screen; its original clock is retained.", current.paths.microphonePath));
        } catch (error) { if (session.cancelled) throw error; issues.push(issue("microphone-unavailable", `The microphone could not be finalized: ${error.message}`, current.paths.microphonePath)); }
      }
      if (raw.cameraPath) {
        try {
          if (!this.helper || journal.cameraStartTime === undefined) fail("camera-clock-unavailable", "Camera recovery requires the native helper and its committed first-frame time; its original bytes remain available.");
          const output = path.join(session.directory, "camera.mp4");
          let protocol;
          await this.toolOutput(session, output, async () => { protocol = await this.process(session, this.helper, ["recover-camera", "--input", raw.cameraPath.copyPath, "--output", output, "--start-time", String(journal.cameraStartTime)], 600000); });
          const messages = protocol.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)), completed = messages.filter(message => message?.type === "completed");
          if (completed.length !== 1 || completed[0].output !== output || completed[0].sourceSHA256 !== raw.cameraPath.sha256 || completed[0].startTime !== journal.cameraStartTime || !Number.isFinite(completed[0].duration) || completed[0].duration <= 0 || completed[0].duration > 86400) fail("camera-protocol-invalid", "The camera helper did not confirm its exact source, destination and shared clock.");
          probes.camera = await this.probe(session, output, "video");
          const first = probes.camera.streams.find(stream => stream.type === "video").start;
          const trackDuration = probes.camera.streams.find(stream => stream.type === "video").duration;
          // ffprobe's format duration omits this valid leading empty edit.
          // The native reader verifies the movie duration; independently check
          // that it includes the demuxed stream's original start and duration.
          if (first === null || trackDuration === null || Math.abs(first - journal.cameraStartTime) > 1 / 600 + 1e-6 || Math.abs(completed[0].duration - (first + trackDuration)) > 1 / 600 + 1e-6) fail("camera-clock-invalid", "The finalized camera did not retain its committed source clock and complete leading empty edit.");
          probes.camera.duration = completed[0].duration;
          recovered.cameraPath = output; recovered.cameraStartTime = journal.cameraStartTime; recovered.cameraEndTime = completed[0].duration; recovered.cameraSource = { width: probes.camera.width, height: probes.camera.height };
        } catch (error) { if (session.cancelled) throw error; issues.push(issue("camera-unavailable", `The camera could not be finalized: ${error.message}`, current.paths.cameraPath)); }
      }
      if (raw.cursorOutput) {
        try {
          const entries = await readCommittedPrefix(raw.cursorOutput.copyPath, journal.cursorPrefixBytes);
          const { validateCursor } = require("./core.cjs");
          if (typeof validateCursor !== "function") fail("cursor-parser-unavailable", "The canonical cursor parser is unavailable.");
          const parsed = validateCursor(entries, journal.duration), usable = parsed.filter(entry => entry.t <= duration);
          if (usable.length !== parsed.length) issues.push(issue("cursor-truncated", `${parsed.length - usable.length} committed cursor samples lie after the recovered media and remain in the source copy.`, current.paths.cursorOutput));
          recovered.cursor = usable;
        } catch (error) { issues.push(issue("cursor-unavailable", `Committed cursor data could not be restored: ${error.message}`, current.paths.cursorOutput)); }
      }
      if (raw.activityOutput) {
        try {
          const entries = await readCommittedPrefix(raw.activityOutput.copyPath, journal.activityPrefixBytes);
          parseRecordingActivity(entries, journal.duration, journal.duration, journal.fps);
          const usable = entries.filter(entry => entry.time <= duration + 1 / journal.fps);
          if (usable.length !== entries.length) issues.push(issue("activity-truncated", `${entries.length - usable.length} committed activity markers lie after the recovered media and remain in the source copy.`, current.paths.activityOutput));
          Object.assign(recovered, parseRecordingActivity(usable, journal.duration, duration, journal.fps));
        } catch (error) { issues.push(issue("activity-unavailable", `Committed recording activity could not be restored: ${error.message}`, current.paths.activityOutput)); }
      }
      this.check(session);
      // Recheck the original directory and marker immediately before transfer.
      const finalOwner = await this.inspect(current.directory, current.journalPath);
      if (!finalOwner || !sameIdentity(finalOwner.identity, current.identity) || !finalOwner.ownerBytes.equals(current.ownerBytes) || !finalOwner.journalBytes.equals(current.journalBytes) || await this.currentPath() === current.directory) fail("changed-source", "The interrupted recording changed or became active during recovery.");
      for (const fact of Object.values(raw)) {
        const stat = await fs.lstat(fact.path);
        if (!stat.isFile() || stat.isSymbolicLink() || !sameIdentity(identity(stat), fact.identity) || stat.size !== fact.bytes || stat.mtimeMs !== fact.mtimeMs || stat.ctimeMs !== fact.ctimeMs) fail("changed-source", "An interrupted recording source changed during recovery; refresh the recovery list.");
      }
      const reportPath = path.join(session.directory, "recovery-report.json");
      const recoverySource = { directory: current.directory, journalPath: current.journalPath, journalId: journal.id, ownerId: current.owner.id, reportPath, rawDirectory, checkpointDuration: journal.duration };
      result = { ...recovered, issues, recoverySource };
      const { cursor, pauseMarkers, typingRanges, recordingFlags, shortcuts, ...resultSummary } = result;
      const reportBytes = Buffer.from(JSON.stringify({ type: "reva-recording-recovery-report", schemaVersion: 1, recoveredAt: new Date().toISOString(), recoverySource, journal, sourceFiles: raw, probes, result: { ...resultSummary, metadataCounts: { cursor: cursor.length, pauseMarkers: pauseMarkers.length, typingRanges: typingRanges.length, recordingFlags: recordingFlags?.length ?? 0, shortcuts: shortcuts?.length ?? 0 } } }, null, 2));
      if (reportBytes.length > MAX_REPORT_BYTES) fail("report-capacity", "The recovery report exceeds its supported size.");
      // The digest is returned to project provenance after serialization so
      // the report never embeds a digest of itself.
      recoverySource.reportSHA256 = sha256(reportBytes);
      await this.writeFile(session, reportPath, reportBytes);
      for (const file of [result.path, result.microphonePath, result.cameraPath, reportPath].filter(Boolean)) { await this.grants.grant(file); this.check(session); }
      const receipt = { type: "reva-recovery-receipt", version: 1, id: crypto.randomUUID(), ownerId: current.owner.id, journalId: journal.id, journalSHA256: raw.journal.sha256, createdAt: new Date().toISOString(), directory: identity(await fs.lstat(session.directory)), output: fileFact(await fs.lstat(result.path)), report: fileFact(await fs.lstat(reportPath)), reportSHA256: sha256(reportBytes) };
      await this.writeFile(session, path.join(session.directory, RECEIPT_FILE), JSON.stringify(receipt));
    } catch (error) { failure = error; }
    if (failure || session.cancelled) {
      try { await this.cleanup(session); }
      catch (cleanup) { failure = new AggregateError([...(failure ? [failure] : []), cleanup], "Recording recovery did not complete and cleanup needs retry."); }
      if (!session.resources.length) this.session = null;
      if (failure && (!session.cancelled || session.resources.length)) throw failure;
      return null;
    }
    session.resources = []; session.directory = null; this.session = null;
    return result;
  }
  async cancel() {
    const session = this.session; if (!session) return;
    session.cancelled = true; this.terminate(session);
    let failure;
    try { await session.done; } catch (error) { failure = error; }
    if (session.resources.length) { await this.cleanup(session); this.session = null; }
    if (this.session === session) this.session = null;
    // A successful cleanup retry completes cancellation even if the first attempt failed.
    if (session.resources.length && failure) throw failure;
  }
  async dispose() { this.disposed = true; await this.cancel(); }
}

module.exports = { RecordingRecovery, RecoveryFailure, parseJournal, readCommittedPrefix, MAX_PREFIX_BYTES, OWNER_FILE, RECEIPT_FILE };
