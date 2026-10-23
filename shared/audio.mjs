/** Local track policy and FFmpeg DSP shared by preview and export. */
import { duration as timelineDuration, timeToOutput, sourceRangeOutputSpans } from "./timeline.mjs";
export const AUDIO_SAMPLE_RATE = 48000;
// Stereo float PCM needs 8 bytes/frame. Bound a looping window to 128 MiB.
export const MAX_LOOP_FRAMES = 16 * 1024 * 1024;
export const MICROPHONE_PRESETS = ["off", "standard", "loud", "noise-reduction"];
const obj = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
};
const num = (value, min, max, label) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} is out of range.`);
  return value;
};
const str = (value, label, max = 32768) => {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new Error(`${label} is invalid.`);
  return value;
};
const bool = (value, label) => { if (typeof value !== "boolean") throw new Error(`${label} must be true or false.`); return value; };
const choose = (value, choices, label) => { if (!choices.includes(value)) throw new Error(`${label} is invalid.`); return value; };

export function defaultAudioSettings() {
  // Absence of this optional model must preserve legacy raw audio.
  return { version: 1, systemMuted: false, microphoneMuted: false, cameraMuted: false, microphonePreset: "off", background: null, voiceovers: [] };
}

export function parseAudioClip(input, expectedKind) {
  const c = obj(input, "Audio clip"), kind = choose(c.kind, ["music", "voiceover"], "Audio clip kind");
  if (expectedKind && kind !== expectedKind) throw new Error("Audio clip is in the wrong track.");
  const id = str(c.id, "Audio clip ID", 256), file = str(c.path, "Audio clip path");
  if (!id || !file) throw new Error("Audio clip ID and file path are required.");
  const sourceDuration = num(c.sourceDuration, 0.001, 604800, "Audio source duration");
  const trimStart = num(c.trimStart, 0, sourceDuration, "Audio trim start");
  const trimEnd = num(c.trimEnd, trimStart, sourceDuration + 1e-6, "Audio trim end");
  const start = num(c.start, 0, 604800, "Audio output start"), end = num(c.end, start, 604800, "Audio output end");
  if (trimEnd <= trimStart || end <= start) throw new Error("Audio clip must retain positive source and output durations.");
  const rate = num(c.rate, 0.25, 4, "Audio playback rate"), loop = bool(c.loop, "Audio looping");
  if (kind === "voiceover" && loop) throw new Error("Voiceover clips do not loop.");
  if (loop && Math.round((trimEnd - trimStart) / rate * AUDIO_SAMPLE_RATE) > MAX_LOOP_FRAMES)
    throw new Error("This looping window exceeds the 128 MiB stereo PCM bound. Shorten the music trim or turn off looping.");
  let sourceAnchor;
  if (c.sourceAnchor !== undefined) {
    if (kind !== "voiceover") throw new Error("Only voiceover clips can follow an original recording anchor.");
    const anchor = obj(c.sourceAnchor, "Voiceover source anchor");
    sourceAnchor = { start: num(anchor.start, 0, 604800, "Voiceover recording anchor"), timeScale: num(anchor.timeScale, Number.MIN_VALUE, Number.MAX_VALUE, "Voiceover source time scale"), voiceoverDuration: num(anchor.voiceoverDuration, .001, 604800, "Original voiceover duration"), attachMode: choose(anchor.attachMode, ["first-frame"], "Voiceover attachment") };
  }
  if (c.hideRecording !== undefined && kind !== "voiceover") throw new Error("Only a voiceover can mute the microphone under its placement.");
  return { id, kind, clock: choose(c.clock, ["output"], "Audio timing clock"), path: file, name: str(c.name, "Audio clip name", 4096), sourceDuration, start, end, trimStart, trimEnd, rate,
    volume: num(c.volume, 0, 1, "Audio clip volume"), muted: bool(c.muted, "Muted audio clip"), loop,
    fadeIn: num(c.fadeIn, 0, 30, "Audio fade in"), fadeOut: num(c.fadeOut, 0, 30, "Audio fade out"),
    ...(sourceAnchor ? { sourceAnchor } : {}), ...(c.hideRecording === undefined ? {} : { hideRecording: bool(c.hideRecording, "Mute microphone under voiceover") }) };
}
export function parseAudioSettings(input) {
  const a = obj(input, "Audio settings");
  choose(a.version, [1], "Audio settings version");
  if (!Array.isArray(a.voiceovers) || a.voiceovers.length > 64) throw new Error("A project supports up to 64 local voiceover clips.");
  const voiceovers = a.voiceovers.map(c => parseAudioClip(c, "voiceover"));
  const background = a.background === null ? null : parseAudioClip(a.background, "music");
  const ids = new Set();
  for (const clip of [...(background ? [background] : []), ...voiceovers]) {
    if (ids.has(clip.id)) throw new Error("Audio clip IDs must be unique.");
    ids.add(clip.id);
  }
  let microphoneMuteRanges;
  if (a.microphoneMuteRanges !== undefined) {
    if (!Array.isArray(a.microphoneMuteRanges) || a.microphoneMuteRanges.length > 64) throw new Error("Microphone source mute ranges exceed the 64-range bound.");
    let previous = 0;
    microphoneMuteRanges = a.microphoneMuteRanges.map(input => { const value = obj(input, "Microphone mute range"), start = num(value.start, previous, 604800, "Microphone mute start"), end = num(value.end, start, 604800, "Microphone mute end"); if (end <= start) throw new Error("Microphone mute ranges must have positive duration."); previous = end; return { start, end }; });
  }
  return { version: 1, systemMuted: bool(a.systemMuted, "System audio mute"), microphoneMuted: bool(a.microphoneMuted, "Microphone mute"), cameraMuted: bool(a.cameraMuted, "Camera audio mute"),
    microphonePreset: choose(a.microphonePreset, MICROPHONE_PRESETS, "Microphone processing preset"), background, voiceovers,
    ...(microphoneMuteRanges === undefined ? {} : { microphoneMuteRanges }) };
}
export function resolveAudioSettings(project) { return project.audio ?? defaultAudioSettings(); }
const voiceoverResolutions = new WeakMap();

/** The original first-frame policy uses the next collection item, including
 * disabled items. Keep imported anchored items in their serialized order. */
export function resolveVoiceovers(project) {
  const voiceovers = resolveAudioSettings(project).voiceovers;
  if (!voiceovers.some(clip => clip.sourceAnchor)) return { clips: voiceovers, issues: [] };
  // Renderer projects use immutable arrays; retain one timing plan per live
  // voiceover collection so playback ticks do not rescan a long recording.
  const timelineKey = project.slices ?? `${project.duration}:${project.trimStart}:${project.trimEnd}:${project.speed}`, cached = voiceoverResolutions.get(voiceovers);
  if (cached?.timelineKey === timelineKey) return cached.result;
  const total = timelineDuration(project), issues = [];
  const anchored = voiceovers.filter(clip => clip.sourceAnchor), starts = new Map(anchored.map(clip => [clip.id, timeToOutput(project, clip.sourceAnchor.start)]));
  const clips = voiceovers.map(clip => {
    if (!clip.sourceAnchor) return clip;
    const anchor = clip.sourceAnchor, start = starts.get(clip.id), index = anchored.indexOf(clip), next = anchored[index + 1], nextStart = next ? starts.get(next.id) : total;
    try {
      if (start == null || start >= total) throw new Error("Its original recording anchor is outside the retained video. Restore that frame or convert this voiceover to edited-timeline timing.");
      if (nextStart == null) throw new Error("The following original voiceover's recording anchor was removed, so its available interval is unknown.");
      const available = nextStart - start;
      if (!(available > 0)) throw new Error("Original voiceover anchors are not in increasing playback order.");
      const rate = Math.max(1 / anchor.timeScale, Math.max(1, anchor.voiceoverDuration / available)), end = Math.min(total, start + anchor.voiceoverDuration / rate), trimEnd = (end - start) * rate;
      if (!Number.isFinite(rate) || rate < .25 || rate > 4) throw new Error(`Its original automatic speed (${Number.isFinite(rate) ? rate.toFixed(3) : "unbounded"}×) exceeds the supported 0.25–4× audio range.`);
      if (!(end > start) || trimEnd > clip.sourceDuration + 1e-6) throw new Error("The local voiceover media is shorter than its required original source interval.");
      return parseAudioClip({ ...clip, start, end, trimStart: 0, trimEnd: Math.min(clip.sourceDuration, trimEnd), rate });
    } catch (error) { issues.push({ id: clip.id, message: error.message }); return clip; }
  });
  const result = { clips, issues }; voiceoverResolutions.set(voiceovers, { timelineKey, result }); return result;
}

function mergedRanges(input) {
  const result = [];
  for (const value of input.sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (value.end <= value.start) continue;
    const last = result[result.length - 1];
    if (last && value.start <= last.end + 1e-9) last.end = Math.max(last.end, value.end);
    else result.push({ start: value.start, end: value.end });
  }
  return result;
}
export function microphoneOutputMuteRanges(project, resolvedClips) {
  const settings = resolveAudioSettings(project), total = timelineDuration(project), ranges = [];
  for (const range of settings.microphoneMuteRanges ?? []) ranges.push(...sourceRangeOutputSpans(project, range.start, range.end));
  for (const clip of resolvedClips ?? resolveVoiceovers(project).clips) if (!clip.muted && clip.hideRecording) ranges.push({ start: clip.start, end: audioClipOutputEnd(clip, total) });
  return mergedRanges(ranges);
}
export function microphoneOutputFilters(project, resolvedClips) {
  const ranges = microphoneOutputMuteRanges(project, resolvedClips);
  if (!ranges.length) return [];
  // aeval evaluates t per sample and val(ch) retains every input channel.
  // volume's timeline enable would instead leak up to one audio frame at a cut.
  return [`aeval=exprs='val(ch)*not(${ranges.map(range => `gte(t,${range.start})*lt(t,${range.end})`).join("+")})':c=same`];
}

export function microphoneFilters(preset) {
  choose(preset, MICROPHONE_PRESETS, "Microphone processing preset");
  if (preset === "off") return [];
  if (preset === "noise-reduction") return ["highpass=f=80", "afftdn=nf=-25", "acompressor=threshold=0.2:ratio=2:attack=10:release=120:makeup=1.25", "alimiter=limit=0.95:level=0:latency=1"];
  if (preset === "loud") return ["highpass=f=70", "acompressor=threshold=0.1:ratio=4:attack=5:release=150:makeup=3", "alimiter=limit=0.95:level=0:latency=1"];
  return ["highpass=f=70", "acompressor=threshold=0.25:ratio=2:attack=10:release=120:makeup=1.25", "alimiter=limit=0.95:level=0:latency=1"];
}
export function atempoFilters(rate) {
  num(rate, 0.1, 24, "Audio tempo");
  const filters = []; let remaining = rate;
  while (remaining > 2) { filters.push("atempo=2"); remaining /= 2; }
  while (remaining < 0.5) { filters.push("atempo=0.5"); remaining /= 0.5; }
  if (Math.abs(remaining - 1) > 1e-9) filters.push(`atempo=${remaining}`);
  return filters;
}

export function audioClipOutputEnd(clip, outputDuration) {
  return Math.max(clip.start, Math.min(outputDuration, clip.end, clip.loop ? Infinity : clip.start + (clip.trimEnd - clip.trimStart) / clip.rate));
}
export function audioClipState(clip, outputTime, outputDuration) {
  const end = audioClipOutputEnd(clip, outputDuration);
  if (clip.muted || clip.volume <= 0 || outputTime < clip.start || outputTime >= end) return null;
  const elapsed = outputTime - clip.start, sourceSpan = clip.trimEnd - clip.trimStart, duration = end - clip.start;
  const sourceTime = clip.trimStart + (clip.loop ? (elapsed * clip.rate) % sourceSpan : elapsed * clip.rate);
  const fadeIn = clip.fadeIn > 0 ? Math.min(1, elapsed / Math.min(clip.fadeIn, duration)) : 1;
  const fadeOut = clip.fadeOut > 0 ? Math.min(1, (end - outputTime) / Math.min(clip.fadeOut, duration)) : 1;
  return { sourceTime, gain: clip.volume * fadeIn * fadeOut, outputEnd: end, rate: clip.rate };
}

/** Numeric-only chain. Supply the same graph to offline preview and final export. */
export function auxiliaryAudioFilter(clip, inputLabel, outputLabel, outputDuration) {
  if (!/^\d+:a(?::\d+)?$/.test(inputLabel) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(outputLabel)) throw new Error("Invalid audio filter label.");
  parseAudioClip(clip);
  num(outputDuration, 0, 604800, "Output duration");
  const end = audioClipOutputEnd(clip, outputDuration), duration = end - clip.start;
  if (clip.muted || clip.volume <= 0 || duration <= 0) return null;
  const chain = [`atrim=start=${clip.trimStart}:end=${clip.trimEnd}`, "asetpts=PTS-STARTPTS", "aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo", ...atempoFilters(clip.rate)];
  if (clip.loop) chain.push(`aloop=loop=-1:size=${Math.max(1, Math.round((clip.trimEnd - clip.trimStart) / clip.rate * AUDIO_SAMPLE_RATE))}`, "asetpts=N/SR/TB");
  chain.push(`atrim=duration=${duration}`, `volume=${clip.volume}`);
  if (clip.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${Math.min(clip.fadeIn, duration)}`);
  if (clip.fadeOut > 0) chain.push(`afade=t=out:st=${Math.max(0, duration - clip.fadeOut)}:d=${Math.min(clip.fadeOut, duration)}`);
  // Pin the delayed stream to sample count before padding. Certain FFmpeg
  // graphs propagate an unset first PTS through aloop/volume, which otherwise
  // shortens PCM output while reporting the full duration.
  const frames = Math.ceil(outputDuration * AUDIO_SAMPLE_RATE);
  chain.push(`adelay=${Math.round(clip.start * AUDIO_SAMPLE_RATE)}S:all=1`, "asetpts=N/SR/TB", `apad=whole_len=${frames}`, `atrim=end_sample=${frames}`);
  return `[${inputLabel}]${chain.join(",")}[${outputLabel}]`;
}

/** Channel policy is owned once; the timeline owner still supplies slice mapping. */
export function audioTracks(project, cameraSourceDelaySeconds = 0) {
  num(cameraSourceDelaySeconds, -Number.MAX_VALUE, Number.MAX_VALUE, "Resolved camera source delay");
  const a = resolveAudioSettings(project), tracks = [], resolved = resolveVoiceovers(project);
  for (const problem of resolved.issues) if (!a.voiceovers.find(clip => clip.id === problem.id)?.muted) throw new Error(`Voiceover ${problem.id}: ${problem.message}`);
  for (const [role, file, volume, muted] of [["system", project.mediaPath, project.appearance.volume, a.systemMuted], ["microphone", project.microphonePath, project.appearance.microphoneVolume, a.microphoneMuted], ["camera", project.cameraPath, project.appearance.cameraVolume, a.cameraMuted]]) {
    if (file && !muted && volume > 0) tracks.push({ role, path: file, clock: "source", volume, sourceDelay: role === "camera" ? cameraSourceDelaySeconds : 0,
      filters: role === "microphone" ? microphoneFilters(a.microphonePreset) : [], ...(role === "microphone" ? { outputFilters: microphoneOutputFilters(project, resolved.clips) } : {}) });
  }
  for (const clip of [...(a.background ? [a.background] : []), ...resolved.clips]) {
    if (!clip.muted && clip.volume > 0) tracks.push({ role: clip.kind, path: clip.path, clock: "output", volume: clip.volume, sourceDelay: 0, filters: [], clip });
  }
  return tracks;
}
