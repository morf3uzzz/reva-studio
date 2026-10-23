"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { importScreenStudioAudio, parseVoiceoverSources } = require("./audio-import.cjs");
const { auxiliaryAudioFilter, audioTracks, defaultAudioSettings } = require("../shared/audio.mjs");
const { buildAudioGraph } = require("./audio-mix.cjs");
const { timeToOutput, outputToSource } = require("../shared/timeline.mjs");
const { findTool, runProcess, MediaGrants } = require("./media.cjs");

const voiceover = (patch = {}) => ({ id: "voice", sourceStartMs: 1000, voiceoverDurationMs: 4000, fileName: "Local narration é.wav", volume: .4, ...patch });
function input(voiceOvers = [], config = {}) {
  const p = { duration: 8, trimStart: 0, trimEnd: 8, speed: 1, slices: [{ id: "whole", start: 0, end: 8, speed: 1, volume: 1 }] };
  return { scene: { voiceOvers }, config, slices: p.slices, sourceDuration: 8, outputDuration: 8, sourceToPlayback: time => timeToOutput(p, time), playbackToSource: time => outputToSource(p, time), resolveAsset: async () => ({ path: "/owned/copied.wav", info: { duration: 4, audio: { codec_type: "audio" } } }) };
}

test("verified first-frame import preserves source anchors, disabled neighbors, scalar gain and local speech metadata", async () => {
  const selectedSource = { type: "speechify", text: "Caller-selected narration", voiceId: "local-metadata", language: "en", speechMarks: [{ time: 0, text: "Caller-selected" }] }, calls = [];
  const args = input([voiceover({ source: selectedSource }), voiceover({ id: "disabled-next", sourceStartMs: 3000, voiceoverDurationMs: 1000, fileName: "second.wav", isDisabled: true })], { audio: { volume: .1, microphoneAudioPreset: "voice", muteSystemAudio: true } });
  args.resolveAsset = async (category, name) => { calls.push([category, name]); return { path: `/owned/${name}`, info: { duration: name === "second.wav" ? 1 : 4, audio: { codec_type: "audio" } } }; };
  const result = await importScreenStudioAudio(args), clip = result.audio.voiceovers[0];
  assert.deepEqual(calls, [["voiceover", "Local narration é.wav"], ["voiceover", "second.wav"]]);
  assert.equal(clip.start, 1); assert.equal(clip.end, 3); assert.equal(clip.rate, 2); assert.equal(clip.trimStart, 0); assert.equal(clip.trimEnd, 4); assert.equal(clip.volume, .4);
  assert.deepEqual(clip.sourceAnchor, { start: 1, timeScale: 1, voiceoverDuration: 4, attachMode: "first-frame" }); assert.equal(clip.hideRecording, true);
  assert.equal(result.audio.voiceovers[1].muted, true); assert.deepEqual(result.microphoneMuteRanges, [{ start: 1, end: 3 }]); assert.equal(result.audio.microphoneMuteRanges, undefined, "derived observations are not persisted as independent stale mutes");
  assert.equal(result.audio.microphonePreset, "standard"); assert.equal(result.audio.systemMuted, true); assert.equal(result.voiceoverSources[0].source, selectedSource);
});

test("unsafe/missing assets, unverified attachment, unknown retained anchors and unsupported speed fail without guessing", async () => {
  let resolutions = 0;
  for (const fileName of ["../escape.wav", "nested/file.wav", "C:\\outside.wav", "file://host/audio.wav", "%2e%2e.wav", ".", "..", "bad\0.wav"]) {
    const args = input([voiceover({ fileName })]); args.resolveAsset = async () => { resolutions++; throw new Error("must not resolve"); };
    await assert.rejects(importScreenStudioAudio(args));
  }
  assert.equal(resolutions, 0);
  await assert.rejects(importScreenStudioAudio(input([voiceover({ attachMode: "last-frame" })])), /unverified attachment/);
  const missing = input([voiceover()]); missing.resolveAsset = async () => { throw new Error("Selected voiceovers file is missing"); }; await assert.rejects(importScreenStudioAudio(missing), /missing/);
  const unprobed = input([voiceover()]); unprobed.resolveAsset = async () => ({ path: "/owned/narration.wav", info: { duration: 4 } }); await assert.rejects(importScreenStudioAudio(unprobed), /verified audio/);
  const short = input([voiceover()]); short.resolveAsset = async () => ({ path: "/owned/narration.wav", info: { duration: 1, audio: {} } }); await assert.rejects(importScreenStudioAudio(short), /shorter/);
  const gap = input([voiceover()]); gap.slices = [{ id: "kept", start: 4, end: 8, speed: 1, volume: 1 }]; gap.outputDuration = 4; gap.sourceToPlayback = () => null; await assert.rejects(importScreenStudioAudio(gap), /retained source slice/);
  await assert.rejects(importScreenStudioAudio(input([voiceover(), voiceover({ id: "close", sourceStartMs: 1500 })])), /exceeds the supported/);
  assert.throws(() => parseVoiceoverSources([voiceover(), voiceover()], 8), /unique/);
  assert.throws(() => parseVoiceoverSources([voiceover({ sourceStartMs: 2000 }), voiceover({ id: "unordered", sourceStartMs: 1000 })], 8), /invalid/);
});

test("preset enums map explicitly, Podcast remains unavailable, and imported caption style does not invent transcript contents", async () => {
  for (const [original, local] of [["channel-fix", "off"], ["voice", "standard"], ["loud", "loud"], ["noise-reduction", "noise-reduction"]]) {
    const result = await importScreenStudioAudio(input([], { audio: { microphoneAudioPreset: original } })); assert.equal(result.audio.microphonePreset, local); assert.deepEqual(result.warnings, []);
  }
  const result = await importScreenStudioAudio(input([], { audio: { microphoneAudioPreset: "podcast", backgroundAudioFileName: "unverified-vendor-track.mp3" }, captions: { enableTranscript: false, showSoundLabels: true, font: "serif", sizeRatio: .07, color: "#abcdef", backgroundColor: "#123456", position01: { x: .25, y: .9 }, wordsReveal: "word-by-word", lineGrowth: "centered", wordEntrance: "fade-in" } }));
  assert.equal(result.audio.microphonePreset, "off"); assert.equal(result.audio.background, null); assert.equal(result.captionSettings.enabled, false); assert.equal(result.captionSettings.font, "serif"); assert.deepEqual(result.captionSettings.position, { x: .25, y: .9 });
  assert.equal(result.transcript, undefined); assert.ok(result.warnings.some(value => value.includes("podcast"))); assert.ok(result.warnings.some(value => value.includes("no verified portable asset"))); assert.ok(result.warnings.some(value => value.includes("Persistent transcript storage is unverified")));
});

test("real copied/probed voiceover imports render the verified automatic speed at its output placement", async t => {
  let ffmpeg, ffprobe; try { ffmpeg = await findTool("ffmpeg"); ffprobe = await findTool("ffprobe"); } catch { t.skip("Requires the existing local FFmpeg installation; no download occurs."); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reva-voiceover-import-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = path.join(root, "original.wav"), copied = path.join(root, "copied.wav");
  await runProcess(ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "aevalsrc=0.5|0.25:s=48000:d=4", "-c:a", "pcm_s16le", original]); await fs.copyFile(original, copied);
  const grants = new MediaGrants(); await grants.grant(copied);
  const parsed = JSON.parse(await runProcess(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", copied]));
  const args = input([voiceover(), voiceover({ id: "next-disabled", sourceStartMs: 3000, voiceoverDurationMs: 1000, isDisabled: true })]); args.resolveAsset = async () => ({ path: await grants.assert(copied), info: { duration: Number(parsed.format.duration), audio: parsed.streams.find(value => value.codec_type === "audio") } });
  const result = await importScreenStudioAudio(args), clip = result.audio.voiceovers[0], graph = auxiliaryAudioFilter(clip, "0:a:0", "voice", 8), output = path.join(root, "render.pcm");
  await runProcess(ffmpeg, ["-nostdin", "-v", "error", "-i", clip.path, "-filter_complex", graph, "-map", "[voice]", "-ac", "2", "-ar", "48000", "-f", "f32le", output]);
  const pcm = await fs.readFile(output); assert.equal(pcm.length, 8 * 48000 * 8); assert.equal(clip.rate, 2);
  for (const [time, expected] of [[.5, 0], [1.5, .2], [2.5, .2], [3.5, 0]]) assert.ok(Math.abs(pcm.readFloatLE(Math.round(time * 48000) * 8) - expected) < .002, `imported narration at ${time}s`);
  const project = { duration: 8, trimStart: 0, trimEnd: 8, speed: 1, slices: args.slices, appearance: { volume: 1, microphoneVolume: 1, cameraVolume: 0 }, mediaPath: null, microphonePath: "/owned/mic.wav", cameraPath: null, audio: result.audio };
  assert.ok(audioTracks(project).find(track => track.role === "microphone").outputFilters.length);
  assert.deepEqual(await fs.readFile(original), await fs.readFile(copied));
});

test("real production mix applies microphone-only voiceover/source mutes after cut concatenation and preserves independent channel gains", async t => {
  let ffmpeg; try { ffmpeg = await findTool("ffmpeg"); } catch { t.skip("Requires existing local FFmpeg; no installation occurs."); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reva-voiceover-mix-")); t.after(() => fs.rm(root, { recursive: true, force: true })); const files = {};
  for (const [role, level] of [["system", .2], ["microphone", .4], ["camera", .1]]) { const file = path.join(root, `${role}.wav`); await runProcess(ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", `aevalsrc=${level}|${level}:s=48000:d=4`, "-c:a", "pcm_f32le", file]); files[role] = file; }
  const p = { duration: 4, trimStart: 0, trimEnd: 4, speed: 1, slices: [{ id: "first", start: 0, end: 1, speed: 1, volume: .5, systemVolume: .25, cameraVolume: .75 }, { id: "second", start: 2, end: 4, speed: 2, volume: .5, systemVolume: .5, cameraVolume: .25 }], appearance: { volume: 1, microphoneVolume: 1, cameraVolume: 1, fadeIn: 0, fadeOut: 0 }, mediaPath: files.system, microphonePath: files.microphone, cameraPath: files.camera,
    audio: { ...defaultAudioSettings(), microphoneMuteRanges: [{ start: 3.4, end: 3.6 }], voiceovers: [{ id: "local", kind: "voiceover", clock: "output", path: files.microphone, name: "Muted narration track", sourceDuration: 4, start: .3, end: .6, trimStart: 0, trimEnd: .3, rate: 1, volume: 0, muted: false, hideRecording: true, loop: false, fadeIn: 0, fadeOut: 0 }] } };
  const graph = buildAudioGraph(p, 2, audioTracks(p), { firstInputIndex: 0 }), output = path.join(root, "mix.pcm"); await runProcess(ffmpeg, ["-nostdin", "-v", "error", ...graph.inputArgs, "-filter_complex", graph.filters.join(";"), "-map", graph.label, "-ac", "2", "-ar", "48000", "-f", "f32le", output]);
  const pcm = await fs.readFile(output); assert.equal(pcm.length, 2 * 48000 * 8);
  // atempo's overlap window slightly modulates a constant test signal; the
  // permitted 0.001 change remains far below a missing/incorrect channel gain.
  for (const [time, expected] of [[.15, .325], [.4, .125], [.8, .325], [1.1, .325], [1.4, .325], [1.75, .125], [1.9, .325]]) { const actual = pcm.readFloatLE(Math.round(time * 48000) * 8); assert.ok(Math.abs(actual - expected) < .001, `independent channels at ${time}s: ${actual} vs ${expected}`); }
});
