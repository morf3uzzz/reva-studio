import { useEffect, useRef, useState } from "react";
import type { InputLevel, InputMonitorState } from "./types";
import { INPUT_LEVEL_FRESHNESS_MS, type MicrophoneStatus } from "./core/input-status";
import { t } from "./i18n";

const initial: InputMonitorState = { phase: "idle", camera: false, cameraDeviceID: null, activeCameraDeviceID: null, microphones: "none", microphoneDeviceID: null, microphonePermission: "unknown", microphoneDeviceIDs: [], errors: [], updatedAt: Date.now() };
export const microphoneStatusLabel = (status: MicrophoneStatus) => t({ live: "Microphone input", silent: "Silence (live input)", denied: "Microphone access denied", restricted: "Microphone access restricted", "not-determined": "Microphone permission required", starting: "Connecting microphone…", "no-input": "No microphone samples", unavailable: "Microphone unavailable", error: "Microphone could not start", inactive: "Microphone monitoring inactive" }[status]);

/** Snapshot plus events preserves permission failures across renderer mount. */
export function useInputMonitor() {
  const received = useRef(new Map<string, InputLevel & { timestamp: number }>());
  const [levels, setLevels] = useState<Map<string, InputLevel>>(new Map());
  const [state, setState] = useState(initial), [now, setNow] = useState(Date.now());
  useEffect(() => {
    const api = window.reva;
    if (!api) return;
    let dirty = false, closed = false, stateEvents = 0, latest = initial, previousTick = Date.now();
    const acceptState = (value: InputMonitorState) => {
      latest = value; setState(value); setNow(Date.now());
      if (value.phase !== "ready") { received.current.clear(); dirty = true; }
    };
    const acceptLevel = (level: InputLevel) => {
      const timestamp = level.timestamp ?? Date.now();
      if (timestamp >= (received.current.get(level.deviceID)?.timestamp ?? 0)) {
        received.current.set(level.deviceID, { ...level, timestamp }); dirty = true;
      }
    };
    const off = api.onInputLevel(acceptLevel);
    const stateOff = api.onInputMonitorState(value => { stateEvents++; acceptState(value); });
    const version = stateEvents;
    void api.getInputMonitorState().then(snapshot => {
      if (closed) return;
      if (stateEvents === version) acceptState(snapshot.state);
      for (const level of snapshot.levels) acceptLevel(level);
    }).catch(error => {
      if (!closed && stateEvents === version) acceptState({ ...initial, phase: "error", errors: [{ message: error instanceof Error ? error.message : String(error), mediaType: "microphone" }] });
    });
    const timer = setInterval(() => {
      const current = Date.now();
      for (const [id, value] of received.current) {
        if (current - value.timestamp > INPUT_LEVEL_FRESHNESS_MS) { received.current.delete(id); dirty = true; }
      }
      const readyDeadline = latest.updatedAt + 1500;
      if (latest.phase === "ready" && previousTick <= readyDeadline && current > readyDeadline) dirty = true;
      if (dirty) { setLevels(new Map(received.current)); setNow(current); dirty = false; }
      previousTick = current;
    }, 50);
    return () => { closed = true; off(); stateOff(); clearInterval(timer); received.current.clear(); };
  }, []);
  return { levels, state, now };
}

export default function InputLevelMeter({ level, name, status }: { level?: InputLevel; name: string; status: MicrophoneStatus }) {
  const measured = status === "live" || status === "silent";
  const amount = measured && level && level.rms > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(level.rms) + 60) / 60)) : 0;
  const label = `${name}: ${microphoneStatusLabel(status)}`;
  return <span className={`input-level-meter${measured ? "" : " unavailable"}${measured && level && level.peak >= .98 ? " clipping" : ""}`} data-input-status={status} role={measured ? "meter" : "status"} title={label} aria-label={label} aria-valuemin={measured ? 0 : undefined} aria-valuemax={measured ? 100 : undefined} aria-valuenow={measured ? Math.round(amount * 100) : undefined}>
    <span style={{ transform: `scaleX(${amount})` }} />
  </span>;
}
