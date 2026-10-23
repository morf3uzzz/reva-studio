import type { Project } from "../types.ts";
import { getDuration, getMediaTime, getOutputTime } from "./model.ts";
export function nextShuttleRate(current: number, direction: -1 | 1): number { return Math.sign(current) === direction ? direction * Math.min(16, Math.max(1, Math.abs(current)) * 2) : direction; }
export function shuttlePosition(project: Project, sourceTime: number, elapsedSeconds: number, rate: number) { const output = Math.max(0, Math.min(getDuration(project), getOutputTime(project, sourceTime) + Math.max(0, elapsedSeconds) * rate)); return { sourceTime: getMediaTime(project, output), outputTime: output, atEnd: rate < 0 ? output <= 0 : output >= getDuration(project) }; }
