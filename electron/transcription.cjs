"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { object, string, number, choice, boolean } = require("./core.cjs");
const { runProcess } = require("./media.cjs");
const { parseTranscript, importSRT, importTranscriptJSON } = require("../shared/transcript.mjs");
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const MAX_PROTOCOL_BYTES = 65536;

function parseSpeechOptions(input) {
  const o = object(input, "Speech options");
  const locale = string(o.locale, 128, "Speech locale");
  if (!locale || !/^[A-Za-z0-9_-]+$/.test(locale)) throw new Error("Choose a supported speech language.");
  const contextualStrings = o.contextualStrings ?? [];
  if (!Array.isArray(contextualStrings) || contextualStrings.length > 100) throw new Error("Speech key terms are invalid.");
  return { locale, track: choice(o.track, ["microphone", "system"], "Speech audio track"), offset: number(o.offset ?? 0, 0, 604800, "Speech source offset"),
    contextualStrings: contextualStrings.map(v => {
      const value = string(v, 1024, "Speech key term");
      if (!value.trim()) throw new Error("Speech key terms cannot be empty.");
      return value;
    }) };
}

function parseSpeechStatus(input) {
  const v = object(input, "Speech status");
  if (!Array.isArray(v.locales) || v.locales.length > 1000) throw new Error("Speech locale list is invalid.");
  return { available: boolean(v.available, "Speech availability"), method: choice(v.method, ["apple-on-device"], "Speech method"),
    permission: choice(v.permission, ["granted", "denied", "restricted", "not-determined", "unknown"], "Speech permission"),
    locale: string(v.locale, 128, "Speech locale"), locales: [...new Set(v.locales.map(v => string(v, 128, "Speech locale")))],
    reason: v.reason == null ? null : string(v.reason, 4096, "Speech availability reason"), engine: string(v.engine, 256, "Speech engine") };
}

async function readBounded(handle, maximum) {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.size > maximum) throw new Error("The transcript file is invalid or too large.");
  const chunks = []; let size = 0;
  while (true) {
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, maximum - size + 1));
    const { bytesRead } = await handle.read(buffer);
    if (!bytesRead) break;
    size += bytesRead;
    if (size > maximum) throw new Error("The transcript file exceeds its size bound.");
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function importTranscriptFile(file, duration, grants) {
  number(duration, 0, 604800, "Recording duration");
  const { handle } = await grants.open(file);
  try {
    const content = await readBounded(handle, MAX_TRANSCRIPT_BYTES);
    return path.extname(file).toLowerCase() === ".srt" ? importSRT(content, duration) : importTranscriptJSON(content, duration);
  } finally { await handle.close(); }
}

/** One local-only speech process, retained through exit and retryable final cleanup. */
class SpeechTranscriber {
  constructor({ helper, cacheRoot, grants, onProgress = () => {}, idleTimeout = 180000, spawnProcess = spawn }) {
    Object.assign(this, { helper, cacheRoot, grants, onProgress, idleTimeout, spawnProcess });
    this.session = null;
  }
  get active() { return this.session !== null; }
  async status(locale) {
    const options = parseSpeechOptions({ locale, track: "microphone", offset: 0 });
    return parseSpeechStatus(JSON.parse(await runProcess(this.helper, ["speech-status", "--locale", options.locale], { timeout: 15000, maxBytes: 256 * 1024 })));
  }
  transcribe(file, input) {
    if (this.active) throw new Error("Local transcription is already running.");
    const options = parseSpeechOptions(input);
    const s = { cancelled: false, child: null, exited: false, directory: null, identity: null, terminateTimer: null, killTimer: null };
    this.session = s;
    s.done = this.run(s, file, options).then(value => s.cancelled ? null : value);
    return s.done;
  }
  terminate(s) {
    if (!s.child || s.exited || s.killTimer) return;
    s.child.stdin.end("cancel\n");
    s.terminateTimer = setTimeout(() => { if (!s.exited) s.child.kill("SIGTERM"); }, 1000);
    s.killTimer = setTimeout(() => { if (!s.exited) s.child.kill("SIGKILL"); }, 5000);
  }
  async assertDirectory(s) {
    const stat = await fs.lstat(s.directory);
    if (!stat.isDirectory() || !s.identity || stat.dev !== s.identity.dev || stat.ino !== s.identity.ino)
      throw new Error("The owned speech directory was replaced; cleanup needs attention.");
  }
  async cleanup(s) {
    if (s.cleanupPromise) return s.cleanupPromise;
    const operation = (async () => {
      if (!s.directory) return;
      if (s.child && !s.exited) throw new Error("The speech helper must exit before cleanup.");
      try { await this.assertDirectory(s); } catch (error) {
        if (error.code === "ENOENT") { s.directory = null; return; }
        throw error;
      }
      await fs.rm(s.directory, { recursive: true, force: true }); s.directory = null;
    })();
    s.cleanupPromise = operation;
    try { await operation; } finally { if (s.cleanupPromise === operation) s.cleanupPromise = null; }
  }
  async run(s, file, options) {
    let runFailure;
    try {
      const source = await this.grants.assert(file);
      if (s.cancelled) return null;
      await fs.mkdir(this.cacheRoot, { recursive: true, mode: 0o700 });
      if (s.cancelled) return null;
      s.directory = await fs.mkdtemp(path.join(this.cacheRoot, "speech-"));
      s.identity = await fs.lstat(s.directory);
      if (s.cancelled) return null;
      const output = path.join(s.directory, "transcript.json");
      const args = ["transcribe-speech", "--input", source, "--output-directory", s.directory, "--locale", options.locale, "--track", options.track, "--offset", String(options.offset),
        ...options.contextualStrings.flatMap(value => ["--contextual-string", value])];
      const child = this.spawnProcess(this.helper, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      s.child = child;
      child.stdin.on("error", () => {});
      let failure, ready = false, completed = false, terminal = false, pending = "", stderr = "", timer;
      const fail = (error) => { failure ??= error; this.terminate(s); };
      const resetTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => fail(new Error("The local speech helper stopped responding.")), this.idleTimeout);
      };
      const accept = line => {
        if (failure || s.cancelled) return;
        if (Buffer.byteLength(line) > MAX_PROTOCOL_BYTES) { fail(new Error("Speech helper returned an oversized message.")); return; }
        try {
          const message = object(JSON.parse(line), "Speech event");
          if (terminal) throw new Error("Speech helper returned conflicting terminal messages.");
          if (message.type === "ready") {
            if (ready) throw new Error("Speech helper returned a duplicate ready event.");
            ready = true; number(message.duration, 0.001, 604800, "Speech audio duration");
          } else if (message.type === "progress") {
            if (!ready) throw new Error("Speech progress arrived before readiness.");
            this.onProgress(number(message.progress, 0, 1, "Speech progress"));
          } else if (message.type === "completed") {
            if (!ready || message.output !== output) throw new Error("Speech helper returned an unexpected result path or sequence.");
            completed = true; terminal = true;
          } else if (message.type === "cancelled") { terminal = true; throw new Error("Speech recognition was cancelled."); }
          else if (message.type === "error") { terminal = true; throw new Error(string(message.message, 16384, "Speech error")); }
          else throw new Error("Speech helper returned an unknown event.");
          resetTimer();
        } catch (error) { fail(error); }
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          if (line.trim()) accept(line);
        }
        if (Buffer.byteLength(pending) > MAX_PROTOCOL_BYTES) { fail(new Error("Speech helper returned an oversized message.")); pending = ""; }
      });
      child.stderr.on("data", data => { stderr = (stderr + data.toString()).slice(-16384); });
      child.once("error", error => { failure ??= error; });
      resetTimer();
      if (s.cancelled) this.terminate(s);
      const code = await new Promise(resolve => child.once("close", code => {
        s.exited = true; clearTimeout(timer); clearTimeout(s.terminateTimer); clearTimeout(s.killTimer);
        if (pending.trim()) accept(pending);
        clearTimeout(timer); resolve(code);
      }));
      if (s.cancelled) return null;
      if (failure) throw failure;
      if (code !== 0 || !completed) throw new Error(stderr.trim() || "Local speech did not produce a completed transcript.");
      await this.grants.assert(file);
      if (s.cancelled) return null;
      await this.assertDirectory(s);
      const handle = await fs.open(output, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let raw;
      try { raw = JSON.parse(await readBounded(handle, MAX_TRANSCRIPT_BYTES)); } finally { await handle.close(); }
      const document = parseTranscript(raw);
      if (document.generator !== "apple-on-device" || document.source.path !== source || document.source.offset !== options.offset || document.source.track !== options.track || document.language !== options.locale)
        throw new Error("The transcript belongs to another source or request.");
      const selected = await this.grants.open(file);
      let sha;
      try {
        const hash = crypto.createHash("sha256");
        for await (const data of selected.handle.createReadStream({ autoClose: false })) { if (s.cancelled) return null; hash.update(data); }
        sha = hash.digest("hex");
      } finally { await selected.handle.close(); }
      if (sha !== document.source.sha256) throw new Error("The audio changed during transcription. Generate the transcript again.");
      return s.cancelled ? null : { ...document, source: { ...document.source, path: file } };
    } catch (error) { runFailure = error; throw error; }
    finally {
      try { await this.cleanup(s); } catch (error) {
        if (runFailure) throw new AggregateError([runFailure, error], `${runFailure.message} Cleanup: ${error.message}`);
        throw error;
      }
      if (this.session === s) this.session = null;
    }
  }
  async cancel() {
    const s = this.session; if (!s) return;
    s.cancelled = true; this.terminate(s);
    try { await s.done; } catch (error) {
      if (this.session === s && s.directory && (!s.child || s.exited)) {
        await this.cleanup(s); if (this.session === s) this.session = null;
      } else if (this.session === s) throw error;
    }
  }
  async dispose() { await this.cancel(); }
}

module.exports = { SpeechTranscriber, parseSpeechStatus, parseSpeechOptions, importTranscriptFile, MAX_TRANSCRIPT_BYTES };
