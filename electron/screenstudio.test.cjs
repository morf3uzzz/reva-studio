"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { findTool, runProcess, probe } = require("./media.cjs");
const { importScreenStudio, inspectScreenStudio, parseLocalHls } = require("./screenstudio.cjs");

async function temp(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reva-screenstudio-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
function session(start, duration = 500) {
  return { durationMs: duration, processTimeStartMs: start, processTimeEndMs: start + duration, unixStartMs: 1000000 + start, unixEndMs: 1000000 + start + duration };
}
async function fixture(root, count = 1) {
  const bundle = path.join(root, "Example.screenstudio");
  await fs.mkdir(path.join(bundle, "recording"), { recursive: true });
  const sessions = Array.from({ length: count }, (_, i) => session(1000 + i * 3000));
  const project = {
    json: {
      version: "4.0.0", id: "original-id", name: "Example", createdAt: "2026-10-22T12:00:00.000Z", updatedAt: "2026-10-22T12:00:00.000Z", lastSavedAt: null,
      config: { output: { aspectRatio: "auto", paddingRatio01: 0.1 }, styles: { background: { type: "color", color: "#112233" }, screenBorderRadius: 16, shadow: { intensity: 0.3 }, screenInset: { size: 0 } }, cursor: { hide: false, size: 48, clickEffect: null }, audio: { volume: 1 }, camera: { hide: false, mirror: true }, crop: { rect01: { x: 0, y: 0, width: 1, height: 1 } } },
      scenes: [{ type: "recording", id: "scene", name: "Default", index: 0, slices: [{ id: "slice", sourceStartMs: 0, sourceEndMs: count * 500, timeScale: 1, volume: 1, systemAudioVolume: 1, externalDeviceAudioVolume: 1, hideCursor: false, disableSmoothMouseMovement: false }], zooms: [], layouts: [], masks: [], voiceOvers: [] }], data: {},
    },
    meta: { values: { createdAt: ["Date"], updatedAt: ["Date"] }, v: 1 },
  };
  const metadata = {
    state: "complete", polyrecorderVersion: "4.1.0-5005", sessions,
    recorders: [
      { id: "cursor", type: "cursor", configuration: {}, cursorsInfoFile: "cursors.json" },
      { id: "input", type: "input", configuration: {}, sessions: sessions.map((s, i) => ({ ...s, mouseMovesFilename: `moves-${i}.json`, mouseClicksFilename: `clicks-${i}.json` })) },
      { id: "display", type: "display", configuration: {}, sessions: sessions.map((s, i) => ({ ...s, outputFilename: `display-${i}.mp4`, bounds: { x: 0, y: 0, width: 64, height: 48 }, recordingScale: 0.5, displayRefreshRate: 60 })) },
    ],
  };
  const save = async () => {
    await fs.writeFile(path.join(bundle, "project.json"), JSON.stringify(project));
    await fs.writeFile(path.join(bundle, "recording", "metadata.json"), JSON.stringify(metadata));
  };
  await save();
  await fs.writeFile(path.join(bundle, "meta.json"), JSON.stringify({ json: { version: "4.1.0-5005", requiredVersion: "4.0.0" } }));
  for (let i = 0; i < count; i++) {
    await fs.writeFile(path.join(bundle, "recording", `moves-${i}.json`), "[]");
    await fs.writeFile(path.join(bundle, "recording", `clicks-${i}.json`), "[]");
  }
  return { bundle, project, metadata, save };
}
function hls(uri = "part-0.m4s") {
  return `#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:1\n#EXT-X-VERSION:6\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:0.5,\n${uri}\n#EXT-X-ENDLIST\n`;
}
async function tools() {
  return { ffmpeg: await findTool("ffmpeg"), ffprobe: await findTool("ffprobe") };
}
async function video(ffmpeg, target, color = "red") {
  await runProcess(ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", `color=c=${color}:s=64x48:r=10:d=0.5`, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", target]);
}
async function digest(file) { return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex"); }

test("local HLS parser rejects every manifest capability that can escape its selected bundle", () => {
  assert.deepEqual(parseLocalHls(hls()), { init: "init.mp4", segments: [{ path: "part-0.m4s", duration: 0.5 }], duration: 0.5 });
  for (const uri of ["https://example.test/a.m4s", "file:///tmp/a.m4s", "../a.m4s", "/tmp/a.m4s", "a%2fm4s", "sub/../a.m4s", "sub\\a.m4s", "a.m3u8"])
    assert.throws(() => parseLocalHls(hls(uri)), undefined, uri);
  for (const text of [
    hls().replace("#EXTINF:0.5,", '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:0.5,'),
    hls().replace("#EXTINF:0.5,", "#EXT-X-BYTERANGE:10@0\n#EXTINF:0.5,"),
    hls().replace("#EXTINF:0.5,", "#EXT-X-DISCONTINUITY\n#EXTINF:0.5,"),
    hls().replace("#EXT-X-ENDLIST", ""),
    hls().replace('URI="init.mp4"', 'URI="https://example.test/init.mp4"'),
    hls().replace("#EXTINF:0.5,", "#EXTINF:NaN,"),
    hls().replace("part-0.m4s\n", ""),
    hls() + "extra.m4s\n",
  ]) assert.throws(() => parseLocalHls(text));
});

test("metadata inspection preserves source cuts, reciprocal speed, dates and manual zoom without opening media", async (t) => {
  const root = await temp(t), f = await fixture(root, 2);
  f.project.json.scenes[0].slices = [
    { id: "first", sourceStartMs: 0, sourceEndMs: 250, timeScale: 1, volume: 1 },
    { id: "second", sourceStartMs: 500, sourceEndMs: 1000, timeScale: 0.5, volume: 1, hideCursor: true, disableSmoothMouseMovement: true },
  ];
  f.project.json.scenes[0].zooms = [{ id: "zoom", sourceStartMs: 100, sourceEndMs: 1000, zoom: 3.357, type: "manual", presentation: "screen", manualTargetPoint: { x: 0.5, y: 0.5 }, isDisabled: false, hasInstantAnimation: false }];
  await f.save();
  const result = await inspectScreenStudio(f.bundle);
  assert.equal(result.duration, 1);
  assert.deepEqual(result.slices, [{ id: "first", start: 0, end: 0.25, speed: 1, volume: 1 }, { id: "second", start: 0.5, end: 1, speed: 2, volume: 1, cursorHidden: true, cursorSmooth: false }]);
  assert.equal(result.zooms[0].scale, 3.357);
  assert.equal(result.appearancePatch.background, "#112233");
  assert.equal(result.provenance.files.length, 3);
  assert.equal(result.provenance.files.find((f) => f.path === "project.json").sha256, await digest(path.join(f.bundle, "project.json")));
  assert.deepEqual(result.pauseMarkers, [{ time: 0.5, duration: 2.5 }]);
  assert.equal(Object.hasOwn(result, "typingRanges"), false);
});

test("typing sidecar import converts process milliseconds, derives source ranges and retains only activity metadata", async t => {
  const root = await temp(t), f = await fixture(root, 2);
  f.metadata.sessions = [session(1000, 3000), session(10000, 3000)];
  for (const recorder of f.metadata.recorders) if (recorder.sessions)
    recorder.sessions.forEach((entry, index) => Object.assign(entry, f.metadata.sessions[index]));
  f.project.json.scenes[0].slices[0].sourceEndMs = 6000;
  f.project.json.config.output.aspectRatio = "3:4";
  f.project.json.data["resolved-typing-speed-increase-suggestions-v2"] = { 100: true, 3100: false };
  for (const [index, start] of [1000, 10000].entries()) {
    f.metadata.recorders[1].sessions[index].keyStrokesFilename = `keys-${index}.json`;
    const events = [100, 400, 700, 1000, 1300, 1600].map(offset => ({ processTimeMs: start + offset, keyCode: 11, character: "private-content-must-not-copy", activeModifiers: ["shift"] }));
    if (index === 0) events.push({ processTimeMs: 999, character: "outside" });
    await fs.writeFile(path.join(f.bundle, "recording", `keys-${index}.json`), JSON.stringify(events.reverse()));
  }
  await f.save();
  const result = await inspectScreenStudio(f.bundle);
  assert.deepEqual(result.typingRanges, [{ start: 0.1, end: 1.6, count: 6 }, { start: 3.1, end: 4.6, count: 6 }]);
  assert.deepEqual(result.pauseMarkers, [{ time: 3, duration: 6 }]);
  assert.deepEqual(result.resolvedTypingSuggestions, [0.1]);
  assert.equal(result.appearancePatch.aspect, "3:4");
  assert.ok(result.warnings.some(warning => warning.includes("1 typing events outside")));
  assert.equal(JSON.stringify(result).includes("private-content-must-not-copy"), false);
  assert.equal(JSON.stringify(result).includes("keyCode"), false);
  assert.equal(result.provenance.files.find(file => file.path === "recording/keys-1.json").sha256, await digest(path.join(f.bundle, "recording", "keys-1.json")));
});

test("typing import rejects malformed clocks, path escapes and invalid resolved keys, preserving explicit empty data", async t => {
  const root = await temp(t), f = await fixture(root);
  f.metadata.recorders[1].sessions[0].keyStrokesFilename = "keys.json";
  const file = path.join(f.bundle, "recording", "keys.json");
  await fs.writeFile(file, "[]"); await f.save();
  assert.deepEqual((await inspectScreenStudio(f.bundle)).typingRanges, []);
  for (const contents of ["{}", '[{"processTimeMs":"1200"}]', '[{"character":"no-clock"}]']) {
    await fs.writeFile(file, contents);
    await assert.rejects(inspectScreenStudio(f.bundle), /typing/i);
  }
  await fs.writeFile(file, "[]");
  for (const resolved of [{ "01": true }, { 100: 1 }, { 501: true }, []]) {
    f.project.json.data["resolved-typing-speed-increase-suggestions-v2"] = resolved;
    await f.save();
    await assert.rejects(inspectScreenStudio(f.bundle), /resolved typing/i);
  }
  delete f.project.json.data["resolved-typing-speed-increase-suggestions-v2"];
  f.metadata.recorders[1].sessions[0].keyStrokesFilename = "../outside.json";
  await f.save();
  await assert.rejects(inspectScreenStudio(f.bundle));
});

test("metadata-only import preserves every camera branch, exact edge settings, relative radius and screen animation settings", async (t) => {
  const root = await temp(t), f = await fixture(root);
  // Names and the inactive-branch storage shape are from original 4.0.0 files.
  // Non-default, distinct values catch accidental use of only the active branch.
  f.project.json.config.defaultLayout = {
    type: "cutout-camera",
    cameraOverlay: {
      overlayCameraPosition01: { x: 0.2, y: 0.8 }, overlayCameraSizeRatio01: 0.3025,
      overlayCameraPaddingRatio01: 0.7, overlayCameraAspectRatio: 4 / 3,
      overlayZoomedCameraScale: 0.8,
    },
    splitScreen: { splitDirection: "horizontal", splitFlip: true, splitScreenRatio01: 0.6, enablePadding: true },
    cutoutCamera: { cutoutCameraPositionX01: 1, cutoutCameraSizeRatio01: 0.5454, cutoutCameraAspectRatio: null, cutoutCameraZoomedScale: 0.843 },
    unknown: "not a project field",
  };
  f.project.json.config.camera.background = { blurAmount01: 0.9, edgeFalloff01: 0, edgeInsetPx: 1.7 };
  f.project.json.config.styles.cameraBorderRadiusRatio01 = 0.15;
  f.project.json.config.zooms = { startAnimationEarly: true };
  const spring = { stiffness: 210, damping: 23, mass: 1.75, clamp: false, precision: 0.003 };
  f.project.json.config.animations = { screenMovementSpring: spring };
  f.project.json.scenes[0].zooms = [{ id: "instant", sourceStartMs: 0, sourceEndMs: 500, zoom: 2, type: "manual", presentation: "screen", manualTargetPoint: { x: 0.4, y: 0.6 }, hasInstantAnimation: true }];
  f.metadata.recorders.push({ id: "camera", type: "webcam", configuration: {}, sessions: [{ ...f.metadata.sessions[0], outputFilename: "never-opened-camera.mp4" }] });
  const expected = {
    type: "cutout-camera",
    overlay: { position: { x: 0.2, y: 0.8 }, sizeRatio: 0.3025, paddingRatio: 0.7, aspectRatio: 4 / 3, zoomScale: 0.8 },
    split: { direction: "horizontal", flip: true, screenRatio: 0.6, enablePadding: true },
    cutout: { positionX: 1, sizeRatio: 0.5454, aspectRatio: null, zoomScale: 0.843, edgeSoftness: 0, inset: 1.7 },
  };
  for (const type of ["cutout-camera", "split-screen", "camera-overlay"]) {
    f.project.json.config.defaultLayout.type = type;
    await f.save();
    const before = await digest(path.join(f.bundle, "project.json"));
    const result = await inspectScreenStudio(f.bundle);
    assert.deepEqual(result.appearancePatch.cameraLayout, { ...expected, type });
    assert.equal(result.appearancePatch.cameraRadiusRatio, 0.15);
    assert.equal(result.appearancePatch.zoomStartEarly, true);
    assert.deepEqual(result.appearancePatch.screenSpring, spring);
    assert.equal(result.zooms[0].instant, true);
    assert.equal(result.warnings.some(v => v.includes("Instant zoom transitions")), false);
    assert.equal(Object.hasOwn(result, "cameraSource"), false, "Metadata inspection cannot invent unprobed camera dimensions.");
    assert.equal(await digest(path.join(f.bundle, "project.json")), before);
  }
  await assert.rejects(fs.stat(path.join(f.bundle, "recording", "never-opened-camera.mp4")), { code: "ENOENT" });
});

test("metadata import preserves all cursor controls and routes animation through the canonical boundary", async (t) => {
  const root = await temp(t), f = await fixture(root);
  f.project.json.config.cursor = {
    hide: false, size: 76, set: { id: "custom-6", variants: { pointer: "pointer-4" } },
    alwaysUseDefault: true, hideNotMovingAfterMs: 1700, loopPositionBeforeEndMs: 2000,
    stopMovementInLastPartMs: 500, rotationMode: "directional", rotateOnXMovementRatio: 1.25,
    baseRotation: -25, removeShakeTreshold: 600, optimizeOriginalTypes: false, followRecordedPositionOnHover: false,
    clickEffect: { type: "circle" },
  };
  f.project.json.config.audio.clickSoundEffect = "apple-magic-mouse";
  f.project.json.config.audio.clickSoundEffectVolume = 0.4;
  f.project.json.config.animations = { mouseMovementSpring: { stiffness: 470, damping: 70, mass: 3, clamp: true, precision: 0.002 } };
  await f.save();
  const { appearancePatch: a } = await inspectScreenStudio(f.bundle);
  assert.deepEqual(a.cursorSettings, {
    size: 76, set: { id: "custom-6", variants: { pointer: "pointer-4" } }, alwaysUsePointer: true,
    hideNotMovingAfterMs: 1700, loopPositionBeforeEndMs: 2000, hidden: false,
    clickEffect: "circle", clickSound: "apple-magic-mouse", clickSoundVolume: 0.4,
    baseRotation: -25, rotationMode: "directional", tiltAmount: 1.25,
    stopMovementInLastPartMs: 500, shakeThreshold: 600, optimizeChanges: false, syncWithHovers: false,
  });
  assert.equal(a.cursorSmooth, true); assert.deepEqual(a.cursorSpring, f.project.json.config.animations.mouseMovementSpring);
  f.project.json.config.animations.mouseMovementSpring = null; await f.save();
  assert.equal((await inspectScreenStudio(f.bundle)).appearancePatch.cursorSmooth, false);
  f.project.json.config.cursor.set.id = "unknown-artwork-set"; await f.save();
  await assert.rejects(inspectScreenStudio(f.bundle), /Cursor set id/);
});

test("camera import uses observed defaults for omissions and rejects invalid inactive layout data", async (t) => {
  const root = await temp(t), f = await fixture(root);
  f.project.json.config.defaultLayout = { type: "camera-overlay", cameraOverlay: {}, splitScreen: {}, cutoutCamera: {} };
  await f.save();
  const result = await inspectScreenStudio(f.bundle);
  assert.deepEqual(result.appearancePatch.cameraLayout, {
    type: "camera-overlay",
    overlay: { position: { x: 1, y: 1 }, sizeRatio: 0.5, paddingRatio: 0.5, aspectRatio: 1, zoomScale: 0.8 },
    split: { direction: "auto", flip: false, screenRatio: null, enablePadding: false },
    cutout: { positionX: 1, sizeRatio: 0.5, aspectRatio: null, zoomScale: 0.8, edgeSoftness: 0.2, inset: 0 },
  });
  for (const mutate of [
    c => { c.defaultLayout.type = "screen-only"; },
    c => { c.defaultLayout.cutoutCamera.cutoutCameraSizeRatio01 = 0; },
    c => { c.defaultLayout.splitScreen.splitScreenRatio01 = 1; },
    c => { c.defaultLayout.cameraOverlay.overlayCameraAspectRatio = null; },
    c => { c.camera.background = { edgeInsetPx: 9 }; },
    c => { c.zooms = { startAnimationEarly: 1 }; },
    c => { c.animations = { screenMovementSpring: null }; },
  ]) {
    const before = structuredClone(f.project.json.config);
    mutate(f.project.json.config); await f.save();
    await assert.rejects(inspectScreenStudio(f.bundle), /Screen Studio import:/);
    f.project.json.config = before;
  }
});

test("manual zoom points convert from the original crop-relative coordinates into full-source coordinates", async (t) => {
  const root = await temp(t), f = await fixture(root);
  f.project.json.config.crop.rect01 = { x: 0.25, y: 0.125, width: 0.5, height: 0.75 };
  f.project.json.scenes[0].zooms = [
    { id: "manual", sourceStartMs: 0, sourceEndMs: 250, zoom: 2, type: "manual", manualTargetPoint: { x: 0.25, y: 0.5 }, hasInstantAnimation: false },
    { id: "auto", sourceStartMs: 250, sourceEndMs: 500, zoom: 2, type: "follow-click-groups", manualTargetPoint: { x: 0.25, y: 0.5 } },
  ];
  await f.save();
  const result = await inspectScreenStudio(f.bundle);
  assert.deepEqual({ x: result.zooms[0].x, y: result.zooms[0].y }, { x: 0.375, y: 0.5 });
  assert.equal(result.zooms[0].instant, false);
  assert.deepEqual({ x: result.zooms[1].x, y: result.zooms[1].y }, { x: 0.25, y: 0.5 });
  assert.deepEqual(result.appearancePatch.crop, { x: 0.25, y: 0.125, width: 0.5, height: 0.75 });
});

test("metadata crop preserves sub-ten-percent source crops without guessing encoded pixel dimensions", async t => {
  const root = await temp(t), f = await fixture(root);
  const crop = { x: 0.5, y: 0.5, width: 1 / 3840, height: 1 / 2160 };
  f.project.json.config.crop.rect01 = crop;
  await f.save();
  assert.deepEqual((await inspectScreenStudio(f.bundle)).appearancePatch.crop, crop);
  f.project.json.config.crop.rect01.width = 0;
  await f.save();
  await assert.rejects(inspectScreenStudio(f.bundle), /crop width/);
});

test("unsupported scene, channel, privacy-mask and serialization structures fail explicitly", async (t) => {
  const root = await temp(t), f = await fixture(root);
  const mutations = [
    () => { f.project.json.version = "5.0.0"; },
    () => { f.project.meta.values.createdAt = ["custom", "runCode"]; },
    () => { f.project.json.scenes[0].masks = [{ type: "sensitive-data", isDisabled: false }]; },
    () => { f.metadata.recorders.push({ ...f.metadata.recorders[2], id: "second-display" }); },
    () => { f.metadata.recorders[2].sessions[0].outputFilename = "../outside.mp4"; },
  ];
  for (const mutate of mutations) {
    const project = structuredClone(f.project), metadata = structuredClone(f.metadata);
    mutate(); await f.save();
    await assert.rejects(inspectScreenStudio(f.bundle));
    Object.keys(f.project).forEach((k) => delete f.project[k]); Object.assign(f.project, project);
    Object.keys(f.metadata).forEach((k) => delete f.metadata[k]); Object.assign(f.metadata, metadata);
  }
});

test("real FFmpeg import joins two sessions, remuxes local HLS, synchronizes cursor and preserves sidecars", async (t) => {
  const root = await temp(t), f = await fixture(root, 2), binaries = await tools();
  const recording = path.join(f.bundle, "recording"), cacheRoot = path.join(root, "cache");
  const playlist = path.join(recording, "display-0.m3u8");
  await runProcess(binaries.ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "color=c=red:s=64x48:r=10:d=0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "1", "-hls_time", "0.2", "-hls_playlist_type", "vod", "-hls_segment_type", "fmp4", "-hls_segment_filename", path.join(recording, "part-%d.m4s"), "-hls_fmp4_init_filename", "init.mp4", playlist]);
  await video(binaries.ffmpeg, path.join(recording, "display-1.mp4"), "blue");
  await video(binaries.ffmpeg, path.join(recording, "camera.mp4"), "yellow");
  await runProcess(binaries.ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.5", "-c:a", "aac", path.join(recording, "audio.m4a")]);
  f.metadata.recorders[2].sessions[0].outputFilename = "display-0.m3u8";
  for (const type of ["systemAudio", "microphone", "webcam"]) {
    f.metadata.recorders.push({ id: type, type, configuration: {}, sessions: f.metadata.sessions.map((s) => ({ ...s, outputFilename: type === "webcam" ? "camera.mp4" : "audio.m4a" })) });
  }
  await fs.writeFile(path.join(recording, "moves-0.json"), JSON.stringify([{ processTimeMs: 1100, x: 16, y: 24, type: "mouseMoved", cursorId: "arrow", activeModifiers: [] }]));
  await fs.writeFile(path.join(recording, "clicks-1.json"), JSON.stringify([{ processTimeMs: 4100, x: 48, y: 12, type: "mouseDown", button: "left", cursorId: "arrow", activeModifiers: [] }]));
  await f.save();
  const before = await digest(path.join(f.bundle, "project.json"));
  const result = await importScreenStudio(f.bundle, { ...binaries, cacheRoot });
  assert.equal(result.mediaInfo.duration, 1);
  assert.deepEqual(result.pauseMarkers, [{ time: 0.5, duration: 2.5 }]);
  assert.equal(result.mediaInfo.width, 64);
  assert.equal((await probe(result.mediaInfo.path, binaries.ffprobe)).hasAudio, true);
  const timing = JSON.parse(await runProcess(binaries.ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,start_time,duration", "-of", "json", result.mediaInfo.path]));
  for (const stream of timing.streams) {
    assert.equal(Number(stream.start_time), 0, "AAC priming must not shift video or audio away from source time zero");
    assert.ok(Math.abs(Number(stream.duration) - 1) < 0.001);
  }
  assert.ok(result.microphonePath && result.cameraPath);
  assert.deepEqual(result.cameraSource, { width: 64, height: 48 });
  assert.ok(result.cursor.some((v) => v.t === 0.1 && v.x === 0.25 && v.y === 0.5));
  assert.ok(result.cursor.some((v) => v.t === 0.6 && v.click && v.x === 0.75));
  assert.equal(result.cursor.find(v => v.t === 0.6).event, "mouseDown");
  assert.equal(result.cursor.find(v => v.t === 0.6).cursorType, "arrow");
  assert.deepEqual(result.cursorSourceSize, { width: 64, height: 48 });
  assert.equal(await digest(path.join(f.bundle, "project.json")), before);
  assert.ok(result.provenance.files.some((v) => v.path.endsWith("part-0.m4s")));
  assert.equal((await fs.readdir(path.dirname(result.mediaInfo.path))).includes(".work"), false);
  const rgb = path.join(root, "colors.rgb");
  await runProcess(binaries.ffmpeg, ["-v", "error", "-i", result.mediaInfo.path, "-vf", "select=eq(n\\,1)+eq(n\\,6),scale=1:1,format=rgb24", "-fps_mode", "vfr", "-f", "rawvideo", rgb]);
  const pixels = await fs.readFile(rgb);
  assert.equal(pixels.length, 6);
  assert.ok(pixels[0] > 200 && pixels[2] < 50, "first session remains red");
  assert.ok(pixels[3] < 50 && pixels[5] > 200, "second session remains blue");
});

test("escaping source symlink is rejected and failed import cache is removed", async (t) => {
  const root = await temp(t), f = await fixture(root), binaries = await tools();
  const outside = path.join(root, "outside.mp4");
  await fs.writeFile(outside, "never-open-this");
  await fs.symlink(outside, path.join(f.bundle, "recording", "display-0.mp4"));
  const cacheRoot = path.join(root, "cache");
  await assert.rejects(importScreenStudio(f.bundle, { ...binaries, cacheRoot }), /escapes the selected bundle/);
  assert.deepEqual(await fs.readdir(cacheRoot), []);
  assert.equal(await fs.readFile(outside, "utf8"), "never-open-this");
});

test("invalid HLS and media-tool failure remove owned partial output while originals remain unchanged", async (t) => {
  const root = await temp(t), f = await fixture(root), binaries = await tools(), cacheRoot = path.join(root, "cache");
  f.metadata.recorders[2].sessions[0].outputFilename = "invalid.m3u8";
  await fs.writeFile(path.join(f.bundle, "recording", "invalid.m3u8"), hls("https://example.test/a.m4s"));
  await f.save();
  await assert.rejects(importScreenStudio(f.bundle, { ...binaries, cacheRoot }), /local paths/);
  assert.deepEqual(await fs.readdir(cacheRoot), []);
  f.metadata.recorders[2].sessions[0].outputFilename = "display-0.mp4"; await f.save();
  const original = path.join(f.bundle, "recording", "display-0.mp4");
  await video(binaries.ffmpeg, original);
  const before = await digest(original);
  await assert.rejects(importScreenStudio(f.bundle, { ...binaries, ffmpeg: "/usr/bin/false", cacheRoot }));
  assert.deepEqual(await fs.readdir(cacheRoot), []);
  assert.equal(await digest(original), before);
});

test("cache inside the original bundle is refused before creating it", async (t) => {
  const root = await temp(t), f = await fixture(root), binaries = await tools();
  const cacheRoot = path.join(f.bundle, "new-cache", "child");
  await assert.rejects(importScreenStudio(f.bundle, { ...binaries, cacheRoot }), /outside the original bundle/);
  await assert.rejects(fs.stat(path.join(f.bundle, "new-cache")), { code: "ENOENT" });
});
test("range import preserves layout scenes, disabled loupe settings and masks in original logical recording units", async t => {
  const root = await temp(t), f = await fixture(root), scene = f.project.json.scenes[0];
  f.project.json.config.crop.rect01 = { x: .25, y: .25, width: .5, height: .5 };
  scene.layouts = [{ id: "scene-full", version: 2, sourceStartMs: 0, sourceEndMs: 500, type: "fullscreen-camera", fullscreenCamera: {}, isDisabled: false }];
  scene.masks = [{ id: "private", sourceStartMs: 0, sourceEndMs: 250, bounds: [{ x: 16, y: 12, width: 16, height: 12 }], blur: 44, type: "sensitive-data", isDisabled: false }, { id: "highlight", sourceStartMs: 250, sourceEndMs: 500, bounds: [{ x: 0, y: 0, width: 32, height: 24 }], highlightMaskOpacity: .7, type: "highlight", isDisabled: false }];
  scene.zooms = [{ id: "loupe", sourceStartMs: 0, sourceEndMs: 500, zoom: 2.3, type: "manual", presentation: "loupe", manualTargetPoint: { x: .4, y: .6 }, isDisabled: true, loupeOptions: { radius01: .35, bevelRatio: .2, chromaticAberration: .5, hasGlassOptics: true } }];
  scene.slices[0].volume = .4; scene.slices[0].systemAudioVolume = .6; scene.slices[0].externalDeviceAudioVolume = .8;
  await f.save(); const result = await inspectScreenStudio(f.bundle);
  assert.equal(result.cameraScenes[0].layout.type, "fullscreen-camera"); assert.equal(result.zooms[0].presentation, "loupe"); assert.equal(result.zooms[0].disabled, true); assert.equal(result.zooms[0].loupeOptions.chromaticAberration, .5);
  assert.deepEqual(result.masks[0].bounds[0], { x: .25, y: .25, width: .25, height: .25 }); assert.equal(result.masks[1].opacity, .7);
  assert.equal(result.slices[0].volume, .4); assert.equal(result.slices[0].systemVolume, .6); assert.equal(result.slices[0].cameraVolume, .8);
  scene.masks[1].sourceStartMs = 200; await f.save(); await assert.rejects(inspectScreenStudio(f.bundle), /cannot be active/);
});
test("public bundle import copies verified first-frame voiceovers and preserves their anchored mute policy", async t => {
  const root = await temp(t), f = await fixture(root), found = await tools(), voiceover = path.join(f.bundle, "voiceovers", "narration.wav");
  await fs.mkdir(path.dirname(voiceover)); await video(found.ffmpeg, path.join(f.bundle, "recording", "display-0.mp4"));
  await runProcess(found.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=0.5", voiceover]);
  f.project.json.config.audio.microphoneAudioPreset = "channel-fix";
  f.project.json.scenes[0].voiceOvers = [{ id: "narration", sourceStartMs: 100, voiceoverDurationMs: 500, fileName: "narration.wav", timeScale: 1, volume: .4, hideRecording: true, attachMode: "first-frame", isDisabled: false, source: { type: "speechify", text: "Source metadata retained only", voiceId: "source-id", language: "en" } }];
  await f.save(); const before = await digest(voiceover), result = await importScreenStudio(f.bundle, { ...found, cacheRoot: path.join(root, "cache") }), clip = result.audio.voiceovers[0];
  assert.equal(clip.rate, 1.25); assert.equal(clip.start, .1); assert.equal(clip.end, .5); assert.equal(clip.hideRecording, true); assert.deepEqual(clip.sourceAnchor, { start: .1, timeScale: 1, voiceoverDuration: .5, attachMode: "first-frame" });
  assert.equal(await digest(clip.path), before); assert.equal(await digest(voiceover), before); assert.equal(result.audio.microphonePreset, "off"); assert.equal(result.provenance.voiceovers.sources[0].source.voiceId, "source-id");
  await fs.rm(voiceover); await fs.symlink(path.join(root, "outside.wav"), voiceover); await fs.writeFile(path.join(root, "outside.wav"), "outside");
  await assert.rejects(importScreenStudio(f.bundle, { ...found, cacheRoot: path.join(root, "rejected") }), /escapes/); assert.deepEqual(await fs.readdir(path.join(root, "rejected")), []);
});
