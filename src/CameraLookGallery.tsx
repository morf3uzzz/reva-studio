import { useEffect, useRef } from "react";
import { Plus } from "lucide-react";
import { FrameProcessor } from "./core/frame-processing";
import type { CameraLook } from "./core/camera-effects";
import { t } from "./i18n";
export const CAMERA_LOOK_CHOICES = [["none", "Original"], ["studio", "Studio"], ["cinematic", "Cinema"], ["film", "Film"], ["warm", "Golden"], ["cream", "Cream"], ["terra", "Terra"], ["moody", "Moody"], ["cool", "Arctic"], ["neon", "Neon"], ["punch", "Punch"], ["fade", "Fade"], ["mono", "Mono"]] as const;
export default function CameraLookGallery({ source, time, value, disabled, change, importLUT }: { source?: HTMLVideoElement | null; time: number; value: CameraLook; disabled: boolean; change: (look: CameraLook) => void; importLUT: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const processor = new FrameProcessor(), sample = document.createElement("canvas");
    sample.width = sample.height = 96; const context = sample.getContext("2d")!;
    let lastPaint = -Infinity;
    const paint = () => {
      if (performance.now() - lastPaint < 500) return;
      lastPaint = performance.now();
      if (source && source.readyState >= 2 && source.videoWidth > 0) {
        const side = Math.min(source.videoWidth, source.videoHeight);
        context.drawImage(source, (source.videoWidth - side) / 2, (source.videoHeight - side) / 2, side, side, 0, 0, 96, 96);
      } else {
        // Original vector portrait sample; no vendor thumbnail artwork.
        context.fillStyle = "#18202a"; context.fillRect(0, 0, 96, 96);
        context.fillStyle = "#617689"; context.beginPath(); context.ellipse(48, 102, 37, 40, 0, 0, Math.PI * 2); context.fill();
        context.fillStyle = "#d9b49a"; context.beginPath(); context.ellipse(48, 40, 19, 25, 0, 0, Math.PI * 2); context.fill();
        context.fillStyle = "#29252a"; context.beginPath(); context.ellipse(48, 24, 23, 12, 0, 0, Math.PI * 2); context.fill();
        context.fillStyle = "#302d31"; context.fillRect(39, 38, 4, 3); context.fillRect(54, 38, 4, 3); context.fillRect(43, 53, 11, 2);
      }
      for (const tile of root.current?.querySelectorAll<HTMLCanvasElement>("canvas") ?? []) {
        const look = tile.dataset.look as CameraLook, drawing = tile.getContext("2d")!;
        try { drawing.drawImage(processor.frame(sample, 96, 96, { look, lut: null, lutIntensity: 1, sharpen: 0, grain: 0 }, 0), 0, 0, 96, 96); }
        catch { drawing.drawImage(sample, 0, 0); }
      }
    };
    paint(); source?.addEventListener("loadeddata", paint); source?.addEventListener("seeked", paint); source?.addEventListener("timeupdate", paint);
    return () => { source?.removeEventListener("loadeddata", paint); source?.removeEventListener("seeked", paint); source?.removeEventListener("timeupdate", paint); processor.dispose(); };
  }, [source]);
  return <div ref={root} className="camera-look-gallery" role="group" aria-label={t("Color grading")}>
    {CAMERA_LOOK_CHOICES.map(([look, label]) => <button key={look} title={t(label)} aria-label={t(label)} aria-pressed={value === look} disabled={disabled} onClick={() => change(look)}><canvas width={96} height={96} data-look={look} aria-hidden="true" /></button>)}
    <button title={t("Import .cube LUT")} aria-label={t("Import .cube LUT")} onClick={importLUT}><Plus size={20} /></button>
  </div>;
}
