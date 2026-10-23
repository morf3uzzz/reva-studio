import { seekMedia } from "./playback.ts";

export interface ScrubMedia {
  currentTime: number;
  playbackRate: number;
  volume: number;
  play(): Promise<void>;
  pause(): void;
  dispose(): void;
}
export interface ScrubTrack { id: string; path: string; time: number; rate: number; volume: number; duration: number }
type Entry = { path: string; media: ScrubMedia; request: number; wanted: boolean; failed: boolean; cancelStop?: () => void };
type Schedule = (fn: () => void, delay: number) => () => void;
const schedule: Schedule = (fn, delay) => { const timer = setTimeout(fn, delay); return () => clearTimeout(timer); };

/** Short forward auditions use at most one streaming decoder per audio track.
 * Their lifetime is separate from the paused video and its playhead. */
export function createAudioScrubber(createMedia: (path: string) => ScrubMedia, onError: (error: unknown) => void, later: Schedule = schedule) {
  const entries = new Map<string, Entry>();
  let generation = 0;
  const stopEntry = (entry: Entry) => {
    entry.wanted = false;
    entry.cancelStop?.(); entry.cancelStop = undefined;
    entry.media.pause();
  };
  const stop = () => { generation++; for (const entry of entries.values()) stopEntry(entry); };
  const reset = () => { stop(); for (const entry of entries.values()) entry.media.dispose(); entries.clear(); };
  return {
    stop, reset,
    audition(tracks: readonly ScrubTrack[]) {
      const request = ++generation;
      const audible = tracks.filter(track => track.volume > 0 && track.duration > 0);
      for (const [id, entry] of entries) {
        if (!audible.some(track => track.id === id && track.path === entry.path)) {
          stopEntry(entry); entry.media.dispose(); entries.delete(id);
        }
      }
      for (const track of audible) {
        let entry = entries.get(track.id);
        if (!entry) {
          entry = { path: track.path, media: createMedia(track.path), request, wanted: false, failed: false };
          entries.set(track.id, entry);
        }
        if (entry.failed) continue;
        const current = entry;
        current.request = request; current.wanted = true;
        current.cancelStop?.(); current.cancelStop = undefined;
        const fail = (error: unknown) => {
          if (!current.wanted || current.request !== request || (error instanceof Error && error.name === "AbortError")) return;
          stopEntry(current); current.failed = true; onError(error);
        };
        try {
          seekMedia(current.media, track.time);
          current.media.playbackRate = track.rate;
          current.media.volume = track.volume;
          void current.media.play().then(() => {
            if (!current.wanted) { current.media.pause(); return; }
            if (current.request !== request) return;
            current.cancelStop = later(() => { if (current.request === request) stopEntry(current); }, Math.min(110, track.duration / track.rate * 1000));
          }).catch(fail);
        } catch (error) { fail(error); }
      }
    },
  };
}
