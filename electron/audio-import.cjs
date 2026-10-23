"use strict";

// Translates the verified local first-frame document model. Asset ownership,
// copying and probing belong to the selected bundle's importer, not this file.
const path = require("node:path");
const { defaultAudioSettings, parseAudioSettings, resolveVoiceovers } = require("../shared/audio.mjs");
const { defaultCaptionSettings, parseCaptionSettings } = require("../shared/transcript.mjs");
const { duration, timeToOutput, outputToSource } = require("../shared/timeline.mjs");

class AudioImportFailure extends Error {
  constructor(code, message) { super(`Screen Studio audio import: ${message}`); this.name = "AudioImportFailure"; this.code = code; }
}
function fail(code, message) { throw new AudioImportFailure(code, message); }
function object(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-metadata", `${label} must be an object.`); return value; }
function number(value, minimum, maximum, label) { if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) fail("invalid-metadata", `${label} is invalid.`); return value; }
function string(value, maximum, label) { if (typeof value !== "string" || !value || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) fail("invalid-metadata", `${label} is invalid.`); return value; }
function boolean(value, fallback, label) { if (value === undefined) return fallback; if (typeof value !== "boolean") fail("invalid-metadata", `${label} must be true or false.`); return value; }
function localFileName(value) {
  const name = string(value, 4096, "Voiceover file name");
  if (name === "." || name === ".." || /[\\/:?#%]/.test(name) || path.isAbsolute(name)) fail("unsafe-path", "Voiceover assets must name one local file inside the selected project's voiceovers directory.");
  return name;
}
function parseVoiceoverSources(input, sourceDuration) {
  number(sourceDuration, .001, 86400, "Recording source duration");
  if (!Array.isArray(input) || input.length > 64) fail("capacity", "Up to 64 local voiceover items can be imported.");
  const ids = new Set(); let previous = 0;
  return input.map((entry, index) => {
    const value = object(entry, `Voiceover ${index + 1}`), id = string(value.id, 256, "Voiceover ID");
    if (ids.has(id)) fail("duplicate-identity", "Voiceover IDs must be unique."); ids.add(id);
    const sourceStartMs = number(value.sourceStartMs, previous, sourceDuration * 1000, "Voiceover source start"); previous = sourceStartMs;
    const attachMode = value.attachMode === undefined ? "first-frame" : string(value.attachMode, 128, "Voiceover attachment");
    if (attachMode !== "first-frame") fail("unsupported-attachment", `Voiceover ${id} uses the unverified attachment mode ${JSON.stringify(attachMode)}.`);
    return { id, sourceStartMs, voiceoverDurationMs: number(value.voiceoverDurationMs, 1, 86400000, "Voiceover duration"), fileName: localFileName(value.fileName),
      timeScale: number(value.timeScale ?? 1, Number.MIN_VALUE, Number.MAX_VALUE, "Voiceover time scale"), volume: number(value.volume ?? 1, 0, 1, "Voiceover gain"),
      isDisabled: boolean(value.isDisabled, false, "Disabled voiceover"), hideRecording: boolean(value.hideRecording, true, "Hide microphone under voiceover"), attachMode,
      ...(value.source === undefined ? {} : { source: value.source }) };
  });
}
function assetFacts(asset, name) {
  const value = object(asset, `Resolved voiceover ${name}`), info = object(value.info, "Resolved voiceover probe");
  if (typeof value.path !== "string" || !path.isAbsolute(value.path) || value.path.includes("\0")) fail("unowned-asset", "A voiceover resolver must return an owned copied absolute local path.");
  if (!info.audio || typeof info.audio !== "object" || Array.isArray(info.audio)) fail("invalid-media", `Voiceover ${name} has no verified audio stream.`);
  return { path: value.path, duration: number(info.duration, .001, 86400, "Probed voiceover duration") };
}
function importCaptionSettings(config, warnings) {
  if (config.captions === undefined) return undefined;
  const value = object(config.captions, "Caption configuration"), defaults = defaultCaptionSettings();
  const settings = parseCaptionSettings({ ...defaults,
    ...(value.enableTranscript === undefined ? {} : { enabled: value.enableTranscript }),
    ...Object.fromEntries(["showSoundLabels", "font", "sizeRatio", "color", "backgroundColor", "wordsReveal", "lineGrowth", "wordEntrance"].filter(key => value[key] !== undefined).map(key => [key, value[key]])),
    ...(value.position01 === undefined ? {} : { position: value.position01 }) });
  warnings.push("Caption appearance is imported. Persistent transcript storage is unverified; generate locally or import a timed transcript to restore its text.");
  return settings;
}

/**
 * Times and callback arguments are seconds. resolveAsset('voiceover', fileName)
 * must copy from <selected project>/voiceovers/<fileName>, enforce the bundle's
 * resource/identity rules, and return {path,info:{duration,audio,video?}}.
 */
async function importScreenStudioAudio({ scene, config = {}, slices, sourceDuration, outputDuration, sourceToPlayback, playbackToSource, resolveAsset }) {
  const originalScene = object(scene, "Recording scene"), originalConfig = object(config, "Project configuration"), audioConfig = originalConfig.audio === undefined ? {} : object(originalConfig.audio, "Audio configuration"), warnings = [];
  const sources = parseVoiceoverSources(originalScene.voiceOvers ?? [], sourceDuration);
  if (!Array.isArray(slices)) fail("invalid-timeline", "The importer must provide its canonical retained recording slices.");
  const project = { duration: sourceDuration, trimStart: 0, trimEnd: sourceDuration, speed: 1, slices }, total = duration(project);
  if (!(total > 0) || !Number.isFinite(total) || (outputDuration !== undefined && Math.abs(outputDuration - total) > 1e-6)) fail("invalid-timeline", "The supplied edited duration does not match its retained slices.");
  const settings = defaultAudioSettings();
  settings.systemMuted = boolean(audioConfig.muteSystemAudio, false, "Mute system audio");
  settings.microphoneMuted = boolean(audioConfig.muteMicrophone, false, "Mute microphone");
  settings.cameraMuted = boolean(audioConfig.muteExternalDeviceAudio, false, "Mute external device audio");
  const preset = audioConfig.microphoneAudioPreset == null ? audioConfig.microphoneAudioPreset : string(audioConfig.microphoneAudioPreset, 128, "Microphone preset");
  const presets = { "channel-fix": "off", voice: "standard", loud: "loud", "noise-reduction": "noise-reduction" };
  if (preset === undefined || preset === null) settings.microphonePreset = "off";
  else if (Object.hasOwn(presets, preset)) settings.microphonePreset = presets[preset];
  else { settings.microphonePreset = "off"; warnings.push(`Original microphone preset ${JSON.stringify(preset)} is unverified and was kept off; choose a local processing preset explicitly.`); }
  for (const source of sources) {
    if (typeof resolveAsset !== "function") fail("asset-resolver-unavailable", "A selected local voiceover asset resolver is required.");
    let asset;
    try { asset = await resolveAsset("voiceover", source.fileName); }
    catch (error) { fail("asset-unavailable", `Voiceover ${source.id} could not be resolved from the selected local project: ${error.message}`); }
    const file = assetFacts(asset, source.fileName), originalDuration = source.voiceoverDurationMs / 1000;
    const start = timeToOutput(project, source.sourceStartMs / 1000);
    if (typeof sourceToPlayback === "function") {
      const supplied = sourceToPlayback(source.sourceStartMs / 1000);
      if (supplied == null || start == null || !Number.isFinite(supplied) || Math.abs(supplied - start) > 1e-6) {
        if (!source.isDisabled) fail("unresolved-anchor", `Voiceover ${source.id} is not anchored inside a retained source slice. Unknown gap snapping is not applied.`);
        warnings.push(`Disabled voiceover ${source.id} has no verified retained recording anchor.`);
      }
    }
    const provisionalDuration = Math.min(file.duration, originalDuration), provisionalStart = Math.min(start ?? 0, Math.max(0, total - .001));
    settings.voiceovers.push({ id: source.id, kind: "voiceover", clock: "output", path: file.path, name: source.fileName, sourceDuration: file.duration,
      start: provisionalStart, end: provisionalStart + provisionalDuration, trimStart: 0, trimEnd: provisionalDuration, rate: 1, volume: source.volume, muted: source.isDisabled,
      loop: false, fadeIn: 0, fadeOut: 0, hideRecording: source.hideRecording,
      sourceAnchor: { start: source.sourceStartMs / 1000, timeScale: source.timeScale, voiceoverDuration: originalDuration, attachMode: "first-frame" } });
  }
  project.audio = parseAudioSettings(settings);
  const resolved = resolveVoiceovers(project);
  for (const problem of resolved.issues) {
    if (!settings.voiceovers.find(clip => clip.id === problem.id).muted) fail("unsupported-timing", `Voiceover ${problem.id}: ${problem.message}`);
    warnings.push(`Disabled voiceover ${problem.id}: ${problem.message}`);
  }
  settings.voiceovers = resolved.clips;
  const microphoneMuteRanges = [];
  for (const clip of resolved.clips) {
    if (clip.muted || !clip.hideRecording || resolved.issues.some(problem => problem.id === clip.id)) continue;
    const end = outputToSource(project, clip.end), suppliedEnd = typeof playbackToSource === "function" ? playbackToSource(clip.end) : end;
    if (end == null || suppliedEnd == null || !Number.isFinite(suppliedEnd) || Math.abs(suppliedEnd - end) > 1e-6 || end < clip.sourceAnchor.start) fail("unresolved-anchor", `Voiceover ${clip.id} has no verified original source end.`);
    microphoneMuteRanges.push({ start: clip.sourceAnchor.start, end });
  }
  if (audioConfig.backgroundAudioFileName != null) warnings.push(`Original background audio ${JSON.stringify(string(audioConfig.backgroundAudioFileName, 4096, "Background audio file name"))} has no verified portable asset location. Select a local replacement; no bundled vendor track is copied or substituted.`);
  const captionSettings = importCaptionSettings(originalConfig, warnings);
  return { audio: parseAudioSettings(settings), microphoneMuteRanges, warnings, voiceoverSources: sources, ...(captionSettings ? { captionSettings } : {}) };
}

module.exports = { AudioImportFailure, importScreenStudioAudio, parseVoiceoverSources, importCaptionSettings };
