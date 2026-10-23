import { useEffect, useRef, useState, type MouseEvent } from "react";
import { AppWindow, ChevronDown, Folder, LoaderCircle, Mic, MicOff, Monitor, MonitorSpeaker, Scan, Settings, Smartphone, Square, Video, VideoOff, X, CirclePause, CirclePlay, CircleStop, RotateCcw, Trash2 } from "lucide-react";
import { initializeLanguage, t, useLanguage } from "./i18n";
import { formatTime } from "./core/model";
import type { CaptureDevice, RecordingPanelState, RecordingPreferences, ScreenCaptureIssue } from "./types";
import InputLevelMeter, { microphoneStatusLabel, useInputMonitor } from "./InputLevelMeter";
import { microphoneStatus } from "./core/input-status";
import { screenCaptureIssueTitle } from "./core/screen-permissions";
import "./recording-panel.css";
import "./recorder-popover.css";

const initial: RecordingPreferences = { fps: 60, countdown: 0, systemAudio: false, microphone: false, camera: false, microphoneDeviceID: null, cameraDeviceID: null, cameraMaxResolution: 1080, cameraPreview: true, cameraPreviewWhileRecording: true, autoZoom: false, afterRecording: "project", quickExportSettings: { format: "mp4", fps: 60, resolution: 1080, quality: "balanced", codec: "h264", proresProfile: "422", gifHighQuality: true, gifLoop: true } };
const position = (event: MouseEvent<HTMLButtonElement>) => { const rect = event.currentTarget.getBoundingClientRect(); return { x: rect.left, y: rect.bottom }; };

export default function RecordingPanel() {
  useLanguage();
  const [preferences, setPreferences] = useState(initial);
  const [devices, setDevices] = useState<{ cameras: CaptureDevice[]; microphones: CaptureDevice[] }>({ cameras: [], microphones: [] });
  const [state, setState] = useState<RecordingPanelState>({ status: "idle", startedAt: null });
  const [countdown, setCountdown] = useState<number | null>(null);
  const [starting, setStarting] = useState(false), [error, setError] = useState("");
  const [screenIssue, setScreenIssue] = useState<ScreenCaptureIssue | null>(null);
  const [now, setNow] = useState(Date.now());
  const cancelled = useRef(false), choosing = useRef(false);
  const input = useInputMonitor();
  const levels = input.levels;
  const api = window.reva!;
  const fail = (error: unknown) => setError(error instanceof Error ? error.message : String(error));
  useEffect(() => {
    cancelled.current = false;
    let issueEvents = 0, mounted = true;
    document.body.classList.add("recording-surface");
    void initializeLanguage().catch(fail);
    const screenOff = api.onScreenCaptureIssue(value => { issueEvents++; setScreenIssue(value); });
    void api.getRecordingPanel().then(value => { if (mounted) { setState(value); setPreferences(value.preferences); if (issueEvents === 0) setScreenIssue(value.screenIssue); } }).catch(fail);
    void api.getCaptureDevices().then(setDevices).catch(fail);
    const stateOff = api.onRecordingPanelState(value => { setState(value); setStarting(false); });
    const errorOff = api.onError(fail);
    const preferencesOff = api.onRecordingPreferences(setPreferences);
    const inputErrorOff = api.onInputError(value => setError(value.message));
    // A background status read may clear only the main process's typed screen
    // issue. It must never dismiss an unrelated camera/microphone/file error.
    const refreshPermission = () => { void api.getPermissions().catch(() => {}); };
    refreshPermission();
    window.addEventListener("focus", refreshPermission);
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => { mounted = false; cancelled.current = true; clearInterval(timer); stateOff(); errorOff(); preferencesOff(); inputErrorOff(); screenOff(); window.removeEventListener("focus", refreshPermission); document.body.classList.remove("recording-surface"); };
  }, []);
  const close = async () => { cancelled.current = true; await api.closeRecordingPanel(); };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !starting && state.status === "idle") void close().catch(fail); };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [starting, state.status]);
  const menu = async (kind: Parameters<typeof api.showRecordingMenu>[0], event: MouseEvent<HTMLButtonElement>) => {
    try {
      const result = await api.showRecordingMenu(kind, position(event));
      setPreferences(result.preferences); await initializeLanguage();
      if (kind === "camera" || kind === "microphone") setDevices(await api.getCaptureDevices());
    } catch (error) { fail(error); }
  };
  const screenHelp = async (anchor: { x: number; y: number }) => {
    const result = await api.showRecordingMenu("screen-permission", anchor);
    return result.retrySource === true && !cancelled.current;
  };
  const choose = async (kind: "display" | "window" | "area" | "device", anchor: { x: number; y: number }, showHelpFirst = false) => {
    if (choosing.current) return;
    choosing.current = true; cancelled.current = false;
    try {
      if (showHelpFirst && !await screenHelp(anchor)) return;
      while (!cancelled.current) {
        const selection = await api.chooseRecordingSource(kind, anchor);
        if (!selection || cancelled.current) return;
        if ("issue" in selection) {
          setScreenIssue(selection.issue);
          if (await screenHelp(anchor)) continue;
          return;
        }
        // The picker can update the after-recording action and zoom defaults.
        const current = (await api.getRecordingPanel()).preferences;
        for (let value = current.countdown; value > 0; value--) {
          if (cancelled.current) return;
          setCountdown(value);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (cancelled.current) return;
        setCountdown(null); setStarting(true);
        const started = await api.startRecording({ ...current, ...selection, ...(selection.source.kind === "device" ? { recordShortcuts: false, systemAudioApplications: null } : {}) });
        setStarting(false);
        if (cancelled.current) return;
        if (started?.issue) {
          setScreenIssue(started.issue);
          if (await screenHelp(anchor)) continue;
        }
        return;
      }
    } catch (error) { if (!cancelled.current) fail(error); }
    finally { choosing.current = false; setCountdown(null); setStarting(false); }
  };
  const deviceName = (kind: "camera" | "microphone") => {
    if (!preferences[kind]) return t(kind === "camera" ? "No camera" : "No microphone");
    const list = devices[kind === "camera" ? "cameras" : "microphones"];
    const id = preferences[kind === "camera" ? "cameraDeviceID" : "microphoneDeviceID"];
    return list.find(device => id ? device.id === id : device.default)?.name ?? t(kind === "camera" ? "Camera" : "Microphone");
  };
  const chooseRef = useRef(choose);
  chooseRef.current = choose;
  useEffect(() => api.onRecorderAction(action => {
    const kind = action === "recordDisplay" ? "display" : action === "recordWindow" ? "window" : action === "recordArea" ? "area" : null;
    if (kind) void chooseRef.current(kind, { x: 20, y: 60 });
  }), [api]);
  const microphoneID = preferences.microphoneDeviceID ?? (input.state.microphones === "selected" ? input.state.microphoneDeviceIDs[0] : undefined) ?? devices.microphones.find(device => device.default)?.id;
  const micLevel = microphoneID ? levels.get(microphoneID) : undefined;
  const micStatus = microphoneStatus(input.state, microphoneID, micLevel, input.now);
  if (state.status !== "idle") return <main className="recorder-strip recorder-active" aria-label={t("Recording controls")}>
    {error && <span role="alert" className="recorder-error" title={error} onClick={() => setError("")}>{error}</span>}
    <button className="recorder-stop" aria-label={t(state.status === "finishing" ? "Finishing…" : "Stop recording")} disabled={state.status === "finishing"} onClick={() => { setState(value => ({ ...value, status: "finishing" })); void api.stopRecording().catch(fail); }} title={t("Stop recording")}>
      {state.status === "finishing" ? <LoaderCircle className="spin" /> : <CircleStop />}
      <span className="recorder-clock">{formatTime((state.elapsedMs === undefined ? Math.max(0, now - (state.startedAt ?? now)) : state.elapsedMs + (state.paused ? 0 : Math.max(0, now - (state.stateUpdatedAt ?? now)))) / 1000)}</span>
    </button>
    <span className="recorder-divider" />
    <button aria-label={t(state.paused ? "Resume recording" : "Pause recording")} title={t(state.paused ? "Resume recording" : "Pause recording")} disabled={state.status === "finishing"} onClick={() => void (state.paused ? api.resumeRecording() : api.pauseRecording()).catch(fail)}>{state.paused ? <CirclePlay /> : <CirclePause />}</button>
    <button aria-label={t("Restart recording")} title={t("Restart recording")} disabled={state.status === "finishing"} onClick={() => void api.restartRecording().catch(fail)}><RotateCcw /></button>
    <button aria-label={t("Delete recording")} title={t("Delete recording")} disabled={state.status === "finishing"} onClick={() => void api.discardRecording().catch(fail)}><Trash2 /></button>
  </main>;
  return <main className="recorder-strip" aria-label={t("New recording")}>
    <button className="recorder-close" aria-label={t("Close recording panel")} onClick={() => void close().catch(fail)} disabled={starting}><X size={15} strokeWidth={3} /></button>
    <span className="recorder-divider" />
    {countdown !== null || starting ? <div className="recorder-preparing" role="status">{starting ? <LoaderCircle size={24} className="spin" /> : <strong>{countdown}</strong>}<span>{t(starting ? "Starting your recording…" : "Recording starts in {value}s", { value: countdown ?? 0 })}</span><button onClick={() => { cancelled.current = true; setCountdown(null); }} disabled={starting}>{t("Cancel")}</button></div> : <>
      <div className="recorder-source-buttons">
        <button onClick={event => void choose("display", position(event))} title={t("Record entire display")}><Monitor /><span>{t("Display")}</span></button>
        <button onClick={event => void choose("window", position(event))} title={t("Record single window")}><AppWindow /><span>{t("Window")}</span></button>
        <button onClick={event => void choose("area", position(event))} title={t("Record area")}><Scan /><span>{t("Area")}</span></button>
        <button onClick={event => void choose("device", position(event))} title={t("Record a connected iPhone or iPad. Device audio is recorded; Mac app audio filters and Mac keyboard shortcuts do not apply.")}><Smartphone /><span>{t("Device")}</span></button>
      </div>
      <span className="recorder-divider" />
      <button className={`recorder-input ${preferences.camera ? "enabled" : ""}`} onClick={event => void menu("camera", event)} title={deviceName("camera")}>{preferences.camera ? <Video /> : <VideoOff />}<span>{deviceName("camera")}</span></button>
      <button className={`recorder-input recorder-microphone ${preferences.microphone ? "enabled" : ""}`} onClick={event => void menu("microphone", event)} title={deviceName("microphone")}>{preferences.microphone ? <Mic /> : <MicOff />}<span className="recorder-microphone-label"><span>{deviceName("microphone")}</span>{preferences.microphone && micStatus !== "live" && micStatus !== "silent" && <small>{microphoneStatusLabel(micStatus)}</small>}</span>{preferences.microphone && <InputLevelMeter level={micLevel} name={deviceName("microphone")} status={micStatus} />}</button>
      <button className={`recorder-input ${preferences.systemAudio ? "enabled" : ""}`} onClick={event => void menu("system-audio", event)} title={t("System audio")}><MonitorSpeaker /><span>{t(preferences.systemAudio ? "System audio" : "No system audio")}</span></button>
      <span className="recorder-divider" />
      <button className="recorder-folder" aria-label={t("Open recordings folder")} onClick={() => void api.openRecordingsFolder().catch(fail)}><Folder /></button>
      <button className="recorder-settings" aria-label={t("Recording settings")} onClick={event => void menu("settings", event)}><Settings /><ChevronDown size={15} /></button>
    </>}
    {error && <button className="recorder-error" onClick={() => setError("")} title={t(error)}>{t(error)}</button>}
    {!error && screenIssue && <button className="recorder-error" onClick={event => void choose(screenIssue.sourceKind, position(event), true)} aria-label={t("Screen Recording settings and retry")}>{t(screenCaptureIssueTitle(screenIssue))}</button>}
  </main>;
}
