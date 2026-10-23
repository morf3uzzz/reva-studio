import { useEffect, useRef, useState } from "react";
import { Volume2 } from "lucide-react";
import { DisclosureChevron, Segmented, Toggle } from "./components";
import ReferenceIcon from "./ReferenceIcon";
import { useLanguage } from "./i18n";
import { cursorSoundURL, defaultCursorSettings, resolveCursorSettings, type CursorSettings, type CursorSound } from "./core/cursor";
import { duration, outputToSource, selectSlice, timeToOutput } from "./core/timeline";
import catalog from "../cursors.json" with { type: "json" };
import ru from "../locales/ru-cursor.json" with { type: "json" };
import type { Project } from "./types";
import "./cursor-inspector.css";

type Update = (project: Project | ((project: Project) => Project), group?: string) => void;
export default function CursorInspector({ project, update, time, onSeek }: {
  project: Project;
  update: Update;
  time?: number;
  /** Original panel seeks to the start of a changed end-of-video adjustment. */
  onSeek?: (sourceTime: number) => void;
}) {
  const [language] = useLanguage();
  const text = (message: string, values: Record<string, string | number> = {}) => {
    const value = language === "ru" ? (ru as Record<string, string>)[message] ?? message : message;
    return value.replace(/\{(\w+)\}/g, (match, key: string) => Object.hasOwn(values, key) ? String(values[key]) : match);
  };
  const settings = resolveCursorSettings(project.appearance), defaults = defaultCursorSettings();
  const [soundError, setSoundError] = useState(false);
  const [imageError, setImageError] = useState("");
  const previewAudio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => { previewAudio.current?.pause(); previewAudio.current = null; }, []);
  const hideDelay = useRef(settings.hideNotMovingAfterMs ?? 2000), loopDuration = useRef(settings.loopPositionBeforeEndMs ?? 1000);
  if (settings.hideNotMovingAfterMs !== null) hideDelay.current = settings.hideNotMovingAfterMs;
  if (settings.loopPositionBeforeEndMs !== null) loopDuration.current = settings.loopPositionBeforeEndMs;
  const set = (patch: Partial<CursorSettings>, group = Object.keys(patch)[0]) => update(p => {
    const next = { ...resolveCursorSettings(p.appearance), ...patch };
    return { ...p, appearance: { ...p.appearance, cursorSettings: next, ...(patch.set && p.appearance.customCursor ? { customCursor: { ...p.appearance.customCursor, enabled: false } } : {}) } };
  }, `cursor-${group}`);
  const range = (label: string, key: keyof CursorSettings, value: number, min: number, max: number, step: number, display = value.toFixed(1), reset = Number(defaults[key]), change?: (value: number) => void) => <div className="cursor-range-field">
    <label className="cursor-setting-label" htmlFor={`cursor-${key}`}>{text(label)}</label>
    <div className="cursor-range-row"><div className="cursor-slider" style={{ "--range": `${(value - min) / (max - min) * 100}%`, "--thumb-offset": `${10 - (value - min) / (max - min) * 20}px` } as React.CSSProperties}>
      <input id={`cursor-${key}`} aria-label={text(label)} aria-valuetext={display} type="range" min={min} max={max} step={step} value={value} onChange={event => change ? change(+event.target.value) : set({ [key]: +event.target.value })} />
      <output className="cursor-slider-value" aria-hidden="true">{display}</output>
    </div><button disabled={Math.abs(value - reset) < 1e-9} onClick={() => change ? change(reset) : set({ [key]: reset })} title={`${text("Reset")} ${text(label)}`}>{text("Reset")}</button></div>
  </div>;
  const toggle = (label: string, value: boolean, change: (next: boolean) => void, description?: string) => <Toggle label={text(label)} description={description && text(description)} value={value} onChange={change} />;
  const seconds = (ms: number) => text("{value}s", { value: (ms / 1000).toFixed(1) });
  const seekTail = (milliseconds: number) => {
    const source = outputToSource(project, Math.max(0, duration(project) - milliseconds / 1000));
    if (source !== null) onSeek?.(source);
  };
  const sound = (choice: CursorSound = settings.clickSound) => {
    previewAudio.current?.pause(); previewAudio.current = null;
    if (choice === "none") return;
    const audio = new Audio(cursorSoundURL(choice)); audio.volume = settings.clickSoundVolume; previewAudio.current = audio;
    setSoundError(false); void audio.play().catch(() => { if (previewAudio.current === audio) setSoundError(true); });
  };
  const entries = catalog.entries.filter(entry => entry.set === settings.set.id);
  const variants = [...new Set(entries.map(entry => entry.type))].map(type => [type, entries.filter(entry => entry.type === type)] as const).filter(([, options]) => options.length > 1);
  const setName = (id: string) => id === "macos" ? text("Classic") : id === "macos-tahoe" ? text("Lumen") : id === "touch" ? text("Touch") : id.startsWith("custom-") ? text("Custom cursor {number}", { number: id.slice(7) }) : text("Halloween");
  const outputTime = time === undefined ? null : timeToOutput(project, time);
  const sourceSlice = outputTime === null ? undefined : selectSlice(project, outputTime)?.slice;
  const selectedSpeed = sourceSlice?.speed ?? project.speed;
  const visibleSets = catalog.sets.filter(id => id !== "halloween" || settings.set.id === "halloween");
  const hide = <div className="cursor-hide-switch">{toggle("Hide cursor", settings.hidden, hidden => set({ hidden }))}</div>;
  const custom = project.appearance.customCursor;
  const importArtwork = async () => {
    setImageError("");
    try { const image = await window.reva?.importCursorImage(); if (image) update(p => ({ ...p, appearance: { ...p.appearance, customCursor: image } })); }
    catch (error) { setImageError(error instanceof Error ? error.message : String(error)); }
  };
  return <div className="cursor-settings">
    {sourceSlice?.cursorHidden && <p className="panel-note">{text("Cursor is hidden in this part of the recording, so you will not see changes you make to it.")}</p>}
    {settings.hidden ? hide : <>
      <div className="cursor-section">
        {range("Cursor size", "size", settings.size, 16, 128, 0.1)}
        <div className="cursor-named-field"><div className="cursor-setting-label">{text("Cursor style")}</div>
        <div className="cursor-swatches" role="group" aria-label={text("Cursor style")}>
          {visibleSets.map(id => {
            const choices = catalog.entries.filter(entry => entry.set === id);
            const entry = choices.find(entry => entry.type === "pointer" && entry.id === settings.set.variants.pointer) ?? choices.find(entry => entry.type === "pointer") ?? choices[0];
            return entry && <button key={id} className={!custom?.enabled && id === settings.set.id ? "selected" : ""} aria-label={setName(id)} title={setName(id)} aria-pressed={!custom?.enabled && id === settings.set.id} onClick={() => set({ set: { id, variants: {} } }, "set")}><img alt="" src={`cursors/${entry.file}`} /></button>;
          })}
        </div></div>
        <button className="wide-action" onClick={() => void importArtwork()}>{text("Import cursor PNG…")}</button>
        {imageError && <p className="panel-note" role="alert">{imageError}</p>}
        {custom && <div className="cursor-card">
          {toggle("Use imported cursor", custom.enabled, enabled => update(p => ({ ...p, appearance: { ...p.appearance, customCursor: { ...custom, enabled } } })))}
          <p className="cursor-description">{custom.name} · {custom.width} × {custom.height}</p>
          {(["x", "y"] as const).map(axis => <label key={axis} className="cursor-range-field">{text(axis === "x" ? "Hotspot X" : "Hotspot Y")}<input type="range" min="0" max="1" step="0.001" value={custom.hotspot[axis]} onChange={event => update(p => ({ ...p, appearance: { ...p.appearance, customCursor: { ...custom, hotspot: { ...custom.hotspot, [axis]: +event.target.value } } } }), `cursor-hotspot-${axis}`)} /></label>)}
          <div className="custom-cursor-preview" style={{ position: "relative", width: 120, height: 120, margin: "8px auto" }}><img alt={text("Imported cursor hotspot preview")} src={window.reva?.mediaURL(custom.path)} style={{ width: "100%", height: "100%", objectFit: "fill" }} /><span style={{ position: "absolute", left: `${custom.hotspot.x * 100}%`, top: `${custom.hotspot.y * 100}%`, width: 9, height: 9, margin: -5, border: "1px solid #ff8c22", background: "#0008", borderRadius: "50%", pointerEvents: "none" }} /></div>
        </div>}
        {variants.length > 0 && <div className="cursor-variants"><div className="cursor-setting-label">{text("Variant")}</div>{variants.map(([type, options]) => <div className="cursor-swatches cursor-variant-swatches" key={type} role="group" aria-label={`${text("Variant")} ${type}`}>
          {options.map((entry, i) => <button key={entry.id} title={`${text("Variant")} ${i + 1}`} aria-label={`${text("Variant")} ${type} ${i + 1}`} aria-pressed={(settings.set.variants[type] ?? options[0].id) === entry.id} className={(settings.set.variants[type] ?? options[0].id) === entry.id ? "selected" : ""} onClick={() => set({ set: { ...settings.set, variants: { ...settings.set.variants, [type]: entry.id } } }, "variant")}><img alt="" src={`cursors/${entry.file}`} /></button>)}
        </div>)}</div>}
        {toggle("Always use pointer cursor", settings.alwaysUsePointer, alwaysUsePointer => set({ alwaysUsePointer }), "Don't change cursor, even if selecting text, etc.")}
      </div>
      <div className="cursor-section">
        {toggle("Hide cursor if not moving", settings.hideNotMovingAfterMs !== null, enabled => set({ hideNotMovingAfterMs: enabled ? hideDelay.current : null }))}
        {settings.hideNotMovingAfterMs !== null && range("Hide not moving cursor after", "hideNotMovingAfterMs", settings.hideNotMovingAfterMs, 500, 5000, 50, seconds(settings.hideNotMovingAfterMs), 2000)}
        {toggle("Loop cursor position", settings.loopPositionBeforeEndMs !== null, enabled => set({ loopPositionBeforeEndMs: enabled ? loopDuration.current : null }), "Near the end of the video, cursor will move back to its initial position")}
        {settings.loopPositionBeforeEndMs !== null && <>{range("Loop cursor position duration", "loopPositionBeforeEndMs", settings.loopPositionBeforeEndMs, 1000, 4000, 50, seconds(settings.loopPositionBeforeEndMs), 1000, value => { set({ loopPositionBeforeEndMs: value }); seekTail(value); })}</>}
        {hide}
      </div>
      <div className="cursor-section">
        <div className="cursor-named-field"><div className="cursor-setting-label">{text("Click effect")}</div>
        <Segmented value={settings.clickEffect} onChange={clickEffect => set({ clickEffect })} options={([ ["none", "None"], ["circle", "Circle"], ["ripple", "Ripple"] ] as const).map(([value, label]) => ({ value, label: text(label) }))} />
        </div><div className="cursor-named-field"><div className="cursor-setting-label">{text("Click sound")}</div>
        <Segmented value={settings.clickSound} onChange={clickSound => { set({ clickSound }); sound(clickSound); }} options={([ ["none", "None"], ["apple-magic-mouse", "Soft click"], ["logitech-mx-master", "Crisp click"] ] as const).map(([value, label]) => ({ value, label: text(label) }))} />
        {settings.clickSound !== "none" && <>
          {range("Click sound volume", "clickSoundVolume", settings.clickSoundVolume, 0, 1, 0.1, `${Math.round(settings.clickSoundVolume * 100)}%`)}
          <button className="outline-button full" onClick={() => sound()}><Volume2 size={15} />{text("Play click sound preview")}</button>
          {selectedSpeed > 2 && <p className="panel-note">{text("Sound will not be played for parts with a playback speed greater than 2x.")}</p>}
          {soundError && <p className="panel-note" role="alert">{text("Unable to play click sound.")}</p>}
        </>}</div>
      </div>
      <details className="cursor-disclosure"><summary>{text("Rotation")}<DisclosureChevron /></summary><div className="cursor-card">
        {range("Rotate cursor", "baseRotation", settings.baseRotation, -180, 180, 1, `${settings.baseRotation.toFixed(0)}°`)}
        <div className="cursor-named-field"><div className="cursor-field-heading"><div className="cursor-setting-label"><ReferenceIcon name="cursorarrow.motionlines.click" size={16} />{text("Rotate while moving")}</div><p className="cursor-description">{text("How the cursor rotates as it chases the mouse.")}</p></div>
        <Segmented value={settings.rotationMode} onChange={rotationMode => set({ rotationMode })} options={[{ value: "velocity", label: text("Tilt") }, { value: "directional", label: text("Follow") }]} />
        <p className="cursor-description">{text(settings.rotationMode === "velocity" ? "Leans with fast horizontal movement, settling back upright at rest." : "Points along the direction of travel, like pulled on a leash - and keeps its bearing at rest.")}</p></div>
        {settings.rotationMode === "velocity" && <>{range("Tilt amount", "tiltAmount", settings.tiltAmount, 0, 2, 0.01)}<p className="cursor-description">{text("How strongly horizontal movement leans the cursor.")}</p></>}
      </div></details>
      <details className="cursor-disclosure"><summary>{text("Advanced")}<DisclosureChevron /></summary><div className="cursor-card">
        {settings.loopPositionBeforeEndMs === null && <>
          <div className="cursor-setting-label">{text("Stop cursor movement at the end of the video")}</div><p className="cursor-description">{text('Near the end of the video, the last mouse movement often leads to clicking "Stop Recording," which you might not want to be visible. Adjust how long before the end of the video the mouse cursor will stop moving.')}</p>
          <div className="cursor-stop-control">{range("Stop cursor movement at the end of the video", "stopMovementInLastPartMs", settings.stopMovementInLastPartMs, 0, 5000, 50, seconds(settings.stopMovementInLastPartMs), 0, value => { set({ stopMovementInLastPartMs: value }); seekTail(value); })}</div>
        </>}
        {toggle("Remove cursor shakes", settings.shakeThreshold !== 0, enabled => set({ shakeThreshold: enabled ? 500 : 0 }), "If you use some accessibility apps that can control your mouse, it is possible those apps will cause sudden, short movements of your mouse. This option allows trying to detect and remove them.")}
        {settings.shakeThreshold !== 0 && range("Remove cursor shakes threshold", "shakeThreshold", settings.shakeThreshold, 100, 2000, 20, settings.shakeThreshold.toFixed(0))}
        {toggle("Optimize cursor changes", settings.optimizeChanges, optimizeChanges => set({ optimizeChanges }), "Screen Studio will try to minimize rapid cursor changes (eg when quickly moving over some elements) when this option is enabled.")}
        {toggle("Keep cursor in sync with hovers", settings.syncWithHovers, syncWithHovers => set({ syncWithHovers }), "When something lights up under the moving mouse, like a menu item or a button, the cursor gets there just in time, setting off a little earlier or moving a little faster, so the highlight never shows before the cursor does.")}
      </div></details>
    </>}
  </div>;
}
