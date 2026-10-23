export interface PlaybackMedia {
  play(): Promise<void>;
  pause(): void;
}

/** Chromium may report the nonempty edit duration while seekable ranges retain
 * the source-clock empty edit. Use the decoder's actual endpoint when present. */
export function mediaTimelineEnd(media: { duration: number; seekable?: Pick<TimeRanges, "length" | "end"> }, knownEnd?: number): number {
  let end = Number.isFinite(knownEnd) && knownEnd! > 0 ? knownEnd! : Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;
  try { for (let index = 0; index < (media.seekable?.length ?? 0); index++) { const value = media.seekable!.end(index); if (Number.isFinite(value)) end = Math.max(end, value); } } catch { /* A live TimeRanges snapshot can change while queried. */ }
  return end;
}
export function mediaSeekTarget(media: { duration: number; seekable?: Pick<TimeRanges, "length" | "end"> }, requested: number, knownEnd?: number): number {
  const end = mediaTimelineEnd(media, knownEnd);
  return Math.min(Math.max(0, requested), Math.max(0, end > media.duration ? end : end - .00001));
}

/** The Chromium media backend accepts 1/16–16× source playback. Export keeps
 * the full slice rate; the preview multiplier never writes to the project. */
export function previewMediaRate(sliceRate: number, previewRate = 1): number {
  return Math.max(1 / 16, Math.min(16, sliceRate * previewRate));
}

/** Assigning even the current time starts a new asynchronous HTML media seek. */
export function seekMedia(media: { currentTime: number }, time: number): void {
  if (Math.abs(media.currentTime - time) > 1e-7) media.currentTime = time;
}

/** Own both the requested state and its asynchronous play completion. A cancelled
 * play promise must never change the state of a later Play/Pause operation. */
export function createPlaybackController(onPlaying: (playing: boolean) => void, onError: (error: unknown) => void) {
  let generation = 0, requested = false;
  let tracks: PlaybackMedia[] = [];
  const pause = () => {
    generation++;
    requested = false;
    for (const track of tracks) track.pause();
    tracks = [];
    onPlaying(false);
  };
  return {
    get requested() { return requested; },
    pause,
    play(primary: PlaybackMedia, companions: PlaybackMedia[] = []) {
      if (requested) return;
      const request = ++generation;
      requested = true;
      tracks = [primary, ...companions];
      void primary.play().then(() => {
        if (request === generation && requested) onPlaying(true);
      }).catch((error: unknown) => {
        if (request !== generation) return;
        pause();
        if (!(error instanceof Error && error.name === "AbortError")) onError(error);
      });
      for (const track of companions) void track.play().catch(() => {});
    },
  };
}
