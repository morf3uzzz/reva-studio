const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** The reference slider spans two seconds to ten minutes, capped by the project. */
export function timelineViewportLimits(duration: number) {
  const max = Math.min(600, Math.max(0.001, duration));
  return { min: Math.min(2, max), max };
}

export function timelineVisibleSeconds(duration: number, requested: number): number {
  const { min, max } = timelineViewportLimits(duration);
  return clamp(Number.isFinite(requested) ? requested : 30, min, max);
}

// Inverted cubic easing gives short durations enough travel at the right end.
export function timelineSliderValue(duration: number, seconds: number): number {
  const { min, max } = timelineViewportLimits(duration);
  return max === min ? 0 : 1 - Math.cbrt((timelineVisibleSeconds(duration, seconds) - min) / (max - min));
}

export function timelineSliderSeconds(duration: number, value: number): number {
  const { min, max } = timelineViewportLimits(duration);
  return min + (max - min) * (1 - clamp(value, 0, 1)) ** 3;
}

export function timelineZoomLabel(seconds: number, language: "ru" | "en"): string {
  const minutes = seconds >= 60;
  const count = Math.max(1, Math.floor(seconds / (minutes ? 60 : 1)));
  if (language === "en") return `Timeline zoom — ${count} ${minutes ? "minute" : "second"}${count === 1 ? "" : "s"} visible`;
  const forms = minutes ? ["минута", "минуты", "минут"] : ["секунда", "секунды", "секунд"];
  const last = count % 10, lastTwo = count % 100;
  const unit = forms[last === 1 && lastTwo !== 11 ? 0 : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? 1 : 2];
  return `Масштаб таймлайна — ${count} ${unit} на экране`;
}

export function timelineAnchoredScroll(scale: number, nextScale: number, scrollLeft: number, width: number, anchor: number): number {
  const point = (scrollLeft + clamp(anchor, 0, width)) / scale;
  return clamp(point * nextScale - clamp(anchor, 0, width), 0, width * Math.max(0, nextScale - 1));
}

/** Chromium represents a trackpad pinch as a ctrl+wheel event. */
export function pinchTimeline(
  viewport: { scale: number; scrollLeft: number; width: number; anchor: number; duration: number },
  deltaY: number,
  deltaMode = 0,
  pageHeight = 188,
): { scale: number; scrollLeft: number } {
  if (!Number.isFinite(deltaY) || viewport.width <= 0) return viewport;
  const delta = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? pageHeight : 1);
  const requested = viewport.duration / viewport.scale * Math.exp(Math.min(700, delta * 0.01));
  const seconds = timelineVisibleSeconds(viewport.duration, requested);
  const scale = viewport.duration / seconds;
  return { scale, scrollLeft: timelineAnchoredScroll(viewport.scale, scale, viewport.scrollLeft, viewport.width, viewport.anchor) };
}

const MARK_INTERVALS = [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

/** First target 100–200 CSS px, then choose the nearest reference interval. */
export function timelineMarkInterval(pixelsPerSecond: number): number {
  if (!Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0) return 1;
  const candidate = pixelsPerSecond > 200 ? 1 / Math.ceil(pixelsPerSecond / 200)
    : pixelsPerSecond < 100 ? Math.ceil(100 / pixelsPerSecond) : 1;
  return MARK_INTERVALS.reduce((nearest, value) => Math.abs(value - candidate) < Math.abs(nearest - candidate) ? value : nearest);
}

/** Generate only visible marks, even for a day-long recording at maximum zoom. */
export function timelineMarks(start: number, end: number, interval: number, duration: number): number[] {
  const first = Math.max(1, Math.ceil(start / interval));
  const last = Math.floor(Math.min(end, duration) / interval);
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => (first + index) * interval);
}

export function visibleSliceWindow(slice: { start: number; end: number; speed: number }, outputStart: number, viewStart: number, viewEnd: number, pixelsPerSecond: number) {
  const outputEnd = outputStart + (slice.end - slice.start) / slice.speed;
  const start = Math.max(outputStart, viewStart), end = Math.min(outputEnd, viewEnd);
  if (end <= start) return null;
  return {
    left: (start - outputStart) * pixelsPerSecond,
    width: (end - start) * pixelsPerSecond,
    sourceStart: slice.start + (start - outputStart) * slice.speed,
    sourceEnd: slice.start + (end - outputStart) * slice.speed,
  };
}
