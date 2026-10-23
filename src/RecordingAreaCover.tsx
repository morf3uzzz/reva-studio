import { useEffect, useState } from "react";
export default function RecordingAreaCover() {
  const [area, setArea] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  useEffect(() => {
    let current = true, events = 0;
    const off = window.reva!.onRecordingAreaCover(value => { events++; setArea(value); });
    void window.reva!.getRecordingAreaCover().then(value => { if (current && events === 0) setArea(value); });
    return () => { current = false; off(); };
  }, []);
  return area ? <div aria-hidden="true" style={{ position: "fixed", left: `${area.x * 100}%`, top: `${area.y * 100}%`, width: `${area.width * 100}%`, height: `${area.height * 100}%`, border: "1px solid rgba(255,161,73,.9)", boxShadow: "0 0 0 50000px rgba(0,0,0,.32)", pointerEvents: "none", boxSizing: "border-box" }} /> : null;
}
