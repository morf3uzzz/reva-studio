import { Monitor, UserRound } from "lucide-react";
import type { CameraSceneLayout } from "./core/camera-effects";
import { wallpaperURL } from "./core/wallpapers";
import { t } from "./i18n";

export const CAMERA_LAYOUT_TYPES = [["camera-overlay", "Camera overlay"], ["split-screen", "Split screen"], ["cutout-camera", "Camera cutout"], ["fullscreen-camera", "Fullscreen camera"], ["screen-only", "Only screen"]] as const;
export default function CameraLayoutCards({ value, onChange, wallpaper, defaults = false }: { value: CameraSceneLayout["type"]; onChange: (type: CameraSceneLayout["type"]) => void; wallpaper: number; defaults?: boolean }) {
  return <div className="camera-layout-cards" role="group" aria-label={t(defaults ? "Default layout" : "Layout type")}>
    {(defaults ? CAMERA_LAYOUT_TYPES.slice(0, 3) : CAMERA_LAYOUT_TYPES).map(([type, label]) => <button key={type} className={`camera-layout-card ${value === type ? "selected" : ""}`} aria-pressed={value === type} onClick={() => onChange(type)}>
      <span className={`camera-layout-thumbnail ${type}`} style={{ backgroundImage: `url("${wallpaperURL(wallpaper)}")` }}><span className="layout-screen"><Monitor /></span><span className="layout-person"><UserRound /></span></span>
      <span>{t(label)}</span>
    </button>)}
  </div>;
}
