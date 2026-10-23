import type { Project } from "../types.ts";
import { duration, getSlices, sourceRangeOutputSpans } from "./timeline.ts";

export type FeatureKind = "layouts" | "masks";
export type FeatureRange = { id: string; start: number; end: number };

/** A hover insertion occupies the empty output gap, up to three seconds. */
export function featureInsertionRange(project: Project, kind: FeatureKind, output: number): { start: number; end: number } | null {
  const total = duration(project);
  if (!Number.isFinite(output) || output < 0 || output >= total) return null;
  const items = kind === "layouts" ? project.cameraScenes ?? [] : project.masks ?? [];
  const spans = items.flatMap(item => sourceRangeOutputSpans(project, item.start, item.end));
  if (spans.some(span => span.start <= output && output < span.end)) return null;
  const end = spans.reduce((end, span) => span.start > output ? Math.min(end, span.start) : end, Math.min(total, output + 3));
  if (end - output < .05 - 1e-9) return null;
  return { start: sourceAt(project, output, "start"), end: sourceAt(project, end, "end") };
}

/** Endpoints at a cut belong to the retained side of the edited range. */
function sourceAt(project: Project, output: number, edge: "start" | "end"): number {
  const slices = getSlices(project);
  let elapsed = 0;
  for (let index = 0; index < slices.length; index++) {
    const slice = slices[index], end = elapsed + (slice.end - slice.start) / slice.speed;
    if (output < end || (edge === "end" && output === end) || index === slices.length - 1)
      return Math.max(slice.start, Math.min(slice.end, slice.start + (output - elapsed) * slice.speed));
    elapsed = end;
  }
  return 0;
}

/** Shared output-clock edit for both feature tracks, independent of zoom/scroll. */
export function editFeatureRange(project: Project, kind: FeatureKind, original: FeatureRange, delta: number, edge?: "start" | "end"): Project {
  if (!Number.isFinite(delta)) return project;
  const items = kind === "layouts" ? project.cameraScenes ?? [] : project.masks ?? [];
  const item = items.find(value => value.id === original.id);
  const spans = sourceRangeOutputSpans(project, original.start, original.end);
  if (!item || !spans.length) return project;
  const total = duration(project), first = spans[0].start, last = spans.at(-1)!.end;
  const minimum = Math.min(.05, last - first);
  const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
  const start = edge === "end" ? first : edge === "start" ? clamp(first + delta, 0, last - minimum) : clamp(first + delta, 0, total - (last - first));
  const end = edge === "start" ? last : edge === "end" ? clamp(last + delta, first + minimum, total) : start + last - first;
  const range = { start: edge === "end" ? original.start : sourceAt(project, start, "start"), end: edge === "start" ? original.end : sourceAt(project, end, "end") };
  if (range.end <= range.start) return project;
  if (kind === "masks") {
    const mask = project.masks!.find(value => value.id === item.id)!;
    if (!mask.disabled && project.masks!.some(value => value.id !== mask.id && !value.disabled && value.type !== mask.type && value.start < range.end && value.end > range.start)) return project;
    if (mask.start === range.start && mask.end === range.end) return project;
    return { ...project, masks: project.masks!.map(value => value.id === item.id ? { ...value, ...range } : value) };
  }
  if (item.start === range.start && item.end === range.end) return project;
  return { ...project, cameraScenes: project.cameraScenes!.map(value => value.id === item.id ? { ...value, ...range } : value) };
}
