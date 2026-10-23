import type { CropRect, CropSize } from "./crop-geometry.ts";

export function globalRectToViewport(rect: CropRect, frame: CropRect, viewport: CropSize): CropRect {
  return { x: (rect.x - frame.x) * viewport.width / frame.width, y: (rect.y - frame.y) * viewport.height / frame.height, width: rect.width * viewport.width / frame.width, height: rect.height * viewport.height / frame.height };
}

export function viewportPointToGlobal(point: { x: number; y: number }, frame: CropRect, viewport: CropSize) {
  return { x: frame.x + point.x * frame.width / viewport.width, y: frame.y + point.y * frame.height / viewport.height };
}

export function sourceRectToGlobal(rect: CropRect, source: CropSize, display: CropRect): CropRect {
  return { x: display.x + rect.x * display.width / source.width, y: display.y + rect.y * display.height / source.height, width: rect.width * display.width / source.width, height: rect.height * display.height / source.height };
}

export function globalPointToSource(point: { x: number; y: number }, source: CropSize, display: CropRect) {
  return { x: Math.max(0, Math.min(source.width, (point.x - display.x) * source.width / display.width)), y: Math.max(0, Math.min(source.height, (point.y - display.y) * source.height / display.height)) };
}
