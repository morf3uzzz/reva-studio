"use strict";
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const { object, number, string, MAX_PROJECT_BYTES } = require("./core.cjs");

/** Shared owner for one bounded local helper lifecycle and its exact resources. */
class LocalVideoJob {
  constructor({ helper, cacheRoot, grants, onProgress = () => {}, idleTimeout = 120000, label = "Local video processing" }) {
    Object.assign(this, { helper, cacheRoot, grants, onProgress, idleTimeout, label });
    this.session = null;
  }
  get active() { return this.session !== null; }

  terminate(s) {
    if (!s.child || s.exited || s.killTimer) return;
    // Buffer cancellation even while the helper is still starting. Escalation
    // targets the ChildProcess we own, never a separately looked-up PID.
    s.child.stdin.end("cancel\n");
    s.terminateTimer = setTimeout(() => {
      if (!s.exited) s.child.kill("SIGTERM");
    }, 1000);
    s.killTimer = setTimeout(() => {
      if (!s.exited) s.child.kill("SIGKILL");
    }, 5000);
  }

  async assertDirectory(s) {
    const stat = await fs.lstat(s.directory);
    if (!s.directoryIdentity || !stat.isDirectory() || stat.dev !== s.directoryIdentity.dev || stat.ino !== s.directoryIdentity.ino)
      throw new Error(`The owned ${this.label} directory was replaced; cleanup needs attention.`);
  }

  async cleanup(s) {
    if (s.cleanupPromise) return s.cleanupPromise;
    const cleanup = this.removeDirectory(s);
    s.cleanupPromise = cleanup;
    try { await cleanup; } finally {
      if (s.cleanupPromise === cleanup) s.cleanupPromise = null;
    }
  }

  async removeDirectory(s) {
    const closeErrors = [];
    for (const handle of s.handles) {
      try { await handle.close(); s.handles.delete(handle); } catch (error) { closeErrors.push(error); }
    }
    if (closeErrors.length) throw new AggregateError(closeErrors, `Owned ${this.label} handles still need cleanup.`);
    if (!s.directory) return;
    if (s.child && !s.exited) throw new Error(`The ${this.label} helper must exit before cleanup.`);
    try { await this.assertDirectory(s); } catch (error) {
      if (error.code === "ENOENT") { s.directory = null; return; }
      throw error;
    }
    await fs.rm(s.directory, { recursive: true, force: true });
    s.directory = null;
  }

  async readResult(s, output) {
    await this.assertDirectory(s);
    const handle = await fs.open(output, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    s.handles.add(handle);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_PROJECT_BYTES)
        throw new Error(`${this.label} analysis result is invalid or too large.`);
      const chunks = [];
      let size = 0;
      while (!s.cancelled) {
        // Include one extra byte to detect growth after fstat without reading an
        // unbounded file or following a replacement symlink.
        const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, MAX_PROJECT_BYTES - size + 1));
        const { bytesRead } = await handle.read(buffer);
        if (!bytesRead) return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
        size += bytesRead;
        if (size > MAX_PROJECT_BYTES) throw new Error(`${this.label} analysis result is too large.`);
        chunks.push(buffer.subarray(0, bytesRead));
      }
      return null;
    } finally { await handle.close(); s.handles.delete(handle); }
  }

  async verifySource(s, original, source, expectedHash) {
    if ((await this.grants.assert(original)) !== source) throw new Error(`${this.label} source changed.`);
    const handle = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    s.handles.add(handle);
    try {
      const before = await handle.stat(), hash = crypto.createHash("sha256");
      const stamp = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");
      if (!before.isFile()) throw new Error(`${this.label} analysis source is not a regular file.`);
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      while (!s.cancelled && position < before.size) {
        const {bytesRead} = await handle.read(buffer, 0, Math.min(buffer.length, before.size-position), position);
        if (!bytesRead) throw new Error(`${this.label} analysis source changed during verification.`);
        hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
      }
      if (s.cancelled) return;
      const after = await handle.stat(), current = await fs.lstat(source);
      if (!current.isFile() || stamp(before) !== stamp(after) || stamp(before) !== stamp(current) || hash.digest("hex") !== expectedHash)
        throw new Error(`${this.label} analysis does not match the current source SHA256.`);
      if ((await this.grants.assert(original)) !== source) throw new Error(`${this.label} source changed.`);
    } finally { await handle.close(); s.handles.delete(handle); }
  }

  async runHelper(s, args, output, parseReady = () => ({})) {
      const child = spawn(this.helper, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      s.child = child;
      let pending = "", stderr = "", failure, completed, terminal, ready = false, timer, readyDetails;
      const resetTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          failure = new Error(`${this.label} analysis stopped responding.`);
          this.terminate(s);
        }, this.idleTimeout);
      };
      const accept = (line) => {
        if (!line.trim() || failure || s.cancelled) return;
        try {
          const m = object(JSON.parse(line), `${this.label} progress`);
          if (terminal) throw new Error(`${this.label} helper sent a message after its terminal result.`);
          if (m.type === "ready") {
            if (ready) throw new Error(`${this.label} helper repeated its ready message.`);
            number(m.duration, 0.001, 86400, `${this.label} duration`);
            readyDetails = parseReady(m);
            ready = true;
          } else if (m.type === "progress") {
            if (!ready) throw new Error(`${this.label} progress arrived before startup.`);
            this.onProgress(number(m.progress, 0, 1, `${this.label} progress`));
          } else if (m.type === "completed") {
            if (!ready || completed || m.output !== output)
              throw new Error(`${this.label} helper reported an unexpected result.`);
            completed = m;
            terminal = "completed";
          } else if (m.type === "error") {
            throw new Error(string(m.message, 32768, `${this.label} error`));
          } else if (m.type === "cancelled") {
            terminal = "cancelled";
          } else {
            throw new Error(`${this.label} helper returned an unknown message.`);
          }
          resetTimer();
        } catch (error) { failure = error; this.terminate(s); }
      };
      child.stdin.on("error", () => {});
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (text) => {
        if (failure || s.cancelled) return;
        pending += text;
        let newline;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (Buffer.byteLength(line) > 65536) {
            failure = new Error(`${this.label} helper returned an oversized message.`);
            this.terminate(s);
            pending = "";
            return;
          }
          accept(line);
        }
        if (Buffer.byteLength(pending) > 65536) {
          failure = new Error(`${this.label} helper returned an oversized message.`);
          this.terminate(s);
          pending = "";
        }
      });
      child.stderr.on("data", (data) => { stderr = (stderr + data.toString()).slice(-16384); });
      child.once("error", (error) => { failure = error; });
      resetTimer();
      const code = await new Promise((resolve) => child.once("close", (code) => {
        s.exited = true;
        clearTimeout(timer);
        clearTimeout(s.terminateTimer);
        clearTimeout(s.killTimer);
        if (pending.trim()) accept(pending);
        clearTimeout(timer);
        resolve(code);
      }));
      if (s.cancelled) return null;
      if (failure) throw failure;
      if (code !== 0 || !completed)
        throw new Error(stderr.trim() || `${this.label} analysis did not produce a complete result.`);
      return { ready: readyDetails, completed };
  }

  async cancel() {
    const s = this.session;
    if (!s || s.handedOff) return;
    s.cancelled = true;
    this.terminate(s);
    try { await s.done; } catch (error) {
      if (this.session === s && s.directory && (!s.child || s.exited)) {
        await this.cleanup(s);
        if (this.session === s) this.session = null;
      } else if (this.session === s) throw error;
    }
  }
  async dispose() { await this.cancel(); }
}

module.exports = { LocalVideoJob };
