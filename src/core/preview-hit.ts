import type { Rect } from "./model.ts";

export type PreviewLayer = "background" | "screen" | "camera" | "cursor";
export interface PreviewFrame { rect: Rect; camera: Rect | null; screenRadius: number; cameraRadius: number; screenClip?: Rect; cursor?: Rect | null }

function contains(rect: Rect, x: number, y: number, radius: number): boolean {
  if (x < rect.x || y < rect.y || x > rect.x + rect.width || y > rect.y + rect.height) return false;
  const r = Math.min(Math.max(0, radius), rect.width / 2, rect.height / 2);
  const cx = Math.max(rect.x + r, Math.min(rect.x + rect.width - r, x));
  const cy = Math.max(rect.y + r, Math.min(rect.y + rect.height - r, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Hit order follows the compositor: camera, cursor, screen, background.
 * Cursor metadata outside the visible screen must not create invisible targets.
 */
export function previewLayerAt(frame: PreviewFrame, x: number, y: number, width: number, height: number, cameraVisible: boolean): PreviewLayer | null {
  if (x < 0 || y < 0 || x > width || y > height) return null;
  if (cameraVisible && frame.camera && contains(frame.camera, x, y, frame.cameraRadius)) return "camera";
  if ((!frame.screenClip || contains(frame.screenClip, x, y, 0)) && contains(frame.rect, x, y, frame.screenRadius)) {
    if (frame.cursor && contains(frame.cursor, x, y, 0)) return "cursor";
    return "screen";
  }
  return "background";
}

export function previewLayerRect(frame: PreviewFrame, layer: PreviewLayer, width: number, height: number): { rect: Rect; radius: number } {
  if (layer === "camera" && frame.camera) return { rect: frame.camera, radius: frame.cameraRadius };
  if (layer === "cursor" && frame.cursor) return { rect: frame.cursor, radius: 0 };
  if (layer === "screen") return { rect: frame.rect, radius: frame.screenRadius };
  return { rect: { x: 0, y: 0, width, height }, radius: 0 };
}
