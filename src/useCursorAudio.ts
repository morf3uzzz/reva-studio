import { useEffect, useMemo, useRef } from "react";
import { cursorAudioCues, cursorSoundURL, resolveCursorSettings } from "./core/cursor";
import { timeToOutput } from "./core/timeline";
import type { Project } from "./types";

/** Playback emits only cues crossed by forward playback; seeks never replay a batch. */
export function useCursorAudio({ project, time, playing, outputTime, onError }: {
  project: Project;
  time: number;
  playing: boolean;
  outputTime?: number;
  onError?: (message: string) => void;
}) {
  const cues = useMemo(() => cursorAudioCues(project), [project.cursor, project.slices, project.trimStart, project.trimEnd, project.speed]);
  const settings = resolveCursorSettings(project.appearance);
  const previous = useRef<{ time: number; playing: boolean; cues: typeof cues; sound: string } | null>(null);
  const active = useRef(new Set<HTMLAudioElement>());
  const onFailure = useRef(onError); onFailure.current = onError;
  useEffect(() => () => { for (const audio of active.current) audio.pause(); active.current.clear(); }, []);
  useEffect(() => {
    const now = outputTime ?? timeToOutput(project, time) ?? 0, last = previous.current;
    previous.current = { time: now, playing, cues, sound: settings.clickSound };
    if (!playing || settings.clickSound === "none" || settings.clickSoundVolume <= 0) {
      for (const audio of active.current) audio.pause(); active.current.clear(); return;
    }
    if (!last?.playing || last.cues !== cues || last.sound !== settings.clickSound || now < last.time || now - last.time > 0.25) return;
    let lo = 0, hi = cues.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (cues[mid].outputTime <= last.time) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < cues.length && cues[i].outputTime <= now; i++) {
      const audio = new Audio(cursorSoundURL(settings.clickSound, cues[i].type));
      audio.volume = settings.clickSoundVolume; active.current.add(audio);
      const finished = () => active.current.delete(audio);
      audio.addEventListener("ended", finished, { once: true });
      audio.addEventListener("error", finished, { once: true });
      void audio.play().catch(() => { finished(); onFailure.current?.("Unable to play click sound."); });
    }
  }, [cues, outputTime, time, playing, settings.clickSound, settings.clickSoundVolume, project]);
}
