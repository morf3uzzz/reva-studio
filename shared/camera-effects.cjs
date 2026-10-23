"use strict";
const { cameraSourceOffsetSeconds } = require("./camera-clock.mjs");

// Canonical camera persistence/native-result boundary. Parsed facts are shared
// by project loading, helper results and the original-project import adapter.
const object = (value, label) => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`); return value; };
const number = (value, min, max, label) => { if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} is out of range.`); return value; };
const string = (value, max, label) => { if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new Error(`${label} is invalid.`); return value; };
const boolean = (value, label) => { if (typeof value !== "boolean") throw new Error(`${label} must be true or false.`); return value; };
const choice = (value, choices, label) => { if (!choices.includes(value)) throw new Error(`${label} is invalid.`); return value; };
const list = (value, maximum, label, parse) => { if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} is too large or invalid.`); return value.map(parse); };
const integer = (value, min, max, label) => { number(value, min, max, label); if (!Number.isInteger(value)) throw new Error(`${label} must be an integer.`); return value; };

function parseCameraLayout(input) {
  const c = object(input, "Camera layout"), overlay = object(c.overlay, "Camera overlay"), position = object(overlay.position, "Camera overlay position"), split = object(c.split, "Camera split layout"), cutout = object(c.cutout, "Camera cutout");
  const screenRatio = split.screenRatio === null ? null : number(split.screenRatio, Number.MIN_VALUE, 1 - Number.EPSILON, "Camera split screen ratio");
  return {
    type: choice(c.type, ["camera-overlay", "split-screen", "cutout-camera"], "Camera layout type"),
    overlay: { position: { x: number(position.x, 0, 1, "Camera overlay x"), y: number(position.y, 0, 1, "Camera overlay y") }, sizeRatio: number(overlay.sizeRatio, Number.MIN_VALUE, 1, "Camera overlay size"), paddingRatio: number(overlay.paddingRatio, 0, 1, "Camera overlay padding"), aspectRatio: number(overlay.aspectRatio, Number.MIN_VALUE, Number.MAX_VALUE, "Camera overlay aspect ratio"), zoomScale: number(overlay.zoomScale, Number.MIN_VALUE, 1, "Camera overlay zoom scale"), ...(overlay.shrinkDuringZoom === undefined ? {} : { shrinkDuringZoom: boolean(overlay.shrinkDuringZoom, "Camera overlay zoom shrinking") }) },
    split: { direction: choice(split.direction, ["auto", "horizontal", "vertical"], "Camera split direction"), flip: boolean(split.flip, "Camera split flip"), screenRatio, enablePadding: boolean(split.enablePadding, "Camera split padding") },
    cutout: { positionX: number(cutout.positionX, 0, 1, "Camera cutout x"), sizeRatio: number(cutout.sizeRatio, Number.MIN_VALUE, 1, "Camera cutout size"), aspectRatio: cutout.aspectRatio === null ? null : number(cutout.aspectRatio, Number.MIN_VALUE, Number.MAX_VALUE, "Camera cutout aspect ratio"), zoomScale: number(cutout.zoomScale, Number.MIN_VALUE, 1, "Camera cutout zoom scale"), edgeSoftness: number(cutout.edgeSoftness, 0, 1, "Camera cutout edge softness"), inset: number(cutout.inset, 0, 8, "Camera cutout edge inset"), ...(cutout.shrinkDuringZoom === undefined ? {} : { shrinkDuringZoom: boolean(cutout.shrinkDuringZoom, "Camera cutout zoom shrinking") }) },
  };
}
function parseCameraScenes(input, duration) {
  number(duration, 0, 86400, "Scene source duration");
  const ids = new Set();
  return list(input, 10000, "Camera scenes", raw => {
    const s = object(raw, "Camera scene"), id = string(s.id, 256, "Camera scene id");
    if (!id || ids.has(id)) throw new Error("Camera scene ids must be nonempty and unique."); ids.add(id);
    const start = number(s.start, 0, duration, "Camera scene start"), end = number(s.end, start, duration, "Camera scene end");
    if (end <= start) throw new Error("Camera scenes must have positive source duration.");
    const layout = object(s.layout, "Camera scene layout");
    const retained = layout.cameraLayout === undefined ? {} : { cameraLayout: parseCameraLayout(layout.cameraLayout) };
    return { id, start, end, layout: layout.type === "fullscreen-camera" ? { type: layout.type, enablePadding: boolean(layout.enablePadding, "Fullscreen camera padding"), ...retained } : layout.type === "screen-only" ? { type: layout.type, ...retained } : parseCameraLayout(layout), ...(s.disabled === undefined ? {} : { disabled: boolean(s.disabled, "Camera scene disabled") }) };
  });
}
function parseCameraLUT(input) {
  const value = object(input, "Camera LUT"), size = integer(value.size, 2, 65, "Camera LUT size");
  const domain = (raw, label) => { const parsed = list(raw, 3, label, value => number(value, -Number.MAX_VALUE, Number.MAX_VALUE, label)); if (parsed.length !== 3) throw new Error(`${label} must have three components.`); return parsed; };
  const domainMin = domain(value.domainMin, "Camera LUT minimum"), domainMax = domain(value.domainMax, "Camera LUT maximum");
  if (domainMin.some((value, index) => Math.fround(value) >= Math.fround(domainMax[index]) || !Number.isFinite(Math.fround(domainMax[index] - value)))) throw new Error("Camera LUT domain must have a positive finite GPU-representable extent.");
  const data = list(value.data, size ** 3 * 3, "Camera LUT colors", value => number(value, -65504, 65504, "Camera LUT component"));
  if (data.length !== size ** 3 * 3) throw new Error("Camera LUT does not match its declared 3D size.");
  return { title: string(value.title, 4096, "Camera LUT title"), size, domainMin, domainMax, data };
}
function parseCameraProcessing(input) {
  const value = object(input, "Camera processing");
  return { look: choice(value.look, ["none", "warm", "cool", "mono", "cinematic", "studio", "film", "cream", "terra", "moody", "neon", "punch", "fade"], "Camera look"), lut: value.lut === null ? null : parseCameraLUT(value.lut), lutIntensity: number(value.lutIntensity, 0, 1, "Camera LUT intensity"), sharpen: number(value.sharpen, 0, 1, "Camera sharpen"), grain: number(value.grain ?? 0, 0, 1, "Camera grain"), ...(value.gradingEnabled === undefined ? {} : { gradingEnabled: boolean(value.gradingEnabled, "Camera color grading enabled") }) };
}
function parseSource(input) {
  const value = object(input, "Camera analysis source"), path = string(value.path, 32768, "Camera analysis source path"), sha256 = string(value.sha256, 64, "Camera analysis SHA256");
  // Portable projects retain relative asset identities until the single owning
  // project-file boundary resolves them. The native wrapper requires grants.
  if (!path || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Camera analysis requires a source path and SHA256.");
  return { path, sha256, duration: number(value.duration, 0.001, 86400, "Camera analysis duration"), ...(value.width === undefined ? {} : { width: integer(value.width, 1, 32768, "Camera analysis width") }), ...(value.height === undefined ? {} : { height: integer(value.height, 1, 32768, "Camera analysis height") }) };
}
function parseIntervals(input, duration, label) {
  let previousEnd = -1;
  return list(input, 100000, label, raw => {
    const value = object(raw, label), start = number(value.start, 0, duration, `${label} start`), end = number(value.end, start, duration, `${label} end`);
    if (end <= start || start < previousEnd) throw new Error(`${label} must be positive, ordered and disjoint.`);
    previousEnd = end; return { start, end };
  });
}
function parseCoverage(input, duration) {
  const value = object(input, "Camera analysis coverage");
  return { complete: boolean(value.complete, "Camera analysis completeness"), intervals: parseIntervals(value.intervals, duration, "Camera analysis coverage"), limitations: list(value.limitations, 1000, "Camera analysis limitations", value => string(value, 32768, "Camera analysis limitation")) };
}
function parseCameraFaceTrack(input) {
  const value = object(input, "Camera face track");
  if (value.version !== 1 || value.coordinateSpace !== "oriented-top-left-normalized") throw new Error("Unsupported camera face track format.");
  const source = parseSource(value.source), coverage = parseCoverage(value.coverage, source.duration);
  if (!source.width || !source.height) throw new Error("Camera face tracks require oriented video dimensions.");
  let previous = -1;
  const samples = list(value.samples, 100000, "Camera face samples", raw => {
    const sample = object(raw, "Camera face sample"), t = number(sample.t, 0, source.duration, "Camera face sample time");
    if (t <= previous) throw new Error("Camera face samples must have strictly increasing timestamps."); previous = t;
    if (!coverage.intervals.some(range => t >= range.start && t < range.end)) throw new Error("Camera face sample is outside measured coverage.");
    let face = null;
    if (sample.face !== null) {
      const box = object(sample.face, "Camera face rectangle");
      face = { x: number(box.x, 0, 1, "Camera face x"), y: number(box.y, 0, 1, "Camera face y"), width: number(box.width, Number.MIN_VALUE, 1, "Camera face width"), height: number(box.height, Number.MIN_VALUE, 1, "Camera face height"), confidence: number(box.confidence, 0, 1, "Camera face confidence") };
      if (face.x + face.width > 1 + 1e-7 || face.y + face.height > 1 + 1e-7) throw new Error("Camera face rectangle extends outside its source.");
    }
    return { t, ...(sample.requestedTime === undefined ? {} : { requestedTime: number(sample.requestedTime, 0, source.duration, "Requested camera sample time") }), face };
  });
  return { version: 1, source, coordinateSpace: value.coordinateSpace, sampleInterval: number(value.sampleInterval, 0.001, 60, "Camera face sample interval"), samples, coverage };
}
function parseCameraSilence(input) {
  const value = object(input, "Camera silence analysis");
  if (value.version !== 1) throw new Error("Unsupported camera silence format.");
  const source = parseSource(value.source), coverage = parseCoverage(value.coverage, source.duration), intervals = parseIntervals(value.intervals, source.duration, "Camera silence intervals");
  const minimumSeconds = number(value.minimumSeconds, 0.1, 60, "Camera silence minimum duration");
  if (intervals.some(range => range.end - range.start + 1e-7 < minimumSeconds || !coverage.intervals.some(covered => range.start >= covered.start && range.end <= covered.end + 1e-7))) throw new Error("Camera silence intervals must meet the minimum duration and measured coverage.");
  return { version: 1, source, thresholdDB: number(value.thresholdDB, -96, -6, "Camera silence threshold"), minimumSeconds, windowSeconds: number(value.windowSeconds, 0.001, 1, "Camera silence window"), intervals, coverage };
}
function parseCameraAnalysis(input) {
  const value = object(input, "Camera analysis");
  if (value.faceTrack === undefined && value.silence === undefined) throw new Error("Camera analysis has no requested detector results.");
  return { ...(value.faceTrack === undefined ? {} : { faceTrack: parseCameraFaceTrack(value.faceTrack) }), ...(value.silence === undefined ? {} : { silence: parseCameraSilence(value.silence) }) };
}

function parseDeviceFrame(input) {
  const value = object(input, "Device frame"), color = string(value.color, 7, "Device frame color");
  if (!/^#[a-fA-F0-9]{6}$/.test(color)) throw new Error("Device frame color must be an RGB hex color.");
  return { type: choice(value.type, ["none", "phone", "tablet"], "Device frame type"), color, bezelRatio: number(value.bezelRatio, .01, .08, "Device frame bezel width") };
}
function parseScreenShadow(input) {
  const value = object(input, "Screen shadow");
  return { style: choice(value.style, ["classic", "directional"], "Shadow style"), distance: number(value.distance, 0, 100, "Shadow Distance"), angle: number(value.angle, 0, 180, "Shadow Angle"), blur: number(value.blur, 0, 30, "Shadow Blur") };
}
function parseScreenProcessing(input) {
  const value = object(input, "Screen processing");
  return { deband: number(value.deband, 0, 1, "Screen debanding") };
}
function parseCameraCrop(input) {
  const value = object(input, "Camera source crop"), x = number(value.x, 0, 1, "Camera crop x"), y = number(value.y, 0, 1, "Camera crop y"), width = number(value.width, Number.MIN_VALUE, 1, "Camera crop width"), height = number(value.height, Number.MIN_VALUE, 1, "Camera crop height");
  if (x + width > 1 + 1e-9 || y + height > 1 + 1e-9) throw new Error("Camera source crop extends outside the source.");
  return { x, y, width, height };
}
function parseScreenEnhancement(input) {
  const value = object(input, "Screen enhancement"), path = string(value.path, 32768, "Enhanced video path"), sourcePath = string(value.sourcePath, 32768, "Enhanced video source path");
  if (!path || !sourcePath || path === sourcePath) throw new Error("Enhanced video must be a separate local asset.");
  const sourceSHA256 = string(value.sourceSHA256, 64, "Enhancement source SHA256"), modelSHA256 = string(value.modelSHA256, 64, "Enhancement model SHA256");
  if (![sourceSHA256, modelSHA256].every(value => /^[a-f0-9]{64}$/.test(value))) throw new Error("Enhancement source/model digest is invalid.");
  const width = integer(value.width, 1, 3840, "Enhanced video width"), height = integer(value.height, 1, 3840, "Enhanced video height");
  if (Math.min(width, height) > 2160 || width * height > 8_294_400) throw new Error("Enhanced video exceeds its 4K landscape/portrait resource budget.");
  const duration = number(value.duration, .001, 86400, "Enhanced video duration"), sourceStartTime = number(value.sourceStartTime, 0, duration, "Enhanced first real frame time");
  if (sourceStartTime >= duration) throw new Error("Enhanced video has no covered source frames.");
  return { path, sourcePath, sourceSHA256, modelSHA256, modelName: string(value.modelName, 4096, "Enhancement model name"), width, height, duration, sourceStartTime, scale: integer(value.scale, 2, 4, "Enhancement neural scale"), enabled: boolean(value.enabled, "Enhancement enabled"), ...(value.attribution === undefined ? {} : { attribution: string(value.attribution, 32768, "Enhancement attribution") }) };
}

module.exports = { parseCameraLayout, parseCameraScenes, parseCameraLUT, parseCameraProcessing, parseCameraFaceTrack, parseCameraSilence, parseCameraAnalysis, parseDeviceFrame, parseScreenProcessing, parseScreenShadow, parseCameraCrop, cameraSourceOffsetSeconds, parseScreenEnhancement };
