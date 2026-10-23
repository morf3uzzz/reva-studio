import type { InputLevel, InputMonitorState } from "../types";

export type MicrophoneStatus = "live" | "silent" | "denied" | "restricted" | "not-determined" | "starting" | "no-input" | "unavailable" | "error" | "inactive";
export const INPUT_LEVEL_FRESHNESS_MS = 400;

/** A measured zero is silence. Missing/expired samples never establish silence. */
export function microphoneStatus(state: InputMonitorState, deviceID: string | undefined, level: InputLevel | undefined, now: number): MicrophoneStatus {
  if (level && level.deviceID === deviceID && level.timestamp !== undefined && now - level.timestamp <= INPUT_LEVEL_FRESHNESS_MS) return level.rms > 0 || level.peak > 0 ? "live" : "silent";
  if (["denied", "restricted", "not-determined"].includes(state.microphonePermission)) return state.microphonePermission as MicrophoneStatus;
  if (state.errors.some(error => (!error.mediaType || error.mediaType === "microphone") && (!error.deviceID || error.deviceID === deviceID))) return "error";
  if (state.phase === "starting" || state.phase === "stopping") return "starting";
  if (state.phase === "ready") {
    if (!deviceID || !state.microphoneDeviceIDs.includes(deviceID)) return "unavailable";
    return now - state.updatedAt <= 1500 ? "starting" : "no-input";
  }
  return "inactive";
}
