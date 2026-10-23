import type { Appearance, CursorPoint, Project } from "../types.ts";
import { getSlices, timeToOutput, outputToSource, duration, selectSlice } from "./timeline.ts";
import { DEFAULT_SPRING, createSpringState, setSpringTarget, advanceSpring, getSpringSettleTime, type SpringConfig, type SpringState } from "./spring.ts";
import { planCursorMotion, lastAt, type PlannedCursorMotion, type MotionPoint, type MotionRange, type SyncPoint } from "./cursor-motion.ts";
import { iterateCursorAudioCues } from "../../shared/cursor-audio.mjs";
export { cursorSoundURL, CURSOR_SOUND_ROOT } from "../../shared/cursor-audio.mjs";
import { defaultCursorSettings } from "../../shared/cursor-settings.mjs";
export { defaultCursorSettings } from "../../shared/cursor-settings.mjs";

export type CursorEvent = "mouseMoved" | "mouseDragged" | "mouseDown" | "mouseUp";
export type CursorSound = "none" | "apple-magic-mouse" | "logitech-mx-master";
export interface RecordedCursorPoint extends CursorPoint {
  event?: CursorEvent;
  cursorType?: string;
  button?: "left" | "right" | "center";
  /** Explicit recorded hover transition; absence does not assert a hover. */
  hover?: boolean;
}

/** Source-derived controls; durations use milliseconds, rotations use degrees. */
export interface CursorSettings {
  size: number;
  set: { id: string; variants: Record<string, string> };
  alwaysUsePointer: boolean;
  hideNotMovingAfterMs: number | null;
  loopPositionBeforeEndMs: number | null;
  hidden: boolean;
  clickEffect: "none" | "circle" | "ripple";
  clickSound: CursorSound;
  clickSoundVolume: number;
  baseRotation: number;
  rotationMode: "velocity" | "directional";
  tiltAmount: number;
  stopMovementInLastPartMs: number;
  /** Zero disables filtering. L1 distance in recording pixels, not time. */
  shakeThreshold: number;
  optimizeChanges: boolean;
  syncWithHovers: boolean;
}

export type CursorAppearance = Appearance & { cursorSettings?: CursorSettings };

/** Compatibility is owned here; old projects retain all selected legacy values. */
export function resolveCursorSettings(appearance: CursorAppearance): CursorSettings {
  if (appearance.cursorSettings) return appearance.cursorSettings;
  return {
    ...defaultCursorSettings(),
    size: appearance.cursorSize,
    hidden: appearance.cursorHidden,
    hideNotMovingAfterMs: appearance.cursorHideIdle ? 2000 : null,
    clickEffect: appearance.clickEffect,
  };
}

export interface CursorAudioCue {
  sourceTime: number;
  outputTime: number;
  type: "click" | "down" | "up";
}

/** Original pairs events under 250 ms; playback over 2× is intentionally silent. */
export function cursorAudioCues(project: Project): CursorAudioCue[] {
  return [...iterateCursorAudioCues(project.cursor, getSlices(project))];
}

const bound = (n: number, low = 0, high = 1) => Math.max(low, Math.min(high, n));
const radians = (n: number) => n * Math.PI / 180;
const wrapAngle = (n: number) => ((n + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

export function cursorType(id = "pointer"): string {
  const aliases: Record<string, string> = {
    arrow: "pointer", iBeam: "ibeamstroke", crosshair: "cross", closedHand: "closedhand", openHand: "openhand", pointingHand: "pointinghand",
    resizeLeft: "resizeleft", resizeRight: "resizeright", resizeLeftRight: "resizeleftright", resizeUp: "resizeup", resizeDown: "resizedown", resizeUpDown: "resizeupdown",
    disappearingItem: "poof", iBeamCursorForVerticalLayout: "ibeamvertical", operationNotAllowed: "notallowed", dragLink: "makealias", dragCopy: "copy", contextualMenu: "contextualmenu",
    windowResizeNorthEast: "resizenortheast", windowResizeNorthWestSouthEast: "resizenorthwestsoutheast", zoomIn: "zoomin", windowResizeNorthWest: "resizenorthwest",
    windowResizeSouthEast: "resizesoutheast", windowResizeEastWest: "resizeeastwest", windowResizeNorth: "resizenorth", windowResizeEast: "resizeeast", windowResizeNorthSouth: "resizenorthsouth",
    windowResizeNorthEastSouthWest: "resizenortheastsouthwest", windowResizeWest: "resizewest", windowResizeSouth: "resizesouth", windowResizeSouthWest: "resizesouthwest",
    bottomRightResize: "resizesoutheast", bottomLeftResize: "resizesouthwest", topRightResize: "resizenortheast", topLeftResize: "resizenorthwest", notAllowed: "notallowed", makeAlias: "makealias", zoomOut: "zoomout", busyButClickable: "busybutclickable",
  };
  return aliases[id] ?? id;
}

/** Observed filter examines two following positions, preserving input metadata. */
export function removeCursorShakes(points: readonly RecordedCursorPoint[], threshold: number, width: number, height: number): RecordedCursorPoint[] {
  if (threshold === 0) return points.slice();
  const result: RecordedCursorPoint[] = [];
  let discardRelease = false;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (discardRelease && p.event === "mouseUp") { discardRelease = false; continue; }
    const distant = (q: RecordedCursorPoint | undefined) => q !== undefined && Math.abs(q.x - p.x) * width + Math.abs(q.y - p.y) * height > threshold;
    if (distant(points[i + 1]) && distant(points[i + 2])) {
      if (p.event === "mouseDown") discardRelease = true;
    } else result.push(p);
  }
  return result;
}

/** Cursor shape changes are held until click/drag boundaries, as in the source. */
export function optimizedCursorTypes(points: readonly RecordedCursorPoint[]): RecordedCursorPoint[] {
  const result: RecordedCursorPoint[] = [];
  let candidate: RecordedCursorPoint | null = null;
  for (const point of points) {
    candidate ??= point;
    if (candidate.cursorType !== point.cursorType) candidate = point;
    const last = result.at(-1);
    if (point.event === "mouseDragged" && (!last || last.cursorType !== point.cursorType)) result.push(point);
    if (point.event === "mouseMoved" && last?.event === "mouseUp" && last.cursorType !== point.cursorType && point.t - last.t > 0.25) result.push({ ...point, cursorType: "pointer" });
    if (point.event === "mouseDown" || (!point.event && point.click)) { if (candidate) result.push(candidate); candidate = null; }
    if (point.event === "mouseUp") result.push(point);
  }
  return result;
}

export interface CursorRotationKeyframe { timeMs: number; radians: number }

/** Rotation targets use the lead-adjusted event clock, separate from its spring. */
export function cursorRotationKeyframes(points: readonly MotionPoint[] | { length: number; sample: (index: number) => MotionPoint }, mode: CursorSettings["rotationMode"], amount: number, initialRotation?: number): CursorRotationKeyframe[] {
  if (!points.length || (mode === "velocity" && amount === 0)) return [];
  const point = (index: number): MotionPoint => "sample" in points ? points.sample(index) : points[index];
  const frames: CursorRotationKeyframe[] = [];
  let lastValue = NaN, pending: CursorRotationKeyframe | undefined;
  const emit = (timeMs: number, value: number, force = false) => {
    if (!force && Math.abs(value - lastValue) < 0.0015) { pending = { timeMs, radians: value }; return; }
    if (pending && pending.timeMs < timeMs) frames.push(pending);
    pending = undefined;
    if (frames.at(-1)?.timeMs === timeMs) frames[frames.length - 1].radians = value; else frames.push({ timeMs, radians: value });
    lastValue = value;
  };
  const initialSpan = points.length > 1 ? point(1).timeMs - point(0).timeMs : 0;
  const firstIndex = initialSpan > 0 && Math.hypot(point(1).x - point(0).x, point(1).y - point(0).y) / initialSpan > 15 ? 2 : 1;
  let heading = 0;
  if (mode === "velocity") {
    const previous = firstIndex - 1 < points.length ? point(firstIndex - 1) : undefined;
    if (previous) {
      for (let i = firstIndex; i < points.length; i++) {
        const span = point(i).timeMs - previous.timeMs;
        if (span >= 120 || i === points.length - 1) { heading = span > 0 ? (point(i).x - previous.x) / span : 0; break; }
      }
    }
  } else if (initialRotation !== undefined) heading = initialRotation;
  else {
    const previous = firstIndex - 1 < points.length ? point(firstIndex - 1) : undefined;
    if (previous) for (let i = firstIndex; i < points.length; i++) {
      const dx = point(i).x - previous.x, dy = point(i).y - previous.y;
      if (Math.hypot(dx, dy) >= 4) { heading = bound(wrapAngle(Math.atan2(dy, dx) - radians(-112.5)), radians(-135), radians(135)); break; }
    }
  }
  const tilt = () => radians(bound(heading * 12 * amount, -20, 20));
  emit(point(0).timeMs, mode === "velocity" ? tilt() : heading, true);
  let angularVelocity = 0, travelX = 0, travelY = 0, travelMs = 0;
  const advance = (start: number, span: number, horizontal: number, travelHeading: number | null, speed: number) => {
    const steps = Math.max(1, Math.ceil(span / 16)), dt = span / steps;
    for (let i = 1; i <= steps; i++) {
      if (mode === "velocity") {
        heading += (horizontal - heading) * (1 - Math.exp(-dt / 120));
        emit(start + dt * i, tilt());
      } else {
        if (travelHeading !== null) angularVelocity += 0.00005 * Math.min(speed, 3) * Math.sin(travelHeading - (radians(-112.5) + heading)) * dt;
        angularVelocity = bound(angularVelocity * Math.exp(-dt / 100), -radians(0.4), radians(0.4));
        heading += angularVelocity * dt;
        if (Math.abs(heading) > radians(135)) { heading = bound(heading, radians(-135), radians(135)); angularVelocity = 0; }
        emit(start + dt * i, heading);
      }
    }
  };
  for (let i = 1; i < points.length; i++) {
    const a = point(i - 1), b = point(i), span = b.timeMs - a.timeMs;
    if (span <= 0) continue;
    if (i < firstIndex) { advance(a.timeMs, span, 0, null, 0); continue; }
    travelX += b.x - a.x; travelY += b.y - a.y; travelMs += span;
    const length = Math.hypot(travelX, travelY);
    advance(a.timeMs, span, (b.x - a.x) / span, length >= 4 ? Math.atan2(travelY, travelX) : null, length >= 4 ? length / travelMs : 0);
    if (length >= 4) { travelX = 0; travelY = 0; travelMs = 0; }
  }
  const end = point(points.length - 1).timeMs, tail = mode === "velocity" ? 720 : 800;
  advance(end, tail, 0, null, 0); emit(end + tail, mode === "velocity" ? 0 : heading, true);
  // Suppress the entry teleport/initial settling for the first half second.
  const calmEnd = point(0).timeMs + 500, calm = rotationAt(frames, calmEnd);
  return [{ timeMs: point(0).timeMs, radians: calm }, { timeMs: calmEnd, radians: calm }, ...frames.filter(f => f.timeMs > calmEnd)];
}

function rotationAt(frames: readonly CursorRotationKeyframe[], timeMs: number): number {
  if (!frames.length) return 0;
  const i = Math.max(0, lastAt(frames, timeMs, f => f.timeMs)), a = frames[i], b = frames[i + 1];
  return !b || b.timeMs <= a.timeMs ? a.radians : a.radians + (b.radians - a.radians) * bound((timeMs - a.timeMs) / (b.timeMs - a.timeMs));
}

interface MappedEvent extends MotionPoint { sample: RecordedCursorPoint; sourceTime: number; injected: boolean }
interface CursorChunk {
  startMs: number;
  motion: PlannedCursorMotion;
  events: MappedEvent[];
  styleStart: number;
  styleStep: number;
  styles: Float32Array;
}
interface PreparedCursor {
  settings: CursorSettings;
  events: RecordedCursorPoint[];
  types: RecordedCursorPoint[];
  size: { width: number; height: number };
  chunks: Map<string, CursorChunk>;
  rawFollowRotation?: CursorRotationKeyframe[];
}
const prepared = new WeakMap<Project, PreparedCursor>();

function preparedCursor(project: Project): PreparedCursor {
  const cached = prepared.get(project);
  if (cached) return cached;
  const settings = resolveCursorSettings(project.appearance);
  const size = (project as Project & { cursorSourceSize?: { width: number; height: number } }).cursorSourceSize ?? { width: project.width, height: project.height };
  const events = removeCursorShakes(project.cursor, settings.shakeThreshold, size.width, size.height);
  const value = { settings, events, types: settings.optimizeChanges ? optimizedCursorTypes(project.cursor) : project.cursor, size, chunks: new Map<string, CursorChunk>() };
  prepared.set(project, value);
  return value;
}

function eventKind(p: RecordedCursorPoint): CursorEvent { return p.event ?? (p.click ? "mouseDown" : "mouseMoved"); }

function buildChunk(project: Project, data: PreparedCursor, outputTime: number, fps: number): CursorChunk {
  const chunkIndex = Math.floor(Math.max(0, outputTime) / 10), cacheKey = `${chunkIndex}:${fps}`;
  const cached = data.chunks.get(cacheKey);
  if (cached) { data.chunks.delete(cacheKey); data.chunks.set(cacheKey, cached); return cached; }
  const { settings, events, size } = data;
  const spring = project.appearance.cursorSpring ?? DEFAULT_SPRING;
  const chunkStart = chunkIndex * 10_000, fromMs = chunkStart - getSpringSettleTime(spring) - 2100, toMs = Math.min(chunkStart + 12100, duration(project) * 1000);
  const totalMs = duration(project) * 1000;
  const cutoffMs = Math.max(0, totalMs - (settings.loopPositionBeforeEndMs ?? settings.stopMovementInLastPartMs));
  const slices = getSlices(project), mapped: MappedEvent[] = [], sync: SyncPoint[] = [], cuts: number[] = [], instant: MotionRange[] = [];
  let outputStart = 0, previousEnd: number | undefined, lastBeforeCut: MappedEvent | undefined;
  let initial: RecordedCursorPoint | undefined;
  for (const slice of slices) {
    const outputEnd = outputStart + (slice.end - slice.start) / slice.speed * 1000;
    if (!initial) initial = events[Math.max(0, lastAt(events, slice.start, p => p.t))];
    if (outputEnd <= fromMs || outputStart > toMs) { outputStart = outputEnd; previousEnd = slice.end; continue; }
    const start = Math.max(outputStart, fromMs), end = Math.min(outputEnd, toMs, cutoffMs);
    if (previousEnd !== undefined && previousEnd !== slice.start) cuts.push(outputStart - chunkStart);
    if (!(slice.cursorSmooth ?? project.appearance.cursorSmooth)) instant.push({ startMs: start - chunkStart, endMs: outputEnd - chunkStart });
    if (start <= end) {
      const sourceStart = slice.start + (start - outputStart) / 1000 * slice.speed;
      const sourceEnd = slice.start + (end - outputStart) / 1000 * slice.speed;
      const first = Math.max(0, lastAt(events, sourceStart, p => p.t));
      const firstSample = events[first];
      if (firstSample) mapped.push({ timeMs: start - chunkStart, x: firstSample.x * size.width, y: firstSample.y * size.height, sample: firstSample, sourceTime: sourceStart, injected: true });
      const final = lastAt(events, sourceEnd, p => p.t);
      for (let i = first; i <= final; i++) {
        const point = events[i];
        if (point.t < sourceStart || point.t >= slice.end) continue;
        const timeMs = outputStart + (point.t - slice.start) / slice.speed * 1000 - chunkStart;
        const item: MappedEvent = { timeMs, x: point.x * size.width, y: point.y * size.height, sample: point, sourceTime: point.t, injected: false };
        mapped.push(item); lastBeforeCut = item;
        const kind = eventKind(point);
        if (kind === "mouseDown" || kind === "mouseUp") sync.push({ timeMs, tolerance: 2, reason: "click" });
        if (kind === "mouseDragged") sync.push({ timeMs, tolerance: 2, reason: "drag" });
        if (settings.syncWithHovers && point.hover) sync.push({ timeMs, tolerance: 4, reason: "hover" });
      }
      if (!settings.alwaysUsePointer) {
        const firstType = Math.max(0, lastAt(data.types, sourceStart, p => p.t)), finalType = lastAt(data.types, sourceEnd, p => p.t);
        for (let i = firstType + 1; i <= finalType; i++) if (cursorType(data.types[i].cursorType) !== cursorType(data.types[i - 1].cursorType)) sync.push({ timeMs: outputStart + (data.types[i].t - slice.start) / slice.speed * 1000 - chunkStart, tolerance: 6, reason: "cursorImage" });
      }
    }
    outputStart = outputEnd; previousEnd = slice.end;
  }
  if (!mapped.length) {
    const source = outputToSource(project, Math.min(outputTime, cutoffMs / 1000)) ?? 0;
    const point = events[Math.max(0, lastAt(events, source, p => p.t))] ?? { t: 0, x: 0, y: 0, click: false, visible: false };
    mapped.push({ timeMs: fromMs - chunkStart, x: point.x * size.width, y: point.y * size.height, sample: point, sourceTime: source, injected: true });
  }
  if (settings.loopPositionBeforeEndMs !== null && initial && cutoffMs <= toMs) {
    const at = Math.max(fromMs - chunkStart, (lastBeforeCut?.timeMs ?? cutoffMs - chunkStart) + 1);
    mapped.push({ timeMs: at, x: initial.x * size.width, y: initial.y * size.height, sample: { ...initial, click: false, event: "mouseMoved" }, sourceTime: initial.t, injected: true });
  }
  mapped.sort((a, b) => a.timeMs - b.timeMs);
  const motion = planCursorMotion({ points: mapped, syncPoints: sync, spring, durationMs: toMs - chunkStart, cutTimesMs: cuts, instantRanges: instant });
  const drawn = mapped.map(p => ({ ...p, timeMs: p.injected ? p.timeMs : motion.targetTimeAt(p.timeMs) })).sort((a, b) => a.timeMs - b.timeMs);
  let initialRotation: number | undefined;
  if (settings.rotationMode === "directional" && fromMs > 0) {
    data.rawFollowRotation ??= cursorRotationKeyframes({ length: events.length, sample: index => ({ timeMs: events[index].t * 1000, x: events[index].x * size.width, y: events[index].y * size.height }) }, "directional", settings.tiltAmount);
    initialRotation = rotationAt(data.rawFollowRotation, (outputToSource(project, fromMs / 1000) ?? 0) * 1000);
  }
  const rotation = cursorRotationKeyframes(drawn, settings.rotationMode, settings.tiltAmount, initialRotation);
  const styleStep = 1000 / fps, styleStart = Math.floor((fromMs - chunkStart) / styleStep) * styleStep;
  const count = Math.ceil((toMs - chunkStart - styleStart) / styleStep) + 1, styles = new Float32Array(count * 4);
  const rotationSpring = { ...DEFAULT_SPRING, ...(settings.rotationMode === "directional" ? { stiffness: 320, damping: 28, mass: 1 } : { stiffness: 120, damping: 8, mass: 1 }) };
  const opacitySpring = { ...DEFAULT_SPRING, stiffness: 340, damping: 60, mass: 3 };
  let rotationState: SpringState | undefined, scaleState: SpringState | undefined, opacityState: SpringState | undefined;
  for (let i = 0; i < count; i++) {
    const local = styleStart + i * styleStep, absolute = (local + chunkStart) / 1000;
    const selection = selectSlice(project, Math.max(0, absolute));
    const source = selection?.sourceTime ?? 0;
    const event = events[lastAt(events, Math.min(source, (outputToSource(project, cutoffMs / 1000) ?? source)), p => p.t)];
    const visible = !!event && event.visible !== false && source >= (events[0]?.t ?? Infinity) && !(selection?.slice.cursorHidden ?? settings.hidden) && (settings.hideNotMovingAfterMs === null || (source - event.t) * 1000 <= settings.hideNotMovingAfterMs);
    const smooth = selection?.slice.cursorSmooth ?? project.appearance.cursorSmooth;
    const current = mapped[lastAt(mapped, local, p => p.timeMs)];
    const currentKind = current && eventKind(current.sample);
    const legacyPress = current?.sample.click && !current.sample.event && local - current.timeMs < 120;
    const pressed = currentKind === "mouseDragged" || (currentKind === "mouseDown" && (current?.sample.event !== undefined || legacyPress));
    const targetRotation = rotationAt(rotation, local) + radians(settings.baseRotation), targetScale = pressed ? 0.9 : 1;
    const advance = (state: SpringState | undefined, target: number, config: SpringConfig) => state === undefined ? createSpringState(target, target, config) : advanceSpring(setSpringTarget(state, target, config), styleStep, config);
    rotationState = advance(rotationState, targetRotation, rotationSpring);
    scaleState = advance(scaleState, targetScale, smooth ? spring : { ...DEFAULT_SPRING, mass: 0 });
    opacityState = advance(opacityState, Number(visible), opacitySpring);
    styles.set([rotationState.position, scaleState.position, bound(opacityState.position), (1 - bound(opacityState.position)) * 10], i * 4);
  }
  const chunk = { startMs: chunkStart, motion, events: mapped, styleStart, styleStep, styles };
  if (data.chunks.size >= 8) data.chunks.delete(data.chunks.keys().next().value!);
  data.chunks.set(cacheKey, chunk);
  return chunk;
}

export interface CursorFrameState {
  x: number; y: number; opacity: number; rotation: number; scale: number; fadeBlur: number; type: string;
  clicks: { x: number; y: number; ageMs: number }[];
}
export interface CursorFrameOptions { fps?: number; outputTime?: number }

/** Random access is deterministic and uses the same output clock as exports. */
export function cursorFrameAt(project: Project, sourceTime: number, options: CursorFrameOptions = {}): CursorFrameState | null {
  if (!project.cursor.length || !Number.isFinite(sourceTime)) return null;
  const output = options.outputTime ?? timeToOutput(project, sourceTime);
  if (output === null) return null;
  const data = preparedCursor(project), settings = data.settings;
  const chunk = buildChunk(project, data, output, options.fps ?? 60), local = output * 1000 - chunk.startMs;
  const pos = chunk.motion.positionAt(local);
  const frame = bound((local - chunk.styleStart) / chunk.styleStep, 0, chunk.styles.length / 4 - 1), a = Math.floor(frame), b = Math.min(a + 1, chunk.styles.length / 4 - 1), f = frame - a;
  const style = (field: number) => chunk.styles[a * 4 + field] + (chunk.styles[b * 4 + field] - chunk.styles[a * 4 + field]) * f;
  const shape = data.types[Math.max(0, lastAt(data.types, sourceTime, p => p.t))];
  const clicks = chunk.events.filter(p => !p.injected && p.sample.click && p.sample.visible !== false && sourceTime >= p.sourceTime && sourceTime - p.sourceTime <= 1 && p.timeMs <= local).slice(-3).map(p => ({ x: p.sample.x, y: p.sample.y, ageMs: (sourceTime - p.sourceTime) * 1000 }));
  return { x: pos.x / data.size.width, y: pos.y / data.size.height, opacity: style(2), rotation: style(0), scale: style(1), fadeBlur: style(3), type: settings.alwaysUsePointer ? "pointer" : cursorType(shape?.cursorType), clicks };
}

export interface CursorCircleState { radius: number; alpha: number; rimWidth: number }
export function cursorCircleState(ageMs: number, videoWidth: number): CursorCircleState | null {
  if (ageMs < 0 || ageMs > 450) return null;
  const p = ageMs / 450;
  const smooth = (a: number, b: number, x: number) => { const n = bound((x - a) / (b - a)); return n * n * (3 - 2 * n); };
  const alpha = smooth(0, 0.15, p) * (1 - smooth(0.15, 0.9, p)) * 0.6;
  return alpha <= 0 ? null : { radius: videoWidth * (0.002 + 0.028 * (1 - (1 - p) ** 3)), alpha, rimWidth: videoWidth * 0.0007 };
}

/** Ripple's radial displacement; the original also uses RGB chromatic offsets. */
export function cursorRippleOffset(ageMs: number, distance: number, videoWidth: number, pullSize = 0.04): { displacement: number; chromatic: number } {
  if (ageMs < 0 || ageMs > 1000 || distance === 0) return { displacement: 0, chromatic: 0 };
  const phase = ageMs / 1000, radius = distance - (pullSize * videoWidth + phase * videoWidth * 0.2), sigma = videoWidth * 0.05;
  if (Math.abs(radius) > sigma * 3) return { displacement: 0, chromatic: 0 };
  const wave = Math.exp(-phase * 3) * Math.sin(phase * 9.4), gaussian = Math.exp(-4 * (radius / sigma) ** 2);
  return { displacement: wave * gaussian * videoWidth * 0.015, chromatic: Math.abs(wave) * gaussian * (1 - gaussian) * 4 * videoWidth * 0.004 };
}
