"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { findTool, runProcess, MediaGrants, probe } = require("./media.cjs");
const { AudioPreview } = require("./audio-preview.cjs"), { buildAudioGraph } = require("./audio-mix.cjs"), { audioTracks, defaultAudioSettings } = require("../shared/audio.mjs");
const project = file => ({ version: 1, name: "Mixed", mediaPath: file, cameraPath: null, microphonePath: null, duration: 3, width: 16, height: 16, trimStart: 0, trimEnd: 3, speed: 1, slices: [{ id: "a", start: 0, end: 1, speed: 1, volume: .5 }, { id: "b", start: 2, end: 3, speed: 2, volume: 1 }], appearance: { backgroundKind: "color", background: "#000000", gradient: 0, wallpaper: 0, image: null, blur: 0, padding: .1, radius: 20, shadow: .3, inset: 0, aspect: "auto", cursorSize: 30, cursorHidden: false, cursorSmooth: true, cursorHideIdle: true, clickEffect: "none", cameraSize: .2, cameraRadius: 20, cameraX: .8, cameraY: .8, cameraMirror: true, cameraHidden: false, volume: .7, microphoneVolume: 1, cameraVolume: 0, fadeIn: .2, fadeOut: .2, zoomDuration: .5, crop: { x: 0, y: 0, width: 1, height: 1 } }, zooms: [], cursor: [], captions: [] });
async function fixture(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), "reva-mix-")); t.after(() => fs.rm(root, { recursive: true, force: true })); const ffmpeg = await findTool("ffmpeg"), ffprobe = await findTool("ffprobe"), source = path.join(root, "source.wav"); await runProcess(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3", "-ac", "2", source]); const grants = new MediaGrants(); await grants.grant(source); return { root, ffmpeg, ffprobe, source, grants }; }
async function pcm(f, p, start, end, name) { const graph = buildAudioGraph(p, 1.5, audioTracks(p), { firstInputIndex: 0, start, end }), file = path.join(f.root, name); await runProcess(f.ffmpeg, ["-v", "error", ...graph.inputArgs, "-filter_complex", graph.filters.join(";"), "-map", graph.label, "-ar", "48000", "-ac", "2", "-f", "f32le", file]); return fs.readFile(file); }
const energy = bytes => { let total = 0; for (let offset = 0; offset < bytes.length; offset += 4) total += bytes.readFloatLE(offset) ** 2; return Math.sqrt(total / (bytes.length / 4)); };
test("preview windows retain the export cut/speed/gain and output-clock music phase", async t => {
  const f = await fixture(t), p = project(f.source); p.appearance.fadeIn = p.appearance.fadeOut = 0;
  const audio = defaultAudioSettings(); audio.background = { id: "music", kind: "music", clock: "output", path: f.source, name: "Music", sourceDuration: 3, start: .3, end: 1.5, trimStart: .1, trimEnd: .35, rate: 1, volume: .2, muted: false, loop: true, fadeIn: 0, fadeOut: 0 }; p.audio = audio;
  const full = await pcm(f, p, 0, 1.5, "full.pcm"), window = await pcm(f, p, .5, 1.3, "window.pcm");
  assert.equal(full.length, 1.5 * 48000 * 8); assert.equal(window.length, .8 * 48000 * 8);
  const expected = full.subarray(.5 * 48000 * 8, 1.3 * 48000 * 8); let error = 0; for (let offset = 0; offset < window.length; offset += 4) error += (window.readFloatLE(offset) - expected.readFloatLE(offset)) ** 2;
  assert.ok(Math.sqrt(error / (window.length / 4)) < .012, "resampled atempo windows retain the same audible mix within their documented decoder boundary");
  assert.ok(energy(window) > .005);
});
test("production PCM preview validates sources, caches equivalent work and invalidates gains", async t => {
  const f = await fixture(t), owner = new AudioPreview({ root: path.join(f.root, "preview"), ...f }), p = project(f.source); t.after(() => owner.dispose());
  const first = await owner.render(p, { id: crypto.randomUUID(), start: .2, duration: 1 }), stat = await fs.stat(first.path);
  const warm = await owner.render(p, { id: crypto.randomUUID(), start: .2, duration: 1 }); assert.equal(first.path, warm.path); assert.equal((await fs.stat(warm.path)).mtimeMs, stat.mtimeMs); assert.equal((await probe(first.path, f.ffprobe)).duration, 1);
  const changed = await owner.render({ ...p, appearance: { ...p.appearance, volume: .2 } }, { id: crypto.randomUUID(), start: .2, duration: 1 }); assert.notEqual(first.key, changed.key);
  await assert.rejects(owner.render({ ...p, mediaPath: path.join(f.root, "unselected.wav") }, { id: crypto.randomUUID(), start: 0, duration: 1 }), /not been selected/);
});
test("cancelled startup publishes no audio and cleanup retry retains its owned cache", async t => {
  const f = await fixture(t), owner = new AudioPreview({ root: path.join(f.root, "preview"), ...f }), p = project(f.source), id = crypto.randomUUID();
  const work = owner.render(p, { id, start: 0, duration: 1 }); await owner.cancel(id); assert.equal(await work, null); assert.equal(owner.jobs.size, 0);
  await owner.render(p, { id: crypto.randomUUID(), start: 0, duration: 1 }); const actual = owner.remove.bind(owner); let fail = true; owner.remove = async entry => { if (fail) { fail = false; throw new Error("simulated cleanup rejection"); } return actual(entry); };
  await assert.rejects(owner.dispose(), /cleanup rejection/); assert.equal(owner.cache.size, 1); await owner.dispose(); assert.equal(owner.cache.size, 0);
});
test("stateful microphone presets, fades and mixed click peaks use exactly the full-export PCM state", async t => {
  const f = await fixture(t), p = project(f.source), microphone = path.join(f.root, "microphone.wav");
  await runProcess(f.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "aevalsrc=0.7*sin(2*PI*137*t)*(0.5+0.5*sin(2*PI*4*t))+0.2*sin(2*PI*951*t):s=48000:d=3", "-ac", "2", microphone]); await f.grants.grant(microphone);
  p.microphonePath = microphone; p.slices[1].speed = 1.7; const duration = 1 + 1 / 1.7;
  p.appearance.cursorSettings = require("../shared/cursor-settings.mjs").defaultCursorSettings(); p.appearance.cursorSettings.clickSound = "apple-magic-mouse"; p.appearance.cursorSettings.clickSoundVolume = 1;
  p.cursor = [{ t: .51, x: .4, y: .5, click: true }, { t: .81, x: .4, y: .5, click: true }, { t: 2.4, x: .4, y: .5, click: true }];
  const click = await require("./cursor-audio.cjs").writeCursorAudio(p, duration, f.root);
  for (const preset of ["standard", "loud", "noise-reduction"]) {
    p.audio = { ...defaultAudioSettings(), microphonePreset: preset };
    const render = async (start, end, name) => { const graph = buildAudioGraph(p, duration, [...audioTracks(p), click], { firstInputIndex: 0, start, end }), file = path.join(f.root, name); await runProcess(f.ffmpeg, ["-v", "error", "-filter_complex_threads", "2", ...graph.inputArgs, "-filter_complex", graph.filters.join(";"), "-map", graph.label, "-ar", "48000", "-ac", "2", "-f", "f32le", file]); return fs.readFile(file); };
    const full = await render(0, duration, `${preset}-full.pcm`), window = await render(.43, 1.47, `${preset}-window.pcm`), expected = full.subarray(Math.round(.43 * 48000) * 8, Math.round(1.47 * 48000) * 8);
    assert.equal(window.length, expected.length); let maximum = 0; for (let offset = 0; offset < window.length; offset += 4) maximum = Math.max(maximum, Math.abs(window.readFloatLE(offset) - expected.readFloatLE(offset)));
    assert.ok(maximum < .000001, `${preset} window retains DSP, atempo, click and limiter state (error ${maximum})`);
  }
  const owner = new AudioPreview({ root: path.join(f.root, "preview"), ...f }); t.after(() => owner.dispose());
  p.appearance.volume = p.appearance.microphoneVolume = 0;
  const audible = await owner.render(p, { id: crypto.randomUUID(), start: .4, duration: .6 }); assert.ok(audible, "click-only projects produce mixed PCM even when recording audio is muted");
  const decoded = path.join(f.root, "click-only.pcm"); await runProcess(f.ffmpeg, ["-v", "error", "-i", audible.path, "-f", "f32le", decoded]); assert.ok(energy(await fs.readFile(decoded)) > .00001);
});
