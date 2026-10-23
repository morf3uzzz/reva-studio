import { useEffect, useRef, useState, type ReactNode } from "react";
import { CircleDot, Command, LoaderCircle, Pencil, RotateCcw, Settings, Settings2, Trash2, Upload, X } from "lucide-react";
import { initializeLanguage, t, useLanguage } from "./i18n";
import russian from "../locales/ru-preferences.json" with { type: "json" };
import { SHORTCUTS, shortcutKeys, type AppPreferences, type AppPreferencesPatch, type PreferencesAPI, type PreferencesTab, type ShortcutDefinition } from "./app-preferences";
import type { QuickExportSettings } from "./types";
import "./preferences-window.css";

const labels: Record<string, string> = russian;
const TABS = [
  { id: "general", label: "General", icon: Settings },
  { id: "recording", label: "Recording", icon: CircleDot },
  { id: "editing", label: "Editing", icon: Pencil },
  { id: "widget", label: "Quick export", icon: Upload },
  { id: "shortcuts", label: "Shortcuts", icon: Command },
  { id: "advanced", label: "Advanced", icon: Settings2 },
] as const;
const MODIFIERS = ["Meta", "Control", "Alt", "Shift"];
const KEY_LABELS: Record<string, string> = { Meta: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧", Enter: "↩", Backspace: "⌫", Tab: "⇥", Space: "␣", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" };
type BooleanPreference = { [Key in keyof AppPreferences]-?: AppPreferences[Key] extends boolean ? Key : never }[keyof AppPreferences];

function Row({ label, description, children, full = false, unavailable = false }: { label: string; description?: string; children: ReactNode; full?: boolean; unavailable?: boolean }) {
  return <div className={`preferences-row${full ? " full" : ""}${unavailable ? " unavailable" : ""}`}><div className="preferences-label"><div>{label}</div>{description && <p>{description}</p>}</div><div className="preferences-control">{children}</div></div>;
}
function Switch({ label, value, change, disabled }: { label: string; value: boolean; change?: () => void; disabled?: boolean }) {
  return <button type="button" className="preferences-switch" role="switch" aria-label={label} aria-checked={value} disabled={disabled || !change} onClick={change}><span /></button>;
}
function Segments<T extends string | number>({ label, values, value, change, disabled }: { label: string; values: readonly { value: T; label: string }[]; value: T; change: (value: T) => void; disabled?: boolean }) {
  return <div className="preferences-segments" role="group" aria-label={label}>{values.map(item => <button type="button" key={item.value} aria-pressed={value === item.value} disabled={disabled} onClick={() => change(item.value)}>{item.label}</button>)}</div>;
}
function keyToken(event: KeyboardEvent) {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  const punctuation: Record<string, string> = { Slash: "/", Period: ".", Comma: ",", Quote: "'", Semicolon: ";", Backslash: "\\", BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", Backquote: "`", Space: "Space" };
  return punctuation[event.code] ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key);
}
function ShortcutRow({ definition, keys, disabled, change, captureChanged, text }: { definition: ShortcutDefinition; keys: string[] | null; disabled: boolean; change: (keys: string[] | null) => Promise<boolean>; captureChanged: (active: boolean) => void; text: (label: string) => string }) {
  const [capturing, setCapturing] = useState(false), [preview, setPreview] = useState<string[]>([]), [invalid, setInvalid] = useState("");
  const container = useRef<HTMLDivElement>(null), chord = useRef<string[]>([]);
  const changed = JSON.stringify(keys?.map(key => key.length === 1 ? key.toUpperCase() : key)) !== JSON.stringify(definition.defaultKeys);
  useEffect(() => {
    if (!invalid) return;
    const timer = setTimeout(() => setInvalid(""), 2000);
    return () => clearTimeout(timer);
  }, [invalid]);
  useEffect(() => {
    if (!capturing) return;
    captureChanged(true);
    chord.current = [];
    const cancel = () => setCapturing(false);
    const timer = setTimeout(cancel, 5000);
    const down = (event: KeyboardEvent) => {
      event.preventDefault(); event.stopPropagation();
      if (event.key === "Escape") { cancel(); return; }
      if (event.repeat) return;
      const modifiers = [event.metaKey && "Meta", event.ctrlKey && "Control", event.altKey && "Alt", event.shiftKey && "Shift"].filter((value): value is string => !!value);
      const key = keyToken(event);
      const primary = MODIFIERS.includes(key) ? chord.current.find(value => !MODIFIERS.includes(value)) : key;
      chord.current = [...modifiers, ...(primary ? [primary] : [])];
      setPreview(chord.current);
    };
    const up = (event: KeyboardEvent) => {
      event.preventDefault(); event.stopPropagation();
      if (event.key === "Escape") return;
      cancel();
      const captured = chord.current;
      if (!captured.some(key => !MODIFIERS.includes(key))) { setInvalid(text("Choose a key for this shortcut.")); return; }
      if (definition.group === "recording" && !captured.some(key => MODIFIERS.includes(key))) { setInvalid(text("Use a modifier and a key for a global shortcut.")); return; }
      void change(captured).then(saved => { if (!saved) setInvalid(text("Shortcut was not saved.")); });
    };
    const outside = (event: MouseEvent) => { if (!container.current?.contains(event.target as Node)) cancel(); };
    window.addEventListener("keydown", down, true); window.addEventListener("keyup", up, true); window.addEventListener("mousedown", outside, true);
    return () => { clearTimeout(timer); captureChanged(false); window.removeEventListener("keydown", down, true); window.removeEventListener("keyup", up, true); window.removeEventListener("mousedown", outside, true); };
  }, [capturing]);
  const displayed = capturing ? preview : keys;
  return <div ref={container} className={`preferences-shortcut-row${invalid ? " invalid" : ""}`}>
    <span>{text(definition.label)}</span><div className="preferences-shortcut-controls">
      <button className="preferences-shortcut-reset" title={text("Reset to default")} aria-label={`${text("Reset to default")}: ${text(definition.label)}`} disabled={disabled || !changed || capturing} onClick={() => void change(definition.defaultKeys)}><RotateCcw size={13} /></button>
      <button className={`preferences-shortcut-key${capturing ? " capturing" : ""}`} disabled={disabled} aria-label={text(definition.label)} aria-invalid={!!invalid} title={invalid || undefined} onClick={() => { setPreview([]); setInvalid(""); setCapturing(value => !value); }}>
        {displayed?.length ? displayed.map((key, index) => <kbd key={`${key}-${index}`}>{KEY_LABELS[key] ?? key.toUpperCase()}</kbd>) : <small>{text(capturing ? "Press keys…" : "Add shortcut")}</small>}
      </button>
      <button className="preferences-shortcut-clear" title={text("Clear shortcut")} aria-label={`${text("Clear shortcut")}: ${text(definition.label)}`} disabled={disabled || !definition.clearable || !keys || capturing} onClick={() => void change(null)}><Trash2 size={13} /></button>
    </div>{invalid && <small className="preferences-shortcut-error" role="alert">{invalid}</small>}
  </div>;
}

export default function PreferencesWindow() {
  const [language] = useLanguage();
  const text = (label: string) => language === "ru" ? labels[label] ?? t(label) : label;
  const api: PreferencesAPI = window.reva!;
  const [preferences, setPreferences] = useState<AppPreferences | null>(null), [tab, setTab] = useState<PreferencesTab>("general"), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [advanced, setAdvanced] = useState(false), [capturing, setCapturing] = useState(false);
  const pending = useRef(0), preferencesEpoch = useRef(0), tabEpoch = useRef(0), body = useRef<HTMLDivElement>(null), header = useRef<HTMLElement>(null), lastHeight = useRef(0), captureRef = useRef(false);
  captureRef.current = capturing;
  const fail = (error: unknown) => setError(error instanceof Error ? error.message : String(error));
  useEffect(() => {
    let mounted = true;
    const preferencesOff = api.onAppPreferences(value => { if (preferencesEpoch.current === 0) setAdvanced(value.quickExportSettings.codec !== "h264"); preferencesEpoch.current++; setPreferences(value); });
    const tabOff = api.onPreferencesTab(value => { tabEpoch.current++; setTab(value); });
    const initialEpoch = preferencesEpoch.current;
    const initialTabEpoch = tabEpoch.current;
    void initializeLanguage().catch(fail);
    void api.getAppPreferences().then(value => { if (mounted && initialEpoch === preferencesEpoch.current) { setPreferences(value); setAdvanced(value.quickExportSettings.codec !== "h264"); } }).catch(fail);
    void api.getPreferencesTab().then(value => { if (mounted && tabEpoch.current === initialTabEpoch) setTab(value); }).catch(fail);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !captureRef.current) void api.closePreferences().catch(fail); };
    window.addEventListener("keydown", escape);
    return () => { mounted = false; preferencesOff(); tabOff(); window.removeEventListener("keydown", escape); };
  }, []);
  useEffect(() => {
    if (!preferences || !body.current || !header.current) return;
    const measure = () => {
      const height = Math.ceil((header.current?.getBoundingClientRect().height ?? 0) + (body.current?.getBoundingClientRect().height ?? 0));
      if (height > 0 && lastHeight.current !== height) { lastHeight.current = height; void api.resizePreferences(height).catch(fail); }
    };
    const observer = new ResizeObserver(measure);
    observer.observe(body.current); observer.observe(header.current); measure();
    return () => observer.disconnect();
  }, [!!preferences]);
  const perform = async (operation: () => Promise<AppPreferences | null>) => {
    pending.current++; setBusy(true); setError("");
    const epoch = preferencesEpoch.current;
    try { const value = await operation(); if (value && epoch === preferencesEpoch.current) setPreferences(value); return true; }
    catch (error) { fail(error); return false; }
    finally { pending.current--; setBusy(pending.current > 0); }
  };
  const change = (patch: AppPreferencesPatch) => perform(() => api.patchAppPreferences(patch));
  const chooseTab = (value: PreferencesTab) => { tabEpoch.current++; setTab(value); };
  const quickChange = (patch: Partial<QuickExportSettings>) => change({ quickExportSettings: patch });
  const toggle = (key: BooleanPreference, label: string, description?: string) => <Row label={text(label)} description={description && text(description)}><Switch label={text(label)} value={preferences?.[key] === true} disabled={busy} change={() => void change({ [key]: !preferences?.[key] })} /></Row>;
  const folder = (kind: "projects" | "presets", label: string) => {
    const value = preferences?.[kind === "projects" ? "projectsFolderPath" : "presetsFolderPath"];
    const home = preferences?.homeDirectory;
    const display = value && home && (value === home || value.startsWith(`${home}/`)) ? `~${value.slice(home.length)}` : value;
    return <Row label={text(label)} description={display || text("Default location")}><button className="preferences-button" disabled={busy} title={value ?? undefined} onClick={() => void perform(() => api.choosePreferencesDirectory(kind))}>{text("Change directory…")}</button></Row>;
  };
  const q = preferences?.quickExportSettings;
  return <main className="preferences-window" aria-label={text("Settings")}>
    <header ref={header} className="preferences-header"><nav className="preferences-tabs" role="tablist" aria-label={text("Settings")}>{TABS.map((item, index) => <button type="button" key={item.id} role="tab" id={`preferences-tab-${item.id}`} aria-selected={tab === item.id} aria-controls="preferences-content" tabIndex={tab === item.id ? 0 : -1} onClick={() => chooseTab(item.id)} onKeyDown={event => {
      const next = event.key === "ArrowRight" ? (index + 1) % TABS.length : event.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length : event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : null;
      if (next !== null) { event.preventDefault(); chooseTab(TABS[next].id); (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus(); }
    }}><item.icon size={23} strokeWidth={1.55} /><span>{text(item.label)}</span></button>)}</nav></header>
    <div className="preferences-scroll"><div ref={body} className="preferences-body" id="preferences-content" role="tabpanel" aria-labelledby={`preferences-tab-${tab}`}>
      {!preferences ? <div className="preferences-loading"><LoaderCircle className="spin" size={22} aria-label={t("Loading…")} /></div> : <>
        {tab === "general" && <div className="preferences-stack">
          {toggle("startAtLogin", "Start REVA Studio at login", "Automatically start the app when you start your computer.")}
          {toggle("hideDockIcon", "Hide Dock Icon", "Hide the Dock icon when no projects are open and no recording is in progress. The menu bar icon remains available.")}
          <Row label={text("Open account dashboard")} description={text("Account management is unavailable in this local app.")} unavailable><button className="preferences-button" disabled>{text("Open dashboard")}</button></Row>
          <Row label={text("Usage data")} description={text("REVA Studio does not collect usage analytics.")} unavailable><Switch label={text("Usage data")} value={false} disabled /></Row>
          <Row label={text("Reset preferences")} description={text("Reset all application and recording preferences.")}><button className="preferences-button" disabled={busy} onClick={() => void perform(() => api.resetAppPreferences())}>{text("Reset…")}</button></Row>
        </div>}
        {tab === "recording" && <div className="preferences-stack">
          {folder("projects", "Save new projects to")}
          {toggle("recordingAreaCover", "Highlight recorded area during recording", "Dim the part of the screen outside the area being recorded.")}
          {toggle("autoZoom", "Create zooms automatically", "Analyze recorded actions to create zooms in each new project.")}
          {toggle("showRecordingWidget", "Show recording widget", "Show recording status and controls while recording.")}
          <Row label={text("Maximum camera resolution")} description={text("Max resolution at which your webcam will be recorded (if your webcam supports it). Higher resolutions improve video quality but may impact performance during recording.")}><Segments label={text("Maximum camera resolution")} value={preferences.cameraMaxResolution} values={[{ value: 720, label: "720p" }, { value: 1080, label: "1080p" }, { value: 2160, label: "4K" }]} disabled={busy} change={value => void change({ cameraMaxResolution: value as AppPreferences["cameraMaxResolution"] })} /></Row>
        </div>}
        {tab === "editing" && <div className="preferences-stack">
          {toggle("useLastProjectConfigForNewProjects", "Use last project settings as default for new recordings", "An explicitly selected default preset takes precedence.")}
          {toggle("autoSaveProject", "Use autosave", "Automatically save project changes every 30 seconds.")}
          {folder("presets", "Save presets in")}
        </div>}
        {tab === "widget" && q && <div className="preferences-stack">
          <Row label={text("Quick export settings")} full><div className="preferences-export-panel">
            <Row label={t("Format")}><Segments label={t("Format")} value={q.format} values={[{ value: "mp4", label: "MP4" }, { value: "prores", label: "ProRes" }, { value: "gif", label: "GIF" }]} disabled={busy} change={value => void quickChange({ format: value as QuickExportSettings["format"] })} /></Row>
            <Row label={t("Frame rate")}><select aria-label={t("Frame rate")} disabled={busy} value={q.fps} onChange={event => void quickChange({ fps: Number(event.target.value) as QuickExportSettings["fps"] })}>{(q.format === "gif" ? [50, 30, 25, 20, 15, 10] : [60, 50, 30, 25, 24, 20, 10]).map(value => <option value={value} key={value}>{value} FPS</option>)}</select></Row>
            <Row label={text("Private Shareable Link")} description={text("Shareable links are unavailable in this local app.")} unavailable><Switch label={text("Private Shareable Link")} value={false} disabled /></Row>
            <Row label={t("Resolution")}><Segments label={t("Resolution")} value={q.resolution} values={(q.format === "gif" ? [480, 720, 1080] : q.quality === "small" || q.quality === "tiny" ? [720, 1080] : [720, 1080, 2160]).map(value => ({ value, label: value === 2160 ? "4K" : `${value}p` }))} disabled={busy} change={value => void quickChange({ resolution: value as QuickExportSettings["resolution"] })} /></Row>
            {q.format === "mp4" && <><Row label={t("Compression")} full><Segments label={t("Compression")} value={q.quality} values={[{ value: "high", label: t("Studio") }, { value: "balanced", label: t("Social Media") }, { value: "small", label: t("Web") }, { value: "tiny", label: t("Web (Low)") }]} disabled={busy} change={value => void quickChange({ quality: value as QuickExportSettings["quality"] })} /></Row>
              <details className="preferences-advanced" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}><summary>{text("Advanced")}</summary><Row label={t("Encoding")}><Segments label={t("Encoding")} value={q.encoding ?? "software"} values={[{ value: "software", label: t("Software") }, { value: "hardware", label: t("Hardware (VideoToolbox)") }]} disabled={busy} change={encoding => void quickChange({ encoding: encoding as "software" | "hardware" })} /></Row><Row label={t("Codec")}><Segments label={t("Codec")} value={q.codec} values={[{ value: "h264", label: "H.264" }, { value: "hevc", label: "HEVC" }, { value: "both", label: t("Both") }]} disabled={busy} change={value => void quickChange({ codec: value as QuickExportSettings["codec"] })} /></Row></details></>}
            {q.format === "prores" && <Row label={t("Profile")}><Segments label={t("Profile")} value={q.proresProfile} values={[{ value: "422-lt", label: "422 LT" }, { value: "422", label: "422" }, { value: "422-hq", label: "422 HQ" }, { value: "4444", label: "4444" }]} disabled={busy} change={value => void quickChange({ proresProfile: value as QuickExportSettings["proresProfile"] })} /></Row>}
            {q.format === "gif" && <><Row label={t("High quality")}><Switch label={t("High quality")} value={q.gifHighQuality} disabled={busy} change={() => void quickChange({ gifHighQuality: !q.gifHighQuality })} /></Row><Row label={t("Disable loop")}><Switch label={t("Disable loop")} value={!q.gifLoop} disabled={busy} change={() => void quickChange({ gifLoop: !q.gifLoop })} /></Row></>}
          </div></Row>
          {toggle("showQuickExportWidget", "Show quick export widget after recording", "When disabled, open the full editor after recording.")}
          {toggle("alwaysSaveProjectAfterQuickExport", "Always save project when using quick export widget", "Otherwise, ask whether to save or delete the project after export.")}
          <Row label={text("Edit project title before exporting to shareable link")} description={text("Shareable links are unavailable in this local app.")} unavailable><Switch label={text("Edit project title before exporting to shareable link")} value={preferences.editProjectTitleBeforeUpload} disabled /></Row>
        </div>}
        {tab === "shortcuts" && <div className="preferences-shortcut-groups">{(["recording", "editing"] as const).map(group => <section key={group}><h2>{text(group === "recording" ? "Recording" : "Editing")}</h2><div className="preferences-shortcut-list">{SHORTCUTS.filter(definition => definition.group === group).map(definition => <ShortcutRow key={definition.id} definition={definition} keys={shortcutKeys(preferences, definition)} disabled={busy} text={text} captureChanged={setCapturing} change={keys => change({ customShortcuts: { [definition.id]: keys, ...(definition.id === "pauseRecording" ? { resumeRecording: keys } : {}) } })} />)}</div></section>)}</div>}
        {tab === "advanced" && <div className="preferences-stack">
          <Row label={text("Skip network certificate validation")} description={text("This app has no licensing server connection.")} unavailable><Switch label={text("Skip network certificate validation")} value={false} disabled /></Row>
          <Row label={text("Share diagnostics information")} description={text("Diagnostic uploads are unavailable in this local app.")} unavailable><button className="preferences-button" disabled>{text("Share diagnostics…")}</button></Row>
        </div>}
      </>}
      {error && <div className="preferences-error" role="alert"><span>{error}</span><button aria-label={text("Dismiss error")} onClick={() => setError("")}><X size={14} /></button></div>}
      {!!preferences?.shortcutRegistrationErrors?.length && <div className="preferences-error" role="alert">{preferences.shortcutRegistrationErrors.join("\n")}</div>}
    </div></div>
    {busy && <div className="preferences-saving" role="status"><LoaderCircle size={12} className="spin" />{text("Saving…")}</div>}
  </main>;
}
