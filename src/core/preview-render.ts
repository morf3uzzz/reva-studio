import type { Project } from "../types.ts";
import { isFrameSourceReady, type DrawFrameOptions } from "./render.ts";
import { drawCompositeFrame } from "./compositor.ts";

/** Keep the displayed frame during a seek/buffer gap. The canvas already owns
 * the pixels: no full-resolution copy is needed on every animation frame.
 * Retention is invalidated by a different source, canvas, or backing size. */
export function createPreviewRenderer() {
  let retained: { canvas: HTMLCanvasElement; source: string; width: number; height: number } | null = null;
  return (context: CanvasRenderingContext2D, project: Project, time: number, options: DrawFrameOptions): boolean => {
    const source = project.mediaPath, ready = isFrameSourceReady(options.screen);
    if (source && !ready && retained?.source === source && retained.canvas === context.canvas &&
        retained.width === context.canvas.width && retained.height === context.canvas.height &&
        retained.width === options.width && retained.height === options.height) return false;
    drawCompositeFrame(context, project, time, options);
    retained = source && ready ? { canvas: context.canvas, source, width: options.width, height: options.height } : null;
    return true;
  };
}
