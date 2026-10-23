"use strict";

const { spawn } = require("node:child_process");
const { MEDIA_FORMATS } = require("./core.cjs");

// Keep full-band transients and independent channels until envelope reduction.
// The reference timeline requests 800 envelope samples per second. Long files
// may reduce this density only when the compact envelope exceeds 8 MiB.
const SAMPLE_RATE = 48000;
const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024;
const MAX_BINS = MAX_ENVELOPE_BYTES / Float32Array.BYTES_PER_ELEMENT;
const BINS_PER_SECOND = 800;
const MAX_DURATION = 86400;
const MAX_PROBE_BYTES = 1024 * 1024;

function abortError() {
  const error = new Error("Waveform analysis cancelled.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}
function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}
function executable(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0"))
    throw new Error(`${label} executable is invalid.`);
  return value;
}
function identity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

// The owner remains alive until the child's close event. Abort, timeout and
// output errors all terminate that same child, then wait for its pipes to close.
function runOwned(command, args, { fd, signal, timeout, onData }) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe", fd],
      windowsHide: true,
    });
    let failure, stderr = "", killTimer;
    const stop = (error) => {
      failure ??= error;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 500);
      }
    };
    const onAbort = () => stop(abortError());
    const timer = setTimeout(() => {
      const error = new Error("Waveform analysis timed out.");
      error.code = "WAVEFORM_TIMEOUT";
      stop(error);
    }, timeout);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.on("data", (chunk) => {
      if (failure) return;
      try { onData(chunk); }
      catch (error) { stop(error); }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-16384);
    });
    child.once("error", (error) => { failure ??= error; });
    child.once("close", (code, signalName) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(new Error(stderr.trim() || `Waveform media process exited with ${code ?? signalName}.`));
      else resolve();
    });
  });
}

async function withGrantedFile(file, grants, expected, signal, action) {
  checkAbort(signal);
  const real = await grants.assert(file);
  const opened = await grants.open(file);
  try {
    const stamp = identity(opened.stat);
    if (expected && (real !== expected.real || stamp !== expected.stamp))
      throw new Error("The selected media changed during waveform analysis.");
    const result = await action(opened.handle.fd);
    checkAbort(signal);
    const current = await opened.handle.stat();
    if (identity(current) !== stamp || (await grants.assert(file)) !== real)
      throw new Error("The selected media changed during waveform analysis.");
    return { result, source: { real, stamp } };
  } finally {
    await opened.handle.close();
  }
}

// The fd protocol is seekable for regular files. Both tools receive a duplicate
// of the already-open granted file, not a path that could be replaced later.
// Only fd and pipe are allowed: media demuxers cannot open a network URL or
// another local path embedded in the selected file.
const INPUT = [
  "-protocol_whitelist", "fd,pipe",
  "-format_whitelist", MEDIA_FORMATS,
  "-fd", "3",
];

async function getWaveform(file, { grants, ffmpeg, ffprobe, signal } = {}) {
  if (!grants || typeof grants.assert !== "function" || typeof grants.open !== "function")
    throw new Error("A local media grant is required for waveform analysis.");
  executable(ffmpeg, "FFmpeg"); executable(ffprobe, "ffprobe");
  const header = await withGrantedFile(file, grants, null, signal, async (fd) => {
    const chunks = [];
    let length = 0;
    await runOwned(ffprobe, [
      "-v", "error", ...INPUT,
      "-show_entries", "format=duration:stream=codec_type,duration,channels",
      "-of", "json", "fd:",
    ], {
      fd, signal, timeout: 30000,
      onData(chunk) {
        length += chunk.length;
        if (length > MAX_PROBE_BYTES) throw new Error("Waveform metadata exceeds its memory budget.");
        chunks.push(chunk);
      },
    });
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const streams = value.streams;
    if (!Array.isArray(streams) || streams.length > 64)
      throw new Error("Waveform media stream metadata is invalid.");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    const duration = Number(value.format?.duration ?? audio?.duration);
    if (!Number.isFinite(duration) || duration < 0 || duration > MAX_DURATION)
      throw new Error("Waveform duration is invalid or exceeds 24 hours.");
    const channels = audio ? Number(audio.channels) : 0;
    if (audio && (!Number.isInteger(channels) || channels < 1 || channels > 32))
      throw new Error("Waveform audio channel count is unsupported.");
    return { duration, audio: !!audio, channels };
  });
  const { duration, audio, channels } = header.result;
  if (!audio || duration === 0) return { duration, peaks: new Float32Array(0) };
  const bins = Math.min(MAX_BINS, Math.max(1, Math.ceil(duration * BINS_PER_SECOND)));
  const peaks = new Float32Array(bins);
  const expectedSamples = Math.max(1, Math.ceil(duration * SAMPLE_RATE));
  let sampleCount = 0, channel = 0, framePeak = 0, carry = Buffer.alloc(0);
  const add = (sample) => {
    if (!Number.isFinite(sample)) throw new Error("Waveform decoder returned an invalid audio sample.");
    framePeak = Math.max(framePeak, Math.abs(sample));
    if (++channel < channels) return;
    if (sampleCount > expectedSamples + SAMPLE_RATE)
      throw new Error("Waveform decoder exceeded the declared media duration.");
    const bin = Math.min(bins - 1, Math.floor(sampleCount * bins / expectedSamples));
    peaks[bin] = Math.max(peaks[bin], framePeak);
    sampleCount++;
    channel = 0; framePeak = 0;
  };
  await withGrantedFile(file, grants, header.source, signal, (fd) => runOwned(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-copyts",
    ...INPUT, "-i", "fd:", "-map", "0:a:0", "-vn", "-sn", "-dn",
    "-af", `aresample=${SAMPLE_RATE}:async=1:first_pts=0,apad=whole_dur=${duration},atrim=duration=${duration}`,
    "-ar", String(SAMPLE_RATE), "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1",
  ], {
    fd, signal,
    timeout: Math.min(15 * 60000, Math.max(30000, duration * 500)),
    onData(chunk) {
      const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const end = bytes.length - bytes.length % 4;
      for (let offset = 0; offset < end; offset += 4) add(bytes.readFloatLE(offset));
      carry = Buffer.from(bytes.subarray(end));
    },
  }));
  if (carry.length || channel || !sampleCount) throw new Error("Waveform decoder returned incomplete audio samples.");
  let maximum = 0;
  for (const peak of peaks) maximum = Math.max(maximum, peak);
  if (maximum > 0) for (let index = 0; index < peaks.length; index++) peaks[index] /= maximum;
  return { duration, peaks };
}

module.exports = { getWaveform };
