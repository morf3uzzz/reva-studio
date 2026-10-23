import { ArrowLeft, ShieldAlert, Trash2 } from "lucide-react";
import { useRef } from "react";
import { t, useLanguage } from "./i18n";
import { NumberInput, Range, Select, Segmented, Toggle } from "./components";
import type { Project } from "./types";
import { clamp, getMediaTime, getOutputTime } from "./core/model";
import type { Rect } from "./core/model";
import { defaultShortcutSettings, shortcutKeyLabels, sourceRectToScreen, type ManualMask } from "./core/annotations";
import "./annotations.css";
import { addManualMask } from "./core/editor-insert";

export default function AnnotationsPanel({ project, update, time, selectedId, select, notify, onSeek, previewTime = time, shortcuts = false }: { project: Project; update: (value: Project | ((project: Project) => Project), group?: string) => void; time: number; selectedId: string | null; select: (id: string | null) => void; notify: (message: string) => void; onSeek?: (time: number) => void; previewTime?: number; shortcuts?: boolean }) {
  useLanguage();
  if (shortcuts) {
    const settings = project.shortcutSettings ?? defaultShortcutSettings(), change = (patch: Partial<typeof settings>) => update(p => ({ ...p, shortcutSettings: { ...(p.shortcutSettings ?? defaultShortcutSettings()), ...patch } }), "shortcuts");
    return <><h3>{t("Recorded shortcuts")}</h3><Toggle label="Show recorded shortcuts" value={settings.enabled} onChange={enabled => change({ enabled })} /><Select label="Key labels" value={settings.style} onChange={style => change({ style: style as "mac" | "windows" })} ><option value="mac">Mac</option><option value="windows">Windows</option></Select><Range label="Size" value={settings.sizeRatio} min={.02} max={.15} step={.005} onChange={sizeRatio => change({ sizeRatio })} display={`${Math.round(settings.sizeRatio * 100)}%`} /><Range label="Horizontal position" value={settings.position.x} max={1} step={.01} onChange={x => change({ position: { ...settings.position, x } })} /><Range label="Vertical position" value={settings.position.y} max={1} step={.01} onChange={y => change({ position: { ...settings.position, y } })} /><Range label="Display duration" value={settings.duration} min={.1} max={5} step={.1} onChange={duration => change({ duration })} display={t("{value}s", { value: settings.duration.toFixed(1) })} /><label>{t("Background")} <input type="color" value={settings.background.slice(0, 7)} onChange={e => change({ background: e.target.value })} /></label><label>{t("Text")} <input type="color" value={settings.color.slice(0, 7)} onChange={e => change({ color: e.target.value })} /></label>
      {!(project.shortcuts?.length) && <p className="panel-note">{t("Enable shortcut capture before recording. Key labels cannot be recovered from typing counts.")}</p>}<div className="annotation-list">{project.shortcuts?.map(event => <label key={event.id}><input type="checkbox" checked={!event.hidden} onChange={e => update(p => ({ ...p, shortcuts: p.shortcuts?.map(item => item.id === event.id ? { ...item, hidden: !e.target.checked } : item) }))} />{shortcutKeyLabels(event.keys, settings.style).join(" + ")} <small>{t("{value}s", { value: event.time.toFixed(2) })}</small></label>)}</div></>;
  }
  const active = project.masks?.find(mask => mask.id === selectedId), change = (patch: Partial<ManualMask>) => {
    if (!active) return;
    const next = { ...active, ...patch };
    if (!next.disabled && (project.masks ?? []).some(mask => mask.id !== next.id && !mask.disabled && mask.type !== next.type && mask.start < next.end && mask.end > next.start)) { notify(t("A mask and highlight cannot overlap in time.")); return; }
    update(p => ({ ...p, masks: p.masks?.map(mask => mask.id === active.id ? next : mask) }), `mask-${active.id}`);
  };
  const add = (type: ManualMask["type"]) => { const mask = addManualMask(project, time, type); if (!mask) { notify(t("A mask and highlight cannot overlap in time.")); return; } update(p => ({ ...p, masks: [...(p.masks ?? []), mask] })); select(mask.id); };
  return <div className="mask-settings">
    {!active ? <><h3>{t("Masks and highlights")}</h3><div className="two-fields"><button className="outline-button" disabled={!project.mediaPath} onClick={() => add("sensitive-data")}>{t("Add mask")}</button><button className="outline-button" disabled={!project.mediaPath} onClick={() => add("highlight")}>{t("Add highlight")}</button></div>
      <p className="panel-note">{t("Drag and resize the rectangle in the preview. Masks stay at the selected source coordinates when the content scrolls.")}</p>
      <div className="annotation-list">{project.masks?.map(mask => <button key={mask.id} onClick={() => { select(mask.id); onSeek?.(mask.start); }}>{t(mask.type === "highlight" ? "Highlight" : "Mask")} <small>{t("{start}–{end}s", { start: mask.start.toFixed(2), end: mask.end.toFixed(2) })}</small></button>)}</div>
    </> : <>
      <button className="outline-button editor-back" onClick={() => select(null)}><ArrowLeft size={18} />{t("Close Mask editor")}</button>
      {(previewTime < active.start || previewTime > active.end) && <div className="mask-preview-notice"><p className="panel-note">{t("Preview is showing different part of the recording than the one covered by the mask.")}</p><button className="outline-button full" onClick={() => onSeek?.(active.start + (active.end - active.start) / 2)}>{t("Focus the timeline on the mask")}</button><hr /></div>}
      <h3 className="muted-heading">{t("Mask type")}</h3>
      <Segmented value={active.type} onChange={type => change({ type: type as ManualMask["type"] })} options={[{ value: "sensitive-data", label: "Sensitive Data" }, { value: "highlight", label: "Highlight" }]} />
      {active.type === "sensitive-data" && <p className="mask-advisory"><ShieldAlert size={17} /><span>{t("Make sure the mask covers the entire part of the timeline where sensitive data is present.")}</span></p>}
      <button className="outline-button full range-focus" onClick={() => onSeek?.(active.start)}>{t("Focus the timeline on the mask start")}</button>
      <hr />
      {active.type === "highlight" ? <><Range label="Highlight mask opacity" value={active.opacity} min={.1} max={.9} step={.01} display={`${Math.round(active.opacity * 100)}%`} onChange={opacity => change({ opacity })} reset={() => change({ opacity: .5 })} /><hr /></> : null}
      <Toggle label="Disable" description="When disabled, the mask will not be applied, but it will still be present in the timeline." value={!!active.disabled} onChange={disabled => change({ disabled })} />
      <hr /><details className="mask-geometry"><summary>{t("Position and timing")}</summary>
        <div className="two-fields"><label>{t("Start")}<NumberInput label="Mask start" value={active.start} min={0} max={active.end - .01} onCommit={start => change({ start })} /></label><label>{t("End")}<NumberInput label="Mask end" value={active.end} min={active.start + .01} max={project.duration} onCommit={end => change({ end })} /></label></div>
        {active.type === "sensitive-data" && <Range label="Blur" value={active.blur} max={100} step={1} display={String(active.blur)} onChange={blur => change({ blur })} />}
        {active.bounds.map((rect, index) => <div className="mask-rectangle-fields" key={index}><strong>{t("Rectangle")} {index + 1}</strong>{(["x", "y", "width", "height"] as const).map(key => <label key={key}>{t(({ x: "X", y: "Y", width: "Width", height: "Height" } as const)[key])}<NumberInput label={t("Mask {dimension}", { dimension: t(({ x: "X", y: "Y", width: "Width", height: "Height" } as const)[key]) })} value={rect[key] * 100} min={key === "width" || key === "height" ? .1 : 0} max={(key === "x" ? 1 - rect.width : key === "y" ? 1 - rect.height : key === "width" ? 1 - rect.x : 1 - rect.y) * 100} onCommit={value => change({ bounds: active.bounds.map((item, i) => i === index ? { ...item, [key]: value / 100 } : item) })} /></label>)}</div>)}
        <button className="text-button" onClick={() => change({ bounds: [...active.bounds, { x: .1, y: .1, width: .2, height: .15 }] })}>{t("Add rectangle")}</button>
      </details><hr /><button className="outline-button full danger" onClick={() => { update(p => ({ ...p, masks: p.masks?.filter(mask => mask.id !== active.id) })); select(null); }}><Trash2 size={17} />{t("Remove mask")}</button>
    </>}
  </div>;
}
export function MaskEditorOverlay({ mask, crop, screen, width, height, update }: { mask: ManualMask; crop: Rect; screen: Rect; width: number; height: number; update: (bounds: Rect[], gesture: string) => void }) {
  const overlay = useRef<HTMLDivElement>(null);
  return <div className="mask-editor-overlay" ref={overlay}>{mask.bounds.map((source, index) => {
    const box = sourceRectToScreen(source, crop, screen); if (!box) return null;
    const startDrag = (event: React.PointerEvent, corner?: "nw" | "n" | "ne" | "e" | "sw" | "s" | "se" | "w") => {
      event.preventDefault(); event.stopPropagation(); const target = event.currentTarget as HTMLElement; target.setPointerCapture(event.pointerId);
      const gesture = `gesture:mask:${crypto.randomUUID()}`;
      const stage = overlay.current!.getBoundingClientRect(), x = event.clientX, y = event.clientY, original = { ...source };
      const move = (next: PointerEvent) => {
        const dx = (next.clientX - x) / stage.width * width / screen.width * crop.width, dy = (next.clientY - y) / stage.height * height / screen.height * crop.height;
        let rect: Rect;
        if (!corner) rect = { ...original, x: clamp(original.x + dx, 0, 1 - original.width), y: clamp(original.y + dy, 0, 1 - original.height) };
        else { const left = corner.endsWith("w") ? clamp(original.x + dx, 0, original.x + original.width - .001) : original.x, right = corner.endsWith("e") ? clamp(original.x + original.width + dx, original.x + .001, 1) : original.x + original.width, top = corner.startsWith("n") ? clamp(original.y + dy, 0, original.y + original.height - .001) : original.y, bottom = corner.startsWith("s") ? clamp(original.y + original.height + dy, original.y + .001, 1) : original.y + original.height; rect = { x: left, y: top, width: right - left, height: bottom - top }; }
        update(mask.bounds.map((item, i) => i === index ? rect : item), gesture);
      };
      const end = () => { target.removeEventListener("pointermove", move); target.removeEventListener("pointerup", end); target.removeEventListener("pointercancel", end); target.removeEventListener("lostpointercapture", end); };
      target.addEventListener("pointermove", move); target.addEventListener("pointerup", end, { once: true }); target.addEventListener("pointercancel", end, { once: true }); target.addEventListener("lostpointercapture", end, { once: true });
    };
    return <div className="mask-edit-rect" key={index} style={{ left: `${box.x / width * 100}%`, top: `${box.y / height * 100}%`, width: `${box.width / width * 100}%`, height: `${box.height / height * 100}%` }} onPointerDown={event => startDrag(event)}>{(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map(corner => <button key={corner} className={`mask-handle ${corner}`} aria-label={t("Resize mask")} onPointerDown={event => startDrag(event, corner)} />)}</div>;
  })}</div>;
}
