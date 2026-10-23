import { cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Side = "top" | "bottom" | "left" | "right";

/** A shared overlay keeps labels above the preview and outside clipped panels. */
export default function Tooltip({ label, shortcut, children, placement, interactive = false, compact = false }: { label: string; shortcut?: string; children: ReactNode; placement?: Side; interactive?: boolean; compact?: boolean }) {
  const anchor = useRef<HTMLSpanElement>(null), bubble = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragging = useRef(false), inside = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number; side: Side; arrow: number } | null>(null);
  const id = useId();
  const cancelTimer = () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };
  const hide = () => { cancelTimer(); setOpen(false); setPosition(null); };
  const show = () => { cancelTimer(); timer.current = setTimeout(() => { timer.current = null; setOpen(true); }, 350); };
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    const scroll = () => { if (!interactive || !dragging.current) hide(); };
    window.addEventListener("blur", hide);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", hide);
    window.addEventListener("keydown", dismiss);
    return () => { cancelTimer(); window.removeEventListener("blur", hide); window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", hide); window.removeEventListener("keydown", dismiss); };
  }, [interactive]);
  useEffect(() => {
    if (!interactive) return;
    const end = () => { dragging.current = false; if (!inside.current) hide(); };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => { window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); };
  }, [interactive]);
  useLayoutEffect(() => {
    if (!open || !anchor.current || !bubble.current) return;
    const a = anchor.current.getBoundingClientRect(), b = bubble.current.getBoundingClientRect();
    let side: Side = placement ?? (anchor.current.closest(".inspector-tabs") ? "left" : anchor.current.closest(".floating-tools") ? "right" : anchor.current.closest(".titlebar") ? "bottom" : "top");
    if (side === "top" && a.top < b.height + 16) side = "bottom";
    if (side === "bottom" && innerHeight - a.bottom < b.height + 16) side = "top";
    if (side === "left" && a.left < b.width + 16) side = "right";
    if (side === "right" && innerWidth - a.right < b.width + 16) side = "left";
    const vertical = side === "top" || side === "bottom";
    const x = side === "left" ? a.left - b.width - 8 : side === "right" ? a.right + 8 : a.left + (a.width - b.width) / 2;
    const y = side === "top" ? a.top - b.height - 8 : side === "bottom" ? a.bottom + 8 : a.top + (a.height - b.height) / 2;
    const left = Math.max(8, Math.min(innerWidth - b.width - 8, x));
    const top = Math.max(8, Math.min(innerHeight - b.height - 8, y));
    const arrow = vertical ? Math.max(9, Math.min(b.width - 9, a.left + a.width / 2 - left)) : Math.max(9, Math.min(b.height - 9, a.top + a.height / 2 - top));
    setPosition({ left, top, side, arrow });
  }, [open, label, shortcut, placement]);
  const control = isValidElement(children) ? cloneElement(children as ReactElement<{ "aria-describedby"?: string }>, { "aria-describedby": open ? id : (children.props as { "aria-describedby"?: string })["aria-describedby"] }) : children;
  return <span ref={anchor} className="tooltip-anchor"
    onPointerEnter={() => { inside.current = true; show(); }} onPointerLeave={() => { inside.current = false; if (!dragging.current) hide(); }}
    onPointerDown={() => { if (interactive) { dragging.current = true; cancelTimer(); setOpen(true); } else hide(); }} onPointerUp={() => { if (!interactive) show(); }}
    onFocusCapture={event => { if (event.target instanceof Element && event.target.matches(":focus-visible")) show(); }} onBlurCapture={hide}>
    {control}
    {open && createPortal(<div id={id} ref={bubble} role="tooltip" className={`editor-tooltip ${compact ? "compact" : ""} side-${position?.side ?? "top"}`} style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? "visible" : "hidden", "--tip-arrow": `${position?.arrow ?? 0}px` } as CSSProperties}>
      <span>{label}</span>{shortcut && <kbd>{shortcut}</kbd>}
    </div>, document.body)}
  </span>;
}
