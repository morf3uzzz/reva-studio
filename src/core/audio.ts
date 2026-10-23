import type { Project } from "../types.ts";
export { AUDIO_SAMPLE_RATE, MAX_LOOP_FRAMES, MICROPHONE_PRESETS, defaultAudioSettings, parseAudioClip, parseAudioSettings, resolveAudioSettings,
  resolveVoiceovers, microphoneOutputMuteRanges, microphoneOutputFilters, microphoneFilters, atempoFilters, audioClipState, audioClipOutputEnd, auxiliaryAudioFilter, audioTracks } from "../../shared/audio.mjs";
import { parseAudioClip, MAX_LOOP_FRAMES, AUDIO_SAMPLE_RATE } from "../../shared/audio.mjs";

export type MicrophonePreset = "off" | "standard" | "loud" | "noise-reduction";
export interface AudioAsset { path: string; name: string; duration: number }
export interface AudioClip {
  id: string; kind: "music" | "voiceover"; clock: "output"; path: string; name: string; sourceDuration: number;
  start: number; end: number; trimStart: number; trimEnd: number; rate: number; volume: number; muted: boolean; loop: boolean; fadeIn: number; fadeOut: number;
  sourceAnchor?: { start: number; timeScale: number; voiceoverDuration: number; attachMode: "first-frame" };
  hideRecording?: boolean;
}
export interface AudioSettings {
  version: 1; systemMuted: boolean; microphoneMuted: boolean; cameraMuted: boolean; microphonePreset: MicrophonePreset;
  background: AudioClip | null; voiceovers: AudioClip[];
  microphoneMuteRanges?: {start: number; end: number}[];
}
export interface AudioProject extends Project { audio?: AudioSettings }
export interface AudioTrackPlan {
  role: "system" | "microphone" | "camera" | "music" | "voiceover"; path: string; clock: "source" | "output";
  volume: number; sourceDelay: number; filters: string[]; outputFilters?: string[]; clip?: AudioClip;
}
export interface AudioServices {
  importFile(): Promise<AudioAsset | null>;
  saveVoiceover(data: Uint8Array, mime: string): Promise<AudioAsset>;
  mediaURL(path: string): string;
  listLibrary?(): Promise<AudioAsset[]>;
  openLibrary?(): Promise<void>;
}

export function createAudioClip(asset: AudioAsset, kind: AudioClip["kind"], outputStart: number, outputDuration: number, id: string): AudioClip {
  const start = Math.min(Math.max(0, outputStart), Math.max(0, outputDuration - 0.01));
  return parseAudioClip({ id, kind, clock: "output", path: asset.path, name: asset.name, sourceDuration: asset.duration, start,
    end: Math.min(604800, kind === "music" ? Math.max(start + .01, outputDuration) : start + asset.duration),
    trimStart: 0, trimEnd: asset.duration, rate: 1, volume: kind === "music" ? .15 : 1, muted: false,
    loop: kind === "music" && asset.duration < outputDuration - start && asset.duration * AUDIO_SAMPLE_RATE <= MAX_LOOP_FRAMES,
    fadeIn: kind === "music" ? .5 : 0, fadeOut: kind === "music" ? .5 : 0 });
}

/** Editing the source trim preserves placement; nonlooping clips stop when audio ends. */
export function updateAudioClip(clip: AudioClip, patch: Partial<AudioClip>): AudioClip {
  return parseAudioClip({ ...clip, ...patch });
}
