"use strict";

const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_PROJECT_BYTES = 64 * 1024 * 1024;
const MAX_EXPORT_PIXELS = 8192 * 4320;
const MEDIA_FORMATS = "mov,matroska,webm,mp3,wav,aac,aiff,flac,ogg";
const cursorCatalog = require("../cursors.json");
const { parseCustomCursor } = require("../shared/cursor-image.cjs");
const { CURSOR_SOUNDS } = require("../shared/cursor-audio.mjs");

function fail(message) {
  throw new Error(message);
}
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object.`);
  return value;
}
function number(value, min, max, label) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    fail(`${label} is out of range.`);
  return value;
}
function integer(value, min, max, label) {
  number(value, min, max, label);
  if (!Number.isInteger(value)) fail(`${label} must be a whole number.`);
  return value;
}
function string(value, max, label) {
  if (typeof value !== "string" || value.length > max || value.includes("\0"))
    fail(`${label} is invalid.`);
  return value;
}
function boolean(value, label) {
  if (typeof value !== "boolean") fail(`${label} must be true or false.`);
  return value;
}
function choice(value, choices, label) {
  if (!choices.includes(value)) fail(`${label} is invalid.`);
  return value;
}
function asset(value, label) {
  return value === null ? null : string(value, 32768, label);
}
function list(value, maximum, label, parse) {
  if (!Array.isArray(value) || value.length > maximum)
    fail(`${label} is too large or invalid.`);
  return value.map(parse);
}

function validateSpring(input) {
  const s = object(input, "Spring");
  return {
    stiffness: number(s.stiffness, 5, 600, "Spring stiffness"),
    damping: number(s.damping, 5, 200, "Spring damping"),
    mass: number(s.mass, 0.1, 15, "Spring mass"),
    clamp: boolean(s.clamp, "Spring clamp"),
    precision: number(s.precision, 0.000001, 1, "Spring precision"),
  };
}

function validateCursorSettings(input) {
  const c = object(input, "Cursor settings"), set = object(c.set, "Cursor set");
  const id = choice(set.id, cursorCatalog.sets, "Cursor set id");
  const variants = object(set.variants, "Cursor variants"), entries = Object.entries(variants);
  if (entries.length > cursorCatalog.entries.length) fail("Too many cursor variants.");
  const parsedVariants = {};
  for (const [type, variant] of entries) {
    if (!cursorCatalog.entries.some(e => e.set === id && e.type === type && e.id === variant)) fail("Unknown cursor variant.");
    Object.defineProperty(parsedVariants, type, { value: variant, enumerable: true, writable: true, configurable: true });
  }
  const duration = (value, label) => value === null ? null : number(value, 0, 86_400_000, label);
  return {
    size: number(c.size, 1, 200, "Cursor size"), set: { id, variants: parsedVariants },
    alwaysUsePointer: boolean(c.alwaysUsePointer, "Always use pointer"),
    hideNotMovingAfterMs: duration(c.hideNotMovingAfterMs, "Idle cursor delay"),
    loopPositionBeforeEndMs: duration(c.loopPositionBeforeEndMs, "Cursor loop duration"),
    hidden: boolean(c.hidden, "Cursor visibility"),
    clickEffect: choice(c.clickEffect, ["none", "circle", "ripple"], "Click effect"),
    clickSound: choice(c.clickSound, CURSOR_SOUNDS, "Click sound"),
    clickSoundVolume: number(c.clickSoundVolume, 0, 1, "Click sound volume"),
    baseRotation: number(c.baseRotation, -180, 180, "Cursor rotation"),
    rotationMode: choice(c.rotationMode, ["velocity", "directional"], "Cursor rotation mode"),
    tiltAmount: number(c.tiltAmount, 0, 2, "Cursor tilt amount"),
    stopMovementInLastPartMs: number(c.stopMovementInLastPartMs, 0, 86_400_000, "Cursor stop duration"),
    shakeThreshold: number(c.shakeThreshold, 0, 2000, "Cursor shake threshold"),
    optimizeChanges: boolean(c.optimizeChanges, "Optimize cursor changes"),
    syncWithHovers: boolean(c.syncWithHovers, "Cursor hover synchronization"),
  };
}

/** Source-clock annotations; absence is retained for recordings without data. */
function validateRecordingMarkers(input, duration) {
  const result = {};
  if (input.recordingFlags !== undefined) {
    let previous = 0; const ids = new Set();
    result.recordingFlags = list(input.recordingFlags, 100000, "Recording flags", value => { const flag = object(value, "Recording flag"), id = string(flag.id, 256, "Flag identity"), time = number(flag.time, previous, duration, "Flag time"); if (ids.has(id)) fail("Recording flag identities must be unique."); ids.add(id); previous = time; return { id, time, ...(flag.label === undefined ? {} : { label: string(flag.label, 4096, "Flag label") }) }; });
  }
  if (input.pauseMarkers !== undefined) {
    let previous = 0;
    result.pauseMarkers = list(input.pauseMarkers, 100000, "Recording pauses", value => {
      const marker = object(value, "Recording pause"), time = number(marker.time, previous, duration, "Recording pause time");
      previous = time;
      return { time, ...(marker.duration === undefined ? {} : { duration: number(marker.duration, 0, Number.MAX_SAFE_INTEGER, "Recording pause duration") }) };
    });
  }
  if (input.typingRanges !== undefined) {
    let previous = 0;
    result.typingRanges = list(input.typingRanges, 100000, "Typing ranges", value => {
      const range = object(value, "Typing range"), start = number(range.start, previous, duration, "Typing start"), end = number(range.end, start, duration, "Typing end");
      if (end <= start) fail("A typing range must have positive duration.");
      previous = end;
      return { start, end, count: integer(range.count, 1, Number.MAX_SAFE_INTEGER, "Typing activity count") };
    });
  }
  if (input.resolvedTypingSuggestions !== undefined) {
    let previous = -1;
    result.resolvedTypingSuggestions = list(input.resolvedTypingSuggestions, 100000, "Resolved typing suggestions", value => {
      const time = number(value, 0, duration, "Resolved typing time");
      if (time <= previous) fail("Resolved typing times must be unique and ordered.");
      previous = time; return time;
    });
  }
  return result;
}

// Camera layout interpretation is owned by the shared camera boundary.
const { parseCameraLayout: validateCameraLayout, parseCameraScenes, parseCameraProcessing, parseCameraFaceTrack, parseCameraSilence, parseCameraCrop, parseDeviceFrame, parseScreenProcessing, parseScreenShadow, parseScreenEnhancement } = require("../shared/camera-effects.cjs");
const { parseManualMasks, parseShortcuts, parseShortcutSettings } = require("../shared/annotations.cjs");
const { parseTranscript, parseCaptionSettings } = require("../shared/transcript.mjs");
const { parseAudioSettings, atempoFilters: tempoFilters } = require("../shared/audio.mjs");

function validateCameraMask(input, cameraPath) {
  const m = object(input, "Camera mask");
  const sourcePath = string(m.sourcePath, 32768, "Camera mask source path");
  const maskPath = string(m.path, 32768, "Camera mask path");
  if (!cameraPath || sourcePath !== cameraPath)
    fail("Camera mask belongs to another camera source.");
  if (!maskPath || maskPath === sourcePath)
    fail("Camera mask must be a separate local media file.");
  const sourceSHA256 = string(m.sourceSHA256, 64, "Camera mask source hash");
  if (!/^[a-f0-9]{64}$/.test(sourceSHA256))
    fail("Camera mask source hash is invalid.");
  return {
    path: maskPath,
    sourcePath,
    sourceSHA256,
    sourceTimeOrigin: number(m.sourceTimeOrigin, -Number.MAX_VALUE, Number.MAX_VALUE, "Camera mask time origin"),
    duration: number(m.duration, Number.MIN_VALUE, 86400, "Camera mask duration"),
    width: integer(m.width, 1, 32768, "Camera mask width"),
    height: integer(m.height, 1, 32768, "Camera mask height"),
  };
}

// Both native results and persisted projects enter through this parser. Text
// recognized by OCR is intentionally absent from the persisted representation.
function validatePrivacyAnalysis(input) {
  const a = object(input, "Privacy analysis");
  if (a.version !== 1 || a.coordinateSpace !== "oriented-top-left-normalized")
    fail("This privacy analysis format is not supported.");
  const s = object(a.source, "Privacy source");
  const hash = string(s.sha256, 64, "Privacy source hash");
  if (!/^[a-f0-9]{64}$/.test(hash)) fail("Privacy source hash is invalid.");
  const duration = number(s.duration, 0.001, 86400, "Privacy source duration");
  const settings = object(a.settings, "Privacy settings");
  const coverage = object(a.coverage, "Privacy coverage");
  const sampledFrames = integer(
    coverage.sampledFrames,
    0,
    172800,
    "Privacy frame count",
  );
  const complete = boolean(coverage.complete, "Privacy sampling completion");
  const plannedFrames =
    coverage.plannedFrames === undefined
      ? undefined
      : integer(coverage.plannedFrames, 1, 172800, "Planned privacy frames");
  if (
    complete &&
    plannedFrames !== undefined &&
    sampledFrames !== plannedFrames
  )
    fail("Privacy sampling did not cover the planned frames.");
  const samples =
    a.samples === undefined
      ? undefined
      : list(a.samples, 172800, "Privacy samples", (input) => {
          const s = object(input, "Privacy sample");
          return {
            requestedTime: number(
              s.requestedTime,
              0,
              duration,
              "Requested sample time",
            ),
            actualTime: number(
              s.actualTime,
              0,
              duration,
              "Decoded sample time",
            ),
            analysisWidth: integer(s.analysisWidth, 1, 4096, "Sample width"),
            analysisHeight: integer(s.analysisHeight, 1, 4096, "Sample height"),
          };
        });
  if (samples && samples.length !== sampledFrames)
    fail("Privacy sample count is inconsistent.");
  const interval = (input) => {
    const r = object(input, "Privacy interval");
    const start = number(r.start, 0, duration, "Privacy interval start");
    return {
      start,
      end: number(r.end, start, duration + 0.000001, "Privacy interval end"),
    };
  };
  return {
    version: 1,
    source: {
      sha256: hash,
      width: integer(s.width, 1, 32768, "Privacy source width"),
      height: integer(s.height, 1, 32768, "Privacy source height"),
      duration,
    },
    settings: {
      sensitive: boolean(settings.sensitive, "Sensitive data detector"),
      faces: boolean(settings.faces, "Face detector"),
      ...(settings.customPhrases === undefined ? {} : { customPhrases: list(settings.customPhrases, 100, "Custom privacy phrases", value => string(value, 500, "Custom phrase")) }),
      ...(settings.faceTrackingInterval === undefined ? {} : { faceTrackingInterval: number(settings.faceTrackingInterval, .001, 1, "Face tracking interval") }),
      ...(settings.faceTrackingMethod === undefined ? {} : { faceTrackingMethod: choice(settings.faceTrackingMethod, ["vision-object-tracking"], "Face tracking method") }),
      sampleInterval: number(
        settings.sampleInterval,
        0.001,
        60,
        "Privacy sampling interval",
      ),
      ...(settings.maximumAnalysisDimension === undefined
        ? {}
        : {
            maximumAnalysisDimension: integer(
              settings.maximumAnalysisDimension,
              1,
              4096,
              "Maximum analysis dimension",
            ),
          }),
      ...Object.fromEntries(
        ["ocrRevision", "faceRevision", "patternRevision"]
          .filter((key) => settings[key] !== undefined)
          .map((key) => [key, integer(settings[key], 1, 1000, key)]),
      ),
    },
    coordinateSpace: "oriented-top-left-normalized",
    coverage: {
      complete,
      sampledFrames,
      ...(coverage.trackedFrames === undefined ? {} : { trackedFrames: integer(coverage.trackedFrames, 0, 864000, "Tracked face frames") }),
      ...(plannedFrames === undefined ? {} : { plannedFrames }),
      intervals: list(coverage.intervals, 200000, "Privacy coverage", interval),
      limitations: list(coverage.limitations, 100, "Privacy limitations", (v) =>
        string(v, 4096, "Privacy limitation"),
      ),
    },
    ...(samples === undefined ? {} : { samples }),
    regions: list(a.regions, 500000, "Privacy regions", (input) => {
      const r = object(input, "Privacy region");
      const box = {
        ...interval(r),
        kind: choice(
          r.kind,
          ["email", "phone", "card", "key", "phrase", "face"],
          "Privacy region kind",
        ),
        x: number(r.x, 0, 1, "Privacy region x"),
        y: number(r.y, 0, 1, "Privacy region y"),
        width: number(r.width, Number.EPSILON, 1, "Privacy region width"),
        height: number(r.height, Number.EPSILON, 1, "Privacy region height"),
        confidence: number(r.confidence, 0, 1, "Privacy confidence"),
      };
      if (box.x + box.width > 1.000001 || box.y + box.height > 1.000001)
        fail("A privacy region lies outside the recording.");
      return box;
    }),
  };
}

// This is the single parser for project files and renderer IPC. Returning an
// explicit shape also strips unknown/prototype properties at this boundary.
function validateCursor(input, duration) {
  let previousTime = -1;
  return list(input, 2_000_000, "Cursor data", (value) => {
    const v = object(value, "Cursor point");
    const t = number(
      v.t,
      previousTime < 0 ? 0 : previousTime,
      duration + 1,
      "Cursor time",
    );
    previousTime = t;
    return {
      t,
      x: number(v.x, 0, 1, "Cursor x"),
      y: number(v.y, 0, 1, "Cursor y"),
      click: boolean(v.click, "Cursor click"),
      ...(v.visible === undefined
        ? {}
        : { visible: boolean(v.visible, "Cursor visibility") }),
      ...(v.event === undefined ? {} : { event: choice(v.event, ["mouseMoved", "mouseDragged", "mouseDown", "mouseUp"], "Cursor event") }),
      ...(v.cursorType === undefined ? {} : { cursorType: string(v.cursorType, 256, "Cursor type") }),
      ...(v.button === undefined ? {} : { button: choice(v.button, ["left", "right", "center"], "Cursor button") }),
      ...(v.hover === undefined ? {} : { hover: boolean(v.hover, "Cursor hover") }),
    };
  });
}
function validateProject(input) {
  const p = object(input, "Project");
  if (p.version !== 1) fail("This project version is not supported.");
  const cameraPath = asset(p.cameraPath, "Camera path");
  const width = integer(p.width, 1, 32768, "Video width");
  const height = integer(p.height, 1, 32768, "Video height");
  const duration = number(p.duration, 0, 86400, "Duration");
  const trimStart = number(p.trimStart, 0, duration, "Trim start");
  const trimEnd = number(p.trimEnd, trimStart, duration, "Trim end");
  const a = object(p.appearance, "Appearance");
  const c = object(a.crop, "Crop");
  const crop = {
    x: number(c.x, 0, 1, "Crop x"),
    y: number(c.y, 0, 1, "Crop y"),
    width: number(c.width, 1 / width, 1, "Crop width"),
    height: number(c.height, 1 / height, 1, "Crop height"),
  };
  if (crop.x + crop.width > 1.000001 || crop.y + crop.height > 1.000001)
    fail("Crop must fit inside the recording.");
  const appearance = {
    backgroundKind: choice(
      a.backgroundKind,
      ["wallpaper", "gradient", "color", "image"],
      "Background kind",
    ),
    background: string(a.background, 128, "Background"),
    gradient: integer(a.gradient, 0, 10000, "Gradient"),
    wallpaper: integer(a.wallpaper, 0, 10000, "Wallpaper"),
    image: asset(a.image, "Background image"),
    ...(a.backgroundPhoto === undefined ? {} : { backgroundPhoto: require("./unsplash.cjs").parseUnsplashPhoto(a.backgroundPhoto) }),
    ...(a.backgroundImageSource === undefined ? {} : { backgroundImageSource: require("./unsplash.cjs").parseBackgroundImageSource(a.backgroundImageSource) }),
    blur: number(a.blur, 0, 100, "Blur"),
    padding: number(a.padding, 0, 0.45, "Padding"),
    radius: number(a.radius, 0, 400, "Radius"),
    shadow: number(a.shadow, 0, 1, "Shadow"),
    ...(a.screenShadow === undefined ? {} : { screenShadow: parseScreenShadow(a.screenShadow) }),
    inset: number(a.inset, 0, 100, "Inset"),
    aspect: choice(
      a.aspect,
      ["auto", "16:9", "9:16", "1:1", "4:3", "3:4", "4:5"],
      "Aspect ratio",
    ),
    cursorSize: number(a.cursorSize, 1, 200, "Cursor size"),
    cursorHidden: boolean(a.cursorHidden, "Cursor visibility"),
    cursorSmooth: boolean(a.cursorSmooth, "Cursor smoothing"),
    cursorHideIdle: boolean(a.cursorHideIdle, "Idle cursor"),
    ...(a.cursorSettings === undefined ? {} : { cursorSettings: validateCursorSettings(a.cursorSettings) }),
    ...(a.customCursor === undefined ? {} : { customCursor: parseCustomCursor(a.customCursor) }),
    clickEffect: choice(
      a.clickEffect,
      ["none", "circle", "ripple"],
      "Click effect",
    ),
    cameraSize: number(a.cameraSize, 0.05, 1, "Camera size"),
    cameraRadius: number(a.cameraRadius, 0, 500, "Camera radius"),
    ...(a.cameraRadiusRatio === undefined
      ? {}
      : { cameraRadiusRatio: number(a.cameraRadiusRatio, 0, 1, "Camera radius ratio") }),
    cameraX: number(a.cameraX, 0, 1, "Camera x"),
    cameraY: number(a.cameraY, 0, 1, "Camera y"),
    cameraMirror: boolean(a.cameraMirror, "Camera mirror"),
    cameraHidden: boolean(a.cameraHidden, "Camera visibility"),
    ...(a.cameraLayout === undefined
      ? {}
      : { cameraLayout: validateCameraLayout(a.cameraLayout) }),
    ...(a.cameraDelayMs === undefined ? {} : { cameraDelayMs: number(a.cameraDelayMs, -200, 200, "Camera delay") }),
    ...(a.cameraCrop === undefined ? {} : { cameraCrop: parseCameraCrop(a.cameraCrop) }),
    ...(a.deviceFrame === undefined ? {} : { deviceFrame: parseDeviceFrame(a.deviceFrame) }),
    ...(a.screenProcessing === undefined ? {} : { screenProcessing: parseScreenProcessing(a.screenProcessing) }),
    ...(a.avoidEmptyZoomArea === undefined ? {} : { avoidEmptyZoomArea: boolean(a.avoidEmptyZoomArea, "Adaptive crop") }),
    ...(a.cameraProcessing === undefined ? {} : { cameraProcessing: parseCameraProcessing(a.cameraProcessing) }),
    ...(a.cameraFollowFace === undefined ? {} : { cameraFollowFace: boolean(a.cameraFollowFace, "Camera face following") }),
    ...(a.cameraHideDuringSilence === undefined ? {} : { cameraHideDuringSilence: boolean(a.cameraHideDuringSilence, "Camera silence hiding") }),
    ...(a.cameraSilenceMinimumSeconds === undefined ? {} : { cameraSilenceMinimumSeconds: number(a.cameraSilenceMinimumSeconds, 2, 15, "Camera silence duration") }),
    volume: number(a.volume, 0, 1, "System audio volume"),
    microphoneVolume: number(a.microphoneVolume, 0, 1, "Microphone volume"),
    cameraVolume: number(a.cameraVolume, 0, 1, "Camera volume"),
    fadeIn: number(a.fadeIn, 0, 60, "Fade in"),
    fadeOut: number(a.fadeOut, 0, 60, "Fade out"),
    zoomDuration: number(a.zoomDuration, 0.01, 10, "Zoom animation duration"),
    ...(a.zoomStartEarly === undefined
      ? {}
      : { zoomStartEarly: boolean(a.zoomStartEarly, "Early zoom animation") }),
    ...(a.screenSpring === undefined
      ? {}
      : { screenSpring: validateSpring(a.screenSpring) }),
    ...(a.cursorSpring === undefined
      ? {}
      : { cursorSpring: validateSpring(a.cursorSpring) }),
    ...(a.motionBlur === undefined
      ? {}
      : { motionBlur: number(a.motionBlur, 0, 1, "Motion blur") }),
    crop,
  };
  const zooms = list(p.zooms, 100000, "Zooms", (value) => {
    const z = object(value, "Zoom");
    const start = number(z.start, 0, duration, "Zoom start");
    return {
      id: string(z.id, 256, "Zoom id"),
      start,
      end: number(z.end, start, duration, "Zoom end"),
      scale: number(z.scale, 1, 10, "Zoom scale"),
      x: number(z.x, 0, 1, "Zoom x"),
      y: number(z.y, 0, 1, "Zoom y"),
      mode: choice(z.mode, ["auto", "manual"], "Zoom mode"),
      ...(z.instant === undefined
        ? {}
        : { instant: boolean(z.instant, "Instant zoom") }),
      ...(z.presentation === undefined ? {} : { presentation: choice(z.presentation, ["screen", "loupe"], "Zoom presentation") }),
      ...(z.disabled === undefined ? {} : { disabled: boolean(z.disabled, "Zoom disabled") }),
      ...(z.loupeOptions === undefined ? {} : { loupeOptions: {
        radius01: number(object(z.loupeOptions, "Loupe options").radius01, .02, 1, "Loupe radius"),
        bevelRatio: number(z.loupeOptions.bevelRatio, 0, 1, "Loupe bevel"),
        chromaticAberration: number(z.loupeOptions.chromaticAberration, 0, 1, "Loupe chromatic aberration"),
        hasGlassOptics: boolean(z.loupeOptions.hasGlassOptics, "Loupe glass optics"),
      } }),
    };
  });
  const cursor = validateCursor(p.cursor, duration);
  const captions = list(p.captions, 100000, "Captions", (value) => {
    const t = object(value, "Caption");
    const start = number(t.start, 0, duration, "Caption start");
    const color = string(t.color, 128, "Caption color");
    return {
      id: string(t.id, 256, "Caption id"),
      text: string(t.text, 100000, "Caption text"),
      start,
      end: number(t.end, start, duration, "Caption end"),
      x: number(t.x, 0, 1, "Caption x"),
      y: number(t.y, 0, 1, "Caption y"),
      size: number(t.size, 1, 500, "Caption size"),
      color,
    };
  });
  let slices;
  if (p.slices !== undefined) {
    let previousEnd = 0;
    const ids = new Set();
    slices = list(p.slices, 100000, "Slices", (input) => {
      const s = object(input, "Slice");
      const id = string(s.id, 256, "Slice id");
      if (ids.has(id)) fail("Slice ids must be unique.");
      ids.add(id);
      const start = number(s.start, previousEnd, duration, "Slice start");
      const end = number(s.end, start, duration + 0.000001, "Slice end");
      if (end <= start) fail("A slice must have a positive duration.");
      previousEnd = end;
      return {
        id,
        start,
        end,
        speed: number(s.speed, 0.1, 24, "Slice speed"),
        volume: number(s.volume, 0, 1, "Slice volume"),
        ...(s.systemVolume === undefined ? {} : { systemVolume: number(s.systemVolume, 0, 1, "Slice system audio volume") }),
        ...(s.cameraVolume === undefined ? {} : { cameraVolume: number(s.cameraVolume, 0, 1, "Slice camera audio volume") }),
        ...(s.cursorHidden === undefined
          ? {}
          : {
              cursorHidden: boolean(s.cursorHidden, "Slice cursor visibility"),
            }),
        ...(s.cursorSmooth === undefined
          ? {}
          : {
              cursorSmooth: boolean(s.cursorSmooth, "Slice cursor smoothing"),
            }),
      };
    });
    if (!slices.length) fail("A project must contain at least one slice.");
  }
  let privacy;
  if (p.privacy !== undefined) {
    const v = object(p.privacy, "Privacy");
    const analysis =
      v.analysis === null ? null : validatePrivacyAnalysis(v.analysis);
    if (
      analysis &&
      (analysis.source.width !== p.width ||
        analysis.source.height !== p.height ||
        Math.abs(analysis.source.duration - duration) > 0.1)
    )
      fail(
        "Privacy analysis does not match this recording's dimensions or duration.",
      );
    privacy = {
      sensitive: boolean(v.sensitive, "Hide sensitive data"),
      faces: boolean(v.faces, "Hide faces"),
      ...(v.customPhrases === undefined ? {} : { customPhrases: list(v.customPhrases, 100, "Custom phrases", value => string(value, 500, "Custom phrase")) }),
      analysis,
    };
    if (
      (privacy.sensitive && !analysis?.settings.sensitive) ||
      (privacy.faces && !analysis?.settings.faces)
    )
      fail("Analyze this recording before enabling privacy masks.");
  }
  return {
    version: 1,
    name: string(p.name, 512, "Project name"),
    mediaPath: asset(p.mediaPath, "Video path"),
    cameraPath,
    ...(p.cameraStartTime === undefined ? {} : { cameraStartTime: number(p.cameraStartTime, 0, duration, "Camera media start") }),
    ...(p.cameraEndTime === undefined ? {} : { cameraEndTime: number(p.cameraEndTime, p.cameraStartTime ?? 0, duration + 1, "Camera media end") }),
    ...(p.cameraSource === undefined
      ? {}
      : {
          cameraSource: {
            width: integer(object(p.cameraSource, "Camera source").width, 1, 32768, "Camera source width"),
            height: integer(p.cameraSource.height, 1, 32768, "Camera source height"),
          },
        }),
    microphonePath: asset(p.microphonePath, "Microphone path"),
    ...(p.cameraMask === undefined
      ? {}
      : { cameraMask: validateCameraMask(p.cameraMask, cameraPath) }),
    duration,
    width,
    height,
    ...(p.cursorSourceSize === undefined ? {} : { cursorSourceSize: {
      width: number(object(p.cursorSourceSize, "Cursor source size").width, 1, 32768, "Cursor source width"),
      height: number(p.cursorSourceSize.height, 1, 32768, "Cursor source height"),
    } }),
    trimStart,
    trimEnd,
    speed: number(p.speed, 0.1, 24, "Playback speed"),
    appearance,
    zooms,
    cursor,
    captions,
    ...(p.cameraScenes === undefined ? {} : { cameraScenes: parseCameraScenes(p.cameraScenes, duration) }),
    ...(p.screenEnhancement === undefined ? {} : { screenEnhancement: (() => {
      const enhanced = parseScreenEnhancement(p.screenEnhancement);
      if (enhanced.sourcePath !== p.mediaPath || enhanced.width !== width * enhanced.scale || enhanced.height !== height * enhanced.scale || Math.abs(enhanced.duration - duration) > .05) fail("Enhanced video does not match the original screen dimensions or timeline.");
      return enhanced;
    })() }),
    ...(p.recoverySource === undefined ? {} : { recoverySource: (() => {
      const value = object(p.recoverySource, "Recovery provenance"), result = {};
      for (const key of ["directory", "journalPath", "journalId", "ownerId", "reportPath", "rawDirectory"]) result[key] = string(value[key], 32768, `Recovery ${key}`);
      result.checkpointDuration = number(value.checkpointDuration, 0, 86400, "Recovery checkpoint");
      if (value.reportSHA256 !== undefined) { if (typeof value.reportSHA256 !== "string" || !/^[a-f0-9]{64}$/.test(value.reportSHA256)) fail("Recovery report checksum is invalid."); result.reportSHA256 = value.reportSHA256; }
      return result;
    })() }),
    ...(p.recoveryIssues === undefined ? {} : { recoveryIssues: list(p.recoveryIssues, 1000, "Recovery issues", value => { const issue = object(value, "Recovery issue"); return { code: string(issue.code, 512, "Recovery issue code"), message: string(issue.message, 32768, "Recovery issue message"), ...(issue.path === undefined ? {} : { path: string(issue.path, 32768, "Recovery issue path") }) }; }) }),
    ...(p.cameraFaceTrack === undefined ? {} : { cameraFaceTrack: parseCameraFaceTrack(p.cameraFaceTrack) }),
    ...(p.cameraSilence === undefined ? {} : { cameraSilence: parseCameraSilence(p.cameraSilence) }),
    ...(p.masks === undefined ? {} : { masks: parseManualMasks(p.masks, duration) }),
    ...(p.shortcuts === undefined ? {} : { shortcuts: parseShortcuts(p.shortcuts, duration) }),
    ...(p.shortcutSettings === undefined ? {} : { shortcutSettings: parseShortcutSettings(p.shortcutSettings) }),
    ...(p.audio === undefined ? {} : { audio: parseAudioSettings(p.audio) }),
    ...(p.transcript === undefined ? {} : { transcript: parseTranscript(p.transcript, duration) }),
    ...(p.captionSettings === undefined ? {} : { captionSettings: parseCaptionSettings(p.captionSettings) }),
    ...validateRecordingMarkers(p, duration),
    ...(slices === undefined ? {} : { slices }),
    ...(privacy === undefined ? {} : { privacy }),
  };
}

function projectAssets(project) {
  return [
    project.mediaPath,
    project.cameraPath,
    project.microphonePath,
    ...(project.screenEnhancement ? [project.screenEnhancement.path, project.screenEnhancement.sourcePath] : []),
    ...(project.recoverySource ? [project.recoverySource.reportPath] : []),
    project.appearance.image,
    ...(project.appearance.customCursor ? [project.appearance.customCursor.path] : []),
    ...(project.cameraMask ? [project.cameraMask.path, project.cameraMask.sourcePath] : []),
    ...(project.cameraFaceTrack ? [project.cameraFaceTrack.source.path] : []),
    ...(project.cameraSilence ? [project.cameraSilence.source.path] : []),
    ...(project.transcript?.source.path ? [project.transcript.source.path] : []),
    ...(project.audio?.background ? [project.audio.background.path] : []),
    ...(project.audio?.voiceovers ?? []).map(clip => clip.path),
  ].filter((p) => p !== null);
}
function mapProjectAssets(project, map) {
  return {
    ...project,
    mediaPath: project.mediaPath === null ? null : map(project.mediaPath),
    cameraPath: project.cameraPath === null ? null : map(project.cameraPath),
    microphonePath:
      project.microphonePath === null ? null : map(project.microphonePath),
    ...(project.screenEnhancement ? { screenEnhancement: { ...project.screenEnhancement, path: map(project.screenEnhancement.path), sourcePath: map(project.screenEnhancement.sourcePath) } } : {}),
    ...(project.recoverySource ? { recoverySource: { ...project.recoverySource, reportPath: map(project.recoverySource.reportPath) } } : {}),
    ...(project.cameraMask
      ? { cameraMask: { ...project.cameraMask, path: map(project.cameraMask.path), sourcePath: map(project.cameraMask.sourcePath) } }
      : {}),
    ...(project.audio ? { audio: { ...project.audio, background: project.audio.background ? { ...project.audio.background, path: map(project.audio.background.path) } : null, voiceovers: project.audio.voiceovers.map(clip => ({ ...clip, path: map(clip.path) })) } } : {}),
    ...(project.cameraFaceTrack ? { cameraFaceTrack: { ...project.cameraFaceTrack, source: { ...project.cameraFaceTrack.source, path: map(project.cameraFaceTrack.source.path) } } } : {}),
    ...(project.cameraSilence ? { cameraSilence: { ...project.cameraSilence, source: { ...project.cameraSilence.source, path: map(project.cameraSilence.source.path) } } } : {}),
    ...(project.transcript?.source.path ? { transcript: { ...project.transcript, source: { ...project.transcript.source, path: map(project.transcript.source.path) } } } : {}),
    appearance: {
      ...project.appearance,
      ...(project.appearance.customCursor ? { customCursor: { ...project.appearance.customCursor, path: map(project.appearance.customCursor.path) } } : {}),
      image:
        project.appearance.image === null
          ? null
          : map(project.appearance.image),
    },
  };
}
function contained(base, file) {
  const rel = path.relative(base, file);
  return (
    rel !== "" &&
    !path.isAbsolute(rel) &&
    rel !== ".." &&
    !rel.startsWith(`..${path.sep}`)
  );
}
function portableAssetPath(base, relative) {
  if (
    typeof relative !== "string" ||
    relative.includes("\\") ||
    /^[a-z][a-z\d+.-]*:/i.test(relative) ||
    path.isAbsolute(relative) ||
    relative.split("/").some((p) => p === ".." || p === "" || p === ".")
  )
    fail("Project assets must use safe relative local paths.");
  const resolved = path.resolve(base, relative);
  if (!contained(base, resolved)) fail("A project asset escapes its folder.");
  return resolved;
}

// Every derived artifact is tied to the exact selected bytes. Verify each file
// once, even when a mask, face trajectory and transcript share the same source.
async function verifyProjectSources(project) {
  const sources = [];
  if (project.recoverySource?.reportSHA256) sources.push({ path: project.recoverySource.reportPath, sha256: project.recoverySource.reportSHA256, label: "Recording recovery report" });
  if (project.screenEnhancement) sources.push({ path: project.screenEnhancement.sourcePath, sha256: project.screenEnhancement.sourceSHA256, label: "Screen enhancement" });
  if (project.appearance.customCursor) sources.push({ path: project.appearance.customCursor.path, sha256: project.appearance.customCursor.sha256, label: "Custom cursor" });
  if (project.appearance.image && project.appearance.backgroundImageSource) sources.push({ path: project.appearance.image, sha256: project.appearance.backgroundImageSource.sha256, label: "Background image" });
  if (project.cameraMask) sources.push({ path: project.cameraMask.sourcePath, sha256: project.cameraMask.sourceSHA256, label: "Camera mask", camera: true });
  if (project.cameraFaceTrack) {
    if (project.cameraFaceTrack.source.path !== project.cameraPath) fail("Camera face analysis belongs to another source.");
    sources.push({ ...project.cameraFaceTrack.source, label: "Camera face analysis" });
  }
  if (project.cameraSilence) {
    if (![project.microphonePath, project.mediaPath, project.cameraPath].includes(project.cameraSilence.source.path)) fail("Camera silence analysis belongs to another source.");
    sources.push({ ...project.cameraSilence.source, label: "Camera silence analysis" });
  }
  if (project.transcript?.source.path && project.transcript.source.sha256) sources.push({ ...project.transcript.source, label: "Transcript" });
  if (project.privacy?.analysis && project.mediaPath) sources.push({ path: project.mediaPath, sha256: project.privacy.analysis.source.sha256, label: "Privacy analysis" });
  const digests = new Map();
  for (const source of sources) {
    let digest = digests.get(source.path);
    if (!digest) {
      const handle = await fsp.open(source.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const before = await handle.stat();
        if (!before.isFile()) fail(`${source.label} source is not a regular file.`);
        const hash = crypto.createHash("sha256"), chunk = Buffer.allocUnsafe(1024 * 1024); let offset = 0;
        while (offset < before.size) { const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, before.size - offset), offset); if (!bytesRead) fail(`${source.label} source changed during verification.`); hash.update(chunk.subarray(0, bytesRead)); offset += bytesRead; }
        const after = await handle.stat(), current = await fsp.lstat(source.path);
        if ([after, current].some(s => !s.isFile() || s.dev !== before.dev || s.ino !== before.ino || s.size !== before.size || s.mtimeMs !== before.mtimeMs || s.ctimeMs !== before.ctimeMs)) fail(`${source.label} source changed during verification.`);
        digest = hash.digest("hex"); digests.set(source.path, digest);
      } finally { await handle.close(); }
    }
    if (digest !== source.sha256) fail(`${source.label} does not match the current ${source.camera ? "camera" : "source"} media.`);
  }
}
async function readPortableProject(file, cacheRoot) {
  if (await require("./project-bundle.cjs").isProjectBundle(file)) {
    if (!cacheRoot) fail("A local extraction directory is required to open this bundled project.");
    const project = await require("./project-bundle.cjs").readProjectBundle(file, cacheRoot);
    await verifyProjectSources(project);
    return project;
  }
  const stat = await fsp.stat(file);
  if (!stat.isFile() || stat.size > MAX_PROJECT_BYTES)
    fail("Project file is too large or invalid.");
  let parsed;
  try {
    parsed = JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    fail("This is not a valid REVA Studio project.");
  }
  const project = validateProject(parsed);
  const base = await fsp.realpath(path.dirname(file));
  const mapping = new Map();
  for (const relative of projectAssets(project)) {
    const resolved = await fsp.realpath(portableAssetPath(base, relative));
    if (!contained(base, resolved) || !(await fsp.stat(resolved)).isFile())
      fail("A project asset is missing or outside its folder.");
    mapping.set(relative, resolved);
  }
  const resolved = mapProjectAssets(project, (p) => mapping.get(p));
  await verifyProjectSources(resolved);
  return resolved;
}
async function writePortableProject(file, input, assertGranted) {
  const project = validateProject(input);
  const base = await fsp.realpath(path.dirname(file));
  const assetsDirectory = path.join(
    base,
    `${path.basename(file, path.extname(file))}.assets`,
  );
  await fsp.mkdir(assetsDirectory, { recursive: true });
  const assetsReal = await fsp.realpath(assetsDirectory);
  if (!contained(base, assetsReal))
    fail("The project asset directory resolves outside its folder.");
  const mapping = new Map();
  for (const source of new Set(projectAssets(project))) {
    const real = await assertGranted(source);
    if (contained(assetsReal, real)) {
      mapping.set(source, path.relative(base, real).split(path.sep).join("/"));
      continue;
    }
    const stat = await fsp.stat(real);
    const identity = crypto
      .createHash("sha256")
      .update(`${real}\0${stat.size}\0${stat.mtimeMs}\0${stat.ino}`)
      .digest("hex")
      .slice(0, 24);
    const extension = path
      .extname(real)
      .toLowerCase()
      .replace(/[^.a-z0-9]/g, "")
      .slice(0, 12);
    const target = path.join(assetsReal, `${identity}${extension}`);
    try {
      await fsp.copyFile(real, target, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await fsp.lstat(target);
      if (
        !existing.isFile() ||
        existing.isSymbolicLink() ||
        existing.size !== stat.size
      )
        fail("An existing project asset conflicts with the selected source.");
    }
    mapping.set(source, path.relative(base, target).split(path.sep).join("/"));
  }
  const portable = mapProjectAssets(project, (p) => mapping.get(p));
  await verifyProjectSources(mapProjectAssets(portable, (p) => path.resolve(base, p)));
  const json = JSON.stringify(portable, null, 2);
  if (Buffer.byteLength(json) > MAX_PROJECT_BYTES)
    fail("Project data exceeds the 64 MiB project-file limit.");
  const temp = path.join(
    base,
    `.${path.basename(file)}.${crypto.randomUUID()}.tmp`,
  );
  const backupTemp = path.join(
    base,
    `.${path.basename(file)}.${crypto.randomUUID()}.bak.tmp`,
  );
  try {
    await fsp.writeFile(temp, json, { flag: "wx", mode: 0o600 });
    try {
      const existing = await fsp.lstat(file);
      if (!existing.isFile() || existing.isSymbolicLink())
        fail("The project destination must be a regular file.");
      await fsp.copyFile(file, backupTemp, fs.constants.COPYFILE_EXCL);
      await fsp.rename(backupTemp, `${file}.bak`);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    await fsp.rename(temp, file);
  } finally {
    await fsp.rm(temp, { force: true });
    await fsp.rm(backupTemp, { force: true });
  }
  return file;
}

function parseByteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size <= 0)
    fail("Unsatisfiable byte range.");
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0)
      fail("Unsatisfiable byte range.");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= size ||
    end < start
  )
    fail("Unsatisfiable byte range.");
  return { start, end: Math.min(end, size - 1) };
}

function validateExport(input) {
  const o = object(input, "Export options");
  const project = validateProject(o.project);
  if (!project.mediaPath || project.trimEnd <= project.trimStart)
    fail("Import or record a video before exporting.");
  const fps = integer(o.fps, 1, 60, "Export frame rate");
  const width = integer(o.width, 2, 8192, "Export width");
  const height = integer(o.height, 2, 8192, "Export height");
  if (width * height > MAX_EXPORT_PIXELS)
    fail("Export dimensions exceed the 8K frame memory budget.");
  const format = choice(o.format, ["mp4", "prores", "gif"], "Export format");
  if (format !== "gif" && (width % 2 || height % 2))
    fail("Video dimensions must be even.");
  const duration = projectSlices(project).reduce(
    (total, s) => total + (s.end - s.start) / s.speed,
    0,
  );
  return {
    format,
    fps,
    width,
    height,
    quality: choice(
      o.quality,
      ["high", "balanced", "small", "tiny"],
      "Export quality",
    ),
    codec: choice(o.codec ?? "h264", ["h264", "hevc", "both"], "Export codec"),
    encoding: choice(o.encoding ?? "software", ["software", "hardware"], "Export encoding"),
    gifHighQuality: boolean(o.gifHighQuality ?? false, "High-quality GIF"),
    gifLoop: boolean(o.gifLoop ?? true, "Loop GIF"),
    proresProfile: choice(
      o.proresProfile ?? "422-hq",
      ["422-lt", "422", "422-hq", "4444"],
      "ProRes profile",
    ),
    destination: choice(
      o.destination ?? "file",
      ["file", "clipboard"],
      "Export destination",
    ),
    project,
    duration,
    frameCount: Math.ceil(duration * fps),
  };
}
const { getSlices: projectSlices } = require("../shared/timeline.mjs");


function exportCodecs(options) {
  return options.format === "mp4" && options.codec === "both"
    ? options.destination === "file" ? ["h264", "hevc"] : ["h264"]
    : [options.codec === "both" ? "h264" : options.codec];
}

function buildEncoderArgs(options, output, audioTracks) {
  const o = validateExport(options);
  const codecs = exportCodecs(o), outputs = Array.isArray(output) ? output : [output];
  if (outputs.length !== codecs.length || outputs.some(file => typeof file !== "string" || !file)) fail("Each selected export codec requires its own output file.");
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostats",
    "-y",
    "-f",
    "image2pipe",
    "-framerate",
    String(o.fps),
    "-vcodec",
    "png",
    "-i",
    "pipe:0",
  ];
  let labels = [];
  if (o.format !== "gif") {
    const graph = require("./audio-mix.cjs").buildAudioGraph(o.project, o.duration, audioTracks);
    args.push(...graph.inputArgs);
    if (graph.label) {
      labels = outputs.length === 1 ? [graph.label] : outputs.map((_, index) => `[paired_audio_${index}]`);
      if (outputs.length > 1) graph.filters.push(`${graph.label}asplit=${outputs.length}${labels.join("")}`);
      args.push("-filter_complex", graph.filters.join(";"));
    }
  }
  for (let index = 0; index < outputs.length; index++) {
    const codec = codecs[index];
    if (o.format !== "gif") {
      args.push("-map", "0:v:0");
      if (labels[index]) {
        args.push("-map", labels[index], "-c:a", o.format === "prores" ? "pcm_s24le" : "aac");
        if (o.format === "mp4") args.push("-b:a", "192k");
      } else args.push("-an");
      if (o.format === "prores")
        args.push(
          "-c:v",
          "prores_ks",
          "-profile:v",
          String({ "422-lt": 1, 422: 2, "422-hq": 3, 4444: 4 }[o.proresProfile]),
          "-pix_fmt",
          o.proresProfile === "4444" ? "yuva444p10le" : "yuv422p10le",
        );
      else {
        const crf = { high: 17, balanced: 22, small: 28, tiny: 34 }[o.quality];
        if (o.encoding === "hardware") {
          const bitRate = Math.max(100000, Math.round(o.width * o.height * o.fps * { high: .24, balanced: .12, small: .06, tiny: .03 }[o.quality] * (codec === "hevc" ? .7 : 1)));
          args.push("-c:v", codec === "hevc" ? "hevc_videotoolbox" : "h264_videotoolbox", "-allow_sw", "0", "-b:v", String(bitRate));
        } else args.push("-c:v", codec === "hevc" ? "libx265" : "libx264", "-preset", "veryfast", "-crf", String(crf));
        args.push(
          "-pix_fmt",
          "yuv420p",
          "-vf",
          "scale=out_color_matrix=bt709:out_range=full,setparams=range=full:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
          "-color_range",
          "pc",
          "-colorspace",
          "bt709",
          "-color_primaries",
          "bt709",
          "-color_trc",
          "bt709",
          "-movflags",
          "+faststart",
        );
        if (codec === "hevc") args.push("-tag:v", "hvc1");
      }
    } else {
      // A per-frame palette bounds retained frames even for long recordings.
      args.push(
        "-filter_complex",
        `[0:v]split[a][b];[a]palettegen=stats_mode=single:max_colors=${o.gifHighQuality ? 256 : 128}[p];[b][p]paletteuse=new=1:dither=${o.gifHighQuality ? "sierra2_4a" : "bayer:bayer_scale=3"}`,
        "-an",
        "-loop",
        o.gifLoop ? "0" : "-1",
      );
    }
    args.push(
      "-frames:v",
      String(o.frameCount),
      "-t",
      String(o.duration),
      "-f",
      o.format === "gif" ? "gif" : o.format === "prores" ? "mov" : "mp4",
      outputs[index],
    );
  }
  return args;
}
function validatePng(input, width, height) {
  if (
    !(input instanceof Uint8Array) ||
    input.byteLength > width * height * 5 + 1024 * 1024
  )
    fail("Export frame exceeds its memory budget.");
  const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (
    buffer.length < 45 ||
    !buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    fail("Export frame must be a PNG.");
  if (
    buffer.readUInt32BE(8) !== 13 ||
    buffer.toString("ascii", 12, 16) !== "IHDR" ||
    buffer.readUInt32BE(16) !== width ||
    buffer.readUInt32BE(20) !== height
  )
    fail("Export frame dimensions do not match the selected export.");
  let cursor = 8,
    hasData = false,
    ended = false;
  while (cursor + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(cursor);
    if (length > buffer.length - cursor - 12)
      fail("Export frame contains a truncated PNG chunk.");
    const type = buffer.toString("ascii", cursor + 4, cursor + 8);
    if (type === "IDAT") hasData = true;
    cursor += length + 12;
    if (type === "IEND") {
      if (length !== 0 || cursor !== buffer.length)
        fail("Export frame has invalid trailing data.");
      ended = true;
      break;
    }
  }
  if (!hasData || !ended) fail("Export frame is incomplete.");
  return buffer;
}

module.exports = {
  MAX_PROJECT_BYTES,
  MEDIA_FORMATS,
  validateProject,
  validateCursor,
  verifyProjectSources,
  validateCameraLayout,
  validateCameraMask,
  validateSpring,
  validateCursorSettings,
  validateRecordingMarkers,
  validatePrivacyAnalysis,
  projectAssets,
  mapProjectAssets,
  contained,
  portableAssetPath,
  readPortableProject,
  writePortableProject,
  parseByteRange,
  validateExport,
  projectSlices,
  tempoFilters,
  buildEncoderArgs,
  exportCodecs,
  validatePng,
  object,
  number,
  integer,
  string,
  boolean,
  choice,
};
