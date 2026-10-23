/** Canonical defaults, independently recorded from the reference schema. */
export function defaultCursorSettings() {
  return {
    size: 48, set: { id: "macos-tahoe", variants: {} }, alwaysUsePointer: false,
    hideNotMovingAfterMs: null, loopPositionBeforeEndMs: null, hidden: false,
    clickEffect: "none", clickSound: "none", clickSoundVolume: 0.25,
    baseRotation: 0, rotationMode: "velocity", tiltAmount: 0.5,
    stopMovementInLastPartMs: 0, shakeThreshold: 500,
    optimizeChanges: true, syncWithHovers: true,
  };
}
