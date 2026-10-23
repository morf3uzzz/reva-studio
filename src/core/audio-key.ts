import type { Project } from "../types.ts";
import { getSlices } from "../../shared/timeline.mjs";
import { cameraSourceOffsetSeconds } from "../../shared/camera-clock.mjs";
import { iterateCursorAudioCues } from "../../shared/cursor-audio.mjs";
/** Only audio-result inputs enter the key; visual edits do not restart audio. */
export function audioPlaybackKey(project: Project): string {
  const slices = getSlices(project).map(({ start, end, speed, volume, systemVolume, cameraVolume }) => ({ start, end, speed, volume, systemVolume, cameraVolume })), cursor = project.appearance.cursorSettings;
  return JSON.stringify({ media: project.mediaPath, microphone: project.microphonePath, camera: project.cameraPath, slices, audio: project.audio, systemGain: project.appearance.volume, microphoneGain: project.appearance.microphoneVolume, cameraGain: project.appearance.cameraVolume, fadeIn: project.appearance.fadeIn, fadeOut: project.appearance.fadeOut, cameraOffset: cameraSourceOffsetSeconds(project), clicks: cursor && cursor.clickSound !== "none" && cursor.clickSoundVolume > 0 ? { sound: cursor.clickSound, volume: cursor.clickSoundVolume, cues: [...iterateCursorAudioCues(project.cursor, slices)].map(({ outputTime, type }) => ({ outputTime, type })) } : null });
}

/** Project state is an immutable snapshot; WeakMap entries disappear with the
 * undo/project owner. Playback time ticks never rescan the recorded cursor. */
export function createAudioKeyCache(): (project: Project) => string {
  const keys = new WeakMap<Project, string>();
  return project => { let key = keys.get(project); if (key === undefined) { key = audioPlaybackKey(project); keys.set(project, key); } return key; };
}
