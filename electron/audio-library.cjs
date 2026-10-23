"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BLOCK_FRAMES = 4096;
const ORIGINAL_TRACKS = Object.freeze([
  Object.freeze({ id: "quiet-orbit-v1", name: "Quiet Orbit · REVA Original", style: "ambient", duration: 32 }),
  Object.freeze({ id: "glass-steps-v1", name: "Glass Steps · REVA Original", style: "arpeggio", duration: 32 }),
  Object.freeze({ id: "warm-current-v1", name: "Warm Current · REVA Original", style: "pulse", duration: 32 }),
]);
const CHORDS = [
  [146.83238396, 174.61411572, 220, 261.6255653],
  [130.81278265, 164.81377846, 195.99771799, 261.6255653],
  [116.54094038, 146.83238396, 174.61411572, 233.08188076],
  [130.81278265, 174.61411572, 220, 261.6255653],
];
// Algebraic oscillator: no sampled music, random seed, imported assets, or
// platform-dependent transcendental functions enter the generated waveform.
function oscillator(phase) {
  const x = (phase % 1) * 2 - 1, y = 4 * x * (1 - Math.abs(x));
  return .775 * y + .225 * y * Math.abs(y);
}
function noise(frame) { let v = (Math.imul(frame, 1664525) + 1013904223) | 0; v ^= v >>> 13; return (v >>> 0) / 2147483648 - 1; }
function frameSample(track, frame, channel) {
  const t = frame / SAMPLE_RATE, chord = CHORDS[Math.floor(t / 8) % CHORDS.length], chordAge = t % 8;
  const chordEnvelope = Math.min(1, chordAge / .35, (8 - chordAge) / .7);
  const boundary = Math.min(1, t / .035, (track.duration - t) / .035);
  let value = 0;
  if (track.style === "ambient") {
    for (let n = 0; n < chord.length; n++) value += oscillator(t * chord[n] / 2 + channel * .13 + n * .19) * .042 * chordEnvelope;
    value += oscillator(t * chord[0] / 4) * .04;
  } else {
    const step = Math.floor(t * 4), age = t - step / 4, envelope = Math.min(1, age / .006) * (1 - age * 4) ** 3;
    const note = chord[(step + (track.style === "pulse" ? 1 : 0)) % chord.length] * (track.style === "arpeggio" ? 2 : 1);
    const pan = channel === step % 2 ? 1 : .65;
    value += (oscillator(age * note) + oscillator(age * note * 2) * .23) * .14 * envelope * pan;
    for (let n = 0; n < 3; n++) value += oscillator(t * chord[n] / 2 + n * .11 + channel * .05) * .018 * chordEnvelope;
    const beatAge = t % .5;
    if (track.style === "pulse") {
      const kickEnvelope = (1 - Math.min(1, beatAge / .18)) ** 3;
      value += oscillator(beatAge * 52) * .15 * kickEnvelope;
      const tickAge = t % .25;
      value += noise(frame + channel * 997) * .014 * (1 - Math.min(1, tickAge / .025));
    }
  }
  return Math.max(-.9, Math.min(.9, value * boundary));
}

function wavHeader(frames) {
  const bytes = frames * CHANNELS * 2, header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(bytes + 36, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * CHANNELS * 2, 28);
  header.writeUInt16LE(CHANNELS * 2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(bytes, 40);
  return header;
}
async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) { const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset); if (!bytesWritten) throw new Error("Cannot write generated music."); offset += bytesWritten; }
}
async function fingerprint(file, expectedSize) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== expectedSize) throw new Error("A cached original music file has changed. Its existing file was preserved.");
    const hash = crypto.createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest("hex");
  } finally { await handle.close(); }
}

/** An app-owned local synthesis cache. It never scans or overwrites user music. */
class AudioLibrary {
  constructor({ root, grants }) {
    this.root = root; this.grants = grants; this.generating = null; this.pendingCleanup = new Map();
  }
  async directory() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.root);
    if (!stat.isDirectory()) throw new Error("The original music library path is not a directory.");
    return this.root;
  }
  async cleanup() {
    for (const [file, identity] of this.pendingCleanup) {
      let stat;
      try { stat = await fs.lstat(file); } catch (error) { if (error.code === "ENOENT") { this.pendingCleanup.delete(file); continue; } throw error; }
      if (!stat.isFile() || stat.dev !== identity.dev || stat.ino !== identity.ino) throw new Error("An owned music temporary file was replaced; cleanup needs attention.");
      await fs.unlink(file); this.pendingCleanup.delete(file);
    }
  }
  list() {
    if (this.generating) return this.generating;
    const work = this.ensure(); this.generating = work;
    work.then(() => { if (this.generating === work) this.generating = null; }, () => { if (this.generating === work) this.generating = null; });
    return work;
  }
  async readMetadata(file) {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4096) throw new Error("Original music cache metadata is invalid.");
      const bytes = Buffer.alloc(4097); const { bytesRead } = await handle.read(bytes);
      if (bytesRead > 4096) throw new Error("Original music metadata grew beyond its bound.");
      return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    } finally { await handle.close(); }
  }
  async ensure() {
    await this.directory(); await this.cleanup();
    const assets = [];
    for (const track of ORIGINAL_TRACKS) {
      const file = path.join(this.root, `${track.id}.wav`), manifest = path.join(this.root, `${track.id}.json`);
      const frames = Math.round(track.duration * SAMPLE_RATE), bytes = 44 + frames * CHANNELS * 2;
      let metadata;
      try { metadata = await this.readMetadata(manifest); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (metadata) {
        if (metadata.version !== 1 || metadata.id !== track.id || metadata.frames !== frames || !/^[\da-f]{64}$/.test(metadata.sha256)) throw new Error("Original music cache metadata does not match this generator.");
        if (await fingerprint(file, bytes) !== metadata.sha256) throw new Error("A cached original music file has changed. Its existing file was preserved.");
      } else {
        const temp = path.join(this.root, `.${track.id}-${crypto.randomBytes(8).toString("hex")}.wav.tmp`);
        const handle = await fs.open(temp, "wx", 0o600);
        this.pendingCleanup.set(temp, await handle.stat());
        let digest;
        try {
          const hash = crypto.createHash("sha256"), header = wavHeader(frames);
          await writeAll(handle, header); hash.update(header);
          const block = Buffer.allocUnsafe(BLOCK_FRAMES * CHANNELS * 2);
          for (let from = 0; from < frames; from += BLOCK_FRAMES) {
            const count = Math.min(BLOCK_FRAMES, frames - from);
            for (let local = 0; local < count; local++) for (let channel = 0; channel < CHANNELS; channel++) {
              block.writeInt16LE(Math.round(frameSample(track, from + local, channel) * 32767), (local * CHANNELS + channel) * 2);
            }
            const data = block.subarray(0, count * CHANNELS * 2); await writeAll(handle, data); hash.update(data);
          }
          await handle.sync(); digest = hash.digest("hex");
        } finally { await handle.close(); }
        try {
          try { await fs.link(temp, file); } catch (error) {
            if (error.code !== "EEXIST") throw error;
            if (await fingerprint(file, bytes) !== digest) throw new Error("A music library path already contains different audio. Its file was preserved.");
          }
          const data = { version: 1, id: track.id, frames, sha256: digest, origin: "Original REVA procedural synthesis; no external samples." };
          try { await fs.writeFile(manifest, JSON.stringify(data), { flag: "wx", mode: 0o600 }); } catch (error) {
            if (error.code !== "EEXIST") throw error;
            const concurrent = await this.readMetadata(manifest);
            if (concurrent.id !== track.id || concurrent.sha256 !== digest || concurrent.frames !== frames) throw new Error("Concurrent original music cache metadata does not match.");
          }
        } finally { await this.cleanup(); }
      }
      const granted = await this.grants.grant(file);
      assets.push({ path: granted, name: track.name, duration: track.duration });
    }
    return assets;
  }
  async dispose() {
    try { await this.generating; } finally { await this.cleanup(); }
  }
}

module.exports = { AudioLibrary, ORIGINAL_TRACKS, SAMPLE_RATE, BLOCK_FRAMES };
