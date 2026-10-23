import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { Range, Segmented, Toggle } from "./components";
import { defaultCameraLayout, type CameraLayoutSettings } from "./core/camera";
import { type CameraScene, type CameraSceneLayout } from "./core/camera-effects";
import { formatTime } from "./core/model";
import { t } from "./i18n";
import type { Project } from "./types";
import "./camera-scenes.css";
import { newCameraScene, sceneLayout } from "./core/editor-insert";
import CameraLayoutCards from "./CameraLayoutCards";

const sceneTypes = [
  ["camera-overlay", "Camera overlay"], ["split-screen", "Split screen"], ["cutout-camera", "Camera cutout"], ["fullscreen-camera", "Fullscreen camera"], ["screen-only", "Screen only"],
] as const;

export default function CameraScenesPanel({ project, update, time = 0, onCutout, selectedId, onSelect, onSeek }: {
  project: Project;
  update: (p: Project | ((p: Project) => Project), group?: string) => void;
  time?: number;
  onCutout?: () => void;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onSeek?: (time: number) => void;
}) {
  const scenes = project.cameraScenes ?? [];
  const patch = (id: string, value: Partial<CameraScene>) => update(p => ({ ...p, cameraScenes: (p.cameraScenes ?? []).map(scene => scene.id === id ? { ...scene, ...value } : scene) }), `camera-scene-${id}`);
  const add = () => {
    const scene = newCameraScene(project, time, project.appearance.cameraLayout?.type ?? "camera-overlay");
    if (!scene) return;
    update(p => ({ ...p, cameraScenes: [...(p.cameraScenes ?? []), scene] }));
    onSelect?.(scene.id);
  };
  const changeType = (scene: CameraScene, type: CameraSceneLayout["type"]) => {
    const cameraLayout = scene.layout.type !== "screen-only" && scene.layout.type !== "fullscreen-camera" ? scene.layout : scene.layout.cameraLayout ?? structuredClone(project.appearance.cameraLayout ?? defaultCameraLayout());
    const layout = sceneLayout(type, cameraLayout);
    patch(scene.id, { layout });
    if (type === "cutout-camera" && !project.cameraMask) onCutout?.();
  };
  return <section className={`camera-scenes-panel ${selectedId ? "scene-editor" : ""}`}>
    {selectedId && <button className="outline-button editor-back" onClick={() => onSelect?.(null)}><ArrowLeft size={18} />{t("Close Camera Layout editor")}</button>}
    {!selectedId && <><div className="camera-scenes-heading"><h3>{t("Layout scenes")}</h3><button className="text-button" disabled={project.duration <= 0} onClick={add}><Plus size={13} />{t("Add scene")}</button></div>
    <p className="camera-description">{t("Change the camera layout for a range of your recording.")}</p></>}
    {scenes.filter(scene => !selectedId || scene.id === selectedId).map((scene, index) => {
      const layout = scene.layout;
      const settings = layout.type !== "screen-only" && layout.type !== "fullscreen-camera" ? layout : null;
      const branch = settings?.type === "camera-overlay" ? settings.overlay : settings?.type === "cutout-camera" ? settings.cutout : null;
      const updateSettings = <K extends "overlay" | "split" | "cutout">(key: K, value: Partial<CameraLayoutSettings[K]>) => settings && patch(scene.id, { layout: { ...settings, [key]: { ...settings[key], ...value } } });
      return <details className="camera-scene" key={scene.id} open={selectedId || scenes.length === 1 ? true : undefined}>
        <summary><span>{index + 1}. {t(sceneTypes.find(([type]) => type === layout.type)?.[1] ?? "Camera overlay")}</span><small>{formatTime(scene.start, true)}–{formatTime(scene.end, true)}</small></summary>
        <div className="camera-scene-body">
          <div className="camera-scene-actions"><Toggle label="Disable layout" value={!!scene.disabled} onChange={disabled => patch(scene.id, { disabled })} /><button className="icon-button" aria-label={t("Delete scene")} onClick={() => update(p => ({ ...p, cameraScenes: (p.cameraScenes ?? []).filter(value => value.id !== scene.id) }))}><Trash2 size={14} /></button></div>
          {!selectedId && <button className="outline-button full" onClick={() => onSelect?.(scene.id)}>{t("Edit layout")}</button>}
          <h3>{t("Layout type")}</h3>
          <CameraLayoutCards value={layout.type} wallpaper={project.appearance.wallpaper} onChange={type => changeType(scene, type)} />
          <hr /><h3>{t("Layout settings")}</h3>

          {layout.type === "fullscreen-camera" && <Toggle label="Padding" value={layout.enablePadding} onChange={enablePadding => patch(scene.id, { layout: { ...layout, enablePadding } })} />}
          {settings?.type === "split-screen" && <>
            <h3>{t("Split ratio")}</h3><div className="split-ratio-options" role="group" aria-label={t("Split ratio")}>{([[null, "Auto"], [.5, "½  ½"], [2 / 3, "⅔  ⅓"]] as const).map(([ratio, label]) => <button key={label} aria-pressed={settings.split.screenRatio === ratio} onClick={() => updateSettings("split", { screenRatio: ratio })}>{ratio === null ? t(label) : <><span style={{ flex: ratio }}>{label.split("  ")[0]}</span><span style={{ flex: 1 - ratio }}>{label.split("  ")[1]}</span></>}</button>)}</div>
            <Toggle label="Flip" value={settings.split.flip} onChange={flip => updateSettings("split", { flip })} /><h3>{t("Fill")}</h3><Segmented value={settings.split.enablePadding ? "padded" : "fullscreen"} onChange={value => updateSettings("split", { enablePadding: value === "padded" })} options={[{ value: "fullscreen", label: "Fullscreen" }, { value: "padded", label: "Padded" }]} />
          </>}
          {branch && <>
            <Range label="Camera Size" value={branch.sizeRatio} min={settings?.type === "camera-overlay" ? .1 : .2} max={settings?.type === "camera-overlay" ? .75 : 1} step={0.0001} display={`${Math.round(branch.sizeRatio * 100)}%`} onChange={sizeRatio => settings?.type === "camera-overlay" ? updateSettings("overlay", { sizeRatio }) : updateSettings("cutout", { sizeRatio })} />
            <Toggle label="Make smaller during zoom" value={branch.shrinkDuringZoom ?? branch.zoomScale < 1} onChange={shrinkDuringZoom => settings?.type === "camera-overlay" ? updateSettings("overlay", { shrinkDuringZoom }) : updateSettings("cutout", { shrinkDuringZoom })} />
            <Range label="Camera size during zoom" disabled={branch.shrinkDuringZoom === false} value={branch.zoomScale} min={.25} max={settings?.type === "camera-overlay" ? .8 : 1} step={0.001} display={`${Math.round(branch.zoomScale * 100)}%`} onChange={zoomScale => settings?.type === "camera-overlay" ? updateSettings("overlay", { zoomScale }) : updateSettings("cutout", { zoomScale })} />
            <Range label="Horizontal position" value={settings?.type === "camera-overlay" ? settings.overlay.position.x : settings!.cutout.positionX} max={1} step={0.01} display={`${Math.round((settings?.type === "camera-overlay" ? settings.overlay.position.x : settings!.cutout.positionX) * 100)}%`} onChange={x => settings?.type === "camera-overlay" ? updateSettings("overlay", { position: { ...settings.overlay.position, x } }) : updateSettings("cutout", { positionX: x })} />
            {settings?.type === "camera-overlay" && <>
              <Range label="Vertical position" value={settings.overlay.position.y} max={1} step={0.01} display={`${Math.round(settings.overlay.position.y * 100)}%`} onChange={y => updateSettings("overlay", { position: { ...settings.overlay.position, y } })} />
              <Segmented value={String(settings.overlay.aspectRatio)} onChange={value => updateSettings("overlay", { aspectRatio: Number(value) })} options={[[16 / 9, "16:9"], [1, "1:1"], [9 / 16, "9:16"]].map(([value, label]) => ({ value: String(value), label: String(label) }))} />
            </>}
            {settings?.type === "cutout-camera" && <>
              <Range label="Edge softness" value={settings.cutout.edgeSoftness} max={1} step={.0001} display={`${Math.round(settings.cutout.edgeSoftness * 100)}%`} onChange={edgeSoftness => updateSettings("cutout", { edgeSoftness })} />
              <Range label="Edge inset" value={settings.cutout.inset} max={8} step={.1} display={`${settings.cutout.inset}px`} onChange={inset => updateSettings("cutout", { inset })} />
            </>}
          </>}
          <details className="scene-timing"><summary>{t("Position and timing")}</summary>
          <div className="camera-scene-times">
            <label>{t("Start")}<input aria-label={t("Scene start")} type="number" step={0.01} min={0} max={scene.end - 0.01} value={Number(scene.start.toFixed(3))} onChange={event => { const start = event.target.valueAsNumber; if (Number.isFinite(start) && start >= 0 && start < scene.end) patch(scene.id, { start }); }} /></label>
            <label>{t("End")}<input aria-label={t("Scene end")} type="number" step={0.01} min={scene.start + 0.01} max={project.duration} value={Number(scene.end.toFixed(3))} onChange={event => { const end = event.target.valueAsNumber; if (Number.isFinite(end) && end > scene.start && end <= project.duration) patch(scene.id, { end }); }} /></label>
          </div>
          {selectedId && <button className="outline-button full range-focus" onClick={() => onSeek?.(scene.start)}>{t("Focus the timeline on the layout start")}</button>}
          {settings?.type === "split-screen" && <><h3>{t("Split direction")}</h3>
            <Segmented value={settings.split.direction} onChange={direction => updateSettings("split", { direction: direction as "auto" | "horizontal" | "vertical" })} options={[{ value: "auto", label: "Auto" }, { value: "horizontal", label: "Horizontal" }, { value: "vertical", label: "Vertical" }]} />
          </>}
          </details>
          <hr /><button className="outline-button full danger" onClick={() => { update(p => ({ ...p, cameraScenes: p.cameraScenes?.filter(value => value.id !== scene.id) })); onSelect?.(null); }}><Trash2 size={17} />{t("Remove layout")}</button>
        </div>
      </details>;
    })}
    {scenes.length > 1 && <p className="camera-description">{t("Later scenes take priority when ranges overlap.")}</p>}
  </section>;
}
