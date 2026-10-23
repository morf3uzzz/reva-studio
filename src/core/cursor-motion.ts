/**
 * Independent implementation of the source-derived cursor planner contract.
 * Units: recording pixels and output milliseconds. This is deliberately separate
 * from the screen animation spring.
 */
import { resolveSpringConfig, type SpringConfig } from "./spring.ts";

export interface MotionPoint { timeMs: number; x: number; y: number }
export interface MotionRange { startMs: number; endMs: number }
export interface SyncPoint { timeMs: number; tolerance: number; reason: "click" | "drag" | "hover" | "cursorImage" }
export interface CursorMotionInput {
  points: readonly MotionPoint[];
  syncPoints: readonly SyncPoint[];
  spring: SpringConfig;
  durationMs: number;
  instantRanges: readonly MotionRange[];
  cutTimesMs: readonly number[];
}
interface Vector { x: number; y: number }
interface State extends Vector { vx: number; vy: number }
interface SyncGroup extends MotionRange { points: SyncPoint[] }
type Knot = [time: number, lead: number];
interface SpeedBump { start: number; fullStart: number; fullEnd: number; end: number; speed: number }
export const CURSOR_PLANNER = Object.freeze({
  groupGapMs: 100, mergeGapMs: 400, maxLeadMs: 600, approachWindowMs: 1500,
  compressionWindowMs: 400, maxCompressionRate: 1.4, leadDecayPerMs: 0.35,
  speedLevels: [1, 1.25, 1.6, 2, 2.5, 3.2, 4, 5, 6.4, 8, 10, 13, 16, 20, 25, 32],
  speedBlendInMs: 250, speedBlendOutMs: 300, acceptedErrorRatio: 0.75,
});

/** Last item whose key is at most time; equal keys choose the final item. */
export function lastAt<T>(items: readonly T[], time: number, key: (item: T) => number): number {
  let lo = 0, hi = items.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (key(items[mid]) <= time) lo = mid + 1; else hi = mid; }
  return lo - 1;
}
const inRange = (ranges: readonly MotionRange[], time: number) => ranges.some(r => time >= r.startMs && time < r.endMs);
const rest = (p: Vector): State => ({ ...p, vx: 0, vy: 0 });

export class RecordedCursorPath {
  readonly moving: MotionRange[] = [];
  readonly points: readonly MotionPoint[];
  constructor(points: readonly MotionPoint[]) {
    this.points = points;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      if (a.x === b.x && a.y === b.y) continue;
      const startMs = b.timeMs - a.timeMs <= 40 ? a.timeMs : b.timeMs;
      const endMs = Math.max(b.timeMs, startMs + 1e-6), previous = this.moving.at(-1);
      if (previous && previous.endMs >= startMs) previous.endMs = Math.max(previous.endMs, endMs);
      else this.moving.push({ startMs, endMs });
    }
  }
  positionAt(time: number): Vector {
    // The recorded-path boundary picks the first equal-time event; this keeps
    // an end-of-clip anchor ahead of the following cut's same-time anchor.
    let lo = 0, hi = this.points.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.points[mid].timeMs < time) lo = mid + 1; else hi = mid; }
    const i = lo < this.points.length && this.points[lo].timeMs === time ? lo : lo - 1, a = this.points[Math.max(0, i)];
    if (!a) return { x: 0, y: 0 };
    const b = this.points[i + 1];
    if (i < 0 || !b || b.timeMs === a.timeMs || b.timeMs - a.timeMs > 40) return { x: a.x, y: a.y };
    const ratio = (time - a.timeMs) / (b.timeMs - a.timeMs);
    return { x: a.x + ratio * (b.x - a.x), y: a.y + ratio * (b.y - a.y) };
  }
  stillBetween(start: number, end: number): boolean {
    if (end < start) return this.stillBetween(end, start);
    const i = lastAt(this.moving, end, r => r.startMs);
    return i < 0 || this.moving[i].endMs <= start;
  }
  lastRestEndingBy(time: number): MotionRange | null {
    const i = lastAt(this.moving, time, r => r.startMs);
    return i < 0 ? null : { startMs: this.moving[i - 1]?.endMs ?? -Infinity, endMs: this.moving[i].startMs };
  }
}

class LeadEnvelope {
  readonly cuts: readonly number[];
  readonly knots: Knot[];
  constructor(cuts: readonly number[], knots: Knot[] = []) { this.cuts = cuts; this.knots = knots; }
  clone() { return new LeadEnvelope(this.cuts, this.knots.slice()); }
  append(knots: readonly Knot[]) { this.knots.push(...knots); }
  plannedAt(time: number): number {
    const i = lastAt(this.knots, time, k => k[0]);
    if (i < 0) return 0;
    const [at, value] = this.knots[i], next = this.knots[i + 1];
    return !next || next[0] === at ? value : value + (next[1] - value) * (time - at) / (next[0] - at);
  }
  at(time: number): number {
    const value = Math.max(0, this.plannedAt(time));
    const nextCut = this.cuts[lastAt(this.cuts, time + 1e-9, t => t) + 1];
    return nextCut === undefined ? value : Math.min(value, nextCut - time);
  }
}

class SpeedEnvelope {
  readonly bumps: SpeedBump[];
  constructor(bumps: SpeedBump[] = []) { this.bumps = bumps; }
  clone() { return new SpeedEnvelope(this.bumps.slice()); }
  add(bump: SpeedBump) { this.bumps.push(bump); }
  at(time: number): number {
    let maxLogSpeed = 0;
    for (const b of this.bumps) {
      if (time < b.start || time >= b.end) continue;
      const weight = time < b.fullStart ? (time - b.start) / Math.max(1e-9, b.fullStart - b.start)
        : time <= b.fullEnd ? 1 : (b.end - time) / Math.max(1e-9, b.end - b.fullEnd);
      maxLogSpeed = Math.max(maxLogSpeed, Math.log(b.speed) * weight);
    }
    return Math.exp(maxLogSpeed);
  }
}

class CursorSimulation {
  readonly spring: SpringConfig;
  readonly path: RecordedCursorPath;
  readonly instant: readonly MotionRange[];
  constructor(path: RecordedCursorPath, spring: SpringConfig, instant: readonly MotionRange[]) { this.path = path; this.instant = instant; this.spring = resolveSpringConfig(spring); }
  target(time: number, lead: LeadEnvelope) { return this.path.positionAt(time + lead.at(time)); }
  run(start: number, end: number, input: State, lead: LeadEnvelope, speed: SpeedEnvelope, sample?: (t: number, state: State) => void): State {
    let { x, y, vx, vy } = input;
    const c = this.spring;
    let at = start, speedTime = NaN, stiffness = c.stiffness, damping = c.damping, omega = 0, braking = 0;
    while (at < end) {
      const next = Math.min(end, Math.floor(at) + 1), dt = (next - at) / 1000, target = this.target(next, lead);
      if (c.mass === 0 || inRange(this.instant, next)) { x = target.x; y = target.y; vx = 0; vy = 0; }
      else if (x !== target.x || y !== target.y || vx !== 0 || vy !== 0) {
        const bucket = Math.floor(next / 4) * 4;
        if (bucket !== speedTime) {
          speedTime = bucket;
          const multiplier = speed.at(bucket);
          stiffness = c.stiffness * multiplier * multiplier;
          damping = c.damping * multiplier;
          omega = Math.sqrt(stiffness / c.mass);
          braking = Math.max(damping, 2 * Math.sqrt(c.mass * stiffness));
        }
        const ex = target.x - x, ey = target.y - y;
        const dx = c.clamp && vx * ex > 0 && Math.abs(vx) > Math.abs(ex) * omega ? braking : damping;
        const dy = c.clamp && vy * ey > 0 && Math.abs(vy) > Math.abs(ey) * omega ? braking : damping;
        vx += (ex * stiffness - vx * dx) / c.mass * dt;
        vy += (ey * stiffness - vy * dy) / c.mass * dt;
        x += vx * dt; y += vy * dt;
        if (Math.abs(vx) < 0.01 && Math.abs(x - target.x) < 0.01) { x = target.x; vx = 0; }
        if (Math.abs(vy) < 0.01 && Math.abs(y - target.y) < 0.01) { y = target.y; vy = 0; }
      }
      at = next;
      if (sample && Number.isInteger(at)) sample(at, { x, y, vx, vy });
    }
    return { x, y, vx, vy };
  }
}

function decayingLead(path: RecordedCursorPath, at: number, lead: number): Knot[] {
  if (lead <= 0) return [[at, 0]];
  return path.stillBetween(at, at + lead) ? [[at, lead], [at + 0.001, 0]] : [[at, lead], [at + lead / CURSOR_PLANNER.leadDecayPerMs, 0]];
}

interface Choice { lead: number; speed: number; error: number; endState: State; knots: Knot[]; bump?: SpeedBump }
interface PlanContext { anchor: number; anchorLead: number; anchorState: State; lead: LeadEnvelope; speed: SpeedEnvelope }

function chooseGroup(path: RecordedCursorPath, simulation: CursorSimulation, group: SyncGroup, context: PlanContext): Choice {
  const cfg = CURSOR_PLANNER;
  const start = Math.floor(Math.max(context.anchor, group.startMs - cfg.approachWindowMs - cfg.maxLeadMs));
  const decay = decayingLead(path, context.anchor, context.anchorLead);
  const baselineLead = context.lead.clone(); baselineLead.append(decay);
  let baselineStates: Float64Array | undefined;
  const baselineAt = (time: number): State => {
    if (!baselineStates) {
      const state = simulation.run(context.anchor, start, context.anchorState, baselineLead, context.speed);
      const count = Math.max(1, Math.ceil(group.startMs) - start + 1);
      baselineStates = new Float64Array(count * 4);
      const put = (offset: number, s: State) => baselineStates!.set([s.x, s.y, s.vx, s.vy], offset);
      put(0, state);
      simulation.run(start, start + count - 1, state, baselineLead, context.speed, (time, s) => put((time - start) * 4, s));
    }
    const offset = Math.max(0, Math.min(baselineStates.length / 4 - 1, time - start)) * 4;
    return { x: baselineStates[offset], y: baselineStates[offset + 1], vx: baselineStates[offset + 2], vy: baselineStates[offset + 3] };
  };
  const leadKnots = (lead: number): { knots: Knot[]; changes: number } | null => {
    if (lead <= 0) return { knots: [...decay.filter(k => k[0] < group.endMs), [group.endMs, baselineLead.plannedAt(group.endMs)]], changes: group.startMs };
    const minTime = Math.max(context.anchor, group.startMs - cfg.approachWindowMs);
    const compressionAllowed = (at: number, value: number) => {
      const ratio = (group.startMs + lead - at - value) / (group.startMs - at);
      return ratio >= 1 - cfg.leadDecayPerMs && ratio <= cfg.maxCompressionRate;
    };
    let raise: { at: number; value: number } | undefined;
    for (let gap = path.lastRestEndingBy(group.startMs + lead); gap && gap.endMs > minTime; gap = path.lastRestEndingBy(gap.startMs)) {
      const at = Math.min(group.startMs - 1, Math.max(minTime, gap.endMs - lead));
      const old = baselineLead.plannedAt(at), value = Math.min(lead, gap.endMs - at);
      if (at + Math.min(value, old) >= gap.startMs && at + Math.max(value, old) <= gap.endMs && compressionAllowed(at, value)) { raise = { at, value }; break; }
    }
    if (!raise) {
      const at = Math.max(context.anchor, group.startMs - cfg.compressionWindowMs), value = baselineLead.plannedAt(at);
      if (at < group.startMs && compressionAllowed(at, value)) raise = { at, value };
    }
    return raise ? { knots: [...decay.filter(k => k[0] < raise.at), [raise.at, baselineLead.plannedAt(raise.at)], [raise.at + 0.001, raise.value], [group.startMs, lead], [group.endMs, lead]], changes: raise.at } : null;
  };
  const evaluate = (lead: number, speed: number, abortAfter = Infinity): Choice | null => {
    const selected = leadKnots(lead);
    if (!selected) return null;
    const candidateLead = context.lead.clone(); candidateLead.append(selected.knots);
    const candidateSpeed = context.speed.clone();
    const bump = speed > 1 ? { start: Math.max(context.anchor, group.startMs - cfg.speedBlendInMs), fullStart: group.startMs, fullEnd: group.endMs, end: group.endMs + cfg.speedBlendOutMs, speed } : undefined;
    if (bump) candidateSpeed.add(bump);
    let at = Math.max(start, Math.floor(Math.min(selected.changes, bump?.start ?? Infinity, group.startMs)));
    let state = baselineAt(at), error = 0;
    for (const sync of group.points) {
      state = simulation.run(at, sync.timeMs, state, candidateLead, candidateSpeed); at = sync.timeMs;
      const target = path.positionAt(at);
      error = Math.max(error, Math.hypot(state.x - target.x, state.y - target.y) / sync.tolerance);
      if (error > abortAfter) break;
    }
    return { lead, speed, error, endState: state, knots: selected.knots, bump };
  };
  const chooseLead = (speed: number): Choice => {
    const values = new Set([0, cfg.maxLeadMs]);
    const lag = simulation.spring.damping / simulation.spring.stiffness * 1000 / speed;
    for (let n = lag / 8; n > 0 && n < cfg.maxLeadMs; n *= 2) values.add(n);
    const leads = [...values].sort((a, b) => a - b), choices: (Choice | null)[] = [];
    let best: Choice | undefined, bestIndex = 0;
    for (let i = 0; i < leads.length; i++) {
      const current = evaluate(leads[i], speed, Math.max(cfg.acceptedErrorRatio, best?.error ?? Infinity)); choices.push(current);
      if (!current) continue;
      if (current.error <= cfg.acceptedErrorRatio) {
        if (i === 0) return current;
        let low = leads[i - 1], high = leads[i], result = current;
        for (let iteration = 0; iteration < 6 && high - low > 0.5; iteration++) {
          const mid = (low + high) / 2, attempt = evaluate(mid, speed);
          if (attempt && attempt.error <= cfg.acceptedErrorRatio) { result = attempt; high = mid; } else low = mid;
        }
        return result;
      }
      if (!best || current.error < best.error) { best = current; bestIndex = i; }
    }
    if (!best) return evaluate(0, speed)!;
    let low = leads[Math.max(0, bestIndex - 1)], high = leads[Math.min(leads.length - 1, bestIndex + 1)];
    const ratio = (Math.sqrt(5) - 1) / 2;
    for (let i = 0; i < 12 && high - low > 0.25; i++) {
      const left = high - (high - low) * ratio, right = low + (high - low) * ratio;
      const a = evaluate(left, speed), b = evaluate(right, speed);
      if (a && a.error < best.error) best = a;
      if (b && b.error < best.error) best = b;
      if (best.error <= cfg.acceptedErrorRatio) return best;
      if ((a?.error ?? Infinity) < (b?.error ?? Infinity)) high = right; else low = left;
    }
    return best;
  };
  const choices = new Map<number, Choice>();
  const pick = (index: number) => { let result = choices.get(index); if (!result) { result = chooseLead(cfg.speedLevels[index]); choices.set(index, result); } return result; };
  const first = pick(0);
  if (first.error <= cfg.acceptedErrorRatio) return first;
  let low = 0, high = cfg.speedLevels.length - 1;
  if (pick(high).error > cfg.acceptedErrorRatio) return [...choices.values()].reduce((a, b) => a.error <= b.error ? a : b);
  while (high - low > 1) { const mid = (high + low) >>> 1; if (pick(mid).error <= cfg.acceptedErrorRatio) high = mid; else low = mid; }
  return pick(high);
}

interface PositionRun { startMs: number; xs: Float32Array; ys: Float32Array }
export class PlannedCursorMotion {
  readonly initial: Vector;
  readonly runs: readonly PositionRun[];
  private readonly lead: LeadEnvelope;
  readonly groups: readonly { startMs: number; endMs: number; error: number; speed: number }[];
  constructor(initial: Vector, runs: readonly PositionRun[], lead: LeadEnvelope, groups: readonly { startMs: number; endMs: number; error: number; speed: number }[]) { this.initial = initial; this.runs = runs; this.lead = lead; this.groups = groups; }
  positionAt(time: number): Vector {
    const i = lastAt(this.runs, time, r => r.startMs);
    if (i < 0) return { ...this.initial };
    const run = this.runs[i], offset = Math.min(run.xs.length - 1, Math.max(0, time - run.startMs)), a = Math.floor(offset), b = Math.min(a + 1, run.xs.length - 1), f = offset - a;
    return { x: run.xs[a] + (run.xs[b] - run.xs[a]) * f, y: run.ys[a] + (run.ys[b] - run.ys[a]) * f };
  }
  targetTimeAt(recordedTime: number): number {
    let low = recordedTime - 601, high = recordedTime;
    for (let i = 0; i < 24; i++) { const mid = (low + high) / 2; if (mid + this.lead.at(mid) >= recordedTime) high = mid; else low = mid; }
    return high;
  }
}

/** Bounded caller-selected chunk; output is sparse millisecond Float32 runs. */
export function planCursorMotion(input: CursorMotionInput): PlannedCursorMotion {
  const path = new RecordedCursorPath(input.points), simulation = new CursorSimulation(path, input.spring, input.instantRanges);
  const groups: SyncGroup[] = [];
  for (const point of [...input.syncPoints].filter(p => !inRange(input.instantRanges, p.timeMs)).sort((a, b) => a.timeMs - b.timeMs)) {
    const previous = groups.at(-1);
    if (previous && point.timeMs - previous.endMs <= CURSOR_PLANNER.groupGapMs) { previous.points.push(point); previous.endMs = point.timeMs; }
    else groups.push({ startMs: point.timeMs, endMs: point.timeMs, points: [point] });
  }
  const start = Math.min(0, path.points[0]?.timeMs ?? 0);
  let lead = new LeadEnvelope(input.cutTimesMs), speed = new SpeedEnvelope();
  const accepted: { group: SyncGroup; choice: Choice; previousLead: LeadEnvelope; previousSpeed: SpeedEnvelope }[] = [];
  for (let index = 0; index < groups.length;) {
    const group = groups[index], last = accepted.at(-1);
    const context: PlanContext = { anchor: last?.group.endMs ?? start, anchorLead: last?.choice.knots.at(-1)?.[1] ?? 0, anchorState: last?.choice.endState ?? rest(path.positionAt(start)), lead, speed };
    const choice = chooseGroup(path, simulation, group, context);
    if (choice.error > 1 && last && group.startMs - last.group.endMs <= CURSOR_PLANNER.mergeGapMs) {
      accepted.pop(); lead = last.previousLead; speed = last.previousSpeed;
      groups[index] = { startMs: last.group.startMs, endMs: group.endMs, points: [...last.group.points, ...group.points] }; continue;
    }
    accepted.push({ group, choice, previousLead: lead.clone(), previousSpeed: speed.clone() });
    lead.append(choice.knots); if (choice.bump) speed.add(choice.bump); index++;
  }
  const last = accepted.at(-1);
  lead.append(decayingLead(path, last?.group.endMs ?? start, last?.choice.knots.at(-1)?.[1] ?? 0));
  const from = Math.min(0, Math.floor(path.points[0]?.timeMs ?? 0)), initial = simulation.target(from, lead), runs: PositionRun[] = [];
  let xs: number[] = [], ys: number[] = [], runStart = 0, previous = initial;
  const flush = () => { if (xs.length) runs.push({ startMs: runStart, xs: Float32Array.from(xs), ys: Float32Array.from(ys) }); xs = []; ys = []; };
  simulation.run(from, Math.max(from, Math.ceil(input.durationMs)), rest(initial), lead, speed, (time, state) => {
    if (state.x === previous.x && state.y === previous.y) { flush(); return; }
    if (!xs.length) runStart = time;
    xs.push(state.x); ys.push(state.y); previous = state;
  });
  flush();
  return new PlannedCursorMotion(initial, runs, lead, accepted.map(({ group, choice }) => ({ startMs: group.startMs, endMs: group.endMs, speed: choice.speed, error: choice.error })));
}
