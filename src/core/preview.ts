// Source-derived preview size steps; only choose a step that changes the fitted canvas.
export const PREVIEW_HEIGHTS = [480, 720, 1080, 1440, 2160] as const;
export function fittedPreviewHeight(width: number, height: number, aspect: number, maximum: number) {
  return Math.max(0, Math.min(height, maximum, width / aspect));
}

/** Preview layout uses CSS pixels; its backing store uses physical display pixels.
 * Keep this separate from export resolution caps and from the preview zoom steps.
 */
export function previewBackingSize(width: number, height: number, pixelRatio: number, quality: number) {
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  const scale = ratio * ([1, .5, .25].includes(quality) ? quality : 1);
  const pixels = (css: number) => Math.max(1, Math.ceil((Number.isFinite(css) && css > 0 ? css : 1) * scale));
  return { width: pixels(width), height: pixels(height) };
}

export function nextPreviewHeight(width: number, height: number, aspect: number, current: number, direction: "larger" | "smaller") {
  const candidates = PREVIEW_HEIGHTS.filter(value => direction === "larger" ? value > current : value < current);
  if (direction === "smaller") candidates.reverse();
  const currentHeight = fittedPreviewHeight(width, height, aspect, current);
  return candidates.find(value => Math.abs(fittedPreviewHeight(width, height, aspect, value) - currentHeight) >= 1) ?? null;
}
