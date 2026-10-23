"use strict";
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { iterateCursorAudioCues, cursorSoundURL, CURSOR_SOUNDS } = require("../shared/cursor-audio.mjs");
const { projectSlices } = require("./core.cjs");

/** Only our two bundled identities can select a local sound; no project paths. */
function bundledCursorSound(sound, type) {
  const relative = cursorSoundURL(sound, type);
  for (const root of ["dist", "public"]) {
    const file = path.join(__dirname, "..", root, relative);
    if (fs.existsSync(file)) return file;
  }
  throw new Error(`Bundled click sound is unavailable: ${sound}/${type}.`);
}

// The six verified resources are mono 44.1kHz PCM16 or IEEE float32 WAV.
function decodeCursorWave(bytes) {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error("Invalid bundled click sound WAV.");
  let format, channels, rate, bits, data;
  for (let at = 12; at + 8 <= bytes.length;) {
    const type = bytes.toString("ascii", at, at + 4), size = bytes.readUInt32LE(at + 4), start = at + 8;
    if (size > bytes.length - start) throw new Error("Truncated bundled click sound WAV.");
    if (type === "fmt " && size >= 16) { format = bytes.readUInt16LE(start); channels = bytes.readUInt16LE(start + 2); rate = bytes.readUInt32LE(start + 4); bits = bytes.readUInt16LE(start + 14); }
    if (type === "data") data = bytes.subarray(start, start + size);
    at = start + size + size % 2;
  }
  if (channels !== 1 || rate !== 44100 || !((format === 1 && bits === 16) || (format === 3 && bits === 32)) || !data || data.length % (bits / 8)) throw new Error("Unsupported bundled click sound format.");
  const samples = new Float32Array(data.length / (bits / 8));
  for (let i = 0; i < samples.length; i++) samples[i] = format === 3 ? data.readFloatLE(i * 4) : data.readInt16LE(i * 2) / 32768;
  if (!samples.every(Number.isFinite)) throw new Error("Nonfinite bundled click sound data.");
  return { rate, samples };
}

function waveHeader(frames, rate = 44100) {
  // RF64 avoids the RIFF 4GB limit on long projects without a large allocation.
  const bytes = frames * 4, header = Buffer.alloc(80);
  header.write("RF64", 0); header.writeUInt32LE(0xffffffff, 4); header.write("WAVE", 8);
  header.write("ds64", 12); header.writeUInt32LE(28, 16); header.writeBigUInt64LE(BigInt(bytes + 72), 20); header.writeBigUInt64LE(BigInt(bytes), 28); header.writeBigUInt64LE(BigInt(frames), 36); header.writeUInt32LE(0, 44);
  header.write("fmt ", 48); header.writeUInt32LE(16, 52); header.writeUInt16LE(3, 56); header.writeUInt16LE(1, 58); header.writeUInt32LE(rate, 60); header.writeUInt32LE(rate * 4, 64); header.writeUInt16LE(4, 68); header.writeUInt16LE(32, 70);
  header.write("data", 72); header.writeUInt32LE(0xffffffff, 76); return header;
}

/** The preparation owns its descriptor until close succeeds, including retries. */
class CursorAudioFileOwner {
  constructor() { this.handle = null; }
  async open(destination) {
    if (this.handle) throw new Error("Cursor audio file is already open.");
    this.handle = await fsp.open(destination, "wx", 0o600);
    return this.handle;
  }
  async close() {
    if (!this.handle) return;
    await this.handle.close();
    this.handle = null;
  }
}

class CursorAudioCleanupError extends AggregateError {
  constructor(errors, owner) {
    super(errors, "Cursor audio file cleanup failed; its descriptor remains owned.");
    this.name = "CursorAudioCleanupError";
    this.cleanupOwner = owner;
  }
}

/** Mixes clicks in one-second bounded blocks, independent of recording audio. */
async function writeCursorAudio(project, duration, directory, { signal, fileOwner = new CursorAudioFileOwner() } = {}) {
  const checkCancellation = () => { if (signal?.aborted) throw new Error("Export cancelled."); };
  checkCancellation();
  const settings = project.appearance.cursorSettings;
  if (!settings || settings.clickSound === "none" || settings.clickSoundVolume === 0) return null;
  if (!CURSOR_SOUNDS.includes(settings.clickSound)) throw new Error("Unknown bundled cursor sound.");
  const iterator = iterateCursorAudioCues(project.cursor, projectSlices(project));
  let next = iterator.next();
  if (next.done) return null;
  const decoded = new Map();
  const samplesFor = async (type) => {
    if (!decoded.has(type)) decoded.set(type, decodeCursorWave(await fsp.readFile(bundledCursorSound(settings.clickSound, type))).samples);
    checkCancellation();
    return decoded.get(type);
  };
  const rate = 44100, total = Math.ceil(duration * rate), destination = path.join(directory, "cursor-clicks.wav"), handle = await fileOwner.open(destination);
  let failure;
  try {
    checkCancellation();
    await handle.write(waveHeader(total, rate));
    await handle.truncate(80 + total * 4);
    let carry = new Float32Array(0), mixed = 0;
    for (let from = 0; from < total; from += rate) {
      checkCancellation();
      // Leave silent spans as sparse zero-filled file ranges; a long recording
      // with a few clicks must not allocate or write a full uncompressed track.
      if (!carry.length) {
        if (next.done) break;
        from = Math.max(from, Math.floor(Math.round(next.value.outputTime * rate) / rate) * rate);
        if (from >= total) break;
      }
      const count = Math.min(rate, total - from), end = from + count;
      let samples = new Float32Array(Math.max(count, carry.length)), audibleUntil = carry.length;
      samples.set(carry);
      while (!next.done && Math.round(next.value.outputTime * rate) < end) {
        checkCancellation();
        const at = Math.round(next.value.outputTime * rate) - from, sound = await samplesFor(next.value.type);
        const until = Math.min(total - from, at + sound.length);
        if (until > samples.length) { const expanded = new Float32Array(until); expanded.set(samples); samples = expanded; }
        for (let i = Math.max(0, at); i < until; i++) samples[i] += sound[i - at] * settings.clickSoundVolume;
        audibleUntil = Math.max(audibleUntil, until); next = iterator.next();
        // Cached sounds await only microtasks. Yield to the event loop so an IPC
        // shutdown can interrupt even a dense run of clicks in one output block.
        if (++mixed % 64 === 0) { await new Promise(setImmediate); checkCancellation(); }
      }
      const bytes = Buffer.allocUnsafe(count * 4);
      for (let i = 0; i < count; i++) bytes.writeFloatLE(samples[i], i * 4);
      await handle.write(bytes, 0, bytes.length, 80 + from * 4);
      // Retain mixed sample tails, never one object per overlapping click.
      carry = samples.slice(count, audibleUntil);
    }
  } catch (error) { failure = error; }
  try { await fileOwner.close(); }
  catch (error) { throw new CursorAudioCleanupError(failure ? [failure, error] : [error], fileOwner); }
  if (failure) throw failure;
  // A shutdown may arrive while the final descriptor close is still pending.
  checkCancellation();
  return { path: destination, volume: 1, timeline: "output" };
}

module.exports = { writeCursorAudio, bundledCursorSound, decodeCursorWave, waveHeader, CursorAudioFileOwner, CursorAudioCleanupError };
