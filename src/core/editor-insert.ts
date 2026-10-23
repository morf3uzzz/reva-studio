import type { Project } from "../types.ts";
import { clamp, getMediaTime, getOutputTime } from "./model.ts";
import { defaultCameraLayout, type CameraPoint } from "./camera.ts";
import type { CameraScene, CameraSceneLayout } from "./camera-effects.ts";
import type { ManualMask } from "./annotations.ts";

export function sceneLayout(type: CameraSceneLayout["type"], base = defaultCameraLayout()): CameraSceneLayout {
  const cameraLayout = structuredClone(base);
  return type === "screen-only" ? { type, cameraLayout } : type === "fullscreen-camera" ? { type, enablePadding: false, cameraLayout } : { ...cameraLayout, type };
}
export function newCameraScene(project: Project, time: number, type: CameraSceneLayout["type"], point?: CameraPoint, endOverride?: number): CameraScene | null {
  const start = clamp(time, 0, Math.max(0, project.duration - .05)), end = endOverride ?? Math.min(project.duration, getMediaTime(project, getOutputTime(project, start) + 3));
  if (!Number.isFinite(end) || end > project.duration || end <= start) return null;
  const initial = sceneLayout(type, project.appearance.cameraLayout ?? defaultCameraLayout());
  const layout = point && initial.type === "camera-overlay" ? { ...initial, overlay: { ...initial.overlay, position: { x: clamp(point.x), y: clamp(point.y) } } } : point && initial.type === "cutout-camera" ? { ...initial, cutout: { ...initial.cutout, positionX: clamp(point.x) } } : initial;
  return { id: crypto.randomUUID(), start, end, layout };
}
export function addManualMask(project: Project, time: number, type: ManualMask["type"], point?: CameraPoint, endOverride?: number): ManualMask | null {
  const start = clamp(time, 0, Math.max(0, project.duration - .5)), end = endOverride ?? Math.min(project.duration, Math.max(start + .5, getMediaTime(project, getOutputTime(project, start) + 3)));
  if (!Number.isFinite(end) || end > project.duration || end <= start || (project.masks ?? []).some(mask => !mask.disabled && mask.type !== type && mask.start < end && mask.end > start)) return null;
  return { id: crypto.randomUUID(), start, end, type, bounds: [{ x: point ? clamp(point.x - .25, 0, .5) : .25, y: point ? clamp(point.y - .15, 0, .7) : .25, width: .5, height: .3 }], blur: 32, opacity: .5 };
}
