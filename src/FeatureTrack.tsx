import { useLayoutEffect, useRef, useState } from "react";
import { Monitor, Square, Sun, Plus } from "lucide-react";
import { t } from "./i18n";
import type { Project } from "./types";
import { duration, sourceRangeOutputSpans, timeToOutput } from "./core/timeline";
import { editFeatureRange, featureInsertionRange, type FeatureKind, type FeatureRange } from "./core/feature-ranges";

const labels = { "camera-overlay": "Camera overlay", "split-screen": "Split screen", "cutout-camera": "Camera cutout", "fullscreen-camera": "Fullscreen camera", "screen-only": "Only screen" };
function Label({ kind, children }: { kind: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState("none");
  useLayoutEffect(() => {
    const box = ref.current!;
    const measure = () => { const width = box.clientWidth - 30; setFits(width >= box.children[1].scrollWidth ? "all" : width >= box.children[0].scrollWidth ? "kind" : "none"); };
    const observer = new ResizeObserver(measure); observer.observe(box); measure();
    return () => observer.disconnect();
  }, [kind, children]);
  return <div ref={ref} className="feature-label" data-labels={fits}><span>{kind}</span><span>{children}</span></div>;
}
export default function FeatureTrack({ project, kind, selectedId, select, seek, update, onAdd }:  {
  project: Project; kind: FeatureKind; selectedId: string | null; select: (id: string) => void; seek: (time: number) => void;
  onAdd?: (start: number, end: number) => void;
  update: (value: Project | ((p: Project) => Project), group?: string) => void;
}) {
  const row = useRef<HTMLDivElement>(null), moved = useRef(false);
  const [hover, setHover] = useState<{ output: number; empty: boolean } | null>(null);
  const candidate = hover?.empty ? featureInsertionRange(project, kind, hover.output) : null;
  const items = kind === "layouts" ? project.cameraScenes ?? [] : project.masks ?? [];
  if (!items.length) return null;
  const drag = (event: React.PointerEvent, item: FeatureRange, edge?: "start" | "end") => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); select(item.id);
    const target = event.currentTarget as HTMLElement, x = event.clientX, width = row.current!.getBoundingClientRect().width;
    const originalProject = project, total = duration(project), gesture = `gesture:feature:${crypto.randomUUID()}`;
    moved.current = false; target.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      if (Math.abs(next.clientX - x) < 2 && !moved.current) return;
      moved.current = true;
      update(current => current.mediaPath !== originalProject.mediaPath ? current : editFeatureRange(current, kind, item, (next.clientX - x) / width * total, edge), gesture);
    };
    const end = (next: PointerEvent) => {
      if (target.hasPointerCapture(next.pointerId)) target.releasePointerCapture(next.pointerId);
      target.removeEventListener("pointermove", move); target.removeEventListener("pointerup", end); target.removeEventListener("pointercancel", end); target.removeEventListener("lostpointercapture", end);
    };
    target.addEventListener("pointermove", move); target.addEventListener("pointerup", end); target.addEventListener("pointercancel", end); target.addEventListener("lostpointercapture", end);
  };
  return <div ref={row} className={`feature-track ${kind} ${hover ? "expanded" : ""}`} aria-label={t(kind === "layouts" ? "Camera layouts timeline" : "Masks timeline")}
    onPointerMove={event => { const box = event.currentTarget.getBoundingClientRect(); const empty = event.target === event.currentTarget || !!(event.target as HTMLElement).closest(".feature-add-preview"); setHover({ output: (event.clientX - box.left) / box.width * duration(project), empty }); }}
    onPointerLeave={() => { setHover(null); }}
    onClick={event => { if (!candidate || !hover?.empty) return; event.stopPropagation(); onAdd?.(candidate.start, candidate.end); }}>
    {candidate && <div className="feature-block feature-add-preview" aria-hidden="true" style={{ left: `${timeToOutput(project, candidate.start)! / duration(project) * 100}%`, width: `${sourceRangeOutputSpans(project, candidate.start, candidate.end).reduce((total, span) => total + span.end - span.start, 0) / duration(project) * 100}%` }}><Plus size={17} /></div>}
    <span className="feature-track-name">{t(kind === "layouts" ? "Layouts" : "Masks")}</span>
    {items.map(item => sourceRangeOutputSpans(project, item.start, item.end).map((span, index) => {
      const selected = item.id === selectedId;
      const scene = kind === "layouts" ? project.cameraScenes!.find(scene => scene.id === item.id)! : null;
      const mask = kind === "masks" ? project.masks!.find(mask => mask.id === item.id)! : null;
      const label = scene ? t(labels[scene.layout.type]) : mask!.type === "highlight" ? `${t("Highlight")} ${Math.round(mask!.opacity * 100)}%` : t("Sensitive Data");
      return <div key={`${item.id}-${index}`} role="button" tabIndex={0} aria-label={`${t(kind === "layouts" ? "Layout" : "Mask")}: ${label}`} aria-pressed={selected}
        className={`feature-block ${selected ? "selected" : ""} ${item.disabled ? "disabled" : ""}`}
        style={{ left: `${span.start / duration(project) * 100}%`, width: `${(span.end - span.start) / duration(project) * 100}%` }}
        onPointerDown={event => drag(event, item)} onClick={event => { event.stopPropagation(); select(item.id); if (!moved.current || event.detail === 0) seek(item.start); }}
        onKeyDown={event => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(item.id); seek(item.start); }
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); update(p => editFeatureRange(p, kind, item, (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 1 : .1))); }
        }}>
        <Label kind={t(kind === "layouts" ? "Layout" : "Mask")}>{scene ? <Monitor size={13} /> : mask!.type === "highlight" ? <Sun size={13} /> : <Square size={12} fill="currentColor" />}{label}</Label>
        {(["start", "end"] as const).map(edge => <button key={edge} className={`feature-handle ${edge}`} aria-label={t(edge === "start" ? "Range start" : "Range end")} onPointerDown={event => drag(event, item, edge)} onClick={event => event.stopPropagation()}
          onKeyDown={event => { event.stopPropagation(); if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); update(p => editFeatureRange(p, kind, item, (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 1 : .1), edge)); } }} />)}
      </div>;
    }))}
  </div>;
}
