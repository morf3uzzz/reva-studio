import { useRef, useState } from "react";
import { Mouse, UserRound, X } from "lucide-react";
import { t } from "./i18n";
import "./insertion-overlay.css";
export type InsertTool = "zoom" | "loupe" | "camera-overlay" | "cutout-camera" | "sensitive-data" | "highlight";
export default function InsertionOverlay({ tool, place, cancel, automatic }: { tool: InsertTool; place: (point: { x: number; y: number }, bounds?: { x: number; y: number; width: number; height: number }) => void; cancel: () => void; automatic: () => void }) {
  const [point, setPoint] = useState({ x: .5, y: .5 });
  const [drawing, setDrawing] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const anchor = useRef<{ x: number; y: number } | null>(null), suppressClick = useRef(false);
  const position = (event: React.PointerEvent | React.MouseEvent) => { const box = event.currentTarget.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)) }; };
  const rectangle = (start: { x: number; y: number }, end: { x: number; y: number }) => ({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) });
  const zoom = tool === "zoom" || tool === "loupe", camera = tool === "camera-overlay" || tool === "cutout-camera";
  return <div className={`insertion-overlay insertion-${tool}`}
    onPointerDown={event => { if (zoom || camera || event.button !== 0 || (event.target as Element).closest("button")) return; event.preventDefault(); anchor.current = position(event); suppressClick.current = false; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => { const point = position(event); setPoint(point); if (anchor.current) setDrawing(rectangle(anchor.current, point)); }}
    onPointerUp={event => { const start = anchor.current; if (!start) return; anchor.current = null; const rect = rectangle(start, position(event)); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setDrawing(null); if (rect.width > .005 && rect.height > .005) { suppressClick.current = true; place({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, rect); } }}
    onPointerCancel={() => { anchor.current = null; setDrawing(null); }}
    onClick={event => { if (suppressClick.current) { suppressClick.current = false; return; } place(position(event)); }}>
    <div className="insertion-hint"><span>{t(tool === "zoom" ? "Click where to zoom in — or use Automatic zoom" : tool === "loupe" ? "Click where to place the loupe — or use Automatic zoom" : camera ? "Click where to place the camera" : "Drag on the canvas to draw the mask")}</span><button aria-label={t("Cancel")} onClick={event => { event.stopPropagation(); cancel(); }}><X size={14} /></button></div>
    <div className="insertion-ghost" style={{ left: `${(drawing ? drawing.x + drawing.width / 2 : point.x) * 100}%`, top: `${(drawing ? drawing.y + drawing.height / 2 : point.y) * 100}%`, ...(drawing ? { width: `${drawing.width * 100}%`, height: `${drawing.height * 100}%` } : {}) }} aria-hidden="true">{camera && <UserRound size={28} />}</div>
    {zoom && <button className="insertion-auto" onClick={event => { event.stopPropagation(); automatic(); }}><Mouse size={15} />{t("Automatic zoom")}</button>}
  </div>;
}
