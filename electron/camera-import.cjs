"use strict";
const { parseCameraLayout, parseCameraScenes, parseCameraProcessing } = require("../shared/camera-effects.cjs");

const object = (value, label) => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Screen Studio camera import: ${label} must be an object.`); return value; };
const field = (value, key, fallback) => Object.hasOwn(value, key) ? value[key] : fallback;
const number = (value, min, max, label) => { if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`Screen Studio camera import: ${label} is invalid.`); return value; };
const flag = (value, label) => { if (typeof value !== "boolean") throw new Error(`Screen Studio camera import: ${label} must be boolean.`); return value; };

/** Source defaults/field mapping have one owner for default and ranged layouts. */
function originalCameraLayout(input, cameraInput = {}) {
  if (input === undefined) return undefined;
  const layout = object(input, "layout"), camera = object(cameraInput, "camera config");
  const overlay = layout.cameraOverlay === undefined ? {} : object(layout.cameraOverlay, "cameraOverlay");
  const split = layout.splitScreen === undefined ? {} : object(layout.splitScreen, "splitScreen");
  const cutout = layout.cutoutCamera === undefined ? {} : object(layout.cutoutCamera, "cutoutCamera");
  const background = camera.background === undefined ? {} : object(camera.background, "camera background");
  return parseCameraLayout({
    type: field(layout, "type", "camera-overlay"),
    overlay: { position: field(overlay, "overlayCameraPosition01", { x: 1, y: 1 }), sizeRatio: field(overlay, "overlayCameraSizeRatio01", .5), paddingRatio: field(overlay, "overlayCameraPaddingRatio01", .5), aspectRatio: field(overlay, "overlayCameraAspectRatio", 1), zoomScale: field(overlay, "overlayZoomedCameraScale", .8) },
    split: { direction: field(split, "splitDirection", "auto"), flip: field(split, "splitFlip", false), screenRatio: field(split, "splitScreenRatio01", null), enablePadding: field(split, "enablePadding", false) },
    cutout: { positionX: field(cutout, "cutoutCameraPositionX01", 1), sizeRatio: field(cutout, "cutoutCameraSizeRatio01", .5), aspectRatio: field(cutout, "cutoutCameraAspectRatio", null), zoomScale: field(cutout, "cutoutCameraZoomedScale", .8), edgeSoftness: field(background, "edgeFalloff01", .2), inset: field(background, "edgeInsetPx", 0) },
  });
}

function importCameraScenes(input, durationSeconds, cameraInput = {}) {
  if (!Array.isArray(input) || input.length > 10000) throw new Error("Screen Studio camera import: layout ranges exceed the 10,000-scene memory budget.");
  const scenes = input.map(raw => {
    const scene = object(raw, "layout range");
    if (scene.version !== undefined && scene.version !== 2) throw new Error("Screen Studio camera import: unsupported layout range version (expected 2).");
    const start = number(scene.sourceStartMs, 0, durationSeconds * 1000, "layout start") / 1000, end = number(scene.sourceEndMs, 0, durationSeconds * 1000, "layout end") / 1000;
    let layout;
    if (scene.type === "fullscreen-camera" || scene.type === "screen-only") {
      const config = object(scene[scene.type === "fullscreen-camera" ? "fullscreenCamera" : "screenOnly"] ?? {}, scene.type);
      // The retained serializer establishes these variants, but no nonempty
      // subtype settings. Reject unknown settings instead of guessing meaning.
      if (Object.keys(config).length) throw new Error(`Screen Studio camera import: nonempty ${scene.type} settings have not been verified.`);
      const cameraLayout = originalCameraLayout({ ...scene, type: "camera-overlay" }, cameraInput);
      layout = scene.type === "fullscreen-camera" ? { type: scene.type, enablePadding: false, cameraLayout } : { type: scene.type, cameraLayout };
    } else layout = originalCameraLayout(scene, cameraInput);
    return { id: scene.id, start, end, layout, ...(scene.isDisabled === undefined ? {} : { disabled: flag(scene.isDisabled, "layout disabled") }) };
  });
  return parseCameraScenes(scenes, durationSeconds);
}

const ORIGINAL_LOOKS = Object.freeze({ original: "none", studio: "studio", cinema: "cinematic", film: "film", golden: "warm", cream: "cream", terra: "terra", moody: "moody", arctic: "cool", neon: "neon", punch: "punch", fade: "fade", mono: "mono" });
function importCameraAppearance(input, warnings = []) {
  const config = object(input, "project config"), camera = config.camera === undefined ? {} : object(config.camera, "camera config"), patch = {};
  const warn = value => { if (!warnings.includes(value)) warnings.push(value); };
  const layout = originalCameraLayout(config.defaultLayout, camera); if (layout !== undefined) patch.cameraLayout = layout;
  if (camera.enableFaceTracking !== undefined) {
    patch.cameraFollowFace = flag(camera.enableFaceTracking, "face tracking");
    if (patch.cameraFollowFace) warn("Face following is preserved; run local camera analysis to produce a genuine Vision face track for this media.");
  }
  if (camera.hideDuringSilenceMs !== undefined) {
    patch.cameraHideDuringSilence = camera.hideDuringSilenceMs !== null;
    if (camera.hideDuringSilenceMs !== null) {
      patch.cameraSilenceMinimumSeconds = number(camera.hideDuringSilenceMs, 100, 60000, "minimum silence duration") / 1000;
      warn("Camera silence visibility is preserved; run local camera analysis to measure the selected audio's quiet ranges.");
    }
  }
  const hasProcessing = ["lut", "lutIntensity", "sharpen01", "grain"].some(key => Object.hasOwn(camera, key));
  if (hasProcessing) {
    let look = "none";
    if (camera.lut !== undefined && camera.lut !== null) {
      if (typeof camera.lut === "string" && Object.hasOwn(ORIGINAL_LOOKS, camera.lut.toLowerCase())) look = ORIGINAL_LOOKS[camera.lut.toLowerCase()];
      else {
        let retained; try { retained = JSON.stringify(camera.lut); } catch { throw new Error("Screen Studio camera import: invalid LUT metadata."); }
        if (retained.length > 32768) throw new Error("Screen Studio camera import: LUT metadata exceeds its 32 KiB budget.");
        warn(`The original camera LUT is not resolved to a local .cube file. Retained source LUT metadata: ${retained}`);
      }
    }
    patch.cameraProcessing = parseCameraProcessing({ look, lut: null, lutIntensity: field(camera, "lutIntensity", 1), sharpen: field(camera, "sharpen01", 0), grain: field(camera, "grain", 0) });
    if (look !== "none") warn("Named camera looks use independently implemented local color transforms; equivalence to the original application's LUT artwork is unverified.");
  }
  if (config.output?.avoidEmptyZoomArea !== undefined) patch.avoidEmptyZoomArea = flag(config.output.avoidEmptyZoomArea, "legacy avoid-empty crop");
  return patch;
}

module.exports = { originalCameraLayout, importCameraScenes, importCameraAppearance };
