import { t } from "./i18n";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Video, ZoomIn, Gauge, Mouse, CirclePause, Keyboard, Plus, X, EyeOff, Flag } from "lucide-react";
import FeatureTrack from "./FeatureTrack";
import EditorContextMenu from "./EditorContextMenu";
import { ScissorsIcon } from "./components";
import {
  clamp,
  formatTime,
  getDuration,
  getMediaTime,
  getOutputTime,
} from "./core/model";
import {
  getSlices,
  MIN_SLICE_DURATION,
  joinNextSlice,
  restoreSliceTrim,
  sourceRangeOutputSpans,
  timeToOutput,
  typingSuggestionSpans,
  applyTypingSuggestions,
  canApplyTypingSpeed,
  resolveTypingSuggestion,
  newZoomRange,
  removeSlice,
  SLICE_SPEEDS,
} from "./core/timeline";
import type { AudioWaveform, Project, Slice, TypingRange, Zoom } from "./types";
import { rasterizeTimelineWaveform, waveformPyramid } from "./core/timeline-waveform";
import { pinchTimeline, timelineAnchoredScroll, timelineMarkInterval, timelineMarks, visibleSliceWindow } from "./core/timeline-viewport";
import "./timeline.css";
import "./feature-track.css";

function TrackItemLabel({ kind, children, className }: { kind: string; children: React.ReactNode; className: string }) {
  const container = useRef<HTMLDivElement>(null), header = useRef<HTMLSpanElement>(null), main = useRef<HTMLSpanElement>(null);
  const [labels, setLabels] = useState<"none" | "kind" | "all">("none");
  useLayoutEffect(() => {
    const element = container.current!, title = header.current!, details = main.current!;
    const measure = () => {
      const available = element.clientWidth - 32;
      setLabels(available > Math.max(title.scrollWidth, details.scrollWidth) ? "all" : available > title.scrollWidth ? "kind" : "none");
    };
    measure();
    const observer = new ResizeObserver(measure);
    [element, title, details].forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, []);
  return <div ref={container} className={className} data-labels={labels}>
    <span ref={header} className="track-item-title">{kind}</span>
    <span ref={main} className="track-item-details">{children}</span>
  </div>;
}

function SliceWaveform({ waveforms, slice, systemVolume, microphoneVolume, window: visible }: {
  waveforms: (AudioWaveform & { pyramid: ReturnType<typeof waveformPyramid> })[];
  slice: Slice;
  systemVolume: number;
  microphoneVolume: number;
  window: NonNullable<ReturnType<typeof visibleSliceWindow>>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const draw = () => {
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(element.clientWidth * ratio));
      const height = Math.max(1, Math.round(element.clientHeight * ratio));
      element.width = width; element.height = height;
      const context = element.getContext("2d");
      if (!context) return;
      const pixels = context.createImageData(width, height);
      pixels.data.set(rasterizeTimelineWaveform(waveforms.map(waveform => ({
        ...waveform,
        volume: slice.volume * (waveform.kind === "microphone" ? microphoneVolume : systemVolume),
      })), visible.sourceStart, visible.sourceEnd, width, height, ratio));
      context.putImageData(pixels, 0, 0);
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(element, { box: "device-pixel-content-box" });
    return () => observer.disconnect();
  }, [waveforms, visible.sourceStart, visible.sourceEnd, visible.width, slice.volume, systemVolume, microphoneVolume]);
  return <canvas ref={canvas} className="audio-waveform" style={{ left: visible.left - 1, width: visible.width, right: "auto" }} aria-hidden="true" />;
}

function shortDuration(seconds: number, roundUp = false): string {
  if (seconds < 1) return t("{value}s", { value: seconds.toFixed(1) });
  const rounded = roundUp ? Math.ceil(seconds) : Math.round(seconds);
  if (rounded < 60) return t("{value}s", { value: rounded });
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

function GapMarker({
  gap,
  edge,
  onClick,
}: {
  gap: number;
  edge: "start" | "end";
  onClick: () => void;
}) {
  const trimmed = gap > 0.001;
  return (
    <button
      className={`slice-gap-marker ${edge} ${trimmed ? "trimmed" : "joined"}`}
      title={
        trimmed
          ? t("Undo trim · {time} removed", { time: shortDuration(gap) })
          : t("Join clips")
      }
      aria-label={
        trimmed
          ? t("Undo trim · {time} removed", { time: shortDuration(gap) })
          : t("Join clips")
      }
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {trimmed && <span>{shortDuration(gap)}</span>}
      <ScissorsIcon size={trimmed ? 8 : 9} />
    </button>
  );
}

function TypingSuggestionPopover({ project, range, allRanges, anchor, update, onClose }: {
  project: Project;
  range: TypingRange;
  allRanges: TypingRange[];
  anchor: HTMLElement;
  update: (value: Project | ((project: Project) => Project), group?: string) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null), slider = useRef<HTMLInputElement>(null);
  const title = useId(), description = useId();
  const [speed, setSpeed] = useState(() => {
    try { const saved = Number(localStorage.getItem("reva-typing-suggestion-speed")); if (Number.isFinite(saved) && saved >= 1.5 && saved <= 8) return saved; } catch { /* The popup remains usable without preference storage. */ }
    return 3;
  });
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const canApply = canApplyTypingSpeed(project, range), canApplyAll = allRanges.some(item => canApplyTypingSpeed(project, item));
  const changeSpeed = (value: number) => { setSpeed(value); try { localStorage.setItem("reva-typing-suggestion-speed", String(value)); } catch { /* Optional preference. */ } };
  const close = () => { onClose(); if (anchor.isConnected) anchor.focus(); };
  const apply = (all: boolean) => {
    if (all ? !canApplyAll : !canApply) return;
    update(current => applyTypingSuggestions(current, all ? allRanges : [range], speed));
    close();
  };
  useLayoutEffect(() => {
    const positionPanel = () => {
      const target = anchor.getBoundingClientRect(), popup = panel.current?.getBoundingClientRect();
      const width = popup?.width ?? 360, height = popup?.height ?? 200;
      setPosition({ left: Math.max(8, Math.min(window.innerWidth - width - 8, target.left + target.width / 2 - width / 2)), top: Math.max(8, target.top - height - 10) });
    };
    positionPanel(); slider.current?.focus();
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, true);
    return () => { window.removeEventListener("resize", positionPanel); window.removeEventListener("scroll", positionPanel, true); };
  }, [anchor]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !panel.current?.contains(event.target) && !anchor.contains(event.target)) onClose(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      else if (event.key === "Enter" && !(event.target instanceof Element && event.target.closest("button"))) { event.preventDefault(); event.stopPropagation(); apply(event.metaKey); }
    };
    document.addEventListener("pointerdown", outside, true); window.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", outside, true); window.removeEventListener("keydown", key, true); };
  });
  return createPortal(<div ref={panel} className="typing-suggestion-popover" style={position} role="dialog" aria-labelledby={title} aria-describedby={description} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <button className="typing-popover-close" aria-label={t("Close")} onClick={close}><X size={15} /></button>
    <div className="typing-popover-title" id={title}><Keyboard size={18} />{t("Speed up typing")}</div>
    <p id={description}>{t("You are typing during this part of the recording. Speed it up using options below.")}</p>
    <div className="typing-speed-row"><input ref={slider} type="range" min={1.5} max={8} step={0.1} value={speed} aria-label={t("Typing playback speed")} aria-valuetext={`${speed.toFixed(1)}×`} onChange={event => changeSpeed(Number(event.target.value))} /><output>{speed.toFixed(1)}×</output><button onClick={() => changeSpeed(3)}>{t("Reset")}</button></div>
    {!canApply && <p className="typing-suggestion-unavailable">{t("This section is too close to a clip edge to split.")}</p>}
    <div className="typing-action-row"><button disabled={!canApplyAll} onClick={() => apply(true)}>{t("Apply all suggestions")}</button><button className="primary" disabled={!canApply} onClick={() => apply(false)}>{t("Apply suggestion")}</button></div>
    <button className="typing-remove" onClick={() => { update(current => resolveTypingSuggestion(current, range.start)); close(); }}>{t("Remove suggestion")}</button>
  </div>, document.body);
}

export default function Timeline({
  project,
  time,
  seek,
  update,
  selectedZoom,
  onSelectZoom,
  onAddZoom,
  selectedSlice,
  onSelectSlice,
  cutMode,
  onSplit,
  onSplitZoom,
  waveforms,
  scale,
  onScaleChange,
  playing = false,
  onHoverTime,
  onSelectMask,
  selectedMask = null,
  selectedScene = null,
  onSelectScene,
  onAddFeature,
  onShowPanel,
  onVolumeAudition,
}: {
  project: Project;
  time: number;
  seek: (t: number) => void;
  update: (p: Project | ((p: Project) => Project), group?: string) => void;
  selectedZoom: string | null;
  onSelectZoom: (id: string) => void;
  onAddZoom: (t: number) => void;
  selectedSlice: string | null;
  onSelectSlice: (id: string) => void;
  cutMode: boolean;
  onSplit: (id: string, sourceTime: number) => void;
  onSplitZoom: (id: string, sourceTime: number) => void;
  waveforms: AudioWaveform[];
  scale: number;
  onScaleChange: (scale: number) => void;
  playing?: boolean;
  onHoverTime?: (sourceTime: number | null) => void;
  onSelectMask?: (id: string) => void;
  selectedMask?: string | null;
  selectedScene?: string | null;
  onSelectScene?: (id: string) => void;
  onAddFeature?: (kind: "layouts" | "masks", start: number, end: number) => void;
  onShowPanel?: (panel: "camera" | "masks" | "shortcuts") => void;
  onVolumeAudition?: (project: Project, time: number) => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const currentScale = useRef(scale);
  const committedScale = useRef(scale);
  const pendingScrollLeft = useRef<number | null>(null);
  currentScale.current = scale;
  const moved = useRef(false);
  const zoomWasCut = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [context, setContext] = useState<{ id: string; x: number; y: number; sourceTime: number } | null>(null);
  const closeContext = useCallback(() => setContext(null), []);
  const [hoverPosition, setHoverPosition] = useState<number | null>(null);
  const [hoveringZoomTrack, setHoveringZoomTrack] = useState(false);
  const [resizingItem, setResizingItem] = useState<string | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 1400, scrollLeft: 0 });
  const committedViewport = useRef(viewportSize);
  const contentWidth = viewportSize.width * scale;
  const [typingPopover, setTypingPopover] = useState<{ start: number; anchor: HTMLElement } | null>(null);
  const typingMarkers = useMemo(() => typingSuggestionSpans(project), [project]);
  const typingRanges = useMemo(() => typingMarkers.map(marker => marker.range), [typingMarkers]);
  const activeTypingRange = typingPopover && typingRanges.find(range => range.start === typingPopover.start);
  useEffect(() => setTypingPopover(null), [project.mediaPath]);
  const sourceGridGradient = useId();
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      committedViewport.current = { width: element.clientWidth, scrollLeft: element.scrollLeft };
      setViewportSize(committedViewport.current);
    };
    const scrolled = () => {
      committedViewport.current = { width: element.clientWidth, scrollLeft: element.scrollLeft };
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.addEventListener("scroll", scrolled, { passive: true });
    measure();
    return () => { observer.disconnect(); element.removeEventListener("scroll", scrolled); cancelAnimationFrame(frame); };
  }, []);
  const waveformLayers = useMemo(
    () =>
      waveforms.map((waveform) => ({
        ...waveform,
        pyramid: waveformPyramid(waveform.peaks),
      })),
    [waveforms],
  );
  const outputDuration = getDuration(project);
  const featureRows = (project.cameraScenes?.length ? 1 : 0) + (project.masks?.length ? 1 : 0) + (project.shortcuts?.length ? 1 : 0);
  // Reserve one expanded row independently of pointer state. Hover may rearrange
  // the tracks within this space, never resize the workspace and video above.
  const featureHeight = featureRows * 32 + (project.cameraScenes?.length || project.masks?.length ? 32 : 0) + (project.captions.length ? 24 : 0);
  const duration = outputDuration || 15;
  const pixelsPerSecond = contentWidth / duration;
  const viewStart = Math.max(0, (viewportSize.scrollLeft - 2) / pixelsPerSecond);
  const viewEnd = (viewportSize.scrollLeft + viewportSize.width + 2) / pixelsPerSecond;
  const slices = getSlices(project);
  let accumulated = 0;
  const spans = slices.map((slice, index) => {
    const start = accumulated;
    accumulated += (slice.end - slice.start) / slice.speed;
    return { slice, index, start, end: accumulated };
  });
  const firstSource = slices[0]?.start ?? 0;
  const lastSource = slices.at(-1)?.end ?? project.duration;
  const percent = (value: number) => `${(value / duration) * 100}%`;
  // Visual separation is one CSS pixel; source ranges and cut positions stay exact.
  const itemStyle = (start: number, end: number) => ({ left: `calc(${percent(start)} + 1px)`, width: `max(0px, calc(${percent(end - start)} - 1px))` });
  const toOutputTime = (clientX: number) => {
    const r = content.current!.getBoundingClientRect();
    return ((clientX - r.left) / r.width) * duration;
  };
  const seekOutput = (output: number) => seek(getMediaTime(project, output));
  const clearHover = useCallback(() => { setHoverPosition(null); onHoverTime?.(null); }, [onHoverTime]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const oldScale = committedScale.current;
    // Shrinking the content can clamp DOM scrollLeft before this layout effect.
    // The old scale must use the last committed viewport, not that clamped value.
    const previousScroll = committedViewport.current.scrollLeft;
    const playheadX = getOutputTime(project, time) / duration * element.clientWidth * oldScale - previousScroll;
    const anchor = playheadX >= 0 && playheadX <= element.clientWidth ? playheadX : element.clientWidth / 2;
    element.scrollLeft = pendingScrollLeft.current ?? timelineAnchoredScroll(oldScale, scale, previousScroll, element.clientWidth, anchor);
    pendingScrollLeft.current = null;
    committedScale.current = scale;
    committedViewport.current = { width: element.clientWidth, scrollLeft: element.scrollLeft };
    setViewportSize(committedViewport.current);
    clearHover();
  }, [scale]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const pinch = (event: WheelEvent) => {
      if (!event.ctrlKey || !project.mediaPath) return;
      event.preventDefault();
      clearHover();
      const next = pinchTimeline({
        scale: currentScale.current,
        scrollLeft: pendingScrollLeft.current ?? element.scrollLeft,
        width: element.clientWidth,
        anchor: event.clientX - element.getBoundingClientRect().left,
        duration,
      }, event.deltaY, event.deltaMode, element.clientHeight);
      if (next.scale === currentScale.current) return;
      pendingScrollLeft.current = next.scrollLeft;
      currentScale.current = next.scale;
      onScaleChange(next.scale);
    };
    element.addEventListener("wheel", pinch, { passive: false });
    return () => element.removeEventListener("wheel", pinch);
  }, [project.mediaPath, clearHover, onScaleChange, duration]);
  useEffect(() => {
    if (playing) onHoverTime?.(null);
  }, [playing, onHoverTime]);
  useEffect(clearHover, [project.mediaPath, clearHover]);
  useEffect(() => {
    window.addEventListener("blur", clearHover);
    return () => window.removeEventListener("blur", clearHover);
  }, [clearHover]);
  const eventSpan = (start: number, end: number) => {
    const visible = sourceRangeOutputSpans(project, start, end);
    return visible.length
      ? { start: visible[0].start, end: visible.at(-1)!.end }
      : null;
  };
  const drag = (e: React.PointerEvent, move: (output: number) => void) => {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    const originX = e.clientX;
    moved.current = false;
    clearHover();
    target.setPointerCapture(e.pointerId);
    setDragging(true);
    const onMove = (event: PointerEvent) => {
      if (Math.abs(event.clientX - originX) > 2) moved.current = true;
      move(toOutputTime(event.clientX));
    };
    const onUp = (event: PointerEvent) => {
      if (target.hasPointerCapture(event.pointerId))
        target.releasePointerCapture(event.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      setDragging(false);
      setResizingItem(null);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  };
  const trimSlice = (
    e: React.PointerEvent,
    slice: Slice,
    edge: "start" | "end",
  ) => {
    onSelectSlice(slice.id);
    setResizingItem(slice.id);
    const origin = toOutputTime(e.clientX);
    const initial = slice[edge];
    drag(e, (output) =>
      update((p) => {
        const current = getSlices(p);
        const index = current.findIndex((item) => item.id === slice.id);
        if (index < 0) return p;
        const item = current[index];
        const source = initial + (output - origin) * slice.speed;
        current[index] =
          edge === "start"
            ? {
                ...item,
                start: clamp(
                  source,
                  current[index - 1]?.end ?? 0,
                  item.end - MIN_SLICE_DURATION,
                ),
              }
            : {
                ...item,
                end: clamp(
                  source,
                  item.start + MIN_SLICE_DURATION,
                  current[index + 1]?.start ?? p.duration,
                ),
              };
        return { ...p, slices: current };
      }, `slice-${edge}`),
    );
  };
  const zoomDrag = (
    e: React.PointerEvent,
    zoom: Zoom,
    edge?: "start" | "end",
  ) => {
    const origin = toOutputTime(e.clientX);
    const base = eventSpan(zoom.start, zoom.end);
    if (!base) return;
    onSelectZoom(zoom.id);
    if (edge) setResizingItem(zoom.id);
    drag(e, (output) =>
      update(
        (p) => ({
          ...p,
          zooms: p.zooms.map((item) => {
            if (item.id !== zoom.id) return item;
            const source = getMediaTime(project, output);
            if (edge === "start")
              return {
                ...item,
                start: clamp(source, firstSource, item.end - 0.05),
              };
            if (edge === "end")
              return {
                ...item,
                end: clamp(source, item.start + 0.05, lastSource),
              };
            const length = base.end - base.start;
            const start = clamp(
              base.start + output - origin,
              0,
              Math.max(0, outputDuration - length),
            );
            return {
              ...item,
              start: getMediaTime(project, start),
              end: getMediaTime(project, start + length),
            };
          }),
        }),
        "zoom-drag",
      ),
    );
  };
  const ticks = timelineMarkInterval(pixelsPerSecond);
  const marks = timelineMarks(viewStart - ticks, viewEnd + ticks, ticks, duration);
  const hoverHeadOffset = hoverPosition === null ? 0 : 9 * (1 + Math.cos(Math.PI * Math.min(1, Math.abs(hoverPosition - getOutputTime(project, time)) / (duration / scale / 75))));
  const newRange = project.mediaPath && hoveringZoomTrack && hoverPosition !== null && !cutMode && !dragging
    ? newZoomRange(project, getMediaTime(project, hoverPosition)) : null;
  const addPreview = newRange && eventSpan(newRange.start, newRange.end);
  return (
    <section
      className={`timeline ${dragging ? "dragging" : ""} ${cutMode ? "cut-mode" : ""}`}
      aria-label={t("Video timeline")}
      style={{ height: 194 + featureHeight }}
      onContextMenu={event => { if (cutMode || event.ctrlKey || event.altKey) event.preventDefault(); }}
    >
      <div className="timeline-scroll" ref={viewport} style={{ height: 188 + featureHeight }}>
        <div
          className="timeline-content"
          ref={content}
          style={{ width: `${scale * 100}%`, height: 142 + featureHeight }}
          onPointerMove={(event) => {
            if (!project.mediaPath || dragging || event.buttons) return;
            const output = clamp(toOutputTime(event.clientX), 0, outputDuration);
            setHoverPosition(output);
            if (!playing) onHoverTime?.(getMediaTime(project, output));
          }}
          onPointerLeave={clearHover}
        >
          <div
            className="time-ruler"
            onPointerDown={(e) => {
              if (project.mediaPath) {
                seekOutput(toOutputTime(e.clientX));
                drag(e, seekOutput);
              }
            }}
          >
            {marks.map(mark => (
                <div
                  className="tick"
                  key={mark}
                  style={{ left: percent(mark) }}
                >
                  <span>
                    {Number.isInteger(mark)
                      ? formatTime(mark)
                      : "\u00a0"}
                  </span>
                  <i />
                </div>
              ))}
          </div>
          <div
            className={`video-track sliced-track ${!project.mediaPath ? "empty" : ""}`}
          >
            {project.mediaPath && (project.pauseMarkers ?? []).map((marker, index) => {
              const output = timeToOutput(project, marker.time);
              return output === null ? null : <span key={`${marker.time}-${index}`} className="recording-pause-marker" style={{ left: percent(output) }} role="img" aria-label={t("Recording paused")} title={marker.duration === undefined ? t("Recording paused") : t("Recording pause · {duration}", { duration: shortDuration(marker.duration) })}><CirclePause size={14} strokeWidth={2} /></span>;
            })}
            {project.mediaPath && typingMarkers.map(({ range, start, end }) => {
              return <button key={range.start} className={`typing-range-marker ${typingPopover?.start === range.start ? "open" : ""}`} style={{ left: percent(start), width: percent(end - start) }} title={t("Speed up typing")} aria-label={t("Typing from {start} to {end}", { start: formatTime(range.start, true), end: formatTime(range.end, true) })} aria-haspopup="dialog" aria-expanded={typingPopover?.start === range.start} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); const anchor = event.currentTarget; setTypingPopover(current => current?.start === range.start ? null : { start: range.start, anchor }); }}><Keyboard size={14} /></button>;
            })}
            {project.recordingFlags?.map(flag => { const output = timeToOutput(project, flag.time); return output === null ? null : <button key={flag.id} className="flag-marker" style={{ left: percent(output) }} title={flag.label ?? t("Recording flag")} aria-label={flag.label ?? t("Recording flag")} onPointerDown={event => event.stopPropagation()} onClick={() => seek(flag.time)}><Flag size={13} fill="currentColor" /></button>; })}
            {project.mediaPath && slices.length ? (
              spans.map(({ slice, index, start, end }) => {
                const next = slices[index + 1];
                const endGap = (next?.start ?? project.duration) - slice.end;
                const visible = visibleSliceWindow(slice, start, viewStart, viewEnd, pixelsPerSecond);
                return (
                  <div
                    key={slice.id}
                    className={`slice-clip ${selectedSlice === slice.id ? "selected" : ""} ${selectedSlice && selectedSlice !== slice.id ? "dimmed" : ""} ${resizingItem === slice.id ? "resizing" : ""} ${(end - start) / duration * contentWidth < 48 ? "narrow" : ""}`}
                    style={itemStyle(start, end)}
                    onContextMenu={event => { if (cutMode || event.ctrlKey || event.altKey) return; event.preventDefault(); event.stopPropagation(); onSelectSlice(slice.id); setContext({ id: slice.id, x: event.clientX, y: event.clientY, sourceTime: clamp(slice.start + (toOutputTime(event.clientX) - start) * slice.speed, slice.start, slice.end) }); }}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selectedSlice === slice.id}
                    aria-label={t(
                      "Slice {index}, {start} to {end}, {speed} times speed",
                      {
                        index: index + 1,
                        start: formatTime(slice.start, true),
                        end: formatTime(slice.end, true),
                        speed: slice.speed,
                      },
                    )}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && e.target === e.currentTarget) {
                        e.preventDefault();
                        e.stopPropagation();
                        onSelectSlice(slice.id);
                        seek(slice.start);
                      }
                    }}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      const output = clamp(toOutputTime(e.clientX), start, end);
                      const source = clamp(
                        slice.start + (output - start) * slice.speed,
                        slice.start,
                        slice.end,
                      );
                      onSelectSlice(slice.id);
                      if (cutMode || e.altKey || e.ctrlKey) {
                        e.preventDefault();
                        e.stopPropagation();
                        onSplit(slice.id, source);
                      } else {
                        seek(source);
                        drag(e, seekOutput);
                      }
                    }}
                  >
                    <div className="clip-content">
                      {visible && <SliceWaveform waveforms={waveformLayers} slice={slice} window={visible} systemVolume={project.appearance.volume} microphoneVolume={project.appearance.microphoneVolume} />}
                      {visible && ((end - start) / duration) * contentWidth > 50 && (
                        <svg
                          className="clip-source-grid"
                          aria-hidden="true"
                          style={{ left: visible.left - 1, width: visible.width, right: "auto" }}
                          viewBox={`0 0 ${visible.sourceEnd - visible.sourceStart} 48`}
                          preserveAspectRatio="none"
                        >
                          <defs>
                            <linearGradient
                              id={`${sourceGridGradient}-grid-${index}`}
                              gradientUnits="userSpaceOnUse"
                              x1="0"
                              y1="0"
                              x2="0"
                              y2="40"
                            >
                              <stop stopColor="#fff" stopOpacity="0.267" />
                              <stop
                                offset="1"
                                stopColor="#fff"
                                stopOpacity="0"
                              />
                            </linearGradient>
                          </defs>
                          {Array.from(
                            {
                              length: Math.max(
                                0,
                                Math.ceil(visible.sourceEnd / ticks) -
                                  Math.ceil(visible.sourceStart / ticks),
                              ),
                            },
                            (_, i) => {
                              const x =
                                (Math.ceil(visible.sourceStart / ticks) + i) * ticks -
                                visible.sourceStart;
                              return (
                                <line
                                  key={i}
                                  x1={x}
                                  x2={x}
                                  y1="0"
                                  y2="40"
                                  stroke={`url(#${sourceGridGradient}-grid-${index})`}
                                  strokeWidth="1"
                                  vectorEffect="non-scaling-stroke"
                                />
                              );
                            },
                          )}
                        </svg>
                      )}
                      <TrackItemLabel className="clip-label" kind={t("Clip")}>
                          <span>
                            {shortDuration(slice.end - slice.start, true)}
                          </span>
                          <span>
                            <Gauge size={12} />
                            {slice.speed}×
                          </span>
                      </TrackItemLabel>
                    </div>
                        <button
                          aria-label={t("Trim slice {index} start", {
                            index: index + 1,
                          })}
                          className="trim-handle start"
                          onPointerDown={(e) => trimSlice(e, slice, "start")}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        />
                        <button
                          aria-label={t("Trim slice {index} end", {
                            index: index + 1,
                          })}
                          className="trim-handle end"
                          onPointerDown={(e) => trimSlice(e, slice, "end")}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        />
                    {slice.cursorHidden && <EyeOff className="slice-cursor-hidden" size={12} aria-label={t("Cursor hidden")} />}
                    {index === 0 && slice.start > 0.001 && (
                      <GapMarker
                        gap={slice.start}
                        edge="start"
                        onClick={() => {
                          update((p) => ({
                            ...p,
                            slices: restoreSliceTrim(p, slice.id, "start"),
                          }));
                          onSelectSlice(slice.id);
                        }}
                      />
                    )}
                    {(next || endGap > 0.001) && (
                      <GapMarker
                        gap={endGap}
                        edge="end"
                        onClick={() => {
                          update((p) => ({
                            ...p,
                            slices:
                              endGap > 0.001
                                ? restoreSliceTrim(p, slice.id, "end")
                                : joinNextSlice(p, slice.id),
                          }));
                          onSelectSlice(slice.id);
                        }}
                      />
                    )}
                  </div>
                );
              })
            ) : (
              <span className="track-placeholder">
                <Video size={16} />{" "}
                {t("Record or import a video to start editing")}
              </span>
            )}
          </div>
          <div
            className="zoom-track"
            onPointerMove={event => setHoveringZoomTrack(event.target === event.currentTarget)}
            onPointerLeave={() => setHoveringZoomTrack(false)}
            onClick={(e) => {
              if (!cutMode && !e.altKey && !e.ctrlKey && e.target === e.currentTarget && project.mediaPath)
                onAddZoom(getMediaTime(project, toOutputTime(e.clientX)));
            }}
          >
            {!project.zooms.length && !addPreview && (
              <span className="track-placeholder">
                <ZoomIn size={15} />
                {t("Click to add zoom on cursor")}
              </span>
            )}
            {addPreview && <div className="zoom-block zoom-add-preview" style={{ left: percent(addPreview.start), width: percent(addPreview.end - addPreview.start) }} aria-hidden="true">
              {(addPreview.end - addPreview.start) * pixelsPerSecond > 20 && <Plus size={16} />}
            </div>}
            {project.zooms.map((zoom) => {
              const span = eventSpan(zoom.start, zoom.end);
              if (!span) return null;
              return (
                <div
                  key={zoom.id}
                  className={`zoom-block ${selectedZoom === zoom.id ? "selected" : ""} ${selectedZoom && selectedZoom !== zoom.id ? "dimmed" : ""} ${resizingItem === zoom.id ? "resizing" : ""} ${(span.end - span.start) / duration * contentWidth < 48 ? "narrow" : ""}`}
                  style={itemStyle(span.start, span.end)}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (zoomWasCut.current || cutMode || e.altKey || e.ctrlKey) {
                      zoomWasCut.current = false;
                      return;
                    }
                    onSelectZoom(zoom.id);
                    if (!moved.current || e.detail === 0)
                      seekOutput(span.start);
                  }}
                  onPointerDown={(e) => {
                    zoomWasCut.current = cutMode || e.altKey || e.ctrlKey;
                    if (zoomWasCut.current) {
                      e.preventDefault();
                      e.stopPropagation();
                      onSelectZoom(zoom.id);
                      onSplitZoom(zoom.id, getMediaTime(project, clamp(toOutputTime(e.clientX), span.start, span.end)));
                    } else {
                      zoomDrag(e, zoom);
                    }
                  }}
                >
                  <button
                    title={t("Zoom start")}
                    className="zoom-handle start"
                    onPointerDown={(e) => zoomDrag(e, zoom, "start")}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                  <TrackItemLabel className="zoom-label" kind={t("Zoom")}>
                      <span>
                        <ZoomIn size={12} />
                        {zoom.scale.toFixed(1)}×
                      </span>
                      <span>
                        <Mouse size={12} />
                        {t(zoom.mode === "manual" ? "Manual" : "Auto")}
                      </span>
                  </TrackItemLabel>
                  <button
                    title={t("Zoom end")}
                    className="zoom-handle end"
                    onPointerDown={(e) => zoomDrag(e, zoom, "end")}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                </div>
              );
            })}
          </div>
          <FeatureTrack project={project} kind="layouts" onAdd={(start, end) => onAddFeature?.("layouts", start, end)} selectedId={selectedScene} select={id => onSelectScene?.(id)} seek={seek} update={update} />
          <FeatureTrack project={project} kind="masks" onAdd={(start, end) => onAddFeature?.("masks", start, end)} selectedId={selectedMask} select={id => onSelectMask?.(id)} seek={seek} update={update} />
          {!!project.shortcuts?.length && <div className="feature-track shortcuts" aria-label={t("Shortcuts timeline")}><span className="feature-track-name">{t("Shortcuts")}</span>{project.shortcuts.filter(event => !event.hidden).map(event => sourceRangeOutputSpans(project, event.time, Math.min(project.duration, event.time + (event.duration ?? project.shortcutSettings?.duration ?? 1.5))).map((span, index) => <button key={`${event.id}-${index}`} style={itemStyle(span.start, span.end)} onClick={() => { seek(event.time); onShowPanel?.("shortcuts"); }}>{event.keys.join(" ")}</button>))}</div>}
          {project.captions.length > 0 && (
            <div className="caption-track">
              {project.captions.map((caption) => {
                const span = eventSpan(caption.start, caption.end);
                if (!span) return null;
                return (
                  <button
                    key={caption.id}
                    style={{
                      left: percent(span.start),
                      width: percent(span.end - span.start),
                    }}
                    onClick={() => seekOutput(span.start)}
                  >
                    {caption.text}
                  </button>
                );
              })}
            </div>
          )}
          {project.mediaPath && (
            <div
              className="playhead"
              style={{ left: percent(getOutputTime(project, time)) }}
              onPointerDown={(e) => drag(e, seekOutput)}
            >
              <span />
              <i />
            </div>
          )}
          {project.mediaPath && hoverPosition !== null && (
            <>
              {!playing && <div className="playhead hover-playhead" style={{ left: percent(hoverPosition), transform: `translateY(${hoverHeadOffset}px)` }} aria-hidden="true"><span /></div>}
              {cutMode && <span className="cut-position" style={{ left: percent(hoverPosition) }} aria-hidden="true" />}
            </>
          )}
        </div>
      </div>
      {typingPopover && activeTypingRange && <TypingSuggestionPopover key={typingPopover.start} project={project} range={activeTypingRange} allRanges={typingRanges} anchor={typingPopover.anchor} update={update} onClose={() => setTypingPopover(null)} />}
      {context && (() => {
        const slice = getSlices(project).find(item => item.id === context.id); if (!slice) return null;
        const change = (patch: Partial<Slice>, audition = false) => { const next = { ...project, slices: getSlices(project).map(item => item.id === slice.id ? { ...item, ...patch } : item) }; update(next, `slice-${slice.id}`); if (audition) onVolumeAudition?.(next, context.sourceTime); };
        return <EditorContextMenu x={context.x} y={context.y} close={closeContext}><button onClick={() => { onSplit(slice.id, context.sourceTime); closeContext(); }}>{t("Cut here")}</button><button disabled={slices.length <= 1} onClick={() => { update(p => ({ ...p, slices: removeSlice(p, slice.id) })); closeContext(); }}>{t("Remove fragment")}</button><hr /><label className="context-field">{t("Speed")}<select aria-label={t("Fragment speed")} value={slice.speed} onChange={event => change({ speed: Number(event.target.value) })}>{SLICE_SPEEDS.map(value => <option value={value} key={value}>{value}×</option>)}</select></label><label className="context-field">{t("Volume")}<input type="range" aria-label={t("Fragment volume")} min={0} max={1} step={.01} value={slice.volume} onChange={event => change({ volume: Number(event.target.value) }, true)} /></label><hr /><button onClick={() => change({ cursorHidden: !slice.cursorHidden })}>{slice.cursorHidden ? "✓ " : ""}{t("Hide cursor")}</button><button onClick={() => change({ cursorSmooth: !(slice.cursorSmooth ?? project.appearance.cursorSmooth) })}>{(slice.cursorSmooth ?? project.appearance.cursorSmooth) ? "✓ " : ""}{t("Smooth cursor")}</button><button onClick={() => { onSelectSlice(slice.id); closeContext(); }}>{t("Fragment settings")}</button></EditorContextMenu>;
      })()}
      <footer className="timeline-footer">
        <span>
          <i className="status-dot" />
          {cutMode
            ? t("Click a clip to split")
            : project.mediaPath
              ? t("{count} slices · All edits are non-destructive", {
                  count: slices.length,
                })
              : t("Ready when you are")}
        </span>
        <span>
          {project.mediaPath
            ? `${project.width} × ${project.height} · ${formatTime(outputDuration, true)}`
            : t("REVA Studio for macOS")}
        </span>
      </footer>
    </section>
  );
}
