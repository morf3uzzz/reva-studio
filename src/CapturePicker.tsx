import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { AppWindow, Check, ChevronDown, ChevronLeft, CircleHelp, LoaderCircle, PanelsTopLeft, Save, Scan, Settings, X } from "lucide-react";
import { initializeLanguage, useLanguage } from "./i18n";
import { constrainPixelCrop, fitCropAspect, movePixelCrop, resizePixelCrop, setCropDimension, type CropHandle, type CropRect } from "./crop-geometry";
import type { CaptureSource, QuickExportSettings } from "./types";
import "./capture-picker.css";

export type { QuickExportSettings } from "./types";

export type CapturePickerMode = "display" | "window" | "area";
export type AfterRecording = "project" | "clipboard" | "file";
export interface SavedCaptureArea { id: string; name: string; rect: CropRect }
export interface PickerSource extends CaptureSource { appName?: string; appIcon?: string; borderRadius?: number }
export interface CapturePickerData {
  mode: CapturePickerMode;
  sources: PickerSource[];
  display: CropRect;
  fps: number;
  autoZoom: boolean;
  afterRecording: AfterRecording;
  savedAreas: SavedCaptureArea[];
  quickExportSettings?: QuickExportSettings;
}
export interface CapturePickerResult {
  sourceID: string;
  area?: CropRect;
  autoZoom: boolean;
  afterRecording: AfterRecording;
  quickExportSettings: QuickExportSettings;
}
export interface CapturePickerBridge {
  getCapturePicker(): Promise<CapturePickerData>;
  completeCapturePicker(result: CapturePickerResult | null): Promise<void>;
  saveCaptureArea(input: { name: string; rect: CropRect }): Promise<SavedCaptureArea[]>;
}

const defaultExport: QuickExportSettings = { format: "mp4", fps: 60, resolution: 1080, quality: "balanced", codec: "h264", proresProfile: "422", gifHighQuality: true, gifLoop: true };
const handles: CropHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const aspectPresets = [[16, 9], [9, 16], [1, 1], [4, 3], [3, 4], [16, 10], [4, 5]];
const interactive = (target: EventTarget | null) => target instanceof Element && !!target.closest(".capture-picker-interactive");
const labels = {
  en: {
    start: "Start recording", after: "After Recording", project: "Create project", clipboard: "Export and copy to clipboard", link: "Export and create shareable link", file: "Export and save to file", linkUnavailable: "Shareable links are unavailable in this local app.", autoZoom: "Automatically create zooms", quickExport: "Quick export settings…", exportTitle: "Quick export settings", format: "Format", fps: "Frame rate", resolution: "Resolution", quality: "Quality", codec: "Codec", profile: "ProRes profile", gifHighQuality: "High quality GIF", gifLoop: "Loop GIF", high: "High", balanced: "Balanced", small: "Small", tiny: "Tiny", done: "Done", back: "Back", size: "Size", position: "Position", width: "Width", height: "Height", select: "Select…", free: "Free selection", original: "Display aspect ratio", saved: "Saved", saveArea: "Save this area…", savedEmpty: "No saved areas", name: "Area name", save: "Save area", cancel: "Cancel", savedDefault: "Recording area", minimum: "Minimal size is 150×150px", draw: "Drag to select a recording area", areaHelp: "Drag the frame to move it. Drag a handle to resize.", clear: "Clear selection", windowHelp: "Click a window to select it. Esc cancels.", chooseWindow: "Select a window…", noWindows: "No windows available on this display", adjust: "Adjust recording area", loading: "Loading capture sources…", missing: "The selected display is no longer available.", bridgeMissing: "REVA desktop bridge is unavailable.", area: "Recording area", resize: "Resize area", exportHelp: "Used when exporting to the clipboard or a file after recording.", escape: "Esc to cancel", source: "Recording source", autoZoomHelp: "Create zooms from clicks captured during the recording.",
  },
  ru: {
    start: "Начать запись", after: "После записи", project: "Создать проект", clipboard: "Экспортировать в буфер обмена", link: "Экспортировать и создать ссылку", file: "Экспортировать в файл", linkUnavailable: "Ссылки для публикации недоступны в локальном приложении.", autoZoom: "Автоматически создавать зумы", quickExport: "Настройки быстрого экспорта…", exportTitle: "Быстрый экспорт", format: "Формат", fps: "Частота кадров", resolution: "Разрешение", quality: "Качество", codec: "Кодек", profile: "Профиль ProRes", gifHighQuality: "Высокое качество GIF", gifLoop: "Зациклить GIF", high: "Высокое", balanced: "Оптимальное", small: "Малый размер", tiny: "Минимальный размер", done: "Готово", back: "Назад", size: "Размер", position: "Положение", width: "Ширина", height: "Высота", select: "Выбрать…", free: "Свободная область", original: "Пропорции дисплея", saved: "Сохранённые", saveArea: "Сохранить эту область…", savedEmpty: "Нет сохранённых областей", name: "Название области", save: "Сохранить", cancel: "Отмена", savedDefault: "Область записи", minimum: "Минимальный размер — 150×150 px", draw: "Перетащите, чтобы выбрать область записи", areaHelp: "Перетащите рамку, чтобы переместить область, или маркеры, чтобы изменить размер.", clear: "Сбросить область", windowHelp: "Нажмите на окно для выбора. Esc — отмена.", chooseWindow: "Выбрать окно…", noWindows: "На этом дисплее нет доступных окон", adjust: "Настроить область записи", loading: "Загрузка источников записи…", missing: "Выбранный дисплей больше недоступен.", bridgeMissing: "Нет подключения к REVA desktop.", area: "Область записи", resize: "Изменить размер области", exportHelp: "Применяется при экспорте в буфер обмена или файл после записи.", escape: "Esc — отмена", source: "Источник записи", autoZoomHelp: "Создавать зумы по щелчкам, сохранённым во время записи.",
  },
};
type Text = typeof labels.en;
type Popup = "after" | "export" | "aspect" | "saved" | "save" | "windows" | "resize" | null;

function PixelField({ label, value, max, min = 0, onCommit }: { label: string; value: number; max: number; min?: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(Math.round(value))), [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setDraft(String(Math.round(value))); }, [value, focused]);
  return <input type="number" inputMode="numeric" min={min} max={max} step={1} aria-label={label} value={draft}
    onFocus={() => setFocused(true)} onChange={event => setDraft(event.target.value)}
    onBlur={() => { const parsed = Number(draft); if (draft.trim() && Number.isFinite(parsed)) onCommit(Math.min(max, Math.max(min, Math.round(parsed)))); else setDraft(String(Math.round(value))); setFocused(false); }}
    onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); event.currentTarget.blur(); } }} />;
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-label={label} aria-checked={checked} className={`capture-picker-toggle ${checked ? "is-on" : ""}`} onClick={() => onChange(!checked)}><span /></button>;
}

function Popover({ anchor, children, className = "" }: { anchor: HTMLElement | null; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 12, top: 12, ready: false });
  useLayoutEffect(() => {
    function place() {
      if (!anchor || !ref.current) return;
      const rect = anchor.getBoundingClientRect(), size = ref.current.getBoundingClientRect();
      const top = rect.bottom + size.height + 6 <= innerHeight - 12 ? rect.bottom + 3 : Math.max(12, rect.top - size.height - 4);
      setPosition({ left: Math.max(12, Math.min(innerWidth - size.width - 12, rect.left - 3)), top, ready: true });
    }
    place();
    const observer = new ResizeObserver(place);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener("resize", place);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); };
  }, [anchor]);
  return <div ref={ref} className={`capture-picker-popover capture-picker-interactive ${className}`} data-picker-popover-root="" style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }} onPointerDown={event => event.stopPropagation()}>{children}</div>;
}

function ExportSettings({ value, onChange, text, onBack }: { value: QuickExportSettings; onChange: (value: QuickExportSettings) => void; text: Text; onBack: () => void }) {
  const patch = (change: Partial<QuickExportSettings>) => onChange({ ...value, ...change });
  return <div className="capture-picker-export-settings">
    <header><button type="button" onClick={onBack} aria-label={text.back}><ChevronLeft size={15} /></button><strong>{text.exportTitle}</strong></header>
    <label>{text.format}<select value={value.format} onChange={event => patch({ format: event.target.value as QuickExportSettings["format"] })}><option value="mp4">MP4</option><option value="prores">ProRes</option><option value="gif">GIF</option></select></label>
    <label>{text.resolution}<select value={value.resolution} onChange={event => patch({ resolution: Number(event.target.value) as QuickExportSettings["resolution"] })}>{[720, 1080, 2160].map(resolution => <option key={resolution} value={resolution}>{resolution === 2160 ? "4K" : `${resolution}p`}</option>)}</select></label>
    <label>{text.fps}<select value={value.fps} onChange={event => patch({ fps: Number(event.target.value) as QuickExportSettings["fps"] })}>{[24, 30, 60].map(fps => <option key={fps} value={fps}>{fps} FPS</option>)}</select></label>
    {value.format === "mp4" && <><label>{text.quality}<select value={value.quality} onChange={event => patch({ quality: event.target.value as QuickExportSettings["quality"] })}>{(["high", "balanced", "small", "tiny"] as const).map(quality => <option key={quality} value={quality}>{text[quality]}</option>)}</select></label><label>{text.codec}<select value={value.codec} onChange={event => patch({ codec: event.target.value as QuickExportSettings["codec"] })}><option value="h264">H.264</option><option value="hevc">HEVC</option></select></label></>}
    {value.format === "prores" && <label>{text.profile}<select value={value.proresProfile} onChange={event => patch({ proresProfile: event.target.value as QuickExportSettings["proresProfile"] })}><option value="422-lt">422 LT</option><option value="422">422</option><option value="422-hq">422 HQ</option><option value="4444">4444</option></select></label>}
    {value.format === "gif" && <><div className="capture-picker-setting-switch"><span>{text.gifHighQuality}</span><Toggle checked={value.gifHighQuality} onChange={gifHighQuality => patch({ gifHighQuality })} label={text.gifHighQuality} /></div><div className="capture-picker-setting-switch"><span>{text.gifLoop}</span><Toggle checked={value.gifLoop} onChange={gifLoop => patch({ gifLoop })} label={text.gifLoop} /></div></>}
    <p>{text.exportHelp}</p><button type="button" className="capture-picker-settings-done" onClick={onBack}>{text.done}</button>
  </div>;
}

function displaySource(data: CapturePickerData | null): PickerSource | undefined {
  const displays = data?.sources.filter(source => source.kind === "display") ?? [];
  return displays.find(source => source.bounds && source.bounds.x === data?.display.x && source.bounds.y === data.display.y) ?? displays[0];
}

function roundedArea(rect: CropRect, source: CaptureSource): CropRect {
  return constrainPixelCrop({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }, source);
}

export default function CapturePicker({ mode: requestedMode }: { mode?: CapturePickerMode } = {}) {
  const [language] = useLanguage(), text = labels[language];
  const api = window.reva as (NonNullable<Window["reva"]> & CapturePickerBridge) | undefined;
  const [data, setData] = useState<CapturePickerData | null>(null), [mode, setMode] = useState<CapturePickerMode>(requestedMode ?? "display");
  const [hover, setHover] = useState<string | null>(null), [selected, setSelected] = useState<string | null>(null), [displaySelected, setDisplaySelected] = useState(true);
  const [area, setArea] = useState<CropRect | null>(null), [aspect, setAspect] = useState("free");
  const [autoZoom, setAutoZoom] = useState(true), [afterRecording, setAfterRecording] = useState<AfterRecording>("project"), [quickExportSettings, setQuickExportSettings] = useState<QuickExportSettings>(defaultExport);
  const [popup, setPopup] = useState<Popup>(null), [popupAnchor, setPopupAnchor] = useState<HTMLElement | null>(null), [saveName, setSaveName] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [saving, setSaving] = useState(false), [dragging, setDragging] = useState(false);
  const [viewport, setViewport] = useState({ width: innerWidth, height: innerHeight });
  const [windowDimensions, setWindowDimensions] = useState({ width: 1280, height: 720 });
  const stageRef = useRef<HTMLElement>(null), areaRef = useRef<HTMLDivElement>(null), busyRef = useRef(false), mounted = useRef(true);
  const dragRef = useRef<{ pointer: number; kind: "create" | "move" | CropHandle; x: number; y: number; rect: CropRect } | null>(null);
  const source = displaySource(data), windows = data?.sources.filter(source => source.kind === "window" && source.bounds) ?? [];
  const windowSource = windows.find(source => source.id === (selected ?? hover));
  const activeSource = mode === "window" ? windowSource : source;
  useEffect(() => { if (windowSource) setWindowDimensions({ width: windowSource.width, height: windowSource.height }); }, [windowSource?.id, windowSource?.width, windowSource?.height]);
  const ratio = aspect === "free" ? null : aspect === "original" && source ? source.width / source.height : Number(aspect);
  const validArea = !!area && Math.round(area.width) >= 150 && Math.round(area.height) >= 150;
  const fail = useCallback((reason: unknown) => { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }, []);

  useEffect(() => {
    mounted.current = true;
    document.documentElement.dataset.capturePicker = "true";
    void initializeLanguage().catch(fail);
    if (!api) setError(text.bridgeMissing);
    else void api.getCapturePicker().then(value => {
      if (!mounted.current) return;
      setData(value); setMode(requestedMode ?? value.mode); setAutoZoom(value.autoZoom); setAfterRecording(value.afterRecording); setQuickExportSettings({ ...defaultExport, ...value.quickExportSettings });
    }).catch(fail);
    return () => { mounted.current = false; delete document.documentElement.dataset.capturePicker; };
  }, []);

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setViewport({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element); return () => observer.disconnect();
  }, []);

  const complete = useCallback(async (cancel = false) => {
    if (busyRef.current || !api) return;
    const chosen = mode === "window" ? windows.find(source => source.id === selected) : source;
    if (!cancel && (!chosen || (mode === "area" && (!area || !validArea)) || (mode === "display" && !displaySelected))) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      await api.completeCapturePicker(cancel ? null : { sourceID: chosen!.id, ...(mode === "area" && area ? { area: roundedArea(area, chosen!) } : {}), autoZoom, afterRecording, quickExportSettings });
    } catch (reason) { busyRef.current = false; if (mounted.current) setBusy(false); fail(reason); }
  }, [api, mode, windows, selected, source, area, validArea, displaySelected, autoZoom, afterRecording, quickExportSettings, fail]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (busyRef.current) return;
      const editing = event.target instanceof HTMLElement && !!event.target.closest("input, select, textarea, [contenteditable=true]");
      if (event.key === "Escape") {
        event.preventDefault();
        if (popup) { setPopup(null); return; }
        if (mode === "area" && area) { setArea(null); return; }
        if (mode === "window" && selected) { setSelected(null); setHover(null); return; }
        if (mode === "display" && displaySelected) { setDisplaySelected(false); return; }
        void complete(true); return;
      }
      if (editing || popup) return;
      if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); void complete(); }
      if (mode !== "area" || !area || !source || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1, dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0, dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
      setArea(event.altKey ? resizePixelCrop(area, dx ? "e" : "s", dx, dy, source, ratio) : movePixelCrop(area, dx, dy, source));
    };
    const outside = (event: PointerEvent) => { if (event.target instanceof Element && !event.target.closest("[data-picker-popover-root]")) setPopup(null); };
    window.addEventListener("keydown", onKey); window.addEventListener("pointerdown", outside);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("pointerdown", outside); };
  }, [popup, mode, area, source, selected, displaySelected, ratio, complete]);

  function showPopup(value: Popup, anchor: HTMLElement) { setPopup(current => current === value ? null : value); setPopupAnchor(anchor); setError(""); }
  function point(event: ReactPointerEvent) {
    const rect = stageRef.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(source!.width, (event.clientX - rect.left) * source!.width / rect.width)), y: Math.max(0, Math.min(source!.height, (event.clientY - rect.top) * source!.height / rect.height)) };
  }
  function startDrag(event: ReactPointerEvent<HTMLElement>, kind: "create" | "move" | CropHandle) {
    if (mode !== "area" || !source || busy || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const p = point(event), initial = kind === "create" ? { ...p, width: 1, height: 1 } : area;
    if (!initial) return;
    dragRef.current = { pointer: event.pointerId, kind, ...p, rect: initial }; setDragging(true); setPopup(null);
    if (kind === "create") setArea(initial);
    event.currentTarget.setPointerCapture(event.pointerId);
    areaRef.current?.focus({ preventScroll: true });
  }
  function movePointer(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (drag && source && drag.pointer === event.pointerId) {
      const p = point(event), dx = p.x - drag.x, dy = p.y - drag.y;
      if (drag.kind === "create") {
        const rect = constrainPixelCrop({ x: Math.min(drag.x, p.x), y: Math.min(drag.y, p.y), width: Math.abs(dx), height: Math.abs(dy) }, source);
        setArea(ratio ? fitCropAspect(rect, ratio, source) : rect);
      } else setArea(drag.kind === "move" ? movePixelCrop(drag.rect, dx, dy, source) : resizePixelCrop(drag.rect, drag.kind, dx, dy, source, ratio ?? (event.shiftKey ? drag.rect.width / drag.rect.height : null)));
      return;
    }
    if (mode !== "window" || selected || !data || interactive(event.target)) return;
    const x = event.clientX * data.display.width / viewport.width + data.display.x, y = event.clientY * data.display.height / viewport.height + data.display.y;
    const hits = windows.filter(source => source.bounds && x >= source.bounds.x && y >= source.bounds.y && x <= source.bounds.x + source.bounds.width && y <= source.bounds.y + source.bounds.height).sort((a, b) => (a.zIndex ?? Infinity) - (b.zIndex ?? Infinity));
    setHover(hits[0]?.id ?? null);
  }
  function endDrag(event: ReactPointerEvent<HTMLElement>) { if (dragRef.current?.pointer === event.pointerId) { dragRef.current = null; setDragging(false); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } }
  function adjustWindowArea() {
    if (!source || !windowSource?.bounds || !data) return;
    const b = windowSource.bounds, d = data.display;
    const left = Math.max(d.x, b.x), top = Math.max(d.y, b.y), right = Math.min(d.x + d.width, b.x + b.width), bottom = Math.min(d.y + d.height, b.y + b.height);
    setArea(constrainPixelCrop({ x: (left - d.x) * source.width / d.width, y: (top - d.y) * source.height / d.height, width: (right - left) * source.width / d.width, height: (bottom - top) * source.height / d.height }, source));
    setMode("area"); setPopup(null); setAspect("free");
  }
  async function saveArea(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!api || !source || !area || !validArea || saving || !saveName.trim()) return;
    setSaving(true);
    try { const savedAreas = await api.saveCaptureArea({ name: saveName.trim(), rect: roundedArea(area, source) }); if (mounted.current) { setData(current => current ? { ...current, savedAreas } : current); setPopup(null); } }
    catch (reason) { fail(reason); }
    finally { if (mounted.current) setSaving(false); }
  }

  const areaCSS = area && source ? { left: area.x / source.width * viewport.width, top: area.y / source.height * viewport.height, width: area.width / source.width * viewport.width, height: area.height / source.height * viewport.height } : null;
  const windowCSS = windowSource?.bounds && data ? { left: (windowSource.bounds.x - data.display.x) * viewport.width / data.display.width, top: (windowSource.bounds.y - data.display.y) * viewport.height / data.display.height, width: windowSource.bounds.width * viewport.width / data.display.width, height: windowSource.bounds.height * viewport.height / data.display.height, borderRadius: windowSource.borderRadius ?? 11 } : null;
  const toolHeight = validArea ? 224 : 162;
  const areaTools = areaCSS ? { left: Math.max(12, Math.min(viewport.width - 284, areaCSS.left + areaCSS.width / 2 - 136)), top: areaCSS.top + areaCSS.height + toolHeight + 20 <= viewport.height - 30 ? areaCSS.top + areaCSS.height + 20 : Math.max(12, areaCSS.top - toolHeight - 20) } : null;
  const cardStyle: CSSProperties = mode === "window" && windowCSS ? { left: Math.max(180, Math.min(viewport.width - 180, windowCSS.left + windowCSS.width / 2)), top: Math.max(150, Math.min(viewport.height - 190, windowCSS.top + windowCSS.height / 2)) } : {};

  const startControl = () => <div className="capture-picker-start-group capture-picker-interactive" data-picker-popover-root="">
    <button type="button" className="capture-picker-start-main" onClick={() => void complete()} disabled={busy || (mode === "window" && !selected)}>{busy ? <LoaderCircle size={18} className="spin" /> : <span className="capture-picker-record-glyph" />}<span>{text.start}</span></button>
    <button type="button" className={`capture-picker-start-options ${popup === "after" || popup === "export" ? "is-open" : ""}`} aria-label={text.after} aria-expanded={popup === "after" || popup === "export"} onClick={event => showPopup("after", event.currentTarget.parentElement!)} disabled={busy}><ChevronDown size={17} /></button>
  </div>;

  return <main ref={stageRef} className={`capture-picker capture-picker-${mode} ${dragging ? "is-dragging" : ""}`} aria-label={text.source}
    onPointerDown={event => { if (interactive(event.target)) return; if (mode === "area") startDrag(event, "create"); }}
    onPointerMove={movePointer} onPointerUp={endDrag} onPointerCancel={endDrag}
    onPointerLeave={() => { if (!selected) setHover(null); }}
    onClick={event => { if (dragRef.current || busy || interactive(event.target)) return; if (mode === "window") setSelected(current => current ? null : hover); if (mode === "display") setDisplaySelected(true); }}>
    {mode === "area" && areaCSS ? <>
      <div className="capture-picker-area-shade" style={{ left: 0, top: 0, width: "100%", height: areaCSS.top }} /><div className="capture-picker-area-shade" style={{ left: 0, top: areaCSS.top + areaCSS.height, right: 0, bottom: 0 }} /><div className="capture-picker-area-shade" style={{ left: 0, top: areaCSS.top, width: areaCSS.left, height: areaCSS.height }} /><div className="capture-picker-area-shade" style={{ left: areaCSS.left + areaCSS.width, top: areaCSS.top, right: 0, height: areaCSS.height }} />
      <div ref={areaRef} className="capture-picker-area-frame" tabIndex={0} role="group" aria-label={text.area} aria-description={text.areaHelp} style={areaCSS} onPointerDown={event => startDrag(event, "move")}>
        {[0.25, 0.5, 0.75].map(fraction => <div key={`x${fraction}`} className="capture-picker-area-grid vertical" style={{ left: `${fraction * 100}%` }} />)}{[0.25, 0.5, 0.75].map(fraction => <div key={`y${fraction}`} className="capture-picker-area-grid horizontal" style={{ top: `${fraction * 100}%` }} />)}
        {handles.map(handle => <button type="button" key={handle} tabIndex={-1} className={`capture-picker-area-handle handle-${handle}`} aria-label={`${text.resize} (${handle.toUpperCase()})`} onPointerDown={event => startDrag(event, handle)} />)}
      </div>
    </> : <div className="capture-picker-base-dim" />}
    {mode === "display" && displaySelected && source && <div className="capture-picker-source-overlay is-display" />}
    {mode === "window" && windowCSS && <div className="capture-picker-source-overlay" style={windowCSS} />}
    {mode === "display" && displaySelected && source && <section className="capture-picker-source-card" style={cardStyle}><h1>{source.name}</h1><div className="capture-picker-source-meta">{Math.round(source.width)}×{Math.round(source.height)} · {data?.fps ?? 60}FPS</div>{startControl()}</section>}
    {mode === "window" && windowSource && windowCSS && <section className="capture-picker-source-card" style={cardStyle}>
      {windowSource.appIcon ? <img className="capture-picker-app-icon" src={windowSource.appIcon} alt="" draggable={false} /> : <AppWindow className="capture-picker-app-fallback" size={58} />}
      <h1>{windowSource.appName ?? windowSource.name}</h1><div className="capture-picker-source-meta">{Math.round(windowSource.width)} × {Math.round(windowSource.height)}</div>
      {selected && startControl()}
    </section>}
    {mode === "area" && area && source && areaTools && !dragging && <section className="capture-picker-area-tools capture-picker-interactive" style={areaTools} data-picker-popover-root="">
      <div className="capture-picker-area-fields"><span>{text.size}</span><PixelField label={text.width} value={area.width} min={1} max={source.width} onCommit={value => setArea(setCropDimension(area, "width", value, source, ratio))} /><b>×</b><PixelField label={text.height} value={area.height} min={1} max={source.height} onCommit={value => setArea(setCropDimension(area, "height", value, source, ratio))} /><small>px</small></div>
      <div className="capture-picker-area-fields"><span>{text.position}</span><PixelField label="X" value={area.x} max={source.width - area.width} onCommit={x => setArea(constrainPixelCrop({ ...area, x }, source))} /><b /><PixelField label="Y" value={area.y} max={source.height - area.height} onCommit={y => setArea(constrainPixelCrop({ ...area, y }, source))} /><small>px</small></div>
      <div className="capture-picker-area-menus"><button type="button" onClick={event => showPopup("aspect", event.currentTarget)} aria-expanded={popup === "aspect"}><PanelsTopLeft size={16} /><span>{aspect === "free" || aspect === "original" ? text.select : aspectPresets.find(([w, h]) => w / h === Number(aspect))?.join(":") ?? text.select}</span><ChevronDown size={15} /></button><button type="button" onClick={event => showPopup("saved", event.currentTarget)} aria-expanded={popup === "saved"}><Scan size={16} /><span>{text.saved}</span><ChevronDown size={15} /></button></div>
      {validArea ? <div className="capture-picker-area-start">{startControl()}</div> : <div className="capture-picker-minimum" role="status">{text.minimum}</div>}
    </section>}
    {mode === "area" && !area && data && source && <div className="capture-picker-empty"><Scan size={36} /><p>{text.draw}</p><button type="button" className="capture-picker-secondary capture-picker-interactive" data-picker-popover-root="" onClick={event => showPopup("saved", event.currentTarget)}><Scan size={16} />{text.saved}<ChevronDown size={14} /></button></div>}
    {mode === "window" && data && <div className="capture-picker-window-actions capture-picker-interactive" data-picker-popover-root="">
      {!windowSource && <span>{windows.length ? text.windowHelp : text.noWindows}</span>}
      {windows.length > 0 && <button type="button" className="capture-picker-secondary" onClick={event => showPopup("windows", event.currentTarget)}><AppWindow size={14} />{text.chooseWindow}<ChevronDown size={13} /></button>}
      {windowSource && source && <button type="button" className="capture-picker-secondary" onClick={adjustWindowArea}>{text.adjust}</button>}
      {windowSource && <button type="button" className="capture-picker-secondary" onClick={event => showPopup("resize", event.currentTarget)}>{language === "ru" ? "Размер окна…" : "Resize window…"}</button>}
    </div>}
    {mode === "display" && !displaySelected && data && <div className="capture-picker-empty"><p>{text.source}</p><span>{text.escape}</span></div>}
    {!data && <div className="capture-picker-empty"><LoaderCircle size={24} className="spin" /><p>{error || text.loading}</p></div>}
    {data && mode !== "window" && !source && <div className="capture-picker-empty"><CircleHelp size={28} /><p>{text.missing}</p></div>}
    <button type="button" className="capture-picker-cancel capture-picker-interactive" aria-label={text.cancel} title={`${text.cancel} (Esc)`} disabled={busy} onClick={() => void complete(true)}><X size={16} /></button>
    {error && data && <div className="capture-picker-error capture-picker-interactive" role="alert"><span>{error}</span><button type="button" aria-label={text.clear} onClick={() => setError("")}><X size={13} /></button></div>}
    {popup && <Popover anchor={popupAnchor} className={popup === "export" ? "is-export" : ""}>
      {popup === "resize" && windowSource && <div className="capture-picker-export-settings"><strong>{language === "ru" ? "Размер окна" : "Resize window"}</strong><label>{text.width}<PixelField label={text.width} value={windowDimensions.width} min={150} max={16384} onCommit={width => setWindowDimensions(value => ({ ...value, width }))} /></label><label>{text.height}<PixelField label={text.height} value={windowDimensions.height} min={150} max={16384} onCommit={height => setWindowDimensions(value => ({ ...value, height }))} /></label><p>{language === "ru" ? "Изменяет выбранное окно приложения. Требуется разрешение Универсального доступа." : "Changes the selected application window. macOS Accessibility access is required."}</p><button className="capture-picker-settings-done" disabled={busy} onClick={() => { if (!api) return; setBusy(true); void api.resizeCaptureWindow(windowSource, windowDimensions.width, windowDimensions.height).then(actual => { setData(value => value ? { ...value, sources: value.sources.map(item => item.id === actual.id ? actual : item) } : value); setPopup(null); }).catch(fail).finally(() => setBusy(false)); }}>{busy ? text.loading : text.done}</button></div>}
      {popup === "after" && <div className="capture-picker-after-menu" role="menu" aria-label={text.after}><div className="capture-picker-menu-label">{text.after}</div>{(["project", "clipboard"] as const).map(value => <button type="button" key={value} role="menuitemradio" aria-checked={afterRecording === value} onClick={() => { setAfterRecording(value); setPopup(null); }}><span className="capture-picker-menu-check">{afterRecording === value && <Check size={15} />}</span>{text[value]}</button>)}<button type="button" disabled title={text.linkUnavailable} role="menuitem"><span className="capture-picker-menu-check" />{text.link}</button><button type="button" role="menuitemradio" aria-checked={afterRecording === "file"} onClick={() => { setAfterRecording("file"); setPopup(null); }}><span className="capture-picker-menu-check">{afterRecording === "file" && <Check size={15} />}</span>{text.file}</button><hr /><div className="capture-picker-auto-zoom" title={text.autoZoomHelp}><span>{text.autoZoom}</span><Toggle checked={autoZoom} onChange={setAutoZoom} label={text.autoZoom} /></div><hr /><button type="button" className="capture-picker-quick-export" role="menuitem" onClick={() => setPopup("export")}><Settings size={14} />{text.quickExport}</button></div>}
      {popup === "export" && <ExportSettings value={quickExportSettings} onChange={setQuickExportSettings} text={text} onBack={() => setPopup("after")} />}
      {popup === "aspect" && <div className="capture-picker-list" role="menu">{[{ key: "free", label: text.free }, { key: "original", label: text.original }, ...aspectPresets.map(([w, h]) => ({ key: String(w / h), label: `${w}:${h}` }))].map(preset => <button type="button" key={preset.key} role="menuitemradio" aria-checked={aspect === preset.key} onClick={() => { setAspect(preset.key); if (area && source && preset.key !== "free") setArea(fitCropAspect(area, preset.key === "original" ? source.width / source.height : Number(preset.key), source)); setPopup(null); }}><span className="capture-picker-menu-check">{aspect === preset.key && <Check size={14} />}</span>{preset.label}</button>)}</div>}
      {popup === "saved" && <div className="capture-picker-list" role="menu">{!data?.savedAreas.length && <div className="capture-picker-menu-label">{text.savedEmpty}</div>}{data?.savedAreas.map(saved => <button type="button" key={saved.id} role="menuitem" onClick={() => { if (source) { setMode("area"); setArea(constrainPixelCrop(saved.rect, source)); setAspect("free"); setPopup(null); } }}><Scan size={14} /><span className="capture-picker-saved-name">{saved.name}</span><small>{Math.round(saved.rect.width)}×{Math.round(saved.rect.height)}</small></button>)}{area && validArea && <><hr /><button type="button" role="menuitem" onClick={() => { setSaveName(`${text.savedDefault} ${Math.round(area.width)}×${Math.round(area.height)}`); setPopup("save"); }}><Save size={14} />{text.saveArea}</button></>}</div>}
      {popup === "save" && <form className="capture-picker-save-form" onSubmit={event => void saveArea(event)}><label htmlFor="capture-area-name">{text.name}</label><input id="capture-area-name" value={saveName} maxLength={80} autoFocus onFocus={event => event.currentTarget.select()} onChange={event => setSaveName(event.target.value)} required /><div><button type="button" className="capture-picker-secondary" onClick={() => setPopup("saved")}>{text.cancel}</button><button type="submit" className="capture-picker-save-submit" disabled={saving || !saveName.trim()}>{saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}{text.save}</button></div></form>}
      {popup === "windows" && <div className="capture-picker-list" role="menu">{windows.map(source => <button type="button" key={source.id} role="menuitemradio" aria-checked={selected === source.id} onClick={() => { setSelected(source.id); setHover(source.id); setPopup(null); }}><span className="capture-picker-menu-check">{selected === source.id ? <Check size={14} /> : <AppWindow size={14} />}</span><span className="capture-picker-saved-name">{source.appName ?? source.name}</span></button>)}</div>}
    </Popover>}
  </main>;
}
