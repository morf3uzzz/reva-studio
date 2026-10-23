"use strict";

const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Readable } = require("node:stream");
const { parseByteRange, MEDIA_FORMATS } = require("./core.cjs");

function runProcess(
  command,
  args,
  { timeout = 30000, maxBytes = 8 * 1024 * 1024 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks = [];
    let total = 0,
      errorText = "",
      failure;
    const timer = setTimeout(() => {
      failure = new Error("The local media tool timed out.");
      child.kill("SIGKILL");
    }, timeout);
    child.stdout.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        failure = new Error("The local media tool returned too much data.");
        child.kill("SIGKILL");
      } else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      errorText = (errorText + chunk.toString()).slice(-16384);
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(
            errorText.trim() ||
              `The local media tool exited with code ${code}.`,
          ),
        );
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

async function findTool(name, resourcesPath) {
  const locations = [
    resourcesPath && path.join(resourcesPath, "bin", name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    ...(process.env.PATH || "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((p) => path.join(p, name)),
  ].filter(Boolean);
  for (const location of new Set(locations)) {
    try {
      await fsp.access(location, fs.constants.X_OK);
      if ((await fsp.stat(location)).isFile()) return location;
    } catch {
      /* Try the next installed location. */
    }
  }
  throw new Error(
    `${name} was not found. Install FFmpeg and restart REVA Studio.`,
  );
}

async function probe(file, ffprobe) {
  let parsed;
  try {
    parsed = JSON.parse(
      await runProcess(ffprobe, [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        MEDIA_FORMATS,
        "-show_entries",
        "format=duration:stream=codec_type,width,height,start_time,duration",
        "-of",
        "json",
        file,
      ]),
    );
  } catch (error) {
    throw new Error(`Could not read this media file: ${error.message}`);
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((s) => s.codec_type === "video");
  const duration = Number(parsed.format?.duration ?? video?.duration ?? 0);
  if (!Number.isFinite(duration) || duration < 0 || duration > 86400)
    throw new Error("The media duration is invalid or exceeds 24 hours.");
  return {
    path: file,
    name: path.basename(file),
    duration,
    width: Number(video?.width || 0),
    height: Number(video?.height || 0),
    ...(video && Number.isFinite(Number(video.start_time)) ? { videoStartTime: Number(video.start_time) } : {}),
    ...(video && Number.isFinite(Number(video.start_time)) && Number.isFinite(Number(video.duration)) && Number(video.duration) > 0 ? { videoEndTime: Number(video.start_time) + Number(video.duration) } : {}),
    hasAudio: streams.some((s) => s.codec_type === "audio"),
  };
}

class MediaGrants {
  constructor() {
    this.grants = new Map();
  }
  async grant(file) {
    const real = await fsp.realpath(file);
    const stat = await fsp.stat(real);
    if (!stat.isFile()) throw new Error("Choose a regular local file.");
    const identity = { real, dev: stat.dev, ino: stat.ino };
    this.grants.set(file, identity);
    this.grants.set(real, identity);
    return real;
  }
  async assert(file) {
    if (typeof file !== "string" || !this.grants.has(file))
      throw new Error("This local file has not been selected in REVA Studio.");
    const grant = this.grants.get(file);
    const real = await fsp.realpath(file);
    const stat = await fsp.stat(real);
    if (
      real !== grant.real ||
      stat.dev !== grant.dev ||
      stat.ino !== grant.ino ||
      !stat.isFile()
    )
      throw new Error(
        "The selected local file changed. Please import it again.",
      );
    return real;
  }
  async open(file) {
    const real = await this.assert(file);
    const handle = await fsp.open(real, "r");
    try {
      const stat = await handle.stat();
      const grant = this.grants.get(file);
      if (stat.dev !== grant.dev || stat.ino !== grant.ino || !stat.isFile())
        throw new Error(
          "The selected local file changed. Please import it again.",
        );
      return { handle, stat };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
}

const MIME = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".aiff": "audio/aiff",
  ".aif": "audio/aiff",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
};
async function mediaResponse(request, grants) {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405 });
  let opened;
  try {
    const url = new URL(request.url);
    if (
      url.protocol !== "reva-media:" ||
      url.hostname !== "asset" ||
      url.pathname !== "/"
    )
      return new Response(null, { status: 404 });
    const file = url.searchParams.get("path");
    opened = await grants.open(file);
    const { handle, stat } = opened;
    let range;
    try {
      range = parseByteRange(request.headers.get("range"), stat.size);
    } catch {
      await handle.close();
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${stat.size}` },
      });
    }
    const headers = {
      "Content-Type":
        MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": String(range ? range.end - range.start + 1 : stat.size),
      "Accept-Ranges": "bytes",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(range
        ? { "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}` }
        : {}),
    };
    if (request.method === "HEAD" || stat.size === 0) {
      await handle.close();
      return new Response(null, { status: range ? 206 : 200, headers });
    }
    const stream = handle.createReadStream({
      ...(range || {}),
      autoClose: true,
    });
    return new Response(Readable.toWeb(stream), {
      status: range ? 206 : 200,
      headers,
    });
  } catch {
    if (opened) await opened.handle.close().catch(() => {});
    return new Response(null, { status: 404 });
  }
}

module.exports = { runProcess, findTool, probe, MediaGrants, mediaResponse };
