import {
  advanceSpring,
  createSpringState,
  DEFAULT_SPRING,
  resolveSpringConfig,
  setSpringTarget,
  type SpringConfig,
  type SpringState,
} from "./spring.ts";

export interface SpringTarget {
  values: readonly number[];
  config?: Partial<SpringConfig>;
}

/** The original clock snaps floating-point values within 1e-7 of an integer. */
export function snapFrameNumber(value: number): number {
  const integer = Math.round(value);
  return Math.abs(integer - value) < 1e-7 ? integer : value;
}

export function frameToMilliseconds(frame: number, fps: number): number {
  return snapFrameNumber((1000 / fps) * frame);
}

/**
 * Frame-stepped numeric paths with the observed 1000ms cache-miss warm-up.
 * This owns state for one renderer: seek history is intentionally retained.
 * Byte provenance and uncovered idle prefetch behavior: motion-shadow-spec.json.
 */
export class SpringTimeline {
  readonly fps: number;
  private readonly targetAt: (outputMilliseconds: number) => SpringTarget;
  private readonly frames = new Map<number, readonly number[]>();
  private states: SpringState[] | null = null;
  private config: SpringConfig = { ...DEFAULT_SPRING };
  private currentFrame = 0;
  private hasUpdatedGlobalConfig = false;
  private memoTime = -1;
  private memoValue: readonly number[] | null = null;
  private resets = 0;
  private advancedFrames = 0;

  constructor(
    fps: number,
    targetAt: (outputMilliseconds: number) => SpringTarget,
  ) {
    if (!Number.isFinite(fps) || fps <= 0)
      throw new RangeError("FPS must be positive");
    this.fps = fps;
    this.targetAt = targetAt;
  }

  get diagnostics(): {
    resets: number;
    advancedFrames: number;
    cachedFrames: number;
  } {
    return {
      resets: this.resets,
      advancedFrames: this.advancedFrames,
      cachedFrames: this.frames.size,
    };
  }

  clear(): void {
    this.states = null;
    this.frames.clear();
    this.memoTime = -1;
    this.memoValue = null;
    this.hasUpdatedGlobalConfig = false;
  }

  private reset(requestedFrame: number): void {
    const requestedMs = frameToMilliseconds(requestedFrame, this.fps);
    this.currentFrame = Math.floor(
      snapFrameNumber(Math.max(0, requestedMs - 1000) / (1000 / this.fps)),
    );
    const target = this.targetAt(
      frameToMilliseconds(this.currentFrame, this.fps),
    );
    this.config = resolveSpringConfig(target.config);
    this.states = target.values.map((value) =>
      createSpringState(value, value, this.config),
    );
    this.frames.clear();
    this.frames.set(
      this.currentFrame,
      this.states.map((state) => state.position),
    );
    this.hasUpdatedGlobalConfig = false;
    this.resets++;
  }

  private frame(frame: number): readonly number[] {
    const cached = this.frames.get(frame);
    if (cached !== undefined) return cached;
    const timeMs = frameToMilliseconds(frame, this.fps);
    if (
      this.states === null ||
      frame < this.currentFrame ||
      timeMs > frameToMilliseconds(this.currentFrame, this.fps) + 1000
    )
      this.reset(frame);
    while (this.currentFrame < frame) {
      const previousMs = frameToMilliseconds(this.currentFrame, this.fps);
      this.currentFrame++;
      const nextMs = frameToMilliseconds(this.currentFrame, this.fps);
      const target = this.targetAt(nextMs);
      if (target.values.length !== this.states!.length)
        throw new RangeError("Spring target shape changed");
      // Structured spring first retargets with the previous path precision.
      const retargeted = this.states!.map((state, index) =>
        setSpringTarget(state, target.values[index], this.config),
      );
      // Its first global config update overrides per-path styles once after reset.
      // Subsequent updates use the same global object and preserve path overrides.
      this.config = this.hasUpdatedGlobalConfig
        ? resolveSpringConfig(target.config)
        : { ...DEFAULT_SPRING };
      this.hasUpdatedGlobalConfig = true;
      this.states = retargeted.map((state) =>
        advanceSpring(state, nextMs - previousMs, this.config),
      );
      this.frames.set(
        this.currentFrame,
        this.states.map((state) => state.position),
      );
      this.advancedFrames++;
    }
    return this.frames.get(frame)!;
  }

  at(outputMilliseconds: number): readonly number[] {
    if (!Number.isFinite(outputMilliseconds) || outputMilliseconds < 0) {
      throw new RangeError("Animation time must be finite and nonnegative");
    }
    if (this.memoTime === outputMilliseconds && this.memoValue !== null)
      return this.memoValue;
    const frame = snapFrameNumber(outputMilliseconds / (1000 / this.fps));
    const lower = Math.floor(frame);
    const amount = frame - lower;
    const start = this.frame(lower);
    const end = amount === 0 ? start : this.frame(lower + 1);
    const value =
      amount === 0
        ? start
        : start.map((item, index) => item + (end[index] - item) * amount);
    this.memoTime = outputMilliseconds;
    this.memoValue = value;
    return value;
  }
}
