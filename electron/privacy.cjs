"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { object, boolean, number, string, validatePrivacyAnalysis, MAX_PROJECT_BYTES } = require("./core.cjs");

// Owns one local Vision analysis from startup through exit and cleanup. The
// returned promise resolves only after that lifecycle has finished.
class PrivacyAnalyzer {
  constructor({ helper, cacheRoot, grants, onProgress = () => {}, idleTimeout = 120000 }) {
    Object.assign(this, { helper, cacheRoot, grants, onProgress, idleTimeout });
    this.session = null;
  }
  get active() { return this.session !== null; }

  analyze(file, input) {
    if (this.active) throw new Error("Privacy analysis is already running.");
    const settings = object(input, "Privacy settings");
    const sensitive = boolean(settings.sensitive, "Sensitive data detector");
    const faces = boolean(settings.faces, "Face detector");
    const customPhrases = settings.customPhrases ?? [];
    if (!Array.isArray(customPhrases) || customPhrases.length > 100 || customPhrases.some(value => typeof value !== "string" || !value.trim() || value.length > 500 || value.includes("\0"))) throw new Error("Enter at most 100 custom phrases of 500 characters each.");
    if (!sensitive && !faces) throw new Error("Select a privacy detector first.");
    const s = { cancelled: false, child: null, exited: false, directory: null, directoryIdentity: null,
      terminateTimer: null, killTimer: null };
    this.session = s;
    // Cancellation remains meaningful through asynchronous final cleanup.
    s.done = this.run(s, file, { sensitive, faces, customPhrases: [...new Set(customPhrases)].sort() }).then((result) => s.cancelled ? null : result);
    return s.done;
  }

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
      throw new Error("The owned privacy directory was replaced; cleanup needs attention.");
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
    if (!s.directory) return;
    if (s.child && !s.exited) throw new Error("The privacy helper must exit before cleanup.");
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
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_PROJECT_BYTES)
        throw new Error("Privacy analysis result is invalid or too large.");
      const chunks = [];
      let size = 0;
      while (!s.cancelled) {
        // Include one extra byte to detect growth after fstat without reading an
        // unbounded file or following a replacement symlink.
        const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, MAX_PROJECT_BYTES - size + 1));
        const { bytesRead } = await handle.read(buffer);
        if (!bytesRead) return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
        size += bytesRead;
        if (size > MAX_PROJECT_BYTES) throw new Error("Privacy analysis result is too large.");
        chunks.push(buffer.subarray(0, bytesRead));
      }
      return null;
    } finally { await handle.close(); }
  }

  async run(s, file, settings) {
    let runFailure;
    try {
      const source = await this.grants.assert(file);
      if (s.cancelled) return null;
      await fs.mkdir(this.cacheRoot, { recursive: true, mode: 0o700 });
      s.directory = await fs.mkdtemp(path.join(this.cacheRoot, "Privacy-"));
      s.directoryIdentity = await fs.lstat(s.directory);
      await this.assertDirectory(s);
      if (s.cancelled) return null;
      const output = path.join(s.directory, "analysis.json");
      const child = spawn(this.helper, ["analyze-privacy", "--input", source,
        "--output", output, "--sensitive", String(settings.sensitive), "--faces", String(settings.faces), "--custom-phrases", JSON.stringify(settings.customPhrases)],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      s.child = child;
      let pending = "", stderr = "", failure, completed, terminal, ready = false, timer;
      const resetTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          failure = new Error("Privacy analysis stopped responding.");
          this.terminate(s);
        }, this.idleTimeout);
      };
      const accept = (line) => {
        if (!line.trim() || failure || s.cancelled) return;
        try {
          const m = object(JSON.parse(line), "Privacy progress");
          if (terminal) throw new Error("Privacy helper sent a message after its terminal result.");
          if (m.type === "ready") {
            if (ready) throw new Error("Privacy helper repeated its ready message.");
            number(m.duration, 0.001, 86400, "Privacy duration");
            ready = true;
          } else if (m.type === "progress") {
            if (!ready) throw new Error("Privacy progress arrived before startup.");
            this.onProgress(number(m.progress, 0, 1, "Privacy progress"));
          } else if (m.type === "completed") {
            if (!ready || completed || m.output !== output)
              throw new Error("Privacy helper reported an unexpected result.");
            completed = m;
            terminal = "completed";
          } else if (m.type === "error") {
            throw new Error(string(m.message, 32768, "Privacy error"));
          } else if (m.type === "cancelled") {
            terminal = "cancelled";
          } else {
            throw new Error("Privacy helper returned an unknown message.");
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
            failure = new Error("Privacy helper returned an oversized message.");
            this.terminate(s);
            pending = "";
            return;
          }
          accept(line);
        }
        if (Buffer.byteLength(pending) > 65536) {
          failure = new Error("Privacy helper returned an oversized message.");
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
        throw new Error(stderr.trim() || "Privacy analysis did not produce a complete result.");
      await this.grants.assert(file);
      if (s.cancelled) return null;
      const raw = await this.readResult(s, output);
      if (s.cancelled) return null;
      if (raw.source?.path !== source)
        throw new Error("Privacy analysis belongs to another recording.");
      const analysis = validatePrivacyAnalysis(raw);
      if (!analysis.coverage.complete || analysis.settings.sensitive !== settings.sensitive || analysis.settings.faces !== settings.faces || JSON.stringify(analysis.settings.customPhrases ?? []) !== JSON.stringify(settings.customPhrases ?? []))
        throw new Error("Privacy analysis did not cover all requested frames and detectors.");
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

  async cancel() {
    const s = this.session;
    if (!s) return;
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

module.exports = { PrivacyAnalyzer };
