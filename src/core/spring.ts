/**
 * Independently expressed scalar spring math from the observed renderer contract.
 * Shared spring equations for editor preview and export.
 * This is a state integrator; zoom scheduling and motion blur are separate concerns.
 */
export interface SpringConfig {
  stiffness: number;
  damping: number;
  mass: number;
  clamp: boolean;
  precision: number;
}

export const DEFAULT_SPRING: Readonly<SpringConfig> = Object.freeze({
  stiffness: 125,
  damping: 12,
  mass: 1.5,
  clamp: true,
  precision: 0.002,
});

export const SPRING_PRESETS = {
  screenFocused: { ...DEFAULT_SPRING, stiffness: 250, damping: 40, mass: 2.25 },
  screenSmooth: { ...DEFAULT_SPRING, stiffness: 170, damping: 50, mass: 3 },
  cursorSmooth: { ...DEFAULT_SPRING, stiffness: 470, damping: 70, mass: 3 },
  cursorMedium: { ...DEFAULT_SPRING, stiffness: 340, damping: 60, mass: 3 },
  cursorRapid: { ...DEFAULT_SPRING, stiffness: 530, damping: 40, mass: 1 },
} satisfies Record<string, SpringConfig>;

export interface SpringState {
  position: number;
  /** Scalar units per second. */
  velocity: number;
  target: number;
  /** Captured when the target changes, rather than recalculated every frame. */
  tolerance: number;
}

export function resolveSpringConfig(
  config: Partial<SpringConfig> = {},
): SpringConfig {
  const result = { ...DEFAULT_SPRING, ...config };
  if (
    !Number.isFinite(result.stiffness) ||
    result.stiffness <= 0 ||
    !Number.isFinite(result.damping) ||
    result.damping < 0 ||
    !Number.isFinite(result.mass) ||
    result.mass < 0 ||
    !Number.isFinite(result.precision) ||
    result.precision <= 0 ||
    typeof result.clamp !== "boolean"
  )
    throw new RangeError("Invalid spring configuration");
  return result;
}

function finitePosition(value: number): number {
  if (!Number.isFinite(value))
    throw new RangeError("Spring position must be finite");
  return value;
}

export function createSpringState(
  position: number,
  target = position,
  config: Partial<SpringConfig> = {},
): SpringState {
  finitePosition(position);
  finitePosition(target);
  const { precision } = resolveSpringConfig(config);
  return {
    position,
    velocity: 0,
    target,
    tolerance:
      position === target
        ? 1
        : Math.max(1, Math.abs(target - position)) * precision,
  };
}

export function setSpringTarget(
  state: SpringState,
  target: number,
  config: Partial<SpringConfig> = {},
): SpringState {
  finitePosition(target);
  if (state.target === target) return state;
  const { precision } = resolveSpringConfig(config);
  return {
    ...state,
    target,
    tolerance:
      state.position === target
        ? 1
        : Math.max(1, Math.abs(target - state.position)) * precision,
  };
}

function snapSpring(state: SpringState): SpringState {
  return { ...state, position: state.target, velocity: 0 };
}

/**
 * The observed clamp flag raises damping for a fast approach; it is not a bound
 * on the position. Overshoot remains possible. Damping is fixed during this call.
 */
export function getEffectiveDamping(
  state: SpringState,
  config: SpringConfig,
): number {
  const distance = state.target - state.position;
  return config.clamp &&
    config.mass > 0 &&
    state.velocity * distance > 0 &&
    Math.abs(state.velocity) >
      Math.abs(distance) * Math.sqrt(config.stiffness / config.mass)
    ? Math.max(config.damping, 2 * Math.sqrt(config.mass * config.stiffness))
    : config.damping;
}

/**
 * One millisecond semi-implicit Euler steps. deltaMs is milliseconds.
 * The shipped fractional tail uses the complement to the next millisecond;
 * preserve that observed rule explicitly instead of silently correcting it.
 */
export function integrateSpring(
  state: SpringState,
  deltaMs: number,
  options: Partial<SpringConfig> = {},
): SpringState {
  if (!Number.isFinite(deltaMs) || deltaMs < 0 || deltaMs > 10_000) {
    throw new RangeError("Spring integration requires 0–10000 milliseconds");
  }
  const config = resolveSpringConfig(options);
  if (
    deltaMs === 0 ||
    (state.position === state.target && state.velocity === 0)
  )
    return state;
  if (config.mass === 0) return snapSpring(state);
  const damping = getEffectiveDamping(state, config);
  let { position, velocity } = state;
  const steps = Math.ceil(deltaMs);
  for (let step = 1; step <= steps; step++) {
    const seconds = step > deltaMs ? (step - deltaMs) / 1000 : 0.001;
    const acceleration =
      (config.stiffness * (state.target - position) - damping * velocity) /
      config.mass;
    velocity += acceleration * seconds;
    position += velocity * seconds;
    if (
      Math.abs(velocity) < state.tolerance &&
      Math.abs(position - state.target) < state.tolerance
    )
      return snapSpring(state);
  }
  return { ...state, position, velocity };
}

const settleTimes = new Map<string, number>();

/** Coarse settle-time shortcut used by the observed scalar and structured springs. */
export function getSpringSettleTime(
  options: Partial<SpringConfig> = {},
): number {
  const config = resolveSpringConfig(options);
  if (config.mass === 0) return 0;
  const key = `${config.stiffness}|${config.damping}|${config.mass}|${config.clamp}|${config.precision}`;
  const cached = settleTimes.get(key);
  if (cached !== undefined) return cached;
  const nominalStep = 1000 / 60;
  const step =
    (nominalStep / 1000) *
      Math.max(
        Math.sqrt(config.stiffness / config.mass),
        config.damping / config.mass,
      ) <=
    0.5
      ? nominalStep
      : 1;
  const seconds = step / 1000;
  const target = 1000;
  const tolerance = target * config.precision;
  let position = 0,
    velocity = 1e-6,
    elapsed = 0;
  while (position !== target && velocity !== 0) {
    velocity +=
      ((config.stiffness * (target - position) - config.damping * velocity) /
        config.mass) *
      seconds;
    position += velocity * seconds;
    if (
      Math.abs(velocity) < tolerance &&
      Math.abs(position - target) < tolerance
    ) {
      position = target;
      velocity = 0;
    }
    if (Number.isNaN(position) || Number.isNaN(velocity)) break;
    elapsed += step;
    if (elapsed > 20_000) break;
  }
  // Editing sliders should not retain an unbounded collection of configuration keys.
  if (settleTimes.size >= 128)
    settleTimes.delete(settleTimes.keys().next().value!);
  settleTimes.set(key, elapsed);
  return elapsed;
}

/** The stateful wrapper's large-time shortcut, distinct from the 1ms integrator. */
export function advanceSpring(
  state: SpringState,
  deltaMs: number,
  options: Partial<SpringConfig> = {},
): SpringState {
  if (!Number.isFinite(deltaMs) || deltaMs < 0)
    throw new RangeError(
      "Spring time must advance by a finite nonnegative amount",
    );
  if (
    deltaMs === 0 ||
    (state.position === state.target && state.velocity === 0)
  )
    return state;
  const config = resolveSpringConfig(options);
  if (config.mass === 0 || deltaMs >= getSpringSettleTime(config))
    return snapSpring(state);
  return integrateSpring(state, deltaMs, config);
}
