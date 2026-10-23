import { useEffect, useRef, useState } from "react";
import { Upload, X } from "lucide-react";
import { DisclosureChevron, Range, Segmented, Toggle } from "./components";
import { cameraConfig, defaultCameraLayout, type CameraLayoutSettings } from "./core/camera";
import { cameraSilenceSource, cameraSourceTime, defaultCameraProcessing, normalizedCameraCrop, parseCameraLUT, type CameraProcessingSettings } from "./core/camera-effects";
import CameraLookGallery from "./CameraLookGallery";
import CameraLayoutCards from "./CameraLayoutCards";
import CameraScenesPanel from "./CameraScenesPanel";
import { t } from "./i18n";
import type { Appearance, Project } from "./types";

type Update = (p: Project | ((p: Project) => Project), group?: string) => void;
export default function CameraInspector({ project, update, processing, notify, onCutout, cutoutProgress, onCancelCutout, selectScene, cameraPreview, time = 0 }: {
  project: Project;
  update: Update;
  processing: boolean;
  notify: (message: string) => void;
  onCutout?: () => void;
  cutoutProgress?: number | null;
  onCancelCutout?: () => void;
  time?: number;
  selectScene?: (id: string | null) => void;
  cameraPreview?: HTMLVideoElement | null;
}) {
  const [analysisProgress, setAnalysisProgress] = useState<number | null>(null);
  const analyzing = useRef(false), mounted = useRef(true), lutInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = window.reva?.onCameraAnalysisProgress?.(progress => { if (mounted.current && analyzing.current) setAnalysisProgress(progress); });
    return () => { mounted.current = false; unsubscribe?.(); if (analyzing.current) void window.reva?.cancelCameraAnalysis?.(); };
  }, []);
  const a = project.appearance;
  const settings = a.cameraLayout ?? defaultCameraLayout();
  const config = cameraConfig(settings);
  const set = <K extends keyof Appearance>(key: K, value: Appearance[K]) => update(p => ({ ...p, appearance: { ...p.appearance, [key]: value } }), `camera-${key}`);
  const layout = (value: CameraLayoutSettings) => set("cameraLayout", value);
  const overlay = (patch: Partial<CameraLayoutSettings["overlay"]>) => layout({ ...settings, overlay: { ...settings.overlay, ...patch } });
  const split = (patch: Partial<CameraLayoutSettings["split"]>) => layout({ ...settings, split: { ...settings.split, ...patch } });
  const cutout = (patch: Partial<CameraLayoutSettings["cutout"]>) => layout({ ...settings, cutout: { ...settings.cutout, ...patch } });
  const processingSettings = a.cameraProcessing ?? defaultCameraProcessing();
  const process = (patch: Partial<CameraProcessingSettings>) => set("cameraProcessing", { ...processingSettings, ...patch });
  const analyze = async (faces = !!a.cameraFollowFace, silence = !!a.cameraHideDuringSilence) => {
    const file = project.cameraPath, api = window.reva;
    if (!file || !api?.analyzeCamera || analyzing.current || (!faces && !silence)) return;
    analyzing.current = true; setAnalysisProgress(0);
    try {
      const audioPath = cameraSilenceSource(project);
      const result = await api.analyzeCamera(file, { faces, silence, silenceMinimumSeconds: .1, ...(audioPath ? { audioPath } : {}) });
      if (result) update(p => p.cameraPath !== file ? p : ({ ...p,
        ...(result.faceTrack ? { cameraFaceTrack: result.faceTrack } : {}),
        ...(result.silence && cameraSilenceSource(p) === audioPath ? { cameraSilence: result.silence } : {}),
      }));
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { analyzing.current = false; if (mounted.current) setAnalysisProgress(null); }
  };
  const importCamera = async () => {
    try {
      const media = await window.reva?.importVideo();
      if (media) update(p => ({ ...p, cameraPath: media.path, cameraSource: { width: media.width, height: media.height }, cameraMask: undefined, cameraFaceTrack: undefined, ...(p.cameraSilence?.source.path === p.cameraPath ? { cameraSilence: undefined } : {}) }));
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
  };
  const cropCamera = async () => {
    if (!project.cameraPath || !window.reva) return;
    const file = project.cameraPath;
    try {
      const crop = await window.reva.editCrop({ mediaPath: file, time: cameraSourceTime(project, time), crop: normalizedCameraCrop(a.cameraCrop) });
      if (crop) update(p => p.cameraPath !== file ? p : ({ ...p, appearance: { ...p.appearance, cameraCrop: crop } }));
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
  };
  const silenceControls = <>
    <Toggle label="Hide camera during silence" description="Use measured microphone or recording audio to hide the camera in quiet ranges." value={!!a.cameraHideDuringSilence} disabled={!project.cameraPath || analysisProgress !== null} onChange={value => {
      update(p => ({ ...p, appearance: { ...p.appearance, cameraHideDuringSilence: value, cameraSilenceMinimumSeconds: p.appearance.cameraSilenceMinimumSeconds ?? 5 } }), "camera-silence");
      if (value && project.cameraSilence?.source.path !== cameraSilenceSource(project)) void analyze(!!a.cameraFollowFace, true);
    }} />
    {a.cameraHideDuringSilence && <Range label="Minimum silence duration" value={a.cameraSilenceMinimumSeconds ?? 5} min={2} max={15} step={.1} display={`${a.cameraSilenceMinimumSeconds ?? 5} s`} onChange={value => set("cameraSilenceMinimumSeconds", value)} reset={() => set("cameraSilenceMinimumSeconds", 5)} />}
  </>;
  if (processing) return <div className="camera-processing-settings">
    <h3>{t("Color grading")}</h3>
    <CameraLookGallery source={cameraPreview} time={time} value={processingSettings.look} disabled={false} change={look => process({ look, gradingEnabled: true })} importLUT={() => lutInput.current?.click()} />
    <input ref={lutInput} type="file" accept=".cube" hidden onChange={async event => {
      const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
      if (file.size > 32 * 1024 * 1024) { notify(t("The LUT exceeds the 32 MiB text budget.")); return; }
      try { const parsed = parseCameraLUT(await file.text(), file.name); if (!parsed.ok) notify(parsed.error.message); else process({ lut: parsed.value }); } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    }} />
    {processingSettings.lut && <div className="camera-lut-name"><span title={processingSettings.lut.title}>{processingSettings.lut.title}</span><button className="icon-button" aria-label={t("Remove LUT")} onClick={() => process({ lut: null })}><X size={13} /></button></div>}
    <Range label="Sharpen" value={processingSettings.sharpen} max={1} step={0.01} display={`${Math.round(processingSettings.sharpen * 100)}%`} onChange={sharpen => process({ sharpen })} reset={() => process({ sharpen: 0 })} />
    <hr /><h3>{t("Crop")}</h3>
    <button className="outline-button full" disabled={!project.cameraPath} onClick={() => void cropCamera()}>{t("Crop camera")}</button>
    <hr />
    <Toggle label="Mirror horizontally" value={a.cameraMirror} onChange={value => set("cameraMirror", value)} />
    <Toggle label="Face tracking" description="Keep the locally detected face inside the camera crop." value={!!a.cameraFollowFace} disabled={!project.cameraPath || analysisProgress !== null} onChange={value => { set("cameraFollowFace", value); if (value && project.cameraFaceTrack?.source.path !== project.cameraPath) void analyze(true, !!a.cameraHideDuringSilence); }} />
    {analysisProgress !== null ? <div className="camera-analysis-status" role="status">{t("Analyzing camera locally… {progress}%", { progress: Math.round(analysisProgress * 100) })}<progress max={1} value={analysisProgress} /><button className="text-button" onClick={() => void window.reva?.cancelCameraAnalysis()}>{t("Cancel")}</button></div> : (a.cameraFollowFace || a.cameraHideDuringSilence) && <>
      <div className="camera-analysis-status">{t("Face samples: {faces}. Quiet ranges: {ranges}.", { faces: project.cameraFaceTrack?.source.path === project.cameraPath ? project.cameraFaceTrack.samples.filter(sample => sample.face !== null).length : 0, ranges: project.cameraSilence?.source.path === cameraSilenceSource(project) ? project.cameraSilence.intervals.length : 0 })}</div>
      <button className="outline-button full" disabled={!project.cameraPath} onClick={() => void analyze()}>{t("Analyze again")}</button>
    </>}
    <hr /><details><summary>{t("Advanced")}</summary>
    <Toggle label="Color grading" value={processingSettings.gradingEnabled !== false} onChange={gradingEnabled => process({ gradingEnabled })} />
    {(processingSettings.lut || processingSettings.look !== "none") && <Range label="Color grading intensity" disabled={processingSettings.gradingEnabled === false} value={processingSettings.lutIntensity} max={1} step={0.01} display={`${Math.round(processingSettings.lutIntensity * 100)}%`} onChange={lutIntensity => process({ lutIntensity })} reset={() => process({ lutIntensity: 1 })} />}
    <Range label="Grain" value={processingSettings.grain} max={1} step={0.01} display={`${Math.round(processingSettings.grain * 100)}%`} onChange={grain => process({ grain })} reset={() => process({ grain: 0 })} />
    <button className="outline-button full" onClick={() => lutInput.current?.click()}><Upload size={15} />{t("Import .cube LUT")}</button>
    <button className="outline-button full" onClick={importCamera}><Upload size={16} />{t(project.cameraPath ? "Replace camera recording" : "Import camera recording")}</button>

    <Range label="Camera delay" value={a.cameraDelayMs ?? 0} min={-200} max={200} step={5} display={`${a.cameraDelayMs ?? 0} ms`} onChange={value => set("cameraDelayMs", value)} reset={() => set("cameraDelayMs", 0)} />
    </details>
  </div>;
  const labels = ["Top left", "Top center", "Top right", "Center left", "Center", "Center right", "Bottom left", "Bottom center", "Bottom right"];
  return <div className="camera-layout-settings">
    <Toggle label="Hide camera" value={a.cameraHidden} onChange={value => set("cameraHidden", value)} />
    <hr />
    <h3>{t("Default layout")}</h3>
    <CameraLayoutCards defaults value={settings.type} wallpaper={a.wallpaper} onChange={type => {
      if (type === "screen-only" || type === "fullscreen-camera") return;
      layout({ ...settings, type }); if (type === "cutout-camera" && !project.cameraMask) onCutout?.();
    }} />
    {config.type === "split-screen" ? <>
      <hr />
      <h3>{t("Split ratio")}</h3>
      <div className="split-ratio-options" role="group" aria-label={t("Split ratio")}>
        {([ [null, "Auto"], [0.5, "½  ½"], [2 / 3, "⅔  ⅓"] ] as const).map(([ratio, label]) => <button key={label} aria-pressed={config.screenRatio === ratio} onClick={() => split({ screenRatio: ratio })}>
          {ratio === null ? t(label) : <><span style={{ flex: ratio }}>{label.split("  ")[0]}</span><span style={{ flex: 1 - ratio }}>{label.split("  ")[1]}</span></>}
        </button>)}
      </div>
      <Toggle label="Flip" description="If enabled, the layout will be flipped." value={config.flip} onChange={flip => split({ flip })} />
      <h3>{t("Fill")}</h3><p className="camera-description">{t(config.enablePadding ? "Split layout includes background padding." : "Split layout fills the entire screen.")}</p>
      <Segmented value={config.enablePadding ? "padded" : "fullscreen"} onChange={value => split({ enablePadding: value === "padded" })} options={[{ value: "fullscreen", label: "Fullscreen" }, { value: "padded", label: "Padded" }]} />
    </> : <>
      <hr />
      <h3>{t("Camera Position")}</h3>
      <div className={`camera-position-picker ${config.type === "cutout-camera" ? "cutout-positions" : ""}`} role="group" aria-label={t("Camera Position")}>
        {(config.type === "camera-overlay" ? [0, 0.5, 1] : [1]).flatMap(y => [0, 0.5, 1].map(x => {
          if (x === 0.5 && y === 0.5) return <span key="center" />;
          const selected = config.type === "camera-overlay" ? config.position.x === x && config.position.y === y : config.positionX === x;
          return <button key={`${x}-${y}`} title={t(labels[y * 6 + x * 2])} aria-label={t(labels[y * 6 + x * 2])} aria-pressed={selected} onClick={() => config.type === "camera-overlay" ? overlay({ position: { x, y } }) : cutout({ positionX: x })}><span /></button>;
        }))}
      </div>
      {config.type === "camera-overlay" && <>
        <hr /><h3>{t("Camera aspect ratio")}</h3>
        <Segmented value={String(config.aspectRatio)} onChange={value => overlay({ aspectRatio: Number(value) })} options={[[16 / 9, "16:9"], [4 / 3, "4:3"], [1, "1:1"], [3 / 4, "3:4"], [9 / 16, "9:16"]].map(([value, label]) => ({ value: String(value), label: String(label) }))} />
      </>}
      <Range label="Camera Size" value={config.sizeRatio} min={config.type === "camera-overlay" ? .1 : .2} max={config.type === "camera-overlay" ? .75 : 1} step={0.0001} display={`${Math.round(config.sizeRatio * 100)}%`} onChange={sizeRatio => config.type === "camera-overlay" ? overlay({ sizeRatio }) : cutout({ sizeRatio })} reset={() => config.type === "camera-overlay" ? overlay({ sizeRatio: 0.5 }) : cutout({ sizeRatio: 0.5 })} />
      <details className="camera-zoom-size"><summary>{t("Camera size during zoom")}<DisclosureChevron /></summary>
        <Toggle label="Make smaller during zoom" value={config.type === "camera-overlay" ? settings.overlay.shrinkDuringZoom ?? settings.overlay.zoomScale < 1 : settings.cutout.shrinkDuringZoom ?? settings.cutout.zoomScale < 1} onChange={shrinkDuringZoom => config.type === "camera-overlay" ? overlay({ shrinkDuringZoom }) : cutout({ shrinkDuringZoom })} />
        <Range label="Camera size during zoom" disabled={config.type === "camera-overlay" ? settings.overlay.shrinkDuringZoom === false : settings.cutout.shrinkDuringZoom === false} value={config.type === "camera-overlay" ? settings.overlay.zoomScale : settings.cutout.zoomScale} min={.25} max={config.type === "camera-overlay" ? .8 : 1} step={0.001} display={`${Math.round((config.type === "camera-overlay" ? settings.overlay.zoomScale : settings.cutout.zoomScale) * 100)}%`} onChange={zoomScale => config.type === "camera-overlay" ? overlay({ zoomScale }) : cutout({ zoomScale })} reset={() => config.type === "camera-overlay" ? overlay({ zoomScale: 0.8 }) : cutout({ zoomScale: 0.8 })} />
      </details>
      {config.type === "camera-overlay" ? <Range label="Camera rounded corners" value={a.cameraRadiusRatio ?? 0.15} max={0.5} step={0.0001} display={`${Math.round((a.cameraRadiusRatio ?? 0.15) * 100)}%`} onChange={value => set("cameraRadiusRatio", value)} reset={() => set("cameraRadiusRatio", 0.15)} /> : <>
        <Range label="Edge softness" value={settings.cutout.edgeSoftness} max={1} step={0.0001} display={`${Math.round(settings.cutout.edgeSoftness * 100)}%`} onChange={edgeSoftness => cutout({ edgeSoftness })} reset={() => cutout({ edgeSoftness: 0.2 })} />
        <Range label="Edge inset" value={settings.cutout.inset} max={8} step={0.1} display={t("{value}px", { value: settings.cutout.inset })} onChange={inset => cutout({ inset })} reset={() => cutout({ inset: 0 })} />
        {cutoutProgress != null ? <div className="privacy-progress" role="status"><span>{t("Removing camera background… {progress}%", { progress: Math.round(cutoutProgress * 100) })}</span><progress value={cutoutProgress} max={1} /><button className="text-button" onClick={onCancelCutout}>{t("Cancel")}</button></div> : !project.cameraMask && project.cameraPath && <button className="outline-button full" onClick={onCutout}>{t("Remove camera background")}</button>}
      </>}
    </>}
    {!project.cameraPath && <><p className="panel-note">{t("Import a camera recording or enable Camera when recording.")}</p><button className="outline-button full" onClick={importCamera}><Upload size={16} />{t("Import camera recording")}</button></>}
    {silenceControls}
    {analysisProgress !== null && <div className="camera-analysis-status" role="status">{t("Analyzing camera locally… {progress}%", { progress: Math.round(analysisProgress * 100) })}<progress max={1} value={analysisProgress} /><button className="text-button" onClick={() => void window.reva?.cancelCameraAnalysis()}>{t("Cancel")}</button></div>}
    <details className="camera-layout-scenes"><summary>{t("Layout scenes")}</summary><CameraScenesPanel project={project} update={update} time={time} onSelect={selectScene} onCutout={onCutout} /></details>
  </div>;
}
