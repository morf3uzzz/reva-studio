"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { writeCursorAudio, decodeCursorWave, bundledCursorSound, CursorAudioFileOwner, CursorAudioCleanupError } = require("./cursor-audio.cjs");
const { defaultCursorSettings } = require("../shared/cursor-settings.mjs");
const { Exporter } = require("./exporter.cjs");
const { findTool, runProcess, probe } = require("./media.cjs");
const { buildEncoderArgs } = require("./core.cjs");

function project() {
  return {
    version: 1, name: "Clicks", mediaPath: "/silent.mov", cameraPath: null, microphonePath: null,
    duration: 1, width: 16, height: 16, trimStart: 0, trimEnd: 1, speed: 1,
    cursor: [{ t: 0.5, x: 0.5, y: 0.5, click: true }], zooms: [], captions: [],
    appearance: { backgroundKind: "color", background: "#112233", gradient: 0, wallpaper: 0, image: null, blur: 0, padding: 0, radius: 0, shadow: 0, inset: 0, aspect: "auto", cursorSize: 48, cursorHidden: false, cursorSmooth: true, cursorHideIdle: false, clickEffect: "none", cameraSize: 0.2, cameraRadius: 0, cameraX: 0.5, cameraY: 0.5, cameraMirror: false, cameraHidden: true, volume: 0, microphoneVolume: 0, cameraVolume: 0, fadeIn: 0, fadeOut: 0, zoomDuration: 0.55, crop: { x: 0, y: 0, width: 1, height: 1 }, cursorSettings: { ...defaultCursorSettings(), clickSound: "apple-magic-mouse", clickSoundVolume: 0.4 } },
  };
}
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reva-cursor-audio-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory;
}

test("only fixed bundled click identities resolve; all six WAV files decode finite samples", async () => {
  for (const sound of ["apple-magic-mouse", "logitech-mx-master"]) for (const type of ["click", "down", "up"]) {
    const wave = decodeCursorWave(await fs.readFile(bundledCursorSound(sound, type)));
    assert.equal(wave.rate, 44100); assert.ok(wave.samples.length > 100); assert.ok(wave.samples.some(value => value !== 0));
  }
  assert.throws(() => bundledCursorSound("../../private", "click"), /Unknown bundled/);
  assert.throws(() => bundledCursorSound("apple-magic-mouse", "../../sample"), /Unknown bundled/);
  assert.throws(() => decodeCursorWave(Buffer.alloc(44)), /Invalid/);
});

test("rendered click audio uses output time once and writes only audible blocks", async (t) => {
  const directory = await temporary(t), p = project(); p.duration = 100; p.trimEnd = 100;
  p.slices = [{ id: "trimmed", start: 10, end: 100, speed: 2, volume: 1 }]; p.cursor = [{ t: 12, x: 0.2, y: 0.4, click: true }];
  const fileOwner = new CursorAudioFileOwner(), open = fileOwner.open.bind(fileOwner);
  let written = 0;
  fileOwner.open = async destination => {
    const handle = await open(destination), write = handle.write.bind(handle);
    handle.write = async (...args) => { const result = await write(...args); written += result.bytesWritten; return result; };
    return handle;
  };
  const track = await writeCursorAudio(p, 45, directory, { fileOwner }), bytes = await fs.readFile(track.path);
  assert.equal(track.timeline, "output"); assert.equal(track.volume, 1); assert.equal(bytes.toString("ascii", 0, 4), "RF64");
  const sound = decodeCursorWave(await fs.readFile(bundledCursorSound("apple-magic-mouse", "click"))).samples;
  const first = sound.findIndex(value => Math.abs(value) > 1e-7), cueStart = 44100;
  assert.equal(bytes.readFloatLE(80 + (cueStart - 1) * 4), 0);
  assert.ok(Math.abs(bytes.readFloatLE(80 + (cueStart + first) * 4) - sound[first] * 0.4) < 1e-8);
  assert.equal(bytes.readFloatLE(80 + 30 * 44100 * 4), 0);
  const stat = await fs.stat(track.path);
  assert.ok(written < stat.size / 4, "producer must not write a dense uncompressed track, on any filesystem");
  // Physical allocation can include filesystem preallocation of unwritten
  // extents. Enforce the producer's writes above and report allocation separately.
  t.diagnostic(`Click track: ${written} bytes written, ${stat.size} logical, ${stat.blocks * 512} allocated.`);
  const options = { project: p, width: 16, height: 16, fps: 5, format: "mp4", quality: "balanced" };
  const filters = buildEncoderArgs(options, path.join(directory, "test.mp4"), [track]).join(" ");
  assert.ok(!filters.includes("atrim=start=10")); assert.ok(!filters.includes("atempo=2"));
});

test("a real MP4 export of a silent recording contains the selected click at its output time", async (t) => {
  const directory = await temporary(t), ffmpeg = await findTool("ffmpeg"), ffprobe = await findTool("ffprobe"), framePath = path.join(directory, "frame.png");
  await runProcess(ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "color=c=blue:s=16x16:r=5:d=0.2", "-frames:v", "1", framePath]);
  const exporter = new Exporter({ grants: { assert: async () => {}, grant: async () => {} }, ffmpeg, ffprobe }); t.after(() => exporter.dispose());
  const p = project(), output = path.join(directory, "Clicks.mp4");
  p.mediaPath = path.join(directory, "Silent.mp4");
  await runProcess(ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "color=c=blue:s=16x16:r=5:d=1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", p.mediaPath]);
  const session = await exporter.start({ project: p, width: 16, height: 16, fps: 5, format: "mp4", quality: "balanced" }, async () => output);
  const png = await fs.readFile(framePath);
  for (let i = 0; i < 5; i++) await exporter.frame(session.id, png);
  await exporter.finish(session.id); assert.equal((await probe(output, ffprobe)).hasAudio, true);
  const raw = path.join(directory, "audio.f32");
  await runProcess(ffmpeg, ["-v", "error", "-nostdin", "-n", "-i", output, "-vn", "-ac", "1", "-ar", "44100", "-f", "f32le", raw]);
  const audio = await fs.readFile(raw);
  const energy = (start, end) => { let total = 0, n = 0; for (let i = Math.floor(start * 44100); i < Math.min(Math.floor(end * 44100), audio.length / 4); i++) { total += audio.readFloatLE(i * 4) ** 2; n++; } return Math.sqrt(total / n); };
  assert.ok(energy(0.05, 0.4) < 0.0001); assert.ok(energy(0.5, 0.66) > 0.0005);
  assert.equal(exporter.active, false); assert.deepEqual((await fs.readdir(directory)).filter(file => file.startsWith(".reva-export-")), []);
});

test("no click asset is opened for disabled sound or only clips above 2x", async (t) => {
  const directory = await temporary(t), p = project(); p.appearance.cursorSettings.clickSound = "none";
  assert.equal(await writeCursorAudio(p, 1, directory), null);
  p.appearance.cursorSettings.clickSound = "apple-magic-mouse"; p.speed = 3;
  assert.equal(await writeCursorAudio(p, 1 / 3, directory), null); assert.deepEqual(await fs.readdir(directory), []);
});

test("overlapping click tails cross sparse block boundaries without duplicating their timing", async (t) => {
  const directory = await temporary(t), p = project(); p.duration = 3; p.trimEnd = 3;
  p.cursor = [0.99, 1.01].map(t => ({ t, x: 0.5, y: 0.5, click: true }));
  const track = await writeCursorAudio(p, 3, directory), bytes = await fs.readFile(track.path);
  const sound = decodeCursorWave(await fs.readFile(bundledCursorSound("apple-magic-mouse", "click"))).samples;
  const expected = new Float32Array(3 * 44100);
  for (const cue of p.cursor) for (let i = 0; i < sound.length; i++) expected[Math.round(cue.t * 44100) + i] += sound[i] * 0.4;
  for (let i = 0; i < expected.length; i++) assert.equal(bytes.readFloatLE(80 + i * 4), expected[i]);
});

test("dense cached click mixing yields to cancellation before writing another audio block", async (t) => {
  const directory = await temporary(t), p = project(), controller = new AbortController(), fileOwner = new CursorAudioFileOwner();
  p.duration = 3; p.trimEnd = 3;
  p.cursor = [0.2, ...Array(10000).fill(1.2)].map(t => ({ t, x: 0.5, y: 0.5, click: true }));
  let writes = 0;
  const open = fileOwner.open.bind(fileOwner);
  fileOwner.open = async destination => {
    const handle = await open(destination), write = handle.write.bind(handle);
    handle.write = async (...args) => {
      const result = await write(...args); writes++;
      // Header and first block are real writes; the next block uses the cached
      // click waveform. This timer must run before that dense block is written.
      if (writes === 2) setImmediate(() => controller.abort());
      return result;
    };
    return handle;
  };
  await assert.rejects(writeCursorAudio(p, 3, directory, { signal: controller.signal, fileOwner }), /Export cancelled/);
  assert.equal(writes, 2); assert.equal(fileOwner.handle, null);
});

test("disposal during a late audio preparation blocks encoder startup and waits for owned cleanup", async (t) => {
  const directory = await temporary(t), output = path.join(directory, "Cancelled.mp4");
  let finishAudio, didBegin;
  const began = new Promise(resolve => { didBegin = resolve; });
  const exporter = new Exporter({ grants: { assert: async () => {}, grant: async () => {} }, ffmpeg: "/must-not-spawn", ffprobe: "/not-used", renderCursorAudio: async (_project, _duration, owned, { signal }) => {
    didBegin(); await new Promise(resolve => { finishAudio = resolve; });
    assert.equal(signal.aborted, true); await fs.writeFile(path.join(owned, "late.wav"), "owned-late-output"); return null;
  } });
  const start = exporter.start({ project: project(), width: 16, height: 16, fps: 5, format: "mp4", quality: "balanced" }, async () => output);
  const rejected = assert.rejects(start, /Export cancelled/);
  await began; const disposal = exporter.dispose(); assert.equal(exporter.dispose(), disposal); assert.equal(exporter.active, true); finishAudio();
  await Promise.all([rejected, disposal]); assert.equal(exporter.active, false);
  assert.deepEqual(await fs.readdir(directory), []);
});

test("failed preparation cleanup remains owned and disposal retries it", async (t) => {
  const directory = await temporary(t), originalRemove = fs.rm;
  let failed = false;
  fs.rm = async (file, options) => { if (!failed && path.basename(file).startsWith(".reva-export-")) { failed = true; throw new Error("simulated cleanup failure"); } return originalRemove(file, options); };
  const exporter = new Exporter({ grants: { assert: async () => {}, grant: async () => {} }, ffmpeg: "/must-not-spawn", ffprobe: "/not-used", renderCursorAudio: async () => { throw new Error("simulated preparation failure"); } });
  try {
    await assert.rejects(exporter.start({ project: project(), width: 16, height: 16, fps: 5, format: "mp4", quality: "balanced" }, async () => path.join(directory, "Failed.mp4")), /cleanup also failed/);
    assert.equal(exporter.active, true); assert.ok(exporter.preparation.directory);
  } finally { fs.rm = originalRemove; }
  await exporter.dispose(); assert.equal(exporter.active, false); assert.deepEqual(await fs.readdir(directory), []);
});

test("audio cancellation during final descriptor close is observed after owned finalization", async (t) => {
  const directory = await temporary(t), controller = new AbortController(), fileOwner = new CursorAudioFileOwner();
  let didClose, releaseClose;
  const closing = new Promise(resolve => { didClose = resolve; });
  const close = fileOwner.close.bind(fileOwner);
  fileOwner.close = async () => { didClose(); await new Promise(resolve => { releaseClose = resolve; }); await close(); };
  const writing = writeCursorAudio(project(), 1, directory, { signal: controller.signal, fileOwner });
  const rejected = assert.rejects(writing, /Export cancelled/);
  await closing; controller.abort(); assert.ok(fileOwner.handle); releaseClose();
  await rejected; assert.equal(fileOwner.handle, null);
});

test("a failed audio write and close retain the exact descriptor before root cleanup retry", async (t) => {
  const directory = await temporary(t), originalOpen = fs.open, originalRemove = fs.rm;
  const primary = new Error("simulated audio write failure"), cleanup = new Error("simulated descriptor close failure");
  let denied = true, rootRemovals = 0, closeCount = 0;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args), close = handle.close.bind(handle);
    handle.write = async () => { throw primary; };
    handle.close = async () => { closeCount++; if (denied) throw cleanup; await close(); };
    return handle;
  };
  fs.rm = async (file, options) => { if (path.basename(file).startsWith(".reva-export-")) rootRemovals++; return originalRemove(file, options); };
  const exporter = new Exporter({ grants: { assert: async () => {}, grant: async () => {} }, ffmpeg: "/must-not-spawn", ffprobe: "/not-used" });
  try {
    await assert.rejects(exporter.start({ project: project(), width: 16, height: 16, fps: 5, format: "mp4", quality: "balanced" }, async () => path.join(directory, "Failed.mp4")), error => {
      assert.ok(error instanceof CursorAudioCleanupError); assert.deepEqual(error.errors, [primary, cleanup]);
      assert.equal(error.cleanupOwner, exporter.preparation.fileOwner); return true;
    });
    assert.equal(rootRemovals, 0); assert.equal(closeCount, 1); assert.equal(exporter.active, true);
    await assert.rejects(exporter.start({}, async () => null), /Another export/);
    await assert.rejects(exporter.dispose(), error => error === cleanup);
    assert.equal(rootRemovals, 0); assert.equal(exporter.active, true); assert.ok(exporter.preparation.fileOwner.handle);
    denied = false; await exporter.dispose();
    assert.equal(closeCount, 3); assert.equal(rootRemovals, 1); assert.equal(exporter.active, false);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    denied = false; fs.open = originalOpen; fs.rm = originalRemove; await exporter.dispose();
  }
});

test("disposal blocks replacement admission until its joined shutdown settles", async () => {
  const exporter = new Exporter({ grants: {}, ffmpeg: "/not-used", ffprobe: "/not-used" });
  const disposing = exporter.dispose(); assert.equal(exporter.active, true);
  await assert.rejects(exporter.start({}, async () => null), /Another export/);
  await disposing; assert.equal(exporter.active, false);
});
