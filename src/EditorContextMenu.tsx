import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
export default function EditorContextMenu({ x, y, close, children }: { x: number; y: number; close: () => void; children: React.ReactNode }) {
  const owner = useRef<HTMLDivElement>(null), [position, setPosition] = useState({ x, y });
  useLayoutEffect(() => { const bounds = owner.current?.getBoundingClientRect(); if (bounds) setPosition({ x: Math.max(8, Math.min(x, innerWidth - bounds.width - 8)), y: Math.max(8, Math.min(y, innerHeight - bounds.height - 8)) }); owner.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(); }, [x, y]);
  useEffect(() => {
    const pointer = (event: PointerEvent) => { if (!owner.current?.contains(event.target as Node)) close(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } };
    window.addEventListener("pointerdown", pointer, true); window.addEventListener("keydown", key, true); window.addEventListener("blur", close);
    return () => { window.removeEventListener("pointerdown", pointer, true); window.removeEventListener("keydown", key, true); window.removeEventListener("blur", close); };
  }, [close]);
  return createPortal(<div ref={owner} className="editor-context-menu" role="menu" style={{ left: position.x, top: position.y }} onContextMenu={event => event.preventDefault()} onPointerDown={event => event.stopPropagation()}>{children}</div>, document.body);
}
