/** One conversion owner shared by browser camera frames and Electron audio plans. */
export function cameraSourceOffsetSeconds(project) {
  const milliseconds = project.appearance.cameraDelayMs ?? 0;
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds)) throw new RangeError("Camera delay must be finite milliseconds.");
  return milliseconds / 1000;
}
