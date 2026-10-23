import { useEffect, useRef, useState } from "react";
import { Range, Segmented, Toggle } from "./components";
import { defaultDeviceFrame, defaultScreenProcessing, type DeviceFrameSettings, type SocialSafeArea } from "./core/screen-effects";
import { t } from "./i18n";
import type { Project } from "./types";

export default function ScreenEnhancementPanel({ project, update, guide = "off", onGuideChange }: {
  project: Project;
  update: (p: Project | ((p: Project) => Project), group?: string) => void;
  guide?: SocialSafeArea;
  onGuideChange?: (mode: SocialSafeArea) => void;
}) {
  const frame = project.appearance.deviceFrame ?? defaultDeviceFrame(), processing = project.appearance.screenProcessing ?? defaultScreenProcessing();
  const [progress, setProgress] = useState<number | null>(null), [failure, setFailure] = useState<string | null>(null);
  const running = useRef(false), mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const off = window.reva?.onScreenUpscaleProgress?.(value => { if (mounted.current && running.current) setProgress(value); });
    return () => { mounted.current = false; off?.(); if (running.current) void window.reva?.cancelScreenUpscale?.(); };
  }, []);
  const enhance = async () => {
    const api = window.reva, source = project.mediaPath;
    if (!api?.upscaleScreen || !source || running.current) return;
    running.current = true; setProgress(0); setFailure(null);
    try { const result = await api.upscaleScreen(source); if (result) update(p => p.mediaPath !== source ? p : ({ ...p, screenEnhancement: result })); }
    catch (error) { if (mounted.current) setFailure(error instanceof Error ? error.message : String(error)); }
    finally { running.current = false; if (mounted.current) setProgress(null); }
  };
  const enhanced = project.screenEnhancement?.sourcePath === project.mediaPath ? project.screenEnhancement : undefined;
  const openAttribution = (url: string) => { void window.reva?.openModelAttribution(url).catch(error => { if (mounted.current) setFailure(error instanceof Error ? error.message : String(error)); }); };
  const setFrame = (patch: Partial<DeviceFrameSettings>) => update(p => ({ ...p, appearance: { ...p.appearance, deviceFrame: { ...frame, ...patch } } }), "device-frame");
  return <div className="screen-enhancement-panel">
    <h3>{t("Device frame")}</h3>
    <Segmented value={frame.type} onChange={type => setFrame({ type: type as DeviceFrameSettings["type"] })} options={[{ value: "none", label: "None" }, { value: "phone", label: "Phone" }, { value: "tablet", label: "Tablet" }]} />
    {frame.type !== "none" && <>
      <p className="panel-note">{t("Independent phone and tablet bezels follow the recording orientation.")}</p>
      <div style={{ display: "flex", gap: 8 }} role="group" aria-label={t("Device color")}>{["#34343a", "#c1c1c6", "#b7a38b"].map(color => <button key={color} style={{ background: color, width: 25, height: 25, borderRadius: "50%", border: "1px solid #ffffff40", outline: frame.color === color ? "2px solid #b9acec" : undefined, outlineOffset: 2 }} aria-label={color} aria-pressed={frame.color === color} onClick={() => setFrame({ color })} />)}</div>
      <Range label="Bezel width" value={frame.bezelRatio} min={.01} max={.08} step={.001} display={`${Math.round(frame.bezelRatio * 1000) / 10}%`} onChange={bezelRatio => setFrame({ bezelRatio })} reset={() => setFrame({ bezelRatio: .035 })} />
    </>}
    <h3>{t("Screen processing")}</h3>
    <Range label="Debanding" value={processing.deband} max={1} step={.01} display={`${Math.round(processing.deband * 100)}%`} onChange={deband => update(p => ({ ...p, appearance: { ...p.appearance, screenProcessing: { ...processing, deband } } }), "screen-deband")} reset={() => update(p => ({ ...p, appearance: { ...p.appearance, screenProcessing: { ...processing, deband: 0 } } }))} />
    <p className="panel-note">{t("Smooths subtle gradient steps while preserving high-contrast edges.")}</p>
    <h3>{t("AI super-resolution")}</h3>
    <p className="panel-note">{t("Enhance a recording up to 1080p with the local PiperSR 2× CoreML model. Video stays on your Mac.")}</p>
    {enhanced && <Toggle label="Use enhanced recording" value={enhanced.enabled} onChange={enabled => update(p => !p.screenEnhancement ? p : ({ ...p, screenEnhancement: { ...p.screenEnhancement, enabled } }))} />}
    {progress !== null ? <div className="camera-analysis-status" role="status">{t("Enhancing locally… {progress}%", { progress: Math.round(progress * 100) })}<progress max={1} value={progress} /><button className="text-button" onClick={() => void window.reva?.cancelScreenUpscale()}>{t("Cancel")}</button></div> : <button className="outline-button full" disabled={!project.mediaPath || project.width * project.height > 2_073_600 || !window.reva?.upscaleScreen} onClick={() => void enhance()}>{t(enhanced ? "Enhance again" : "Enhance recording 2×")}</button>}
    {failure && <p className="panel-note" role="alert">{failure}</p>}
    {enhanced && <p className="panel-note">{enhanced.width} × {enhanced.height} · {enhanced.modelName}<br /><a href="https://modelpiper.com" onClick={event => { event.preventDefault(); openAttribution(event.currentTarget.href); }}>PiperSR by Ben Racicot / ModelPiper</a> · <a href="https://creativecommons.org/licenses/by/4.0/" onClick={event => { event.preventDefault(); openAttribution(event.currentTarget.href); }}>CC BY 4.0</a></p>}
    {onGuideChange && <>
      <h3>{t("Social preview guides")}</h3>
      <Segmented value={guide} onChange={value => onGuideChange(value as SocialSafeArea)} options={[{ value: "off", label: "Off" }, { value: "tiktok", label: "TikTok" }, { value: "instagram", label: "Instagram" }]} />
      <p className="panel-note">{t("Composition guides are approximate and stay out of exports.")}</p>
    </>}
  </div>;
}
