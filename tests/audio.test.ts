import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createProject } from "../src/core/model.ts";
import { createAudioClip, updateAudioClip, defaultAudioSettings, parseAudioSettings, parseAudioClip, resolveAudioSettings,
  audioClipOutputEnd, audioClipState, audioTracks, auxiliaryAudioFilter, microphoneFilters, atempoFilters,
  resolveVoiceovers, microphoneOutputMuteRanges, microphoneOutputFilters,
  type AudioClip, type AudioProject } from "../src/core/audio.ts";

function clip(patch: Partial<AudioClip> = {}): AudioClip {
  return { id: "music-1", kind: "music", clock: "output", path: "/music.wav", name: "Local track", sourceDuration: 2,
    start: 1, end: 5, trimStart: .25, trimEnd: 1.25, rate: 1, volume: .5, muted: false, loop: true, fadeIn: .2, fadeOut: .2, ...patch };
}
test("audio boundary preserves raw legacy channels and validates owned output-clock clips", () => {
  const project = createProject();
  assert.equal(resolveAudioSettings(project).microphonePreset, "off");
  assert.deepEqual(parseAudioSettings(defaultAudioSettings()), defaultAudioSettings());
  const settings = { ...defaultAudioSettings(), background: clip() };
  assert.deepEqual(parseAudioSettings(settings), settings);
  for (const patch of [{ clock: "source" }, { rate: 0 }, { sourceDuration: NaN }, { trimEnd: 3 }, { end: .5 }, { kind: "voiceover", loop: true }, { volume: 2 }]) assert.throws(() => parseAudioClip({ ...clip(), ...patch }));
  assert.throws(() => parseAudioSettings({ ...settings, voiceovers: [{ ...clip(), kind: "voiceover", loop: false }] }), /unique/);
  assert.throws(() => parseAudioSettings({ ...settings, microphonePreset: "podcast" }), /preset/);
  assert.throws(() => parseAudioClip({ ...clip(), sourceDuration: 10000, trimEnd: 10000 }), /128 MiB/);
});
test("music placement, loop source position, rate, fades and end truncation share one plan", () => {
  const music = clip();
  assert.equal(audioClipState(music, .99, 10), null);
  assert.ok(Math.abs(audioClipState(music, 1.1, 10)!.gain - .25) < 1e-9);
  assert.equal(audioClipState(music, 2.5, 10)!.sourceTime, .75);
  assert.equal(audioClipState(music, 4.9, 10)!.gain.toFixed(4), "0.2500");
  assert.equal(audioClipState(music, 5, 10), null);
  assert.equal(audioClipOutputEnd({ ...music, loop: false, rate: 2 }, 10), 1.5);
  assert.equal(audioClipOutputEnd(music, 3), 3);
  const short = { ...music, start: 0, end: .1, fadeIn: 10, fadeOut: 10 };
  assert.ok(Math.abs(audioClipState(short, .05, 10)!.gain - .125) < 1e-9);
  assert.equal(audioClipState({ ...music, muted: true }, 2, 10), null);
});
test("auxiliary clips preserve local source data while editing output placement and trim", () => {
  const asset = { path: "/private/Music/My $ local track.wav", name: "My $ local track", duration: 2 };
  const music = createAudioClip(asset, "music", 0, 10, "music");
  assert.equal(music.path, asset.path); assert.equal(music.loop, true); assert.equal(music.end, 10);
  const narration = createAudioClip(asset, "voiceover", 3, 10, "voice");
  assert.equal(narration.start, 3); assert.equal(narration.end, 5); assert.equal(narration.loop, false);
  assert.deepEqual(updateAudioClip(narration, { trimStart: .5, rate: 2 }), { ...narration, trimStart: .5, rate: 2 });
  assert.equal(createAudioClip({ ...asset, duration: 600 }, "music", 0, 1000, "long").loop, false);
});
test("track policy separates mute from remembered gain and carries camera source delay and exact DSP", () => {
  const project: AudioProject = { ...createProject({ path: "/screen.mp4", name: "Screen", duration: 10, width: 100, height: 100 }), microphonePath: "/microphone.m4a", cameraPath: "/camera.mp4",
    audio: { ...defaultAudioSettings(), systemMuted: true, microphonePreset: "loud", background: clip(), voiceovers: [clip({ id: "voice", kind: "voiceover", loop: false })] } };
  const tracks = audioTracks(project, -.2);
  assert.equal(tracks.some(track => track.role === "system"), false);
  assert.equal(project.appearance.volume, 1);
  assert.deepEqual(tracks.find(track => track.role === "microphone")!.filters, microphoneFilters("loud"));
  assert.equal(tracks.find(track => track.role === "camera")!.sourceDelay, -.2);
  assert.equal(tracks.find(track => track.role === "music")!.clock, "output");
  assert.deepEqual(atempoFilters(4), ["atempo=2", "atempo=2"]);
  assert.deepEqual(atempoFilters(.25), ["atempo=0.5", "atempo=0.5"]);
});

test("original first-frame voiceovers reanchor through cuts and include disabled neighbors in their automatic speed", () => {
  const project: AudioProject = { ...createProject({ path: "/screen.mp4", name: "Source", duration: 10, width: 100, height: 100 }), microphonePath: "/mic.wav",
    slices: [{ id: "a", start: 0, end: 2, speed: 1, volume: 1 }, { id: "b", start: 4, end: 10, speed: 2, volume: 1 }],
    audio: { ...defaultAudioSettings(), voiceovers: [
      clip({ id: "first", kind: "voiceover", loop: false, start: 1, end: 3, trimStart: 0, trimEnd: 2, sourceDuration: 2, hideRecording: true, sourceAnchor: { start: 1, timeScale: 1, voiceoverDuration: 2, attachMode: "first-frame" } }),
      clip({ id: "next-disabled", kind: "voiceover", loop: false, start: 4, end: 5, trimStart: 0, trimEnd: 2, sourceDuration: 2, muted: true, sourceAnchor: { start: 8, timeScale: 1, voiceoverDuration: 2, attachMode: "first-frame" } }),
    ] } };
  const first = resolveVoiceovers(project); assert.deepEqual(first.issues, []); assert.equal(first.clips[0].start, 1); assert.equal(first.clips[0].end, 3); assert.equal(first.clips[1].rate, 2);
  assert.equal(resolveVoiceovers(project), first, "immutable playback ticks reuse one timing plan");
  const edited = { ...project, slices: project.slices!.map(slice => ({ ...slice, speed: slice.id === "a" ? 2 : 1 })) };
  assert.equal(resolveVoiceovers(edited).clips[0].start, .5); assert.equal(resolveVoiceovers(edited).clips[0].end, 2.5);
  const closeNeighbor = { ...project, audio: { ...project.audio!, voiceovers: project.audio!.voiceovers.map((value, index) => index ? { ...value, sourceAnchor: { ...value.sourceAnchor!, start: 2 } } : { ...value, sourceAnchor: { ...value.sourceAnchor!, voiceoverDuration: 4 }, sourceDuration: 4, trimEnd: 4 }) } };
  assert.equal(resolveVoiceovers(closeNeighbor).clips[0].rate, 4, "a disabled next item still limits the preceding voiceover");
  const removed = { ...project, slices: [project.slices![1]] }; assert.ok(resolveVoiceovers(removed).issues.some(issue => issue.id === "first")); assert.throws(() => audioTracks(removed), /outside the retained video/);
  const tooClose = { ...closeNeighbor, audio: { ...closeNeighbor.audio!, voiceovers: closeNeighbor.audio!.voiceovers.map((value, index) => index ? { ...value, sourceAnchor: { ...value.sourceAnchor!, start: 1.5 } } : value) } };
  assert.throws(() => audioTracks(tooClose), /exceeds the supported/);
});

test("source microphone mutes map through cuts, combine with narration placements, and leave system/camera gain intact", () => {
  const project: AudioProject = { ...createProject({ path: "/screen.mp4", name: "Source", duration: 10, width: 100, height: 100 }), microphonePath: "/mic.wav", cameraPath: "/camera.mp4",
    slices: [{ id: "a", start: 0, end: 2, speed: 1, volume: 1 }, { id: "b", start: 4, end: 10, speed: 2, volume: 1 }],
    audio: { ...defaultAudioSettings(), microphoneMuteRanges: [{ start: 5, end: 9 }], voiceovers: [clip({ id: "vo", kind: "voiceover", loop: false, start: 1, end: 3, trimStart: 0, trimEnd: 2, sourceDuration: 2, hideRecording: true })] } };
  assert.deepEqual(microphoneOutputMuteRanges(project), [{ start: 1, end: 4.5 }]);
  const tracks = audioTracks(project); assert.equal(tracks.find(track => track.role === "microphone")!.outputFilters!.length, 1); assert.equal(tracks.find(track => track.role === "system")!.outputFilters, undefined);
  const mutedNarration = { ...project, audio: { ...project.audio!, voiceovers: project.audio!.voiceovers.map(value => ({ ...value, muted: true })) } };
  assert.deepEqual(microphoneOutputMuteRanges(mutedNarration), [{ start: 2.5, end: 4.5 }]);
  assert.throws(() => parseAudioSettings({ ...defaultAudioSettings(), microphoneMuteRanges: [{ start: 1, end: 3 }, { start: 2, end: 4 }] }), /range/);
  assert.throws(() => parseAudioClip(clip({ hideRecording: true })), /voiceover/);
  assert.throws(() => parseAudioClip(clip({ kind: "voiceover", loop: false, sourceAnchor: { start: 1, timeScale: 1, voiceoverDuration: 1, attachMode: "unverified" as "first-frame" } })), /attachment/);
});

const ffmpeg = process.env.REVA_TEST_FFMPEG ?? "ffmpeg";
const available = spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).status === 0;
function render(filter: string, input: string, outputLabel?: string): Float32Array {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", input,
    ...(outputLabel ? ["-filter_complex", filter, "-map", `[${outputLabel}]`] : ["-af", filter || "anull"]),
    "-ac", "2", "-ar", "48000", "-f", "f32le", "pipe:1"], { maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  return new Float32Array(result.stdout.buffer, result.stdout.byteOffset, result.stdout.byteLength / 4);
}
test("real FFmpeg auxiliary chain produces exact delay, trim loop, gain and matching fade envelope", { skip: !available }, () => {
  const music = clip({ start: .4, end: 2.4, trimStart: .1, trimEnd: .6, sourceDuration: 1, volume: .5 });
  const graph = auxiliaryAudioFilter(music, "0:a:0", "music", 3)!;
  const samples = render(graph, "aevalsrc=0.5|0.5:s=48000:d=1", "music");
  assert.equal(samples.length, 3 * 48000 * 2);
  for (const time of [.1, .3, .5, .7, 1.2, 1.7, 2.3, 2.7]) {
    const actual = samples[Math.round(time * 48000) * 2];
    const expected = (audioClipState(music, time, 3)?.gain ?? 0) * .5;
    assert.ok(Math.abs(actual - expected) < .001, `${time}s: ${actual} != ${expected}`);
  }
});
test("real FFmpeg microphone presets run distinct bounded DSP and Off preserves unprocessed audio", { skip: !available }, () => {
  const input = "aevalsrc=0.2+0.2*sin(2*PI*220*t)|0.2+0.2*sin(2*PI*220*t):s=48000:d=1";
  const stats = (samples: Float32Array) => {
    const kept = samples.subarray(48000 / 2);
    return { mean: kept.reduce((sum, v) => sum + v, 0) / kept.length, rms: Math.sqrt(kept.reduce((sum, v) => sum + v * v, 0) / kept.length), peak: kept.reduce((max, v) => Math.max(max, Math.abs(v)), 0) };
  };
  const results = Object.fromEntries((["off", "standard", "loud", "noise-reduction"] as const).map(preset => [preset, stats(render(microphoneFilters(preset).join(","), input))]));
  assert.ok(results.off.mean > .19 && results.off.mean < .21);
  for (const preset of ["standard", "loud", "noise-reduction"]) {
    assert.ok(Math.abs(results[preset].mean) < .01, `${preset} removes DC through its real high-pass filter`);
    assert.ok(results[preset].rms > .01 && Number.isFinite(results[preset].rms));
    assert.ok(results[preset].peak <= .951);
  }
  assert.ok(results.loud.rms > results.standard.rms + .02);
});

test("real FFmpeg microphone gating is sample accurate and retains both channel values", { skip: !available }, () => {
  const p: AudioProject = { ...createProject({ path: "/screen.mp4", name: "Source", duration: 1, width: 100, height: 100 }), audio: { ...defaultAudioSettings(), microphoneMuteRanges: [{ start: .2, end: .4 }, { start: .45, end: .55 }] } };
  const output = render(microphoneOutputFilters(p).join(","), "aevalsrc=0.5|0.25:s=48000:d=1"); assert.equal(output.length, 96000);
  for (const sample of [0, 9599, 9600, 19199, 19200, 21599, 21600, 26399, 26400, 47999]) {
    const muted = (sample >= 9600 && sample < 19200) || (sample >= 21600 && sample < 26400);
    assert.equal(output[sample * 2], muted ? 0 : .5, `left at ${sample}`); assert.equal(output[sample * 2 + 1], muted ? 0 : .25, `right at ${sample}`);
  }
});
