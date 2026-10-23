import { useEffect, useRef, useState } from "react";
import { Video, X, SlidersHorizontal } from "lucide-react";
import { initializeLanguage, t, useLanguage } from "./i18n";
import type { CameraPreviewFrame } from "./types";
import "./recorder-popover.css";

export default function CameraPreview() {
  useLanguage();
  const [frame, setFrame] = useState<CameraPreviewFrame | null>(null);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const receivedAt = useRef(0);
  useEffect(() => {
    const api = window.reva!;
    let eventVersion = 0, disposed = false;
    const accept = (value: CameraPreviewFrame | null) => { receivedAt.current = value ? Date.now() : 0; setFrame(value); setError(""); setStale(false); };
    const fail = (error: unknown) => setError(error instanceof Error ? error.message : String(error));
    void initializeLanguage().catch(fail);
    const off = api.onCameraPreviewFrame(value => { eventVersion++; accept(value); });
    const errorOff = api.onInputError(value => {
      if (value.mediaType !== "microphone") { eventVersion++; accept(null); setError(value.message); }
    });
    void api.getCameraPreview().then(value => { if (!disposed && eventVersion === 0) accept(value.frame); }).catch(error => { if (!disposed && eventVersion === 0) fail(error); });
    const timer = setInterval(() => { if (receivedAt.current && Date.now() - receivedAt.current > 1500) setStale(true); }, 500);
    return () => { disposed = true; off(); errorOff(); clearInterval(timer); };
  }, []);
  return <main className="camera-preview-surface" aria-label={t("Camera preview")}>
    {frame && <img src={`data:image/jpeg;base64,${frame.jpegBase64}`} alt={t("Camera preview")} draggable={false} />}
    {(!frame || error || stale) && <div className="camera-preview-message"><Video size={26} /><span>{error || t(stale ? "Waiting for camera…" : "Starting camera…")}</span></div>}
    <button className="camera-preview-close" aria-label={t("Hide camera preview")} onClick={() => void window.reva!.patchRecordingPreferences({ cameraPreview: false }).catch(error => setError(String(error)))}><X size={12} /></button>
    <button className="camera-preview-close" style={{ right: 30 }} disabled={!frame || stale} aria-label={t("macOS camera effects")} title={t("macOS camera effects")} onClick={() => void window.reva!.showCameraEffects().catch(error => setError(error instanceof Error ? error.message : String(error)))}><SlidersHorizontal size={12} /></button>
  </main>;
}
