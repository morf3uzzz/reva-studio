// Shared source-time -> output-time click contract for renderer and encoder.
export const CURSOR_SOUNDS = Object.freeze(["none", "apple-magic-mouse", "logitech-mx-master"]);
export const CURSOR_SOUND_ROOT = "sounds/clicks";
export function cursorSoundURL(sound, type = "click") {
  if (!CURSOR_SOUNDS.includes(sound) || sound === "none" || !["click", "down", "up"].includes(type)) throw new RangeError("Unknown bundled cursor sound.");
  return `${CURSOR_SOUND_ROOT}/${sound}/${type}.wav`;
}
export function* iterateCursorAudioCues(points, slices) {
  const events = points.filter(p => p.event === "mouseDown" || p.event === "mouseUp" || (!p.event && p.click));
  let outputStart = 0;
  for (const slice of slices) {
    if (slice.speed <= 2) {
      let lo = 0, hi = events.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (events[mid].t < slice.start) lo = mid + 1; else hi = mid; }
      for (let i = lo; i < events.length && events[i].t < slice.end; i++) {
        const event = events[i];
        if (event.visible === false) continue;
        const next = events[i + 1];
        let type = event.event === "mouseUp" ? "up" : "down";
        if (!event.event) type = "click";
        else {
          // The original explicit-event scheduler requires a following event.
          if (!next) continue;
          if (next.t > event.t && next.t - event.t < 0.25 && next.t < slice.end) { type = "click"; i++; }
        }
        const outputTime = outputStart + (event.t - slice.start) / slice.speed;
        if (outputTime > 0) yield { sourceTime: event.t, outputTime, type };
      }
    }
    outputStart += (slice.end - slice.start) / slice.speed;
  }
}
