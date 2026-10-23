import type { Project, Slice, TypingRange, Zoom } from "../types.ts";
import { getSlices, duration, selectSlice, outputToSource, timeToOutput, sourceRangeOutputSpans } from "../../shared/timeline.mjs";
export { getSlices, duration, selectSlice, outputToSource, timeToOutput, sourceRangeOutputSpans };
const sliceDuration = (slice: Slice) => (slice.end - slice.start) / slice.speed;

export const SLICE_SPEEDS = [
  0.5, 0.75, 1, 1.2, 1.4, 1.6, 1.8, 2, 3, 4, 8, 16, 24,
];
export const MIN_SLICE_DURATION = 0.05;

export interface SliceSelection {
  slice: Slice;
  index: number;
  sourceTime: number;
  outputTime: number;
  outputStart: number;
  outputEnd: number;
}

/** One insertion plan owns both the hover preview and the created zoom range. */
export function newZoomRange(project: Project, sourceTime: number): Pick<Zoom, "start" | "end"> | null {
  const outputStart = timeToOutput(project, sourceTime);
  if (outputStart === null || project.zooms.some(zoom => zoom.start <= sourceTime && sourceTime < zoom.end)) return null;
  const outputEnd = Math.min(duration(project), outputStart + 3);
  const candidateEnd = outputToSource(project, outputEnd);
  if (candidateEnd === null) return null;
  const nextZoom = project.zooms.reduce((end, zoom) => zoom.start > sourceTime ? Math.min(end, zoom.start) : end, candidateEnd);
  return nextZoom - sourceTime >= 0.1 - 1e-9 ? { start: sourceTime, end: nextZoom } : null;
}


interface TypingIntersection { slice: Slice; start: number; end: number }
interface TypingPlan {
  range: TypingRange;
  start: number;
  end: number;
  intersections: TypingIntersection[];
}

/** Ranges are canonical, ordered and disjoint. Slice order remains output order. */
function typingPlans(slices: readonly Slice[], ranges: readonly TypingRange[]): TypingPlan[] {
  const plans: (TypingPlan | undefined)[] = [];
  let output = 0;
  for (const slice of slices) {
    let low = 0, high = ranges.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (ranges[middle].end <= slice.start) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < ranges.length && ranges[index].start < slice.end; index++) {
      const range = ranges[index], start = Math.max(range.start, slice.start), end = Math.min(range.end, slice.end);
      const outputStart = output + (start - slice.start) / slice.speed, outputEnd = output + (end - slice.start) / slice.speed;
      const plan = plans[index] ??= { range, start: outputStart, end: outputEnd, intersections: [] };
      plan.end = outputEnd;
      plan.intersections.push({ slice, start, end });
    }
    output += sliceDuration(slice);
  }
  return plans.filter((plan): plan is TypingPlan => plan !== undefined);
}

function canSplitTypingIntersection({ slice, start, end }: TypingIntersection, left = slice.start): boolean {
  if (start === left && end === slice.end) return true;
  return !(start > left && start - left < MIN_SLICE_DURATION - 1e-9)
    && !(end < slice.end && slice.end - end < MIN_SLICE_DURATION - 1e-9)
    && end - start >= MIN_SLICE_DURATION - 1e-9;
}

/** Compute all marker positions once per edit, not once per marker per frame. */
export function typingSuggestionSpans(project: Project): { range: TypingRange; start: number; end: number; canApply: boolean }[] {
  const resolved = new Set(project.resolvedTypingSuggestions ?? []);
  const ranges = (project.typingRanges ?? []).filter(range => !resolved.has(range.start));
  return typingPlans(getSlices(project), ranges).map(plan => ({ range: plan.range, start: plan.start, end: plan.end, canApply: plan.intersections.every(part => canSplitTypingIntersection(part)) }));
}

export function unresolvedTypingRanges(project: Project): TypingRange[] {
  return typingSuggestionSpans(project).map(item => item.range);
}

/** The same 50ms split boundary used by manual cuts, with existing edges allowed. */
export function canApplyTypingSpeed(project: Project, range: TypingRange): boolean {
  let present = false;
  for (const slice of getSlices(project)) {
    const start = Math.max(range.start, slice.start), end = Math.min(range.end, slice.end);
    if (end <= start) continue;
    present = true;
    if (!canSplitTypingIntersection({ slice, start, end })) return false;
  }
  return present;
}

export function resolveTypingSuggestion(project: Project, start: number): Project {
  if (project.resolvedTypingSuggestions?.includes(start)) return project;
  return { ...project, resolvedTypingSuggestions: [...(project.resolvedTypingSuggestions ?? []), start].sort((a, b) => a - b) };
}

/** One immutable edit: split retained intersections, set absolute speed, resolve. */
export function applyTypingSuggestions(project: Project, ranges: readonly TypingRange[], speed: number): Project {
  if (!Number.isFinite(speed) || speed < 1.5 || speed > 8) throw new RangeError("Typing speed must be between 1.5 and 8.");
  const original = getSlices(project), resolved = new Set(project.resolvedTypingSuggestions ?? []);
  const selected = [...new Map(ranges.filter(range => !resolved.has(range.start)).map(range => [range.start, range])).values()].sort((a, b) => a.start - b.start);
  const sections = new Map<string, TypingIntersection[]>(), lastEnd = new Map<string, number>();
  for (const plan of typingPlans(original, selected)) {
    // A previous accepted suggestion may have introduced a new left boundary.
    // Validate the whole range before changing any of its retained intersections.
    if (!plan.intersections.every(part => canSplitTypingIntersection(part, lastEnd.get(part.slice.id)))) continue;
    for (const part of plan.intersections) {
      const list = sections.get(part.slice.id) ?? [];
      list.push(part); sections.set(part.slice.id, list); lastEnd.set(part.slice.id, part.end);
    }
    resolved.add(plan.range.start);
  }
  if (sections.size === 0) return project;
  const ids = new Set(original.map(slice => slice.id));
  let sequence = 1;
  const id = () => { while (ids.has(`typing-${sequence}`)) sequence++; const value = `typing-${sequence++}`; ids.add(value); return value; };
  const slices = original.flatMap(slice => {
    const intersections = sections.get(slice.id);
    if (!intersections) return [slice];
    const parts: Slice[] = [];
    const append = (start: number, end: number, rate: number) => parts.push({ ...slice, id: parts.length ? id() : slice.id, start, end, speed: rate });
    let start = slice.start;
    for (const part of intersections) {
      if (part.start > start) append(start, part.start, slice.speed);
      append(part.start, part.end, speed); start = part.end;
    }
    if (start < slice.end) append(start, slice.end, slice.speed);
    return parts;
  });
  return { ...project, slices, resolvedTypingSuggestions: [...resolved].sort((a, b) => a - b) };
}

/** Explicit seek fallback for removed source times; equidistant gaps prefer earlier output. */
export function nearestOutputTime(
  project: Project,
  sourceSeconds: number,
): number | null {
  if (!Number.isFinite(sourceSeconds)) return null;
  const exact = timeToOutput(project, sourceSeconds);
  if (exact !== null) return exact;
  let outputStart = 0,
    bestDistance = Infinity,
    bestOutput: number | null = null;
  for (const slice of getSlices(project)) {
    const outputEnd = outputStart + sliceDuration(slice);
    for (const [source, output] of [
      [slice.start, outputStart],
      [slice.end, outputEnd],
    ]) {
      const distance = Math.abs(sourceSeconds - source);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestOutput = output;
      }
    }
    outputStart = outputEnd;
  }
  return bestOutput;
}

/** Source-clock cuts share edge and identity rules across timeline tracks. */
function splitSourceRange<T extends { id: string; start: number; end: number }>(
  items: T[],
  id: string,
  sourceSeconds: number,
  newId?: string,
): T[] {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0 || !Number.isFinite(sourceSeconds)) return items;
  const item = items[index];
  if (
    sourceSeconds - item.start < MIN_SLICE_DURATION - 1e-9 ||
    item.end - sourceSeconds < MIN_SLICE_DURATION - 1e-9
  )
    return items;
  const ids = new Set(items.map((item) => item.id));
  let secondId = newId;
  if (secondId !== undefined && (!secondId || ids.has(secondId)))
    throw new RangeError("Split item id must be unique and nonempty");
  if (secondId === undefined) {
    let suffix = 2;
    do secondId = `${id}-${suffix++}`;
    while (ids.has(secondId));
  }
  return [
    ...items.slice(0, index),
    { ...item, end: sourceSeconds },
    { ...item, id: secondId, start: sourceSeconds },
    ...items.slice(index + 1),
  ];
}

/** Both pieces retain source speed, volume and per-clip cursor settings. */
export function splitSlice(project: Project, id: string, sourceSeconds: number, newId?: string): Slice[] {
  return splitSourceRange(getSlices(project), id, sourceSeconds, newId);
}

/** Only the chosen zoom is cut; media slices and the playback clock are untouched. */
export function splitZoom(project: Project, id: string, sourceSeconds: number, newId?: string): Zoom[] {
  return splitSourceRange(project.zooms, id, sourceSeconds, newId);
}

/** A pure edit; the UI decides whether deleting the final slice is permitted. */
export function removeSlice(project: Project, id: string): Slice[] {
  return getSlices(project).filter((slice) => slice.id !== id);
}

/** A gap marker restores the adjacent removed source interval into its owner. */
export function restoreSliceTrim(
  project: Project,
  id: string,
  edge: "start" | "end",
): Slice[] {
  const slices = getSlices(project);
  const index = slices.findIndex((slice) => slice.id === id);
  if (index < 0) return slices;
  slices[index] = {
    ...slices[index],
    [edge]:
      edge === "start"
        ? (slices[index - 1]?.end ?? 0)
        : (slices[index + 1]?.start ?? project.duration),
  };
  return slices;
}

/** The end marker joins into the left clip, preserving its speed and settings. */
export function joinNextSlice(project: Project, id: string): Slice[] {
  const slices = getSlices(project);
  const index = slices.findIndex((slice) => slice.id === id);
  const next = slices[index + 1];
  if (index < 0 || !next || Math.abs(next.start - slices[index].end) > 0.001)
    return slices;
  slices[index] = { ...slices[index], end: next.end };
  slices.splice(index + 1, 1);
  return slices;
}
