import type { Project, Slice } from "../src/types.ts";
export function getSlices(project: Project): Slice[];
export function duration(project: Project): number;
export function selectSlice(project: Project, outputSeconds: number): import("../src/core/timeline.ts").SliceSelection | null;
export function outputToSource(project: Project, outputSeconds: number): number | null;
export function timeToOutput(project: Project, sourceSeconds: number, sliceId?: string): number | null;
export function sourceRangeOutputSpans(project: Project, start: number, end: number): {start: number; end: number; sliceId: string}[];
