import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { IconButton } from "./components";
import ReferenceIcon from "./ReferenceIcon";
import { t } from "./i18n";
import type { Appearance } from "./types";
import Tooltip from "./Tooltip";

const aspects: { value: Appearance["aspect"]; label: string; detail: string }[] = [
  { value: "auto", label: "Auto", detail: "" }, { value: "16:9", label: "Wide", detail: "16:9" },
  { value: "1:1", label: "Square", detail: "1:1" }, { value: "4:3", label: "Classic", detail: "4:3" },
  { value: "9:16", label: "Vertical", detail: "9:16" }, { value: "3:4", label: "Tall", detail: "3:4" },
  { value: "4:5", label: "Portrait", detail: "4:5" },
];
export default function PreviewToolbar({ aspect, setAspect, quality, setQuality, fullResolutionHeight, crop, canCrop, smaller, larger }: {
  aspect: Appearance["aspect"]; setAspect: (value: Appearance["aspect"]) => void;
  quality: number; setQuality: (value: number) => void; fullResolutionHeight: number;
  crop: () => void; canCrop: boolean; smaller: (() => void) | null; larger: (() => void) | null;
}) {
  const [menu, setMenu] = useState<"aspect" | "quality" | null>(null);
  const owner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => { if (!owner.current?.contains(event.target as Node)) setMenu(null); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setMenu(null); } };
    document.addEventListener("pointerdown", dismiss); document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", key, true); };
  }, [menu]);
  return <div className="preview-toolbar" ref={owner}>
    <div className="framing-controls">
      <div className="preview-menu-owner">
        <Tooltip label={t("Output aspect ratio")}><button className="aspect-button" aria-label={t("Output aspect ratio")} aria-haspopup="menu" aria-expanded={menu === "aspect"} onClick={() => setMenu(menu === "aspect" ? null : "aspect")}><ReferenceIcon name="aspectratio" /><span>{t(aspects.find(item => item.value === aspect)?.label ?? "Auto")}</span><ReferenceIcon name="chevron.down" size={12} /></button></Tooltip>
        {menu === "aspect" && <div className="preview-dropdown" role="menu" aria-label={t("Output aspect ratio")}>
          {aspects.map(item => <button key={item.value} role="menuitemradio" aria-checked={aspect === item.value} onClick={() => setAspect(item.value)}><span>{t(item.label)} <small>{item.detail}</small></span>{aspect === item.value && <Check size={17} />}</button>)}
        </div>}
      </div>
      <Tooltip label={t("Crop recorded area")}><button className="crop-button" onClick={() => { setMenu(null); crop(); }} disabled={!canCrop}><ReferenceIcon name="crop" />{t("Crop")}</button></Tooltip>
    </div>
    <div className="preview-tools">
      <div className="preview-menu-owner">
        <Tooltip label={t("Preview quality")}><button className="quality-label" aria-haspopup="menu" aria-expanded={menu === "quality"} onClick={() => setMenu(menu === "quality" ? null : "quality")}><ReferenceIcon name="circle.hexagongrid" /><span>{t("Preview quality")} <b>{t(quality === 1 ? "Full" : quality === .5 ? "Half" : "Quarter")}</b></span><ReferenceIcon name="chevron.down" size={12} /></button></Tooltip>
        {menu === "quality" && <div className="preview-dropdown quality-dropdown" role="menu" aria-label={t("Preview quality")}>
          {([[1, "Full"], [.5, "Half"], [.25, "Quarter"]] as const).map(([value, label]) => <button key={value} role="menuitemradio" aria-checked={quality === value} onClick={() => { setQuality(value); setMenu(null); }}><span>{t(label)} <small>{Math.ceil(fullResolutionHeight * value)}p</small></span>{quality === value && <Check size={17} />}</button>)}
        </div>}
      </div>
      <IconButton title="Decrease preview size" disabled={!smaller} onClick={() => { setMenu(null); smaller?.(); }}><ReferenceIcon name="minus.magnifyingglass" /></IconButton>
      <IconButton title="Increase preview size" disabled={!larger} onClick={() => { setMenu(null); larger?.(); }}><ReferenceIcon name="plus.magnifyingglass" /></IconButton>
    </div>
  </div>;
}
