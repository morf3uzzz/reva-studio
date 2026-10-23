import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import Tooltip from "./Tooltip";
import { t } from "./i18n";

const cycle = [1, 2, 4, 8, 16];
const groups = [{ label: "Slower", values: [.25, .5] }, { label: "Normal", values: [1] }, { label: "Faster", values: [2, 4, 8, 16] }];

export default function PlaybackSpeed({ value, onChange, disabled }: { value: number; onChange: (value: number) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false), owner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!owner.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, [open]);
  return <div className="playback-speed" ref={owner}>
    <Tooltip label={t("Playback speed")}><button disabled={disabled} aria-label={t("Playback speed")} aria-haspopup="menu" aria-expanded={open}
      onClick={() => { setOpen(false); onChange(cycle[(cycle.indexOf(value) + 1) % cycle.length]); }}
      onContextMenu={event => { event.preventDefault(); if (!disabled) setOpen(!open); }}
      onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); event.stopPropagation(); setOpen(true); } }}
    >{value}×</button></Tooltip>
    {open && <div className="preview-dropdown" role="menu" aria-label={t("Playback speed")}>
      {groups.map(group => <div key={group.label}><div className="speed-group">{t(group.label)}</div>
        {group.values.map(rate => <button key={rate} role="menuitemradio" aria-checked={value === rate} onClick={() => { onChange(rate); setOpen(false); }}>{rate}×{value === rate && <Check size={14} />}</button>)}
      </div>)}
    </div>}
  </div>;
}
