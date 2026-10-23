"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { validateProject, readPortableProject, writePortableProject } = require("./core.cjs");

function legacyProject() {
  return {
    version: 1, name: "Camera example", mediaPath: null, cameraPath: null,
    microphonePath: null, duration: 3, width: 1920, height: 1080,
    trimStart: 0, trimEnd: 3, speed: 1, zooms: [], cursor: [], captions: [],
    appearance: {
      backgroundKind: "color", background: "#112233", gradient: 0, wallpaper: 0,
      image: null, blur: 0, padding: 0.1, radius: 16, shadow: 0.3, inset: 0,
      aspect: "auto", cursorSize: 48, cursorHidden: false, cursorSmooth: true,
      cursorHideIdle: false, clickEffect: "none", cameraSize: 0.22,
      cameraRadius: 24, cameraX: 0.85, cameraY: 0.8, cameraMirror: true,
      cameraHidden: false, volume: 1, microphoneVolume: 1, cameraVolume: 0,
      fadeIn: 0, fadeOut: 0, zoomDuration: 0.55,
      crop: { x: 0, y: 0, width: 1, height: 1 },
    },
  };
}

function layout(type = "cutout-camera") {
  return {
    type,
    overlay: {
      position: { x: 0.2, y: 0.8 }, sizeRatio: 0.3025, paddingRatio: 0.5,
      aspectRatio: 4 / 3, zoomScale: 0.8,
    },
    split: { direction: "vertical", flip: true, screenRatio: 0.42, enablePadding: true },
    cutout: {
      positionX: 1, sizeRatio: 0.5454, aspectRatio: null, zoomScale: 0.843,
      edgeSoftness: 0, inset: 3.6,
    },
  };
}

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reva-camera-project-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("portable save/open retains all camera variants across type changes and keeps old camera fields", async (t) => {
  const root = await temporary(t), file = path.join(root, "Camera.revastudio");
  const p = legacyProject();
  p.appearance.cameraLayout = layout();
  p.appearance.cameraRadiusRatio = 0.15;
  p.cameraSource = { width: 1920, height: 1080 };
  p.appearance.zoomStartEarly = true;
  p.appearance.screenSpring = { stiffness: 240, damping: 31, mass: 2, clamp: false, precision: 0.002 };
  p.zooms = [{ id: "instant", start: 1, end: 2, scale: 2, x: 0.5, y: 0.5, mode: "manual", instant: true }];
  const oldCamera = Object.fromEntries(["cameraSize", "cameraRadius", "cameraX", "cameraY"].map(k => [k, p.appearance[k]]));
  for (const type of ["cutout-camera", "split-screen", "camera-overlay"]) {
    p.appearance.cameraLayout.type = type;
    await writePortableProject(file, p, () => assert.fail("An asset-free project must not request a media grant."));
    const disk = JSON.parse(await fs.readFile(file, "utf8"));
    const opened = await readPortableProject(file);
    assert.deepEqual(disk.appearance.cameraLayout, p.appearance.cameraLayout);
    assert.deepEqual(opened, p);
    for (const [key, value] of Object.entries(oldCamera)) assert.equal(opened.appearance[key], value);
  }
  assert.equal(JSON.parse(await fs.readFile(`${file}.bak`, "utf8")).appearance.cameraLayout.type, "split-screen");
});

test("legacy projects do not acquire a camera layout on validation or portable roundtrip", async (t) => {
  const root = await temporary(t), file = path.join(root, "Legacy.revastudio"), p = legacyProject();
  assert.deepEqual(validateProject(p), p);
  await writePortableProject(file, p, () => assert.fail("No assets expected."));
  const opened = await readPortableProject(file);
  assert.equal(Object.hasOwn(opened.appearance, "cameraLayout"), false);
  assert.deepEqual(opened, p);
});

test("portable projects preserve source-clock pause, typing and resolved metadata without keystroke contents", async t => {
  const root = await temporary(t), file = path.join(root, "Typing.revastudio"), p = legacyProject();
  p.appearance.aspect = "3:4";
  p.pauseMarkers = [{ time: 0.3, duration: 8 }, { time: 1.8 }];
  p.typingRanges = [{ start: 0.3, end: 1.8, count: 7 }];
  p.resolvedTypingSuggestions = [0.3];
  await writePortableProject(file, p, () => assert.fail("No media assets expected."));
  assert.deepEqual(await readPortableProject(file), p);
  assert.deepEqual(validateProject({ ...p, typingRanges: [{ ...p.typingRanges[0], characters: "never retain", keyCodes: [11] }] }), p);
  const legacy = validateProject(legacyProject());
  for (const key of ["pauseMarkers", "typingRanges", "resolvedTypingSuggestions"]) assert.equal(Object.hasOwn(legacy, key), false);
});

test("recording metadata boundary rejects unordered, overlapping, out-of-clock or malformed ranges", () => {
  const invalid = [
    { pauseMarkers: null }, { pauseMarkers: [{ time: -1 }] }, { pauseMarkers: [{ time: 4 }] },
    { pauseMarkers: [{ time: 1, duration: -1 }] }, { pauseMarkers: [{ time: 1, duration: null }] }, { pauseMarkers: [{ time: 2 }, { time: 1 }] },
    { typingRanges: null }, { typingRanges: [{ start: 1, end: 1, count: 1 }] }, { typingRanges: [{ start: -1, end: 2, count: 1 }] },
    { typingRanges: [{ start: 1, end: 4, count: 1 }] }, { typingRanges: [{ start: 1, end: 2, count: 0 }] }, { typingRanges: [{ start: 1, end: 2, count: 1.5 }] },
    { typingRanges: [{ start: 0, end: 2, count: 1 }, { start: 1, end: 3, count: 1 }] },
    { resolvedTypingSuggestions: [2, 1] }, { resolvedTypingSuggestions: [1, 1] }, { resolvedTypingSuggestions: [4] }, { resolvedTypingSuggestions: [NaN] },
  ];
  for (const values of invalid) assert.throws(() => validateProject({ ...legacyProject(), ...values }));
});

test("portable cursor settings, variants and original event metadata survive save/open", async (t) => {
  const root = await temporary(t), file = path.join(root, "Cursor.revastudio"), p = legacyProject();
  p.appearance.cursorSettings = { ...require("../shared/cursor-settings.mjs").defaultCursorSettings(), size: 63, set: { id: "custom-3", variants: { pointer: "pointer-4" } }, alwaysUsePointer: true, hideNotMovingAfterMs: 1250, loopPositionBeforeEndMs: 2500, clickEffect: "ripple", clickSound: "logitech-mx-master", clickSoundVolume: 0.7, baseRotation: -42, rotationMode: "directional", tiltAmount: 1.2, stopMovementInLastPartMs: 800, shakeThreshold: 700, optimizeChanges: false, syncWithHovers: false };
  p.cursorSourceSize = { width: 1512, height: 982 };
  p.cursor = [{ t: 1, x: 0.3, y: 0.4, click: true, event: "mouseDown", cursorType: "iBeam", button: "left", hover: true }];
  await writePortableProject(file, p, () => assert.fail("Fixed bundled cursor artwork must not request a media grant."));
  assert.deepEqual(await readPortableProject(file), p);
  assert.equal(p.appearance.cursorSize, 48, "canonical settings do not overwrite legacy fields");
});

test("cursor boundary rejects malformed nested values and arbitrary sound/artwork paths", () => {
  const { defaultCursorSettings } = require("../shared/cursor-settings.mjs");
  const invalid = [
    c => { c.set.id = "../../private"; }, c => { c.set.variants.pointer = "../arrow.svg"; }, c => { c.set.variants.pointer = "pointer-99"; },
    c => { c.set.variants = []; }, c => { c.clickSound = "/tmp/sound.wav"; }, c => { c.clickSoundVolume = NaN; }, c => { c.size = Infinity; },
    c => { c.hideNotMovingAfterMs = "500"; }, c => { c.loopPositionBeforeEndMs = -1; }, c => { c.hidden = 0; }, c => { c.alwaysUsePointer = null; },
    c => { c.rotationMode = "spin"; }, c => { c.baseRotation = 181; }, c => { c.shakeThreshold = -1; }, c => { c.tiltAmount = 2.1; },
    c => { c.optimizeChanges = "false"; }, c => { delete c.syncWithHovers; },
  ];
  for (const change of invalid) { const p = legacyProject(); p.appearance.cursorSettings = defaultCursorSettings(); change(p.appearance.cursorSettings); assert.throws(() => validateProject(p)); }
  const p = legacyProject(); p.appearance.cursorSettings = defaultCursorSettings();
  p.appearance.cursorSettings.set.extra = "discard"; p.appearance.cursorSettings.extra = 1;
  assert.deepEqual(validateProject(p).appearance.cursorSettings, defaultCursorSettings());
  p.cursor = [{ t: 1, x: 0.2, y: 0.3, click: false, event: "mouseTeleport" }]; assert.throws(() => validateProject(p), /Cursor event/);
});

test("camera boundary rejects malformed inactive variants without coercing null, nonfinite or endpoint ratios", () => {
  const invalid = [
    c => { c.type = "fullscreen-camera"; },
    c => { c.overlay = null; },
    c => { c.overlay.position = []; },
    c => { c.overlay.position.x = -0.1; },
    c => { c.overlay.sizeRatio = 0; },
    c => { c.overlay.aspectRatio = null; },
    c => { c.overlay.paddingRatio = Infinity; },
    c => { c.overlay.zoomScale = 1.01; },
    c => { c.split.direction = "diagonal"; },
    c => { c.split.flip = "false"; },
    c => { c.split.screenRatio = 0; },
    c => { c.split.screenRatio = 1; },
    c => { c.cutout.aspectRatio = -1; },
    c => { c.cutout.zoomScale = NaN; },
    c => { c.cutout.edgeSoftness = 1.01; },
    c => { c.cutout.inset = 8.1; },
    c => { delete c.cutout.inset; },
  ];
  for (const mutate of invalid) {
    const p = legacyProject();
    p.appearance.cameraLayout = layout("camera-overlay");
    mutate(p.appearance.cameraLayout);
    assert.throws(() => validateProject(p), /Camera/);
  }
  const p = legacyProject();
  p.appearance.cameraLayout = layout();
  p.appearance.cameraLayout.split.screenRatio = null;
  p.appearance.cameraLayout.cutout.inset = 8;
  assert.deepEqual(validateProject(p).appearance.cameraLayout, p.appearance.cameraLayout);
});

test("camera parsing constructs an independent canonical shape and strips unknown nested properties", () => {
  const p = legacyProject();
  p.appearance.cameraLayout = layout();
  p.appearance.cameraLayout.extra = "discard";
  p.appearance.cameraLayout.overlay.extra = "discard";
  p.appearance.cameraLayout.overlay.position = JSON.parse('{"x":0.2,"y":0.8,"__proto__":{"polluted":true},"extra":7}');
  p.appearance.cameraLayout.split.extra = "discard";
  p.appearance.cameraLayout.cutout.extra = "discard";
  const parsed = validateProject(p);
  assert.deepEqual(parsed.appearance.cameraLayout, layout());
  assert.equal({}.polluted, undefined);
  p.appearance.cameraLayout.overlay.position.x = 0.9;
  assert.equal(parsed.appearance.cameraLayout.overlay.position.x, 0.2);
});

test("camera source dimensions and relative roundness have independent bounded contracts", () => {
  for (const dimensions of [{ width: 0, height: 10 }, { width: 12.5, height: 10 }, { width: 10, height: Infinity }, { width: 10, height: 32769 }, null]) {
    const p = legacyProject();
    p.cameraSource = dimensions;
    assert.throws(() => validateProject(p), /Camera source/);
  }
  for (const ratio of [null, -0.1, 1.1, NaN, "0.15"]) {
    const p = legacyProject();
    p.appearance.cameraRadiusRatio = ratio;
    assert.throws(() => validateProject(p), /Camera radius ratio/);
  }
  for (const ratio of [0, 0.15, 1]) {
    const p = legacyProject();
    p.appearance.cameraRadiusRatio = ratio;
    p.cameraSource = { width: 1080, height: 1920, unknown: true };
    const parsed = validateProject(p);
    assert.equal(parsed.appearance.cameraRadiusRatio, ratio);
    assert.deepEqual(parsed.cameraSource, { width: 1080, height: 1920 });
    assert.equal(parsed.appearance.cameraRadius, 24, "legacy fallback is retained independently of relative roundness");
  }
});

test("portable camera masks remap both assets, survive original removal and reject changed camera bytes", async (t) => {
  const root = await temporary(t), original = path.join(root, "source");
  await fs.mkdir(original);
  const camera = path.join(original, "camera.mp4"), mask = path.join(original, "mask.mp4");
  const bytes = Buffer.from("synthetic camera bytes"), maskBytes = Buffer.from("synthetic opaque red mask");
  await fs.writeFile(camera, bytes);
  await fs.writeFile(mask, maskBytes);
  const p = legacyProject();
  p.cameraPath = camera;
  p.cameraSource = { width: 1920, height: 1080 };
  p.cameraMask = { path: mask, sourcePath: camera, sourceSHA256: crypto.createHash("sha256").update(bytes).digest("hex"), sourceTimeOrigin: -0.25, duration: 3, width: 512, height: 384 };
  const file = path.join(root, "Cutout.revastudio"), granted = [];
  await writePortableProject(file, p, async source => { granted.push(source); return fs.realpath(source); });
  assert.deepEqual(new Set(granted), new Set([camera, mask]));
  const disk = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(disk.cameraMask.sourcePath, disk.cameraPath);
  assert.equal(path.isAbsolute(disk.cameraMask.path), false);
  assert.notEqual(disk.cameraMask.path, disk.cameraPath);
  await fs.rm(original, { recursive: true });
  const opened = await readPortableProject(file);
  assert.equal(opened.cameraMask.sourcePath, opened.cameraPath);
  assert.deepEqual(await fs.readFile(opened.cameraMask.path), maskBytes);
  assert.deepEqual(await fs.readFile(opened.cameraPath), bytes);
  assert.equal(opened.cameraMask.sourceTimeOrigin, -0.25);
  assert.deepEqual([opened.cameraMask.width, opened.cameraMask.height], [512, 384], "Vision mask aspect need not match camera aspect");
  await fs.writeFile(opened.cameraPath, Buffer.alloc(bytes.length, 65));
  await assert.rejects(readPortableProject(file), /does not match the current camera media/);
});

test("saving a stale camera mask does not replace an existing project", async (t) => {
  const root = await temporary(t), camera = path.join(root, "camera.mp4"), mask = path.join(root, "mask.mp4"), file = path.join(root, "Existing.revastudio");
  await fs.writeFile(camera, "changed source");
  await fs.writeFile(mask, "mask");
  await writePortableProject(file, legacyProject(), () => assert.fail("No assets expected."));
  const original = await fs.readFile(file, "utf8"), p = legacyProject();
  p.cameraPath = camera;
  p.cameraMask = { path: mask, sourcePath: camera, sourceSHA256: "a".repeat(64), sourceTimeOrigin: 0, duration: 3, width: 512, height: 384 };
  await assert.rejects(writePortableProject(file, p, source => fs.realpath(source)), /does not match the current camera media/);
  assert.equal(await fs.readFile(file, "utf8"), original);
});

test("camera masks require exact source identity and finite signed timing without inventing an origin bound", () => {
  const make = () => {
    const p = legacyProject();
    p.cameraPath = "/local/camera.mp4";
    p.cameraMask = { path: "/local/mask.mp4", sourcePath: p.cameraPath, sourceSHA256: "a".repeat(64), sourceTimeOrigin: -90000, duration: 3, width: 512, height: 384 };
    return p;
  };
  assert.equal(validateProject(make()).cameraMask.sourceTimeOrigin, -90000);
  for (const mutate of [
    p => { p.cameraPath = null; },
    p => { p.cameraMask.sourcePath = "/different/camera.mp4"; },
    p => { p.cameraMask.path = p.cameraPath; },
    p => { p.cameraMask.path = ""; },
    p => { p.cameraMask.sourceSHA256 = "a".repeat(63); },
    p => { p.cameraMask.sourceTimeOrigin = Infinity; },
    p => { p.cameraMask.duration = 0; },
    p => { p.cameraMask.width = 512.5; },
    p => { p.cameraMask.height = 0; },
  ]) {
    const p = make(); mutate(p);
    assert.throws(() => validateProject(p), /Camera mask/);
  }
});

test("portable crop accepts exactly one source pixel and rejects empty or subpixel extents", async (t) => {
  const root = await temporary(t), p = legacyProject(), file = path.join(root, "One-pixel.revastudio");
  p.width = 3840; p.height = 2160;
  p.appearance.crop = { x: 3839 / 3840, y: 2159 / 2160, width: 1 / 3840, height: 1 / 2160 };
  await writePortableProject(file, p, () => assert.fail("No media assets expected."));
  assert.deepEqual((await readPortableProject(file)).appearance.crop, p.appearance.crop);
  for (const [key, value] of [["width", 0], ["height", 0], ["width", 0.5 / 3840], ["height", 0.5 / 2160]]) {
    const invalid = structuredClone(p); invalid.appearance.crop[key] = value;
    assert.throws(() => validateProject(invalid), /Crop/);
  }
});


test("advanced screen shadows persist through the project boundary while legacy geometry stays omitted", () => {
  const original = legacyProject();
  assert.equal(validateProject(original).appearance.screenShadow, undefined);
  original.appearance.screenShadow = { style: "directional", distance: 70, angle: 135, blur: 7.5 };
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(original))).appearance.screenShadow, original.appearance.screenShadow);
  for (const patch of [{ style: "unknown" }, { angle: 181 }, { distance: Infinity }, { blur: -1 }]) {
    assert.throws(() => validateProject({ ...original, appearance: { ...original.appearance, screenShadow: { ...original.appearance.screenShadow, ...patch } } }), /Shadow/);
  }
});
