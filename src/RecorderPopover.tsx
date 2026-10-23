import { useEffect, useState } from "react";
import { Check, Keyboard, LoaderCircle } from "lucide-react";
import { initializeLanguage, t, useLanguage } from "./i18n";
import InputLevelMeter, { microphoneStatusLabel, useInputMonitor } from "./InputLevelMeter";
import type { RecordingPopoverData, RecordingPreferences, ScreenPermission } from "./types";
import { microphoneStatus } from "./core/input-status";
import { screenCaptureIssueTitle } from "./core/screen-permissions";
import "./recorder-popover.css";

function Switch({ label, value, change, disabled = false }: { label: string; value: boolean; change: () => void; disabled?: boolean }) {
  return <button className="recorder-menu-toggle" role="switch" aria-label={t(label)} aria-checked={value} disabled={disabled} onClick={change}><span>{t(label)}</span><i aria-hidden="true" className={value ? "on" : ""} /></button>;
}
function Segments<T extends string | number>({ label, values, value, change }: { label: string; values: { value: T; label: string }[]; value: T; change: (value: T) => void }) {
  return <div className="recorder-menu-segment-row"><span>{t(label)}</span><div role="group" aria-label={t(label)}>{values.map(item => <button key={item.value} aria-pressed={value === item.value} onClick={() => change(item.value)}>{item.label}</button>)}</div></div>;
}

export default function RecorderPopover() {
  const [language, setLanguage] = useLanguage();
  const api = window.reva!;
  const [data, setData] = useState<RecordingPopoverData | null>(null);
  const [preferences, setPreferences] = useState<RecordingPreferences | null>(null);
  const [error, setError] = useState("");
  const [screenPermission, setScreenPermission] = useState<ScreenPermission | null>(null);
  const input = useInputMonitor();
  const levels = input.levels;
  const [retrying, setRetrying] = useState(false);
  const fail = (error: unknown) => setError(error instanceof Error ? error.message : String(error));
  useEffect(() => {
    void initializeLanguage().catch(fail);
    void api.getRecordingPopover().then(value => { setData(value); setPreferences(value.preferences); }).catch(fail);
    const prefsOff = api.onRecordingPreferences(setPreferences);
    const inputOff = api.onInputError(value => setError(value.message));
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") void api.closeRecordingPopover().catch(fail); };
    window.addEventListener("keydown", key);
    return () => { prefsOff(); inputOff(); window.removeEventListener("keydown", key); };
  }, []);
  useEffect(() => {
    if (data?.kind !== "screen-permission") return;
    let version = 0, disposed = false;
    const refresh = () => {
      const current = ++version;
      void api.getPermissions().then(value => { if (!disposed && current === version) setScreenPermission(value.screen); }).catch(error => { if (!disposed && current === version) fail(error); });
    };
    const off = api.onScreenCaptureIssue(issue => {
      version++;
      if (issue) { setScreenPermission(issue.permission); setData(current => current ? { ...current, screenIssue: issue } : current); }
      else refresh();
    });
    refresh(); window.addEventListener("focus", refresh);
    return () => { disposed = true; off(); window.removeEventListener("focus", refresh); };
  }, [data?.kind]);
  const change = async (patch: Partial<RecordingPreferences>, close = false) => {
    setError("");
    try { setPreferences(await api.patchRecordingPreferences(patch)); if (close) await api.closeRecordingPopover(); }
    catch (error) { fail(error); }
  };
  const retry = async () => {
    setRetrying(true); setError("");
    try { await api.retryMicrophoneMonitoring(); }
    catch (error) { fail(error); }
    finally { setRetrying(false); }
  };
  if (!data || !preferences) return <main className="recorder-popover"><LoaderCircle className="spin" aria-label={t("Loading…")} /></main>;
  const kind = data.kind;
  const cameras = kind === "camera", microphones = kind === "microphone";
  const enabled = cameras ? preferences.camera : preferences.microphone;
  const selectedID = cameras ? preferences.cameraDeviceID : preferences.microphoneDeviceID;
  const microphoneID = preferences.microphoneDeviceID ?? data.devices.microphones.find(device => device.default)?.id;
  const micStatus = microphoneStatus(input.state, microphoneID, microphoneID ? levels.get(microphoneID) : undefined, input.now);
  const microphoneIssue = !["live", "silent", "starting"].includes(micStatus);
  const screenReady = screenPermission === "granted" && data.screenIssue?.reason === "access-unconfirmed";
  return <main className={`recorder-popover ${microphones ? "microphone-menu" : ""}`} aria-label={t(cameras ? "Camera" : microphones ? "Microphone" : kind === "screen-permission" ? "Screen Recording" : "Recording settings")}>
    {kind === "screen-permission" && data.screenIssue && <section className="recorder-screen-status">
      <h2>{t("Screen Recording")}</h2>
      <p role="status" aria-live="polite">{t(screenReady ? "Screen Recording access is available. Retry source selection." : screenCaptureIssueTitle(data.screenIssue))}</p>
      {data.screenIssue.reason === "access-unconfirmed" && !screenReady && <>
        <p>{t("macOS has not confirmed Screen Recording access for this running copy of REVA Studio.")}</p>
        <p>{t("If REVA Studio is already enabled in System Settings, choose REVA Studio → Quit REVA Studio, reopen the app, then retry. Closing a window does not quit the app.")}</p>
      </>}
      {data.screenIssue.reason === "no-windows" && <p>{t("Screen Recording access is available, but no eligible windows were found. Open a visible window in another app, then retry.")}</p>}
      {data.screenIssue.reason === "no-displays" && <p>{t("No connected display was returned. Check your display connection, then retry.")}</p>}
      <div><button onClick={() => void api.openCapturePrivacySettings("screen").catch(fail)}>{t("Screen Recording settings…")}</button><button onClick={() => void api.retryScreenSource().catch(fail)}>{t("Retry source selection")}</button></div>
    </section>}
    {(cameras || microphones) && <>
      <div role="menu" aria-label={t(cameras ? "Camera" : "Microphone")}>
        {data.devices[cameras ? "cameras" : "microphones"].map(device => {
          const checked = enabled && (selectedID ? selectedID === device.id : device.default);
          return <button key={device.id} className="recorder-device-option" role="menuitemradio" aria-checked={checked} onClick={() => void change(cameras ? { camera: true, cameraDeviceID: device.id } : { microphone: true, microphoneDeviceID: device.id }, true)}>
            <span className="recorder-menu-check">{checked && <Check size={16} strokeWidth={2.3} />}</span>
            <span className="recorder-device-title">{device.name}</span>{device.default && <small>{t("Default")}</small>}
            {microphones && <InputLevelMeter level={levels.get(device.id)} name={device.name} status={microphoneStatus(input.state, device.id, levels.get(device.id), input.now)} />}
          </button>;
        })}
        <button className="recorder-device-option recorder-device-none" role="menuitemradio" aria-checked={!enabled} onClick={() => void change(cameras ? { camera: false } : { microphone: false }, true)}>
          <span className="recorder-menu-check">{!enabled && <Check size={16} strokeWidth={2.3} />}</span><span>{t(cameras ? "Don't record camera" : "Don't record microphone")}</span>
        </button>
      </div>
      {microphones && <div className="recorder-microphone-status">
        <p role="status">{microphoneStatusLabel(micStatus)}</p>
        {micStatus === "denied" && <p>{t("Enable REVA Studio in System Settings → Privacy & Security → Microphone, then retry.")}</p>}
        {micStatus === "restricted" && <p>{t("macOS or an administrator restricts microphone access.")}</p>}
        {micStatus === "not-determined" && <p>{t("Allow microphone access in the macOS prompt. If it is not visible, retry.")}</p>}
        {(micStatus === "no-input" || micStatus === "unavailable" || micStatus === "inactive") && <p>{t("No audio samples have arrived. Check the selected device and retry.")}</p>}
        <div><button disabled={retrying} onClick={() => void retry()}>{t(retrying ? "Connecting microphone…" : micStatus === "not-determined" ? "Allow microphone access" : "Retry microphone")}</button>{microphoneIssue && <button onClick={() => void api.openCapturePrivacySettings("microphone").catch(fail)}>{t("Microphone settings…")}</button>}</div>
      </div>}
      {cameras && <><hr /><Switch label="Show camera preview" value={preferences.cameraPreview} disabled={!preferences.camera} change={() => void change({ cameraPreview: !preferences.cameraPreview })} /><button className="recorder-menu-action" disabled={input.state.phase !== "ready" || !input.state.activeCameraDeviceID} onClick={() => void api.showCameraEffects().catch(fail)}>{t("macOS camera effects…")}</button><p className="recorder-menu-description">{t("Portrait, Studio Light and other effects are provided by macOS for the active camera. Enable the live preview to open them.")}</p><Segments label="Max resolution" value={preferences.cameraMaxResolution} values={[{ value: 720, label: "720p" }, { value: 1080, label: "1080p" }, { value: 2160, label: "4K" }]} change={value => void change({ cameraMaxResolution: value as 720 | 1080 | 2160 })} /></>}
    </>}
    {kind === "system-audio" && <><Switch label="Record system audio" value={preferences.systemAudio} change={() => void change({ systemAudio: !preferences.systemAudio })} /><hr /><button className="recorder-device-option" role="menuitemradio" aria-checked={!preferences.systemAudioApplications} onClick={() => void change({ systemAudioApplications: null })}><span className="recorder-menu-check">{!preferences.systemAudioApplications && <Check size={16} />}</span>{t("All applications")}</button><p className="recorder-menu-description">{t("Select one or more applications to exclude other system sound. Disconnected selections are retained and never broaden to all apps.")}</p>{[...(data.applications ?? []), ...(preferences.systemAudioApplications ?? []).filter(id => !data.applications?.some(app => app.id === id)).map(id => ({ id, name: `${id} (${t("Unavailable")})`, processID: 0 }))].map(app => { const selected = preferences.systemAudioApplications?.includes(app.id) ?? false; return <button className="recorder-device-option" role="menuitemcheckbox" aria-checked={selected} key={app.id} onClick={() => { const next = selected ? preferences.systemAudioApplications!.filter(id => id !== app.id) : [...(preferences.systemAudioApplications ?? []), app.id]; if (next.length) void change({ systemAudio: true, systemAudioApplications: next }); else setError(t("Keep at least one application selected, or choose All applications.")); }}><span className="recorder-menu-check">{selected && <Check size={16} />}</span>{app.name}</button>; })}</>}
    {kind === "settings" && <>
      <h2>{t("Before Recording")}</h2>
      <Segments label="Countdown" value={preferences.countdown} values={[0, 3, 5, 10].map(value => ({ value, label: value ? t("{value}s", { value }) : t("Off") }))} change={value => void change({ countdown: value as 0 | 3 | 5 | 10 })} />
      <hr /><h2>{t("While Recording")}</h2>
      <Switch label="Keep camera preview while recording" value={preferences.cameraPreviewWhileRecording} change={() => void change({ cameraPreviewWhileRecording: !preferences.cameraPreviewWhileRecording })} />
      <Switch label="Record keyboard shortcuts" value={preferences.recordShortcuts ?? false} change={() => void change({ recordShortcuts: !preferences.recordShortcuts })} />
      <Switch label="Hide desktop icons while recording" value={preferences.hideDesktopIcons ?? false} change={() => void change({ hideDesktopIcons: !preferences.hideDesktopIcons })} />
      <button className="recorder-menu-action" onClick={() => void api.showSpeakerNotes().catch(fail)}>{t("Speaker notes…")}</button>
      <button className="recorder-menu-action" onClick={() => void api.restoreDesktopIcons().catch(fail)}>{t("Restore desktop icons")}</button>
      <p className="recorder-menu-description">{t("Shortcut capture needs macOS Input Monitoring. It records key combinations and navigation keys, without ordinary typed text.")}</p>
      <Segments label="Frame rate" value={preferences.fps} values={[24, 30, 60].map(value => ({ value, label: `${value}` }))} change={value => void change({ fps: value as 24 | 30 | 60 })} />
      <hr /><Segments label="Language" value={language} values={[{ value: "ru", label: "RU" }, { value: "en", label: "EN" }]} change={value => void setLanguage(value as "ru" | "en").catch(fail)} />
      <button className="recorder-menu-action" onClick={() => void api.showRecordingShortcuts().catch(fail)}><Keyboard size={16} />{t("Keyboard Shortcuts")}</button>
    </>}
    {error && <button className="recorder-menu-error" role="alert" title={error} onClick={() => setError("")}>{error}</button>}
  </main>;
}
