import type { Project } from "../types.ts";
import { drawFrame, type DrawFrameOptions } from "./render.ts";
import { getMediaTime, getOutputTime } from "./model.ts";
const surfaces = new WeakMap<CanvasRenderingContext2D, HTMLCanvasElement>();

/** Geometry shutter integration. All samples use the decoder's current media
 * pixels; only the animated screen/camera/cursor transforms are integrated. */
export function drawCompositeFrame(context: CanvasRenderingContext2D, project: Project, time: number, options: DrawFrameOptions): void {
  const amount = project.appearance.motionBlur ?? 0;
  if (amount <= 0 || typeof document === "undefined") { drawFrame(context, project, time, options); return; }
  // Redaction changes must take effect on the requested frame without leaking
  // an earlier unmasked exposure through a temporal blend.
  const hasRedaction = project.masks?.some(mask => !mask.disabled && time >= mask.start && time < mask.end) || !!(project.privacy?.sensitive || project.privacy?.faces);
  if (hasRedaction) { drawFrame(context, project, time, options); return; }
  let surface = surfaces.get(context); if (!surface) { surface = document.createElement("canvas"); surfaces.set(context, surface); }
  if (surface.width !== options.width) surface.width = options.width; if (surface.height !== options.height) surface.height = options.height;
  const sampleContext = surface.getContext("2d")!;
  const output = options.outputTime ?? getOutputTime(project, time), fps = options.fps ?? 60, shutter = amount * 1.5 / fps, samples = amount > .5 ? 5 : 3;
  context.save(); context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, options.width, options.height);
  for (let index = 0; index < samples; index++) {
    const sampleOutput = Math.max(0, output - shutter + shutter * index / (samples - 1)), sampleTime = getMediaTime(project, sampleOutput);
    drawFrame(sampleContext, project, sampleTime, { ...options, outputTime: sampleOutput }); context.globalAlpha = 1 / (index + 1); context.drawImage(surface, 0, 0);
  }
  context.restore();
}
