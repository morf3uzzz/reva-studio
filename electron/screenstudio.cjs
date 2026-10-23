"use strict";

// Independent reader for the observed Screen Studio 4.0.0 document format.
// No code or assets from the original application are loaded or executed.
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");
const { runProcess } = require("./media.cjs");
const { contained, portableAssetPath, validateSpring, validateCursorSettings, validateRecordingMarkers } = require("./core.cjs");
const { defaultCursorSettings } = require("../shared/cursor-settings.mjs");
const { originalCameraLayout, importCameraScenes, importCameraAppearance } = require("./camera-import.cjs");
const { parseManualMasks } = require("../shared/annotations.cjs");
const { importScreenStudioAudio, parseVoiceoverSources } = require("./audio-import.cjs");
const { timeToOutput, outputToSource } = require("../shared/timeline.mjs");
const { deriveTypingRanges } = require("../shared/typing-markers.mjs");

const LIMITS = Object.freeze({
  documentBytes: 16 * 1024 * 1024,
  eventBytes: 64 * 1024 * 1024,
  playlistBytes: 8 * 1024 * 1024,
  assetBytes: 64 * 1024 ** 3,
  totalAssetBytes: 256 * 1024 ** 3,
  sessions: 1024,
  items: 100000,
  events: 2000000,
  segments: 100000,
  durationMs: 86400000,
});
const pendingCleanup = new Set();
let activeImport = false;
let wallpaperCatalog = [];
try { wallpaperCatalog = require("../wallpapers.json").entries; }
catch { /* Local reference artwork is optional on other installations. */ }

function fail(message) {
  throw new Error(`Screen Studio import: ${message}`);
}
function obj(v, label) {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail(`${label} must be an object.`);
  return v;
}
function num(v, min, max, label) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    fail(`${label} is invalid.`);
  return v;
}
function str(v, label, max = 4096) {
  if (typeof v !== "string" || !v.length || v.length > max || /[\x00-\x1f\x7f]/.test(v))
    fail(`${label} is invalid.`);
  return v;
}
function arr(v, max, label) {
  if (!Array.isArray(v) || v.length > max) fail(`${label} is invalid or exceeds the import memory budget.`);
  return v;
}
function relativeName(v) {
  str(v, "asset path");
  if (/[:?#%]/.test(v)) fail("Asset paths must be plain relative local paths.");
  portableAssetPath("/screenstudio-root", v);
  return v;
}
function warn(list, message) {
  if (!list.includes(message)) list.push(message);
}
function canonical(parse, input) {
  try { return parse(input); }
  catch (error) { fail(error.message); }
}
function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

class BundleReader {
  constructor(root) {
    this.root = root;
    this.files = new Map();
    this.copiedBytes = 0;
  }
  async open(relative, maximum) {
    relativeName(relative);
    const selected = path.join(this.root, relative);
    const real = await fsp.realpath(selected);
    if (!contained(this.root, real)) fail(`Asset escapes the selected bundle: ${relative}`);
    const before = await fsp.stat(real);
    if (!before.isFile() || before.size > maximum) fail(`Asset is not a regular file or exceeds its size budget: ${relative}`);
    const handle = await fsp.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const actual = await handle.stat();
      if (!sameFile(before, actual) || !actual.isFile()) fail(`Asset changed while opening: ${relative}`);
      return { relative, real, handle, stat: actual };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  async finish(opened, digest) {
    if (!sameFile(opened.stat, await opened.handle.stat())) fail(`Asset changed while reading: ${opened.relative}`);
    this.files.set(opened.relative, {
      path: opened.relative,
      resolvedPath: opened.real,
      bytes: opened.stat.size,
      sha256: digest,
    });
  }
  async text(relative, maximum = LIMITS.documentBytes) {
    const opened = await this.open(relative, maximum);
    try {
      const data = Buffer.allocUnsafe(opened.stat.size);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await opened.handle.read(data, offset, data.length - offset, offset);
        if (!bytesRead) fail(`Asset was truncated during import: ${relative}`);
        offset += bytesRead;
      }
      await this.finish(opened, crypto.createHash("sha256").update(data).digest("hex"));
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        fail(`Asset is not UTF-8: ${relative}`);
      }
    } finally {
      await opened.handle.close();
    }
  }
  async json(relative, maximum) {
    const text = await this.text(relative, maximum);
    try {
      return JSON.parse(text);
    } catch {
      fail(`Invalid JSON: ${relative}`);
    }
  }
  async append(relative, destination) {
    const opened = await this.open(relative, LIMITS.assetBytes);
    try {
      this.copiedBytes += opened.stat.size;
      if (this.copiedBytes > LIMITS.totalAssetBytes) fail("Selected media exceeds the 256 GiB staging budget.");
      const hash = crypto.createHash("sha256");
      const chunk = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      while (position < opened.stat.size) {
        const { bytesRead } = await opened.handle.read(chunk, 0, Math.min(chunk.length, opened.stat.size - position), position);
        if (!bytesRead) fail(`Asset was truncated during import: ${relative}`);
        const bytes = chunk.subarray(0, bytesRead);
        hash.update(bytes);
        let written = 0;
        while (written < bytesRead) {
          const result = await destination.write(bytes, written, bytesRead - written);
          if (!result.bytesWritten) fail("Could not write imported media.");
          written += result.bytesWritten;
        }
        position += bytesRead;
      }
      await this.finish(opened, hash.digest("hex"));
    } finally {
      await opened.handle.close();
    }
  }
}

// This accepts only the local, complete fragmented-MP4 VOD dialect observed in
// the shipped recorder. The original manifest is never passed to a media tool.
function parseLocalHls(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
  if (lines.shift() !== "#EXTM3U") fail("Invalid HLS header.");
  let init, pendingDuration, ended = false, duration = 0;
  const segments = [], tags = new Set();
  for (const line of lines) {
    if (ended) fail("Unexpected data after HLS ENDLIST.");
    if (!line.startsWith("#")) {
      if (pendingDuration === undefined || !init) fail("An HLS segment needs one EXTINF and an initialization map.");
      relativeName(line);
      if (!/\.(m4s|mp4)$/i.test(line)) fail("Only local fragmented-MP4 HLS segments are supported.");
      segments.push({ path: line, duration: pendingDuration });
      duration += pendingDuration;
      if (segments.length > LIMITS.segments || duration * 1000 > LIMITS.durationMs) fail("HLS exceeds the import resource budget.");
      pendingDuration = undefined;
      continue;
    }
    const tag = line.split(":", 1)[0];
    if (tag === "#EXTINF") {
      if (pendingDuration !== undefined) fail("HLS segment URI is missing.");
      const match = /^#EXTINF:([0-9]+(?:\.[0-9]+)?),$/.exec(line);
      if (!match || !(Number(match[1]) > 0)) fail("Invalid HLS segment duration.");
      pendingDuration = Number(match[1]);
    } else if (tag === "#EXT-X-MAP") {
      const match = /^#EXT-X-MAP:URI="([^"\r\n]+)"$/.exec(line);
      if (!match || init || segments.length || pendingDuration !== undefined) fail("Only one local HLS initialization map is supported.");
      init = relativeName(match[1]);
      if (!/\.mp4$/i.test(init)) fail("HLS initialization map must be an MP4 file.");
    } else if (line === "#EXT-X-ENDLIST") {
      if (pendingDuration !== undefined) fail("HLS segment URI is missing.");
      ended = true;
    } else if (
      line === "#EXT-X-PLAYLIST-TYPE:VOD" ||
      line === "#EXT-X-INDEPENDENT-SEGMENTS" ||
      /^#EXT-X-(TARGETDURATION|VERSION|MEDIA-SEQUENCE):[0-9]+$/.test(line)
    ) {
      if (tags.has(tag)) fail(`Duplicate HLS tag: ${tag}`);
      tags.add(tag);
    } else {
      fail(`Unsupported HLS tag: ${tag}. Remote media, encryption, ranges, live and master playlists are not supported.`);
    }
  }
  if (!ended || !init || !segments.length || !tags.has("#EXT-X-PLAYLIST-TYPE")) fail("A complete local HLS VOD playlist is required.");
  return { init, segments, duration };
}

function envelope(value, label) {
  const outer = obj(value, label);
  const json = obj(outer.json, `${label}.json`);
  if (outer.meta !== undefined) {
    const meta = obj(outer.meta, `${label}.meta`);
    if (meta.v !== 1 || meta.referentialEqualities !== undefined) fail(`${label} uses unsupported serialization metadata.`);
    const values = obj(meta.values || {}, `${label}.meta.values`);
    for (const [key, annotation] of Object.entries(values)) {
      if (!["createdAt", "updatedAt", "lastSavedAt"].includes(key) || !Array.isArray(annotation) || annotation.length !== 1 || annotation[0] !== "Date" || typeof json[key] !== "string" || !Number.isFinite(Date.parse(json[key])))
        fail(`${label} uses an unsupported typed JSON annotation.`);
    }
  }
  return json;
}
function sessionInfo(input, index) {
  const s = obj(input, `session ${index}`);
  const start = num(s.processTimeStartMs, 0, Number.MAX_SAFE_INTEGER, "session start");
  const end = num(s.processTimeEndMs, start, Number.MAX_SAFE_INTEGER, "session end");
  const duration = end - start;
  if (duration <= 0 || duration > LIMITS.durationMs || Math.abs(num(s.durationMs, 0, LIMITS.durationMs, "session duration") - duration) > 1)
    fail("Session duration and process timestamps disagree.");
  return { start, end, duration };
}
function normalizeSlices(scene, durationMs, warnings) {
  let previousEnd = 0;
  const ids = new Set();
  return arr(scene.slices, LIMITS.items, "slices").map((input) => {
    const s = obj(input, "slice"), id = str(s.id, "slice id", 256);
    if (ids.has(id)) fail("Duplicate slice identity.");
    ids.add(id);
    const start = num(s.sourceStartMs, previousEnd - 0.000001, durationMs, "slice start");
    const end = num(s.sourceEndMs, start, durationMs + 1, "slice end");
    if (end <= start) fail("Empty slices are not supported.");
    const timeScale = num(s.timeScale, 1 / 16, 10, "slice timeScale");
    const volume = num(s.volume ?? 1, 0, 1, "slice volume");
    for (const key of ["hideCursor", "disableSmoothMouseMovement"])
      if (s[key] !== undefined && typeof s[key] !== "boolean") fail(`Slice ${key} must be boolean.`);
    previousEnd = end;
    return {
      id, start: start / 1000, end: Math.min(end, durationMs) / 1000, speed: 1 / timeScale, volume,
      ...(s.systemAudioVolume === undefined ? {} : { systemVolume: num(s.systemAudioVolume, 0, 1, "System audio slice volume") }),
      ...(s.externalDeviceAudioVolume === undefined ? {} : { cameraVolume: num(s.externalDeviceAudioVolume, 0, 1, "External device slice volume") }),
      ...(s.hideCursor === undefined ? {} : { cursorHidden: s.hideCursor }),
      ...(s.disableSmoothMouseMovement === undefined ? {} : { cursorSmooth: !s.disableSmoothMouseMovement }),
    };
  });
}
function normalizeZooms(scene, durationMs, warnings, crop) {
  const output = [];
  for (const input of arr(scene.zooms, LIMITS.items, "zooms")) {
    const z = obj(input, "zoom");
    for (const key of ["isDisabled", "hasInstantAnimation"])
      if (z[key] !== undefined && typeof z[key] !== "boolean") fail(`Zoom ${key} must be boolean.`);
    if (!["manual", "follow-click-groups"].includes(z.type)) fail(`Unsupported zoom mode: ${z.type}`);
    const start = num(z.sourceStartMs, 0, durationMs, "zoom start");
    const end = num(z.sourceEndMs, start, durationMs + 1, "zoom end");
    const point = obj(z.manualTargetPoint, "zoom target");
    const x = num(point.x, 0, 1, "zoom x"), y = num(point.y, 0, 1, "zoom y");
    if (z.presentation !== undefined && !["screen", "loupe"].includes(z.presentation)) fail("Unsupported zoom presentation.");
    if (z.type === "follow-click-groups") warn(warnings, "Automatic zooms use REVA cursor tracking; the original click-group motion is not reproduced exactly.");
    output.push({
      id: str(z.id, "zoom id", 256), start: start / 1000, end: Math.min(end, durationMs) / 1000,
      scale: num(z.zoom, 1, 10, "zoom factor"),
      // Original nd maps manualTargetPoint through screenCropRect. REVA stores
      // the resulting point normalized to the full source, like cursor data.
      x: z.type === "manual" ? crop.x + x * crop.width : x,
      y: z.type === "manual" ? crop.y + y * crop.height : y,
      mode: z.type === "manual" ? "manual" : "auto",
      ...(z.hasInstantAnimation === undefined ? {} : { instant: z.hasInstantAnimation }),
      ...(z.isDisabled === undefined ? {} : { disabled: z.isDisabled }),
      ...(z.presentation === undefined ? {} : { presentation: z.presentation }),
      ...(z.loupeOptions === undefined ? {} : { loupeOptions: { radius01: num(z.loupeOptions.radius01, .02, 1, "Loupe radius"), bevelRatio: num(z.loupeOptions.bevelRatio, 0, 1, "Loupe bevel"), chromaticAberration: num(z.loupeOptions.chromaticAberration, 0, 1, "Loupe chromatic aberration"), hasGlassOptics: (() => { if (typeof z.loupeOptions.hasGlassOptics !== "boolean") fail("Loupe glass optics must be boolean."); return z.loupeOptions.hasGlassOptics; })() } }),
    });
  }
  return output;
}


function appearance(config, warnings, hasCamera) {
  const c = obj(config, "project config"), patch = {};
  const setNumber = (key, value, min, max) => { if (value !== undefined) patch[key] = num(value, min, max, key); };
  const setBoolean = (key, value) => {
    if (value !== undefined) {
      if (typeof value !== "boolean") fail(`${key} must be boolean.`);
      patch[key] = value;
    }
  };
  setNumber("padding", c.output?.paddingRatio01, 0, 0.45);
  setNumber("radius", c.styles?.screenBorderRadius, 0, 400);
  setNumber("cameraRadiusRatio", c.styles?.cameraBorderRadiusRatio01, 0, 1);
  setNumber("shadow", c.styles?.shadow?.intensity, 0, 1);
  setNumber("inset", c.styles?.screenInset?.size, 0, 100);
  setNumber("blur", c.styles?.background?.blur, 0, 100);
  const cursor = c.cursor === undefined ? {} : obj(c.cursor, "cursor config");
  const sourceKeys = { size: "size", set: "set", alwaysUsePointer: "alwaysUseDefault", hideNotMovingAfterMs: "hideNotMovingAfterMs", loopPositionBeforeEndMs: "loopPositionBeforeEndMs", hidden: "hide", baseRotation: "baseRotation", rotationMode: "rotationMode", tiltAmount: "rotateOnXMovementRatio", stopMovementInLastPartMs: "stopMovementInLastPartMs", shakeThreshold: "removeShakeTreshold", optimizeChanges: "optimizeOriginalTypes", syncWithHovers: "followRecordedPositionOnHover" };
  const settings = defaultCursorSettings();
  for (const [key, source] of Object.entries(sourceKeys)) if (Object.hasOwn(cursor, source)) settings[key] = cursor[source];
  if (Object.hasOwn(cursor, "clickEffect")) settings.clickEffect = cursor.clickEffect === null ? "none" : obj(cursor.clickEffect, "cursor click effect").type;
  if (c.audio?.clickSoundEffect !== undefined) settings.clickSound = c.audio.clickSoundEffect === null ? "none" : c.audio.clickSoundEffect;
  if (c.audio?.clickSoundEffectVolume !== undefined) settings.clickSoundVolume = c.audio.clickSoundEffectVolume;
  patch.cursorSettings = canonical(validateCursorSettings, settings);
  if (cursor.useDefaultIfAppHasLowResolution === false) warn(warnings, "Recorded custom cursor PNGs are not imported; the selected bundled cursor set is used.");
  setBoolean("cameraMirror", c.camera?.mirror);
  setBoolean("cameraHidden", c.camera?.hide);
  Object.assign(patch, canonical(value => importCameraAppearance(value, warnings), c));
  if (c.zooms !== undefined) {
    const zooms = obj(c.zooms, "zoom config");
    setBoolean("zoomStartEarly", zooms.startAnimationEarly);
  }
  if (c.animations !== undefined) {
    const animations = obj(c.animations, "animation config");
    setNumber("motionBlur", animations.motionBlurAmount, 0, 2);
    if (animations.screenMovementSpring !== undefined)
      patch.screenSpring = canonical(validateSpring, animations.screenMovementSpring);
    if (animations.mouseMovementSpring === null) patch.cursorSmooth = false;
    else if (animations.mouseMovementSpring !== undefined) {
      patch.cursorSmooth = true;
      patch.cursorSpring = canonical(validateSpring, animations.mouseMovementSpring);
    }
  }
  const volume = num(c.audio?.volume ?? 1, 0, 1, "audio volume");
  patch.volume = c.audio?.muteSystemAudio ? 0 : volume;
  patch.microphoneVolume = c.audio?.muteMicrophone ? 0 : volume;
  patch.cameraVolume = 0;
  const ratio = c.output?.aspectRatio;
  if (ratio !== undefined) {
    if (["auto", "16:9", "9:16", "1:1", "4:3", "3:4", "4:5"].includes(ratio)) patch.aspect = ratio;
    else warn(warnings, "The source aspect ratio is not represented; REVA keeps its current aspect ratio.");
  }
  if (c.crop?.rect01) {
    const r = obj(c.crop.rect01, "crop rectangle");
    // Metadata carries normalized coordinates; actual encoded dimensions are
    // not known until media probing. Project validation owns the one-pixel
    // minimum, so logical display bounds must not impose another crop minimum.
    patch.crop = { x: num(r.x, 0, 1, "crop x"), y: num(r.y, 0, 1, "crop y"), width: num(r.width, Number.MIN_VALUE, 1, "crop width"), height: num(r.height, Number.MIN_VALUE, 1, "crop height") };
    if (r.x + r.width > 1.000001 || r.y + r.height > 1.000001) fail("Crop rectangle lies outside the recording.");
  }
  const background = c.styles?.background;
  const wallpaper = background?.type === "system" && Array.isArray(wallpaperCatalog)
    ? wallpaperCatalog.findIndex((entry) => entry.file === background.systemName) : -1;
  if (background?.type === "color" && /^#[0-9a-f]{6}$/i.test(background.color)) {
    patch.backgroundKind = "color";
    patch.background = background.color;
  } else if (wallpaper >= 0 && ["public", "dist"].some((base) => fs.existsSync(path.join(__dirname, "..", base, "reference-wallpapers", wallpaperCatalog[wallpaper].file)))) {
    patch.backgroundKind = "wallpaper";
    patch.wallpaper = wallpaper;
  } else if (background) warn(warnings, "The original wallpaper, gradient or background image is not imported; REVA keeps its own background.");
  if (hasCamera) warn(warnings, "Camera media and layout settings are preserved; camera styling, foreground segmentation and processing effects may differ.");
  if (c.audio?.backgroundAudioFileName && !c.audio.muteBackgroundAudio) warn(warnings, "Background music is not imported.");
  warn(warnings, "Cursor motion follows the reconstructed planner; native hover detection, custom recorded PNGs and GPU rendering have not been verified as equivalent to the original. Captions, shadows and processing effects may differ.");
  return patch;
}

async function loadBundle(bundlePath) {
  str(bundlePath, "bundle path", 32768);
  const root = await fsp.realpath(bundlePath);
  if (!(await fsp.stat(root)).isDirectory()) fail("Choose a .screenstudio package directory.");
  const reader = new BundleReader(root);
  const project = envelope(await reader.json("project.json"), "project.json");
  const meta = envelope(await reader.json("meta.json"), "meta.json");
  str(project.name, "project name", 512); str(project.id, "project id", 256); str(meta.version, "application version", 128);
  if (project.version !== "4.0.0" || meta.requiredVersion !== "4.0.0") fail("Only the verified 4.0.0 project schema is supported.");
  const metadata = obj(await reader.json("recording/metadata.json"), "recording metadata");
  if (metadata.state !== undefined && metadata.state !== "complete") fail("The recording has not finished saving.");
  const scenes = arr(project.scenes, 1, "scenes");
  if (scenes.length !== 1 || scenes[0]?.type !== "recording") fail("Only a single recording scene is supported.");
  const scene = scenes[0], warnings = [];
  const sessions = arr(metadata.sessions, LIMITS.sessions, "recording sessions").map(sessionInfo);
  if (!sessions.length) fail("The recording has no sessions.");
  let durationMs = 0, priorProcessEnd = -1;
  for (const s of sessions) {
    if (s.start < priorProcessEnd - 1) fail("Recording sessions overlap or are unordered.");
    s.recordingStartMs = durationMs;
    durationMs += s.duration;
    priorProcessEnd = s.end;
  }
  if (durationMs > LIMITS.durationMs) fail("Recording exceeds the 24 hour import budget.");
  const channels = new Map();
  for (const recorder of arr(metadata.recorders, 16, "recorders")) {
    const r = obj(recorder, "recorder"), type = str(r.type, "recorder type", 80);
    if (!["cursor", "input", "display", "systemAudio", "microphone", "webcam"].includes(type)) fail(`Unsupported recorder type: ${type}`);
    if (channels.has(type)) fail(`Multiple ${type} channels are not supported.`);
    channels.set(type, r);
    if (type === "cursor") continue;
    const items = arr(r.sessions, LIMITS.sessions, `${type} sessions`);
    if (items.length !== sessions.length) fail(`${type} sessions do not align with the recording sessions.`);
    items.forEach((item, index) => {
      const t = sessionInfo(item, index), s = sessions[index];
      if (Math.abs(t.start - s.start) > 100 || Math.abs(t.end - s.end) > 100) fail(`${type} session timing differs by more than the supported 100 ms alignment window.`);
      if (type !== "input") relativeName(item.outputFilename);
    });
  }
  const display = channels.get("display");
  if (!display) fail("A display recording channel is required; window and external-device projects are not yet supported.");
  const bounds = display.sessions.map((s) => {
    const b = obj(s.bounds, "display bounds");
    return { x: num(b.x, -100000, 100000, "display x"), y: num(b.y, -100000, 100000, "display y"), width: num(b.width, 1, 32768, "display width"), height: num(b.height, 1, 32768, "display height") };
  });
  if (bounds.some((b) => b.width !== bounds[0].width || b.height !== bounds[0].height)) fail("Display dimensions change between sessions.");
  const crop = display.configuration?.cropRect;
  if (crop && bounds.some((b) => crop.x !== b.x || crop.y !== b.y || crop.width !== b.width || crop.height !== b.height || crop.yAxis !== "topBasedIncreasingDownwards")) fail("Cropped display recorder coordinates are not yet supported.");
  const slices = normalizeSlices(scene, durationMs, warnings);
  if (!slices.length) fail("The project has no playable slices.");
  const appearancePatch = appearance(project.config, warnings, channels.has("webcam"));
  const zooms = normalizeZooms(scene, durationMs, warnings, appearancePatch.crop || { x: 0, y: 0, width: 1, height: 1 });
  const cameraScenes = canonical(value => importCameraScenes(value, durationMs / 1000, project.config.camera ?? {}), arr(scene.layouts ?? [], LIMITS.items, "layouts"));
  // Shipped mask renderer divides persisted rectangles by sizes.recording,
  // whose owner is recording.initialBounds (logical points, not encoded pixels
  // or the edited crop). Keep that one normalization at the import boundary.
  const masks = canonical(value => parseManualMasks(value, durationMs / 1000), arr(scene.masks ?? [], LIMITS.items, "masks").map(input => {
    const mask = obj(input, "mask");
    return { id: str(mask.id, "mask identity", 256), start: num(mask.sourceStartMs, 0, durationMs, "mask start") / 1000, end: num(mask.sourceEndMs, 0, durationMs, "mask end") / 1000, type: mask.type ?? "sensitive-data", bounds: arr(mask.bounds, 1000, "mask rectangles").map(input => { const rect = obj(input, "mask rectangle"); return { x: num(rect.x, 0, bounds[0].width, "mask x") / bounds[0].width, y: num(rect.y, 0, bounds[0].height, "mask y") / bounds[0].height, width: num(rect.width, Number.MIN_VALUE, bounds[0].width, "mask width") / bounds[0].width, height: num(rect.height, Number.MIN_VALUE, bounds[0].height, "mask height") / bounds[0].height }; }), blur: mask.blur ?? 32, opacity: mask.highlightMaskOpacity ?? .5, ...(mask.isDisabled === undefined ? {} : { disabled: mask.isDisabled }) };
  }));
  const voiceoverSources = canonical(value => parseVoiceoverSources(value, durationMs / 1000), scene.voiceOvers ?? []);
  return { reader, project, meta, metadata, channels, sessions, bounds, slices, zooms, appearancePatch, cameraScenes, masks, voiceoverSources, durationMs, warnings };
}
function provenance(plan) {
  return {
    format: "screenstudio", projectSchemaVersion: plan.project.version,
    applicationVersion: plan.meta.version, selectedBundle: plan.reader.root,
    sourceProjectId: plan.project.id, sourceSessionCount: plan.sessions.length,
    sourceDurationMs: plan.durationMs, files: [...plan.reader.files.values()],
    timing: "Sessions are concatenated without wall-clock pauses. Source milliseconds are divided by 1000; speed is 1/timeScale.",
  };
}
async function inspectScreenStudio(bundlePath) {
  const plan = await loadBundle(bundlePath);
  const markers = await readRecordingMarkers(plan);
  return {
    name: str(plan.project.name, "project name", 512), duration: plan.durationMs / 1000,
    sessionCount: plan.sessions.length, channels: [...plan.channels.keys()],
    slices: plan.slices, zooms: plan.zooms, appearancePatch: plan.appearancePatch, cameraScenes: plan.cameraScenes, masks: plan.masks,
    voiceoverSources: plan.voiceoverSources,
    ...markers,
    warnings: plan.warnings, provenance: provenance(plan),
  };
}

async function readRecordingMarkers(plan) {
  const pauseMarkers = plan.sessions.slice(1).map((session, index) => {
    const gap = session.start - plan.sessions[index].end;
    return { time: session.recordingStartMs / 1000, ...(gap >= 0 ? { duration: gap / 1000 } : {}) };
  });
  const input = plan.channels.get("input"), samples = [];
  let examined = 0, omitted = 0, hasTypingData = false;
  if (input) for (let index = 0; index < plan.sessions.length; index++) {
    const filename = input.sessions[index].keyStrokesFilename;
    if (filename === undefined) continue;
    hasTypingData = true;
    const session = plan.sessions[index];
    const events = arr(await plan.reader.json(`recording/${relativeName(filename)}`, LIMITS.eventBytes), LIMITS.events, "typing activity");
    examined += events.length;
    if (examined > LIMITS.events) fail("Typing activity exceeds the two million event import budget.");
    for (const event of events) {
      const value = obj(event, "typing event"), time = num(value.processTimeMs, 0, Number.MAX_SAFE_INTEGER, "typing process time");
      if (time < session.start || time > session.end) { omitted++; continue; }
      // The source grouper consumes timing only. Never copy character, shortcut,
      // modifier or key-code fields into our project or generated cache.
      samples.push({ time: (time - session.start + session.recordingStartMs) / 1000, count: 1 });
    }
  }
  samples.sort((a, b) => a.time - b.time);
  if (omitted) warn(plan.warnings, `${omitted} typing events outside their recording session were omitted.`);
  const resolved = plan.project.data?.["resolved-typing-speed-increase-suggestions-v2"];
  let resolvedTypingSuggestions;
  if (resolved !== undefined) {
    resolvedTypingSuggestions = [];
    for (const [key, value] of Object.entries(obj(resolved, "resolved typing suggestions"))) {
      if (typeof value !== "boolean") fail("Resolved typing suggestion values must be boolean.");
      const time = num(Number(key), 0, plan.durationMs, "resolved typing time");
      if (String(time) !== key) fail("Resolved typing keys must be canonical source millisecond values.");
      if (value) resolvedTypingSuggestions.push(time / 1000);
    }
    resolvedTypingSuggestions.sort((a, b) => a - b);
  }
  return canonical(value => validateRecordingMarkers(value, plan.durationMs / 1000), {
    pauseMarkers,
    ...(hasTypingData ? { typingRanges: deriveTypingRanges(samples) } : {}),
    ...(resolvedTypingSuggestions === undefined ? {} : { resolvedTypingSuggestions }),
  });
}

async function readCursor(plan) {
  const channel = plan.channels.get("input");
  if (!channel) return [];
  const output = [];
  let omitted = 0;
  for (let index = 0; index < plan.sessions.length; index++) {
    const session = plan.sessions[index], bounds = plan.bounds[index], samples = [];
    for (const key of ["mouseMovesFilename", "mouseClicksFilename"]) {
      const filename = channel.sessions[index][key];
      if (filename === undefined) continue;
      const events = arr(await plan.reader.json(`recording/${relativeName(filename)}`, LIMITS.eventBytes), LIMITS.events, "mouse events");
      if (output.length + samples.length + events.length > LIMITS.events) fail("Cursor events exceed the two million point import budget.");
      for (const event of events) {
        obj(event, "mouse event");
        const time = num(event.processTimeMs, 0, Number.MAX_SAFE_INTEGER, "event process time");
        if (time < session.start || time > session.end) { omitted++; continue; }
        if (!["mouseMoved", "mouseDragged", "mouseDown", "mouseUp"].includes(event.type)) fail(`Unsupported mouse event type: ${event.type}`);
        const x = (num(event.x, -1000000, 1000000, "cursor x") - bounds.x) / bounds.width;
        const y = (num(event.y, -1000000, 1000000, "cursor y") - bounds.y) / bounds.height;
        const cursorType = event.cursorId === undefined ? "arrow" : str(event.cursorId, "cursor id", 256);
        const button = event.button === undefined ? undefined : str(event.button, "mouse button", 16);
        if (button !== undefined && !["left", "right", "center"].includes(button)) fail("Unsupported mouse button.");
        samples.push({ t: (time - session.start + session.recordingStartMs) / 1000, x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)), click: event.type === "mouseDown", visible: x >= 0 && x <= 1 && y >= 0 && y <= 1, event: event.type, cursorType, ...(button === undefined ? {} : { button }) });
      }
    }
    samples.sort((a, b) => a.t - b.t);
    if (samples.length && samples[0].t > session.recordingStartMs / 1000)
      output.push({ t: session.recordingStartMs / 1000, x: samples[0].x, y: samples[0].y, click: false, visible: false });
    for (const sample of samples) output.push(sample);
    if (output.length > LIMITS.events) fail("Cursor events exceed the two million point import budget.");
  }
  if (omitted) warn(plan.warnings, `${omitted} mouse events outside their recording session were omitted.`);
  return output;
}

async function stageMedia(plan, filename, destination) {
  const relative = `recording/${relativeName(filename)}`;
  const handle = await fsp.open(destination, "wx", 0o600);
  try {
    if (/\.m3u8$/i.test(filename)) {
      const playlist = parseLocalHls(await plan.reader.text(relative, LIMITS.playlistBytes));
      const parent = path.posix.dirname(relative);
      await plan.reader.append(`${parent}/${playlist.init}`, handle);
      for (const segment of playlist.segments) await plan.reader.append(`${parent}/${segment.path}`, handle);
    } else {
      if (!/\.(mp4|mov|m4a)$/i.test(filename)) fail("Only MP4, MOV, M4A and the verified local fMP4 HLS dialect are supported.");
      await plan.reader.append(relative, handle);
    }
  } finally {
    await handle.close();
  }
  return destination;
}
const MOV_INPUT = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0"];
async function inspectMedia(file, ffprobe) {
  const raw = JSON.parse(await runProcess(ffprobe, ["-v", "error", ...MOV_INPUT, "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate,duration", "-of", "json", file]));
  const streams = arr(raw.streams, 16, "media streams");
  const videos = streams.filter((s) => s.codec_type === "video"), audios = streams.filter((s) => s.codec_type === "audio");
  if (videos.length > 1 || audios.length > 1 || streams.some((s) => !["video", "audio"].includes(s.codec_type))) fail("Multiple or unsupported streams in one source asset.");
  const duration = Number(raw.format?.duration ?? streams[0]?.duration);
  num(duration, 0.001, LIMITS.durationMs / 1000 + 1, "media duration");
  const video = videos[0];
  if (video) {
    num(video.width, 1, 8192, "video width"); num(video.height, 1, 8192, "video height");
    if (video.width % 2 || video.height % 2 || video.width * video.height > 8192 * 4320) fail("Video dimensions exceed the import encoder budget or are not even.");
  }
  return { video, audio: audios[0], duration };
}
function inputArgs(file) { return [...MOV_INPUT, "-i", file]; }
function videoFilter(offset, duration, fps) {
  return `trim=start=${Math.max(0, -offset)},setpts=PTS-STARTPTS,tpad=start_mode=clone:start_duration=${Math.max(0, offset)}:stop_mode=clone:stop_duration=${duration},trim=duration=${duration},fps=${fps},format=yuv420p`;
}
function audioFilter(offset, duration) {
  return `atrim=start=${Math.max(0, -offset)},asetpts=PTS-STARTPTS,adelay=${Math.max(0, offset) * 1000}:all=1,aresample=48000,apad=whole_dur=${duration},atrim=duration=${duration}`;
}
async function encodeSession(ffmpeg, output, inputs, filters, maps, duration, hasVideo) {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", ...inputs.flatMap(inputArgs), "-filter_complex", filters.join(";"), ...maps.flatMap((v) => ["-map", v]), "-map_metadata", "-1", "-map_chapters", "-1"];
  if (hasVideo) args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-video_track_timescale", "90000");
  if (maps.some((v) => v === "[a]")) args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2");
  else args.push("-an");
  args.push("-t", String(duration), "-movflags", "+faststart", output);
  await runProcess(ffmpeg, args, { timeout: Math.min(6 * 3600000, Math.max(120000, duration * 5000)) });
}
async function concatSessions(ffmpeg, work, names, durations, output, hasAudio) {
  const list = path.join(work, `concat-${path.basename(output)}.txt`);
  await fsp.writeFile(list, "ffconcat version 1.0\n" + names.map((name, i) => `file '${name}'\nduration ${durations[i]}\n`).join(""), { flag: "wx", mode: 0o600 });
  const duration = durations.reduce((sum, value) => sum + value, 0);
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-copyts", "-protocol_whitelist", "file,pipe", "-format_whitelist", "concat,mov", "-f", "concat", "-safe", "1", "-i", list, "-map", "0", "-c:v", "copy"];
  // Decode the per-session AAC priming only once at this boundary. Copying its
  // negative packet timestamp shifts the whole MP4 by 1024/48000 seconds.
  if (hasAudio) args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-af", `aresample=48000:async=1:first_pts=0,apad=whole_dur=${duration},atrim=duration=${duration}`);
  else args.push("-an");
  args.push("-t", String(duration), "-map_metadata", "-1", "-map_chapters", "-1", "-avoid_negative_ts", "disabled", "-movflags", "+faststart", output);
  await runProcess(ffmpeg, args, { timeout: 600000 });
}
async function cacheDirectory(root, bundle) {
  str(root, "cache directory", 32768);
  let ancestor = path.resolve(root), tail = [];
  while (true) {
    try {
      const real = await fsp.realpath(ancestor);
      const target = path.join(real, ...tail);
      if (target === bundle || contained(bundle, target)) fail("The import cache must be outside the original bundle.");
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      tail.unshift(path.basename(ancestor));
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  await fsp.mkdir(root, { recursive: true });
  const real = await fsp.realpath(root);
  if (real === bundle || contained(bundle, real)) fail("The import cache must be outside the original bundle.");
  return fsp.mkdtemp(path.join(real, "screenstudio-"));
}
async function cleanupScreenStudioImports() {
  for (const directory of [...pendingCleanup]) {
    await fsp.rm(directory, { recursive: true, force: true });
    pendingCleanup.delete(directory);
  }
}
async function importScreenStudio(bundlePath, { ffmpeg, ffprobe, cacheRoot }) {
  if (activeImport) fail("Another Screen Studio import is already running.");
  activeImport = true;
  let directory;
  try {
    str(ffmpeg, "ffmpeg executable", 32768); str(ffprobe, "ffprobe executable", 32768);
    const plan = await loadBundle(bundlePath);
    const cursor = await readCursor(plan);
    const markers = await readRecordingMarkers(plan);
    directory = await cacheDirectory(cacheRoot, plan.reader.root);
    const work = path.join(directory, ".work");
    await fsp.mkdir(work, { mode: 0o700 });
    const timeline = { slices: plan.slices, duration: plan.durationMs / 1000, trimStart: 0, trimEnd: plan.durationMs / 1000, speed: 1 };
    const importedAudio = await importScreenStudioAudio({ scene: plan.project.scenes[0], config: plan.project.config, slices: plan.slices, sourceDuration: plan.durationMs / 1000, sourceToPlayback: time => timeToOutput(timeline, time), playbackToSource: time => outputToSource(timeline, time), resolveAsset: async (_category, fileName) => {
      const file = path.join(directory, `voiceover-${crypto.randomUUID()}${path.extname(fileName).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 12)}`), handle = await fsp.open(file, "wx", 0o600);
      try { await plan.reader.append(`voiceovers/${fileName}`, handle); } finally { await handle.close(); }
      const raw = JSON.parse(await runProcess(ffprobe, ["-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", require("./core.cjs").MEDIA_FORMATS, "-show_entries", "format=duration:stream=codec_type,duration", "-of", "json", file]));
      const streams = arr(raw.streams, 16, "Voiceover streams"), audio = streams.find(stream => stream.codec_type === "audio"), video = streams.find(stream => stream.codec_type === "video");
      if (streams.length !== 1 || !audio || video) fail("A local voiceover must contain exactly one audio stream.");
      return { path: file, info: { duration: num(Number(raw.format?.duration ?? audio.duration), .001, 86400, "Voiceover media duration"), audio } };
    } });
    for (const warning of importedAudio.warnings) warn(plan.warnings, warning);
    const names = { screen: [], microphone: [], camera: [] }, durations = [];
    let dimensions, cameraDimensions, screenHasAudio, fps;
    for (let index = 0; index < plan.sessions.length; index++) {
      const session = plan.sessions[index], duration = session.duration / 1000;
      durations.push(duration);
      const sources = {};
      for (const [kind, channelType] of [["screen", "display"], ["system", "systemAudio"], ["microphone", "microphone"], ["camera", "webcam"]]) {
        const channel = plan.channels.get(channelType);
        if (!channel) continue;
        const item = channel.sessions[index];
        const file = await stageMedia(plan, item.outputFilename, path.join(work, `input-${index}-${kind}.mp4`));
        const info = await inspectMedia(file, ffprobe);
        if (Math.abs(info.duration - duration) > Math.max(0.25, duration * 0.001)) fail(`${kind} media duration disagrees with session metadata.`);
        sources[kind] = { file, info, offset: (item.processTimeStartMs - session.start) / 1000 };
      }
      const screen = sources.screen;
      if (!screen.info.video) fail("Display media does not contain video.");
      const size = `${screen.info.video.width}x${screen.info.video.height}`;
      if (dimensions && dimensions !== size) fail("Display media dimensions change between sessions.");
      dimensions = size;
      if (!fps) {
        const [n, d = "1"] = String(screen.info.video.r_frame_rate).split("/");
        const rate = Number(n) / Number(d);
        fps = Number.isFinite(rate) && rate > 0 ? Math.min(60, Math.max(1, rate)) : 30;
      }
      if (screen.info.audio && sources.system) fail("Display media and a separate system-audio recorder both contain audio; the intended track is ambiguous.");
      const audio = sources.system || (screen.info.audio ? screen : null);
      if (audio && (!audio.info.audio || (sources.system && audio.info.video))) fail("System audio asset has unexpected streams.");
      if (screenHasAudio !== undefined && screenHasAudio !== !!audio) fail("System audio presence changes between sessions.");
      screenHasAudio = !!audio;
      const inputs = [screen.file], filters = [`[0:v]${videoFilter(screen.offset, duration, fps)}[v]`], maps = ["[v]"];
      if (audio) {
        const audioIndex = audio === screen ? 0 : inputs.push(audio.file) - 1;
        filters.push(`[${audioIndex}:a]${audioFilter(audio.offset, duration)}[a]`); maps.push("[a]");
      }
      const name = `screen-${index}.mp4`;
      await encodeSession(ffmpeg, path.join(work, name), inputs, filters, maps, duration, true);
      names.screen.push(name);
      for (const kind of ["microphone", "camera"]) {
        const source = sources[kind];
        if (!source) continue;
        const camera = kind === "camera";
        if (camera ? !source.info.video || source.info.audio : !source.info.audio || source.info.video) fail(`${kind} asset has unexpected streams.`);
        if (camera) {
          const size = `${source.info.video.width}x${source.info.video.height}`;
          if (cameraDimensions && cameraDimensions !== size) fail("Camera dimensions change between sessions.");
          cameraDimensions = size;
        }
        const name = `${kind}-${index}.${camera ? "mp4" : "m4a"}`;
        await encodeSession(ffmpeg, path.join(work, name), [source.file], [camera ? `[0:v]${videoFilter(source.offset, duration, fps)}[v]` : `[0:a]${audioFilter(source.offset, duration)}[a]`], [camera ? "[v]" : "[a]"], duration, camera);
        names[kind].push(name);
      }
      // Release source copies before starting another session.
      for (const source of Object.values(sources)) await fsp.rm(source.file);
    }
    const outputs = {};
    for (const kind of ["screen", "microphone", "camera"]) {
      if (!names[kind].length) continue;
      const output = path.join(directory, `${kind}.${kind === "microphone" ? "m4a" : "mp4"}`);
      await concatSessions(ffmpeg, work, names[kind], durations, output, kind === "microphone" || (kind === "screen" && screenHasAudio));
      const info = await inspectMedia(output, ffprobe);
      if (Math.abs(info.duration - plan.durationMs / 1000) > 0.15) fail(`Normalized ${kind} duration does not match the source timeline.`);
      outputs[kind] = { path: output, info };
    }
    await fsp.rm(work, { recursive: true });
    const source = provenance(plan);
    source.normalization = { videoCodec: "h264", audioCodec: "aac", fps, directory };
    source.voiceovers = { sources: importedAudio.voiceoverSources, originalMicrophoneMuteRanges: importedAudio.microphoneMuteRanges };
    await fsp.writeFile(path.join(directory, "provenance.json"), JSON.stringify(source, null, 2), { flag: "wx", mode: 0o600 });
    const video = outputs.screen.info.video;
    return {
      mediaInfo: { path: outputs.screen.path, name: str(plan.project.name, "project name", 512), duration: plan.durationMs / 1000, width: video.width, height: video.height },
      cursorSourceSize: { width: plan.bounds[0].width, height: plan.bounds[0].height },
      ...(outputs.microphone ? { microphonePath: outputs.microphone.path } : {}),
      ...(outputs.camera ? {
        cameraPath: outputs.camera.path,
        cameraSource: { width: outputs.camera.info.video.width, height: outputs.camera.info.video.height },
      } : {}),
      cursor, zooms: plan.zooms, slices: plan.slices, appearancePatch: plan.appearancePatch, cameraScenes: plan.cameraScenes, masks: plan.masks,
      audio: importedAudio.audio, ...(importedAudio.captionSettings ? { captionSettings: importedAudio.captionSettings } : {}),
      ...markers,
      warnings: plan.warnings, provenance: source,
    };
  } catch (error) {
    if (directory) {
      pendingCleanup.add(directory);
      try { await fsp.rm(directory, { recursive: true, force: true }); pendingCleanup.delete(directory); }
      catch (cleanupError) {
        const combined = new AggregateError([error, cleanupError], `${error.message} Temporary import cleanup also failed: ${directory}`);
        combined.cleanupPath = directory;
        throw combined;
      }
    }
    throw error;
  } finally {
    activeImport = false;
  }
}

module.exports = { importScreenStudio, inspectScreenStudio, parseLocalHls, cleanupScreenStudioImports, LIMITS };
