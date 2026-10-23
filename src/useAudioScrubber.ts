import { useCallback, useEffect, useRef } from "react";
import { createAudioScrubber, type ScrubTrack } from "./core/audio-scrubber";
import { getOutputTime } from "./core/model";
import { previewMediaRate } from "./core/playback";
import { selectSlice } from "./core/timeline";
import type { Project } from "./types";

export function useAudioScrubber({ project, enabled, playing, previewRate, onError }: { project: Project; enabled: boolean; playing: boolean; previewRate: number; onError: (message: string) => void }) {
  const state = useRef({ project, enabled, playing, previewRate, onError });
  state.current = { project, enabled, playing, previewRate, onError };
  const controller = useRef<ReturnType<typeof createAudioScrubber> | null>(null);
  controller.current ??= createAudioScrubber(path => {
    const audio = new Audio(window.reva?.mediaURL(path) ?? path);
    audio.preload = "auto";
    return {
      get currentTime() { return audio.currentTime; }, set currentTime(value) { audio.currentTime = value; },
      get playbackRate() { return audio.playbackRate; }, set playbackRate(value) { audio.playbackRate = value; },
      get volume() { return audio.volume; }, set volume(value) { audio.volume = value; },
      play: () => audio.play(), pause: () => audio.pause(),
      dispose: () => { audio.pause(); audio.removeAttribute("src"); audio.load(); },
    };
  }, error => state.current.onError(error instanceof Error ? error.message : String(error)));
  const stop = useCallback(() => controller.current?.stop(), []);
  useEffect(() => { controller.current?.reset(); }, [project.mediaPath, project.cameraPath, project.microphonePath, enabled]);
  useEffect(stop, [playing, project.slices, project.appearance, previewRate, stop]);
  useEffect(() => {
    window.addEventListener("blur", stop);
    return () => { window.removeEventListener("blur", stop); controller.current?.reset(); };
  }, [stop]);
  const audition = useCallback((time: number | null) => {
    const { project: p, enabled, playing, previewRate } = state.current;
    if (time === null || !enabled || playing) { stop(); return; }
    const selected = selectSlice(p, getOutputTime(p, time));
    if (!selected) { stop(); return; }
    const tracks: ScrubTrack[] = [];
    for (const [id, path, volume] of [["system", p.mediaPath, p.appearance.volume], ["camera", p.cameraPath, p.appearance.cameraVolume], ["microphone", p.microphonePath, p.appearance.microphoneVolume]] as const) {
      if (path) tracks.push({ id, path, time: selected.sourceTime, rate: previewMediaRate(selected.slice.speed, previewRate), volume: volume * selected.slice.volume, duration: Math.max(0, selected.slice.end - selected.sourceTime) });
    }
    controller.current?.audition(tracks);
  }, [stop]);
  return { audition, stop };
}
