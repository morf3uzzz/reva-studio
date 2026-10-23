import { t } from "./i18n";
import { useEffect, useState } from "react";
import { readExportPreferences, writeExportPreferences, type ExportModeSettings } from "./core/export-settings";
import {
  ArrowUpFromLine,
  Check,
  ChevronDown,
  Film,
  FolderOpen,
  Monitor,
  SlidersHorizontal,
  SquareArrowOutUpRight,
  Video,
} from "lucide-react";
import { Modal, Select, Toggle } from "./components";
import {
  formatTimecode,
  getDuration,
  getOutputSizeForHeight,
} from "./core/model";
import type { ExportOptions, Project } from "./types";
import "./export.css";

const COMPRESSIONS = [
  {
    value: "high",
    label: "Studio",
    description:
      "The highest quality, with minimal compression. Best for further editing and keeping an original copy.",
  },
  {
    value: "balanced",
    label: "Social Media",
    description:
      "Good for sharing on social media, etc. Compression is noticable when taking a good look. Keep in mind that social media server might further compress the video.",
  },
  {
    value: "small",
    label: "Web",
    description:
      "Smaller files for embedding on websites. More compression keeps downloads quick.",
  },
  {
    value: "tiny",
    label: "Web (Low)",
    description:
      "The smallest file size with visible compression. Useful when a fast download matters most.",
  },
] as const;

export default function ExportPanel({
  project,
  onClose,
  onExport,
  progress,
  output,
  outputs = [],
  onReveal,
  onCancel,
}: {
  project: Project;
  onClose: () => void;
  onExport: (options: ExportOptions) => void;
  progress: number | null;
  output: string | null;
  outputs?: string[];
  onReveal: (path: string) => void;
  onCancel: () => void;
}) {
  const [restored] = useState(() => readExportPreferences());
  const [preferences, setPreferences] = useState(restored.value);
  const [preferenceIssue, setPreferenceIssue] = useState(restored.issue ?? null);
  const { format, destination } = preferences;
  const { height, fps, quality, codec, encoding, proresProfile, gifHighQuality, gifLoop } = preferences.modes[format];
  const [advanced, setAdvanced] = useState(false);
  const set = <Key extends keyof ExportModeSettings>(key: Key, value: ExportModeSettings[Key]) => setPreferences(previous => ({ ...previous, modes: { ...previous.modes, [previous.format]: { ...previous.modes[previous.format], [key]: value } } }));
  useEffect(() => {
    const saved = writeExportPreferences(preferences);
    if (!saved.ok) setPreferenceIssue(saved.error);
  }, [preferences]);
  const size = getOutputSizeForHeight(project, height);
  const exporting = progress !== null;
  const frameRates =
    format === "gif" ? [50, 30, 25, 20, 15, 10] : [60, 50, 30, 25, 24, 20, 10];
  const chooseFormat = (format: ExportOptions["format"]) => setPreferences(previous => ({ ...previous, format }));
  const submit = () =>
    onExport({
      format,
      fps,
      ...size,
      quality,
      codec,
      encoding,
      proresProfile,
      gifHighQuality,
      gifLoop,
      destination,
      project,
    });
  return (
    <Modal
      title={t("Export recording")}
      className="export-modal"
      hideHeader
      onClose={exporting ? () => {} : onClose}
    >
      {output ? (
        <div className="export-complete">
          <div className="export-success-icon">
            <Check size={28} />
          </div>
          <h3>
            {t(
              destination === "clipboard"
                ? "Copied to clipboard"
                : "Export complete",
            )}
          </h3>
          {(outputs.length ? outputs : [output]).map(path => <div className="export-output-file" key={path}><p>{path.split("/").pop()}</p><button className="primary-button" onClick={() => onReveal(path)}><FolderOpen size={17} />{t("Show in Finder")}</button></div>)}
          <button className="text-button" onClick={onClose}>
            {t("Back to editor")}
          </button>
        </div>
      ) : exporting ? (
        <div className="export-progress">
          <div
            className="progress-ring"
            style={
              { "--progress": `${progress * 100}%` } as React.CSSProperties
            }
          >
            <span>
              {Math.round(progress * 100)}
              <small>%</small>
            </span>
          </div>
          <h3>
            {t(
              progress >= 0.99
                ? "Finishing export…"
                : "Exporting your recording…",
            )}
          </h3>
          <p>
            {size.width} × {size.height} · {fps} FPS
          </p>
          <button className="outline-button" onClick={onCancel}>
            {t("Cancel export")}
          </button>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="export-grid">
            <div className="export-setting">
              <label>
                <Video size={15} /> {t("Format")}
              </label>
              <div
                className="export-segments"
                role="group"
                aria-label={t("Export format")}
              >
                {(
                  [
                    ["mp4", "MP4"],
                    ["prores", "ProRes"],
                    ["gif", "GIF"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={format === value}
                    className={format === value ? "selected" : ""}
                    onClick={() => chooseFormat(value)}
                  >
                    {t(label)}
                  </button>
                ))}
              </div>
            </div>
            <div className="export-setting">
              <label>
                <Film size={15} /> {t("Frame rate")}
              </label>
              <div className="export-frame-rate">
                <Select
                  label={t("Export frame rate")}
                  value={fps}
                  onChange={(v) => set("fps", +v)}
                >
                  {frameRates.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </Select>
                <span>FPS</span>
              </div>
            </div>
            <div className="export-setting">
              <label>
                <Monitor size={15} /> {t("Resolution")}
              </label>
              <div
                className="export-segments"
                role="group"
                aria-label={t("Export resolution")}
              >
                {(format === "gif" ? [480, 720, 1080] : [720, 1080, 2160]).map(
                  (value) => (
                    <button
                      type="button"
                      key={value}
                      aria-pressed={height === value}
                      className={height === value ? "selected" : ""}
                      onClick={() => set("height", value)}
                    >
                      {value === 2160 ? "4K" : `${value}p`}
                    </button>
                  ),
                )}
              </div>
              <p>
                {t("{value}px", { value: size.width })} × {t("{value}px", { value: size.height })}
              </p>
            </div>
            <div className="export-setting export-compression">
              <label>
                <SlidersHorizontal size={15} />{" "}
                {t(
                  format === "prores"
                    ? "Codec"
                    : format === "gif"
                      ? "GIF options"
                      : "Compression",
                )}
              </label>
              {format === "gif" ? (
                <div className="gif-options">
                  <Toggle
                    label="High quality"
                    description="Preserve more detail with a larger file size."
                    value={gifHighQuality}
                    onChange={value => set("gifHighQuality", value)}
                  />
                  <Toggle
                    label="Disable loop"
                    description="Play the GIF once instead of repeating."
                    value={!gifLoop}
                    onChange={(value) => set("gifLoop", !value)}
                  />
                </div>
              ) : format === "prores" ? (
                <>
                  <div
                    className="export-segments"
                    role="group"
                    aria-label={t("ProRes profile")}
                  >
                    {(
                      [
                        ["422-lt", "422 LT"],
                        ["422", "422"],
                        ["422-hq", "422 HQ"],
                        ["4444", "4444"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        type="button"
                        key={value}
                        aria-pressed={proresProfile === value}
                        className={proresProfile === value ? "selected" : ""}
                        onClick={() => set("proresProfile", value)}
                      >
                        {t(label)}
                      </button>
                    ))}
                  </div>
                  <p>{t("High quality video with uncompressed audio.")}</p>
                </>
              ) : (
                <>
                  <div
                    className="export-segments"
                    role="group"
                    aria-label={t("Export compression")}
                  >
                    {COMPRESSIONS.map((item) => (
                      <button
                        type="button"
                        key={item.value}
                        aria-pressed={quality === item.value}
                        className={quality === item.value ? "selected" : ""}
                        onClick={() => set("quality", item.value)}
                      >
                        {t(item.label)}
                      </button>
                    ))}
                  </div>
                  <p>
                    {t(
                      COMPRESSIONS.find((item) => item.value === quality)
                        ?.description ?? "",
                    )}
                  </p>
                  {format === "mp4" && (
                    <>
                      <p>
                        {t("Quality setting does not impact export speed.")}
                      </p>
                      <button
                        className="export-advanced"
                        type="button"
                        aria-expanded={advanced}
                        onClick={() => setAdvanced(!advanced)}
                      >
                        {t("Advanced")}{" "}
                        <ChevronDown
                          size={14}
                          className={advanced ? "expanded" : ""}
                        />
                      </button>
                      {advanced && (
                        <div className="export-codec">
                          <label>{t("Encoding")}</label>
                          <div className="export-segments" role="group" aria-label={t("Encoding")}>{(["software", "hardware"] as const).map(value => <button type="button" key={value} aria-pressed={encoding === value} className={encoding === value ? "selected" : ""} onClick={() => set("encoding", value)}>{t(value === "hardware" ? "Hardware (VideoToolbox)" : "Software")}</button>)}</div>
                          <p>{t(encoding === "hardware" ? "Uses the Mac hardware encoder. Export reports an error if this codec or resolution is unavailable." : "Uses the local software encoder for consistent quality across Macs.")}</p>
                          <label>{t("Codec")}</label>
                          <div
                            className="export-segments"
                            role="group"
                            aria-label={t("Video codec")}
                          >
                            {(
                              [
                                ["h264", "H.264"],
                                ["hevc", "HEVC"],
                                ["both", "Both"],
                              ] as const
                            ).map(([value, label]) => (
                              <button
                                type="button"
                                key={value}
                                aria-pressed={codec === value}
                                className={codec === value ? "selected" : ""}
                                onClick={() => set("codec", value)}
                              >
                                {t(label)}
                              </button>
                            ))}
                          </div>
                          <p>
                            {t(
                              codec === "both"
                                ? destination === "file" ? "Writes H.264 to the selected filename and HEVC to a companion ending in -hevc.mp4. Both files use the same rendered frames and mixed audio." : "Clipboard uses H.264. Choose File to export both codecs."
                                : codec === "h264"
                                ? "Great compatibility. Can play literally everywhere. Worse quality to file size ratio than HEVC."
                                : "Smaller files with high quality. Requires a player that supports HEVC.",
                            )}
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          </div>
          {preferenceIssue && <p className="panel-note" role="status">{t("Saved export settings could not be restored or updated.")} {preferenceIssue}</p>}
          <footer className="export-footer">
            <div className="export-setting export-destination">
              <label>
                <SquareArrowOutUpRight size={15} /> {t("Export to")}
              </label>
              <div
                className="export-segments"
                role="group"
                aria-label={t("Export destination")}
              >
                {(
                  [
                    ["file", "File"],
                    ["clipboard", "Clipboard"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={destination === value}
                    className={destination === value ? "selected" : ""}
                    onClick={() => setPreferences(previous => ({ ...previous, destination: value }))}
                  >
                    {t(label)}
                  </button>
                ))}
                <button
                  type="button"
                  disabled
                  title={t(
                    "Shareable links require a sharing service, which is not connected in this local build.",
                  )}
                >
                  {t("Shareable link")}
                </button>
              </div>
            </div>
            <div className="export-submit">
              <div>
                <button type="submit" className="primary-button">
                  <ArrowUpFromLine size={16} />
                  {t(
                    destination === "file"
                      ? "Export to file…"
                      : "Copy to clipboard",
                  )}
                  <kbd>↵</kbd>
                </button>
                <button
                  type="button"
                  className="export-cancel"
                  onClick={onClose}
                >
                  {t("Cancel")}
                </button>
              </div>
              <p>
                {formatTimecode(getDuration(project), fps)} · {size.width} ×{" "}
                {size.height} · {fps} FPS
              </p>
            </div>
          </footer>
        </form>
      )}
    </Modal>
  );
}
