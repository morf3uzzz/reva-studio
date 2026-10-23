import { useState, useEffect, useRef } from "react";
import { t } from "./i18n";
import AnimationInspector from "./AnimationInspector";
import CameraScenesPanel from "./CameraScenesPanel";
import CameraInspector from "./CameraInspector";
import CursorInspector from "./CursorInspector";
import TranscriptPanel from "./TranscriptPanel";
import AnnotationsPanel from "./AnnotationsPanel";
import AudioPanel from "./AudioPanel";
import ScreenEnhancementPanel from "./ScreenEnhancementPanel";
import BackgroundLibrary from "./BackgroundLibrary";
import { defaultScreenShadow, type SocialSafeArea } from "./core/screen-effects";
import { getOutputTime } from "./core/model";
import {
  WALLPAPERS,
  wallpaperURL,
  wallpapersInCategory,
} from "./core/wallpapers";

import {
  Image as ImageIcon,
  Palette,
  Shuffle,
  Sparkles,
  Star,
  Trash2,
  Upload,
  WandSparkles,
  Plus,
  MousePointer2,
  Video,
  AlignCenter,
  Crop,
  RotateCcw,
  ArrowLeft,
  Gauge,
  Volume2,
} from "lucide-react";
import {
  IconButton,
  Range,
  Toggle,
  Segmented,
  Select,
  NumberInput,
  DisclosureChevron,
} from "./components";
import {
  BACKGROUNDS,
  defaultAppearance,
  formatTime,
  clamp,
} from "./core/model";
import { getSlices, MIN_SLICE_DURATION, SLICE_SPEEDS } from "./core/timeline";
import type { Appearance, Project, Slice, Zoom } from "./types";

export type Panel =
  | "background"
  | "cursor"
  | "camera"
  | "camera-scene"
  | "camera-processing"
  | "captions"
  | "transcript"
  | "audio"
  | "motion"
  | "masks"
  | "shortcuts"
  | "zoom"
  | "slice";
export default function Inspector({
  panel,
  project,
  update,
  time,
  selectedZoom,
  selectedSlice,
  onRemoveSlice,
  onCloseSlice,
  onCloseTranscript,
  selectZoom,
  notify,
  privacyProgress,
  onPrivacyChange,
  onPrivacyCancel,
  onCutout,
  cutoutProgress,
  onCancelCutout,
  cameraPreview,
  previewTime = time,
  selectedScene = null,
  selectScene,
  selectedMask = null,
  selectMask,
  onSeek,
  onVolumeAudition,
  socialSafeArea = "off",
  onSocialSafeAreaChange,
}: {
  panel: Panel;
  project: Project;
  update: (p: Project | ((p: Project) => Project), group?: string) => void;
  time: number;
  selectedZoom: string | null;
  selectedSlice: string | null;
  onRemoveSlice: (id: string) => void;
  onCloseSlice?: () => void;
  onCloseTranscript?: () => void;
  selectZoom: (s: string | null) => void;
  notify: (s: string) => void;
  privacyProgress: number | null;
  onPrivacyChange: (kind: "sensitive" | "faces", value: boolean) => void;
  onPrivacyCancel: () => void;
  onCutout?: () => void;
  cutoutProgress?: number | null;
  onCancelCutout?: () => void;
  cameraPreview?: HTMLVideoElement | null;
  previewTime?: number;
  selectedScene?: string | null;
  selectScene?: (id: string | null) => void;
  selectedMask?: string | null;
  selectMask?: (id: string | null) => void;
  onSeek?: (time: number) => void;
  onVolumeAudition?: (project: Project, time: number) => void;
  socialSafeArea?: SocialSafeArea;
  onSocialSafeAreaChange?: (mode: SocialSafeArea) => void;
}) {
  const a = project.appearance;
  const [speechProgress, setSpeechProgress] = useState<number | null>(null);
  useEffect(() => window.reva?.onSpeechProgress(setSpeechProgress), []);
  const panelLabel: Record<Panel, string> = {
    background: "Background",
    cursor: "Cursor",
    camera: "Camera",
    "camera-scene": "Camera layout",
    "camera-processing": "Camera recording",
    captions: "Captions",
    transcript: "Transcript",
    audio: "Audio",
    motion: "Animation",
    zoom: "Zoom",
    slice: "Slice",
    masks: "Masks and highlights",
    shortcuts: "Recorded shortcuts",
  };
  const set = <K extends keyof Appearance>(key: K, value: Appearance[K]) =>
    update(
      (p) => ({ ...p, appearance: { ...p.appearance, [key]: value } }),
      String(key),
    );
  const reset = (key: keyof Appearance) => set(key, defaultAppearance()[key]);
  const [category, setCategory] = useState(WALLPAPERS[0]?.category ?? "REVA");
  useEffect(() => {
    setCategory(WALLPAPERS[a.wallpaper]?.category ?? WALLPAPERS[0]?.category ?? "REVA");
  }, [a.wallpaper]);
  const visibleBackgrounds = BACKGROUNDS.map((background, index) => ({
    background,
    index,
  }));
  const [selectedCaption, setSelectedCaption] = useState<string | null>(null);
  const zoom = project.zooms.find((z) => z.id === selectedZoom);
  const slices = getSlices(project);
  const sliceIndex = slices.findIndex((slice) => slice.id === selectedSlice);
  const slice = slices[sliceIndex];
  const speedList = useRef<HTMLDivElement>(null);
  useEffect(() => {
    speedList.current
      ?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedSlice, slice?.speed]);
  const sliceChange = (patch: Partial<Slice>) =>
    update((p) => {
      const items = getSlices(p);
      const index = items.findIndex((item) => item.id === selectedSlice);
      if (index < 0) return p;
      const current = items[index];
      const next = { ...current, ...patch };
      next.start = clamp(
        next.start,
        items[index - 1]?.end ?? 0,
        current.end - MIN_SLICE_DURATION,
      );
      next.end = clamp(
        next.end,
        next.start + MIN_SLICE_DURATION,
        items[index + 1]?.start ?? p.duration,
      );
      items[index] = next;
      return { ...p, slices: items };
    }, "slice-settings");
  const zoomChange = (patch: Partial<Zoom>) =>
    update(
      (p) => ({
        ...p,
        zooms: p.zooms.map((z) =>
          z.id === selectedZoom ? { ...z, ...patch } : z,
        ),
      }),
      "zoom-settings",
    );
  const caption =
    project.captions.find((c) => c.id === selectedCaption) ??
    project.captions.find((c) => c.start <= time && c.end >= time) ??
    project.captions[0];
  const editCaption = (patch: Record<string, string | number>) =>
    update(
      (p) => ({
        ...p,
        captions: p.captions.map((c) =>
          c.id === caption?.id ? { ...c, ...patch } : c,
        ),
      }),
      "caption",
    );
  const importImage = async () => {
    try {
      const path = await window.reva?.importImage();
      if (path)
        update((p) => ({
          ...p,
          appearance: { ...p.appearance, backgroundKind: "image", image: path },
        }));
      else if (!window.reva)
        notify(t("Open the macOS app to choose a background image."));
    } catch (e) {
      notify(t(e instanceof Error ? e.message : String(e)));
    }
  };
  return (
    <aside
      className={`inspector inspector-${panel}`}
      aria-label={t("{panel} settings", { panel: t(panelLabel[panel]) })}
    >
      {panel === "slice" && (
        <div className="slice-settings">
          <button
            className="outline-button close-slice"
            onClick={onCloseSlice}
            disabled={!onCloseSlice}
          >
            <ArrowLeft size={18} />
            {t("Close Slice editor")}
          </button>
          {slice ? (
            <>
              <div className="slice-volume">
                <Volume2 size={18} aria-hidden="true" />
                <Range
                  label="System audio volume"
                  value={slice.systemVolume ?? slice.volume}
                  min={0}
                  max={1}
                  step={0.01}
                  display={`${Math.round((slice.systemVolume ?? slice.volume) * 100)}%`}
                  onChange={systemVolume => { sliceChange({ systemVolume }); onVolumeAudition?.({ ...project, slices: getSlices(project).map(item => item.id === slice?.id ? { ...item, systemVolume } : item) }, time); }}
                />
              </div>
              {project.microphonePath && <Range label="Microphone volume" value={slice.volume} min={0} max={1} step={.01} display={`${Math.round(slice.volume * 100)}%`} onChange={volume => { sliceChange({ volume }); onVolumeAudition?.({ ...project, slices: getSlices(project).map(item => item.id === slice?.id ? { ...item, volume } : item) }, time); }} />}
              {project.cameraPath && <Range label="Camera audio volume" value={slice.cameraVolume ?? slice.volume} min={0} max={1} step={.01} display={`${Math.round((slice.cameraVolume ?? slice.volume) * 100)}%`} onChange={cameraVolume => { sliceChange({ cameraVolume }); onVolumeAudition?.({ ...project, slices: getSlices(project).map(item => item.id === slice?.id ? { ...item, cameraVolume } : item) }, time); }} />}
              <hr />
              <h3 className="slice-speed-label">{t("Speed")}</h3>
              <div
                className="slice-speed-options"
                ref={speedList}
                role="group"
                aria-label={t("Slice playback speed")}
              >
                {[
                  ...(!SLICE_SPEEDS.includes(slice.speed) ? [slice.speed] : []),
                  ...SLICE_SPEEDS.filter((speed) => speed >= 1),
                  ...SLICE_SPEEDS.filter((speed) => speed < 1),
                ].map((speed) => (
                  <button
                    key={speed}
                    aria-pressed={slice.speed === speed}
                    onClick={() => sliceChange({ speed })}
                  >
                    {speed}x
                  </button>
                ))}
              </div>
              <button
                className="outline-button full apply-slice-speed"
                onClick={() =>
                  update(
                    (p) => ({
                      ...p,
                      slices: getSlices(p).map((item) => ({
                        ...item,
                        speed: slice.speed,
                      })),
                    }),
                    "all-slice-speeds",
                  )
                }
              >
                <Gauge size={18} />
                {t("Apply speed to all slices")}
              </button>
              <hr />
              <details className="slice-cursor-settings" key={slice.id}>
                <summary>
                  <span>
                    {t("Cursor settings")}
                    <small>
                      {t(
                        "Change appearance of mouse cursor in this part of the recording.",
                      )}
                    </small>
                  </span>
                  <DisclosureChevron />
                </summary>
                <div className="slice-cursor-controls">
                  <Toggle
                    label="Hide cursor"
                    value={slice.cursorHidden ?? a.cursorHidden}
                    onChange={(cursorHidden) => sliceChange({ cursorHidden })}
                  />
                  <Toggle
                    label="Disable smooth mouse movement"
                    description="This is useful, for example, when recording drop-down menus, where precise alignment is required."
                    value={!(slice.cursorSmooth ?? a.cursorSmooth)}
                    onChange={(disabled) =>
                      sliceChange({ cursorSmooth: !disabled })
                    }
                  />
                </div>
              </details>
              <hr />
              <button
                className="outline-button full remove-slice"
                disabled={slices.length <= 1}
                onClick={() => onRemoveSlice(slice.id)}
              >
                <Trash2 size={18} />
                {t("Remove slice")}
              </button>
              <details className="slice-advanced">
                <summary>
                  {t("Advanced")} <DisclosureChevron />
                </summary>
                <div className="slice-duration">
                  <span>{t("Duration")}</span>
                  <strong>
                    {formatTime((slice.end - slice.start) / slice.speed, true)}
                  </strong>
                </div>
                <div className="two-fields">
                  <label>
                    {t("Start, seconds")}
                    <NumberInput
                      label="Slice source start"
                      value={slice.start}
                      min={slices[sliceIndex - 1]?.end ?? 0}
                      max={slice.end - MIN_SLICE_DURATION}
                      step={0.01}
                      onCommit={(start) => sliceChange({ start })}
                    />
                  </label>
                  <label>
                    {t("End, seconds")}
                    <NumberInput
                      label="Slice source end"
                      value={slice.end}
                      min={slice.start + MIN_SLICE_DURATION}
                      max={slices[sliceIndex + 1]?.start ?? project.duration}
                      step={0.01}
                      onCommit={(end) => sliceChange({ end })}
                    />
                  </label>
                </div>
              </details>
            </>
          ) : (
            <p className="panel-note">
              {t(
                "Select a clip in the timeline to adjust its speed, volume and range.",
              )}
            </p>
          )}
        </div>
      )}
      {panel === "background" && (
        <>
          <h3>{t("Background")}</h3>
          <Segmented
            value={a.backgroundKind}
            onChange={(v) => set("backgroundKind", v)}
            options={[
              { value: "wallpaper", label: "Wallpaper" },
              { value: "gradient", label: "Gradient" },
              { value: "color", label: "Color" },
              { value: "image", label: "Image" },
            ]}
          />
          {(a.backgroundKind === "wallpaper" ||
            a.backgroundKind === "gradient") && (
            <>
              <h3 className="section-title">
                {t(a.backgroundKind === "wallpaper" ? "Wallpaper" : "Gradient")}
              </h3>
              {a.backgroundKind === "wallpaper" && (
                <div className="wallpaper-categories">
                  {[...new Set(WALLPAPERS.map(item => item.category))].map((cat) => (
                    <button
                      key={cat}
                      className={category === cat ? "selected" : ""}
                      onClick={() => setCategory(cat)}
                    >
                      {t(cat)}
                    </button>
                  ))}
                </div>
              )}
              <button
                className="outline-button full random-wallpaper"
                onClick={() =>
                  set(
                    a.backgroundKind === "wallpaper" ? "wallpaper" : "gradient",
                    Math.floor(
                      Math.random() *
                        (a.backgroundKind === "wallpaper"
                          ? WALLPAPERS.length
                          : BACKGROUNDS.length),
                    ),
                  )
                }
              >
                <WandSparkles size={16} />{" "}
                {t(
                  a.backgroundKind === "wallpaper"
                    ? "Pick random wallpaper"
                    : "Pick random gradient",
                )}
              </button>
              <div className="swatch-grid">
                {a.backgroundKind === "wallpaper"
                  ? wallpapersInCategory(category).map(
                      ({ wallpaper, index }) => (
                        <button
                          key={wallpaper.file}
                          title={wallpaper.name}
                          aria-label={wallpaper.name}
                          onClick={() => set("wallpaper", index)}
                          className={`swatch reference-wallpaper ${a.wallpaper === index ? "selected" : ""}`}
                        >
                          <img
                            src={wallpaperURL(index)}
                            alt=""
                            loading="lazy"
                            draggable={false}
                          />
                        </button>
                      ),
                    )
                  : visibleBackgrounds.map(({ background: b, index: i }) => (
                      <button
                        key={b.name}
                        title={t(b.name)}
                        aria-label={t(b.name)}
                        onClick={() =>
                          set(
                            a.backgroundKind === "wallpaper"
                              ? "wallpaper"
                              : "gradient",
                            i,
                          )
                        }
                        className={`swatch ${(a.backgroundKind === "wallpaper" ? a.wallpaper : a.gradient) === i ? "selected" : ""} ${a.backgroundKind === "wallpaper" ? "wallpaper-swatch" : ""}`}
                        style={{
                          background: `linear-gradient(${120 + i * 17}deg, ${b.colors.join(",")})`,
                        }}
                      >
                        <span className="swatch-wave" />
                      </button>
                    ))}
              </div>
            </>
          )}
          {a.backgroundKind === "color" && (
            <div className="color-field">
              <label>{t("Background color")}</label>
              <input
                type="color"
                aria-label={t("Background color")}
                value={a.background}
                onChange={(e) => set("background", e.target.value)}
              />
              <code>{a.background.toUpperCase()}</code>
            </div>
          )}
          {a.backgroundKind === "image" && (
            <button className="image-drop" onClick={importImage}>
              <ImageIcon size={28} />
              <span>
                {t(
                  a.image
                    ? "Replace background image"
                    : "Choose a background image",
                )}
              </span>
              <small>{t("PNG, JPEG or WebP")}</small>
            </button>
          )}
          <Range
            label="Background blur"
            value={a.blur}
            max={100}
            step={0.1}
            display={t("{value}px", { value: a.blur })}
            onChange={(v) => set("blur", v)}
            reset={() => reset("blur")}
          />
          <hr />
          <Range
            label="Padding"
            value={a.padding}
            max={0.25}
            step={0.001}
            display={`${Math.round(a.padding * 100)}%`}
            onChange={(v) => set("padding", v)}
            reset={() => reset("padding")}
          />
          <Range
            label="Screen rounded corners"
            value={a.radius}
            max={128}
            display={t("{value}px", { value: a.radius })}
            onChange={(v) => set("radius", v)}
            reset={() => reset("radius")}
          />
          <Toggle
            label="Inset"
            description="Add a fine border around the screen."
            value={a.inset > 0}
            onChange={(v) => set("inset", v ? 3 : 0)}
          />
          {a.inset > 0 && (
            <Range
              label="Inset width"
              value={a.inset}
              min={1}
              max={12}
              display={t("{value}px", { value: a.inset })}
              onChange={(v) => set("inset", v)}
            />
          )}
          <Range
            label="Shadow"
            value={a.shadow}
            max={0.6}
            step={0.01}
            display={`${Math.round(a.shadow * 100)}%`}
            onChange={(v) => set("shadow", v)}
            reset={() => reset("shadow")}
          />
          <Segmented label="Shadow style" value={a.screenShadow?.style ?? "classic"} options={[{ value: "classic", label: "Classic" }, { value: "directional", label: "Directional" }]} onChange={style => set("screenShadow", { ...(a.screenShadow ?? defaultScreenShadow()), style })} />
          <details className="shadow-advanced"><summary>{t("Advanced shadow settings")}<DisclosureChevron /></summary>
            <Range label="Shadow Distance" value={a.screenShadow?.distance ?? 25} max={100} step={1} onChange={distance => set("screenShadow", { ...(a.screenShadow ?? defaultScreenShadow()), distance })} reset={() => set("screenShadow", { ...(a.screenShadow ?? defaultScreenShadow()), distance: 25 })} />
            <Range label="Shadow Angle" value={a.screenShadow?.angle ?? 90} max={180} step={1} display={`${a.screenShadow?.angle ?? 90}°`} onChange={angle => set("screenShadow", { ...(a.screenShadow ?? defaultScreenShadow()), angle })} reset={() => set("screenShadow", { ...(a.screenShadow ?? defaultScreenShadow()), angle: 90 })} />
            <Range label="Shadow Blur" value={a.screenShadow?.blur ?? 20} max={30} step={.1} onChange={blur => set("screenShadow", { ...(a.screenShadow ?? defaultScreenShadow()), blur })} reset={() => set("screenShadow", { ...(a.screenShadow ?? defaultScreenShadow()), blur: 20 })} />
          </details>
          <hr />
          <Toggle
            label="Hide sensitive data"
            description="Covers detected emails, phone numbers, card numbers and keys."
            value={project.privacy?.sensitive ?? false}
            onChange={(value) => onPrivacyChange("sensitive", value)}
          />
          <Toggle
            label="Hide faces"
            description="Blurs detected faces shown in the recording."
            value={project.privacy?.faces ?? false}
            onChange={(value) => onPrivacyChange("faces", value)}
          />
          <label className="field-label privacy-phrases">{t("Custom phrases")}<textarea aria-label={t("Custom privacy phrases")} placeholder={t("One phrase per line")} value={(project.privacy?.customPhrases ?? []).join("\n")} onChange={event => {
            const customPhrases = event.target.value.split(/\r?\n/).map(phrase => phrase.trim()).filter(Boolean).slice(0, 100).map(phrase => phrase.slice(0, 500));
            update(p => ({ ...p, privacy: { sensitive: false, faces: false, analysis: null, ...p.privacy, customPhrases } }), "privacy-phrases");
          }} /></label>
          <button className="outline-button full" disabled={!project.mediaPath || privacyProgress !== null || !(project.privacy?.customPhrases?.length)} onClick={() => onPrivacyChange("sensitive", true)}>{t("Analyze custom phrases")}</button>
          {privacyProgress !== null && (
            <div className="privacy-progress" role="status">
              <span>
                {t("Analyzing recording… {progress}%", {
                  progress: Math.round(privacyProgress * 100),
                })}
              </span>
              <progress max={1} value={privacyProgress} />
              <button className="text-button" onClick={onPrivacyCancel}>
                {t("Cancel analysis")}
              </button>
            </div>
          )}
          {project.privacy?.analysis &&
            (project.privacy.faces || project.privacy.sensitive) && (
              <p className="panel-note">
                {t(
                  "Review the video before sharing. Automatic detection can miss brief appearances and small text.",
                )}
              </p>
            )}
        </>
      )}
      {panel === "background" && <BackgroundLibrary current={{ kind: a.backgroundKind, wallpaperId: a.wallpaper, imagePath: a.image, photo: a.backgroundPhoto }} services={window.reva?.backgrounds} notify={notify} onSelect={selection => update(p => ({ ...p, appearance: selection.kind === "wallpaper" ? { ...p.appearance, backgroundKind: "wallpaper", wallpaper: selection.wallpaperId } : { ...p.appearance, backgroundKind: "image", image: selection.path, backgroundPhoto: selection.photo, backgroundImageSource: selection.sha256 ? { sha256: selection.sha256, downloadURL: selection.downloadURL, downloadedAt: selection.downloadedAt } : undefined } }))} />}
      {panel === "background" && <ScreenEnhancementPanel project={project} update={update} guide={socialSafeArea} onGuideChange={onSocialSafeAreaChange} />}
      {panel === "cursor" && <CursorInspector project={project} update={update} time={time} onSeek={onSeek} />}
      {(panel === "camera" || panel === "camera-processing") && <CameraInspector project={project} update={update} time={time} cameraPreview={cameraPreview} selectScene={selectScene} processing={panel === "camera-processing"} notify={notify} onCutout={onCutout} cutoutProgress={cutoutProgress} onCancelCutout={onCancelCutout} />}
      {panel === "camera-scene" && <CameraScenesPanel project={project} update={update} time={time} selectedId={selectedScene} onSelect={id => selectScene?.(id)} onSeek={onSeek} onCutout={onCutout} />}
      {(panel === "masks" || panel === "shortcuts") && <AnnotationsPanel project={project} update={update} time={time} previewTime={previewTime} selectedId={selectedMask} select={id => selectMask?.(id)} onSeek={onSeek} notify={notify} shortcuts={panel === "shortcuts"} />}
      {panel === "audio" && <AudioPanel project={project} outputTime={getOutputTime(project, time)} update={(value, group) => { const next = typeof value === "function" ? value(project) : value; update(next, group); if (group && /volume/i.test(group)) onVolumeAudition?.(next, time); }} notify={notify} services={window.reva?.audio} />}
      {panel === "motion" && <AnimationInspector project={project} update={update} />}
      {panel === "zoom" && (
        <>
          <h3>{t("Zoom")}</h3>
          {zoom ? (
            <>
              <Segmented value={zoom.presentation ?? "screen"} onChange={presentation => zoomChange({ presentation })} options={[{ value: "screen", label: "Screen" }, { value: "loupe", label: "Loupe" }]} />
              <Segmented
                value={zoom.mode}
                onChange={(mode) => zoomChange({ mode })}
                options={[
                  { value: "auto", label: "Follow cursor" },
                  { value: "manual", label: "Manual" },
                ]}
              />
              <Range
                label="Zoom level"
                value={zoom.scale}
                min={1}
                max={5}
                step={0.1}
                display={`${zoom.scale.toFixed(1)}×`}
                onChange={(scale) => zoomChange({ scale })}
              />
              {zoom.presentation === "loupe" && <><Range label="Lens size" value={zoom.loupeOptions?.radius01 ?? .35} min={.05} max={1} step={.01} onChange={radius01 => zoomChange({ loupeOptions: { ...(zoom.loupeOptions ?? { radius01: .35, bevelRatio: .2, chromaticAberration: .5, hasGlassOptics: true }), radius01 } })} /><Range label="Glass bevel" value={zoom.loupeOptions?.bevelRatio ?? .2} max={1} step={.01} onChange={bevelRatio => zoomChange({ loupeOptions: { ...(zoom.loupeOptions ?? { radius01: .35, bevelRatio: .2, chromaticAberration: .5, hasGlassOptics: true }), bevelRatio } })} /><Range label="Chromatic aberration" value={zoom.loupeOptions?.chromaticAberration ?? .5} max={1} step={.01} onChange={chromaticAberration => zoomChange({ loupeOptions: { ...(zoom.loupeOptions ?? { radius01: .35, bevelRatio: .2, chromaticAberration: .5, hasGlassOptics: true }), chromaticAberration } })} /><Toggle label="Glass optics" value={zoom.loupeOptions?.hasGlassOptics ?? true} onChange={hasGlassOptics => zoomChange({ loupeOptions: { ...(zoom.loupeOptions ?? { radius01: .35, bevelRatio: .2, chromaticAberration: .5, hasGlassOptics: true }), hasGlassOptics } })} /></>}
              <Toggle
                label="Instant zoom"
                description="Enter and leave this zoom without an animation."
                value={zoom.instant ?? false}
                onChange={(instant) => zoomChange({ instant })}
              />
              {zoom.mode === "manual" && (
                <>
                  <p className="panel-note">
                    {t("Click the preview to set your focal point.")}
                  </p>
                  <Range
                    label="Horizontal focus"
                    value={zoom.x}
                    max={1}
                    step={0.01}
                    display={`${Math.round(zoom.x * 100)}%`}
                    onChange={(x) => zoomChange({ x })}
                  />
                  <Range
                    label="Vertical focus"
                    value={zoom.y}
                    max={1}
                    step={0.01}
                    display={`${Math.round(zoom.y * 100)}%`}
                    onChange={(y) => zoomChange({ y })}
                  />
                </>
              )}
              <div className="two-fields">
                <label>
                  {t("Start")}
                  <NumberInput
                    label="Zoom start"
                    value={zoom.start}
                    min={project.trimStart}
                    max={zoom.end - 0.1}
                    onCommit={(start) => zoomChange({ start })}
                  />
                </label>
                <label>
                  {t("End")}
                  <NumberInput
                    label="Zoom end"
                    value={zoom.end}
                    min={zoom.start + 0.1}
                    max={project.trimEnd}
                    onCommit={(end) => zoomChange({ end })}
                  />
                </label>
              </div>
              <button
                className="outline-button full danger"
                onClick={() => {
                  update((p) => ({
                    ...p,
                    zooms: p.zooms.filter((z) => z.id !== zoom.id),
                  }));
                  selectZoom(null);
                }}
              >
                <Trash2 size={14} />
                {t("Remove zoom")}
              </button>
            </>
          ) : (
            <p className="panel-note">
              {t(
                "Click the purple timeline to add a zoom, then select it to adjust the framing.",
              )}
            </p>
          )}
        </>
      )}
      {panel === "transcript" && <>
        <button className="outline-button editor-back" onClick={onCloseTranscript}><ArrowLeft size={19} />{t("Close Transcript editor")}</button>
        <TranscriptPanel project={project} update={update} time={time} notify={notify} services={window.reva?.speech} progress={speechProgress} onSeek={onSeek} editor onOpenGeneration={onCloseTranscript} />
      </>}
      {panel === "captions" && (
        <>
          <TranscriptPanel project={project} update={update} time={time} notify={notify} services={window.reva?.speech} progress={speechProgress} onSeek={onSeek} />
          <hr />
          <details className="manual-caption-controls" open={project.captions.length > 0}><summary>{t("Manual captions")}</summary>
          <h3>{t("Captions")}</h3>
          <button
            disabled={!project.mediaPath}
            className="outline-button full"
            onClick={() => {
              const id = crypto.randomUUID();
              update((p) => ({
                ...p,
                captions: [
                  ...p.captions,
                  {
                    id,
                    text: t("Your caption here"),
                    start: clamp(time, p.trimStart, p.trimEnd - 0.1),
                    end: Math.min(time + 3, p.trimEnd),
                    x: 0.5,
                    y: 0.88,
                    size: 32,
                    color: "#ffffff",
                  },
                ],
              }));
              setSelectedCaption(id);
            }}
          >
            <Plus size={15} />
            {t("Add caption at playhead")}
          </button>
          {project.captions.length > 0 && (
            <div className="caption-list">
              {project.captions.map((c) => (
                <button
                  className={caption?.id === c.id ? "selected" : ""}
                  key={c.id}
                  onClick={() => setSelectedCaption(c.id)}
                >
                  <span>{c.text}</span>
                  <small>
                    {formatTime(c.start)} — {formatTime(c.end)}
                  </small>
                </button>
              ))}
            </div>
          )}
          {caption ? (
            <>
              <textarea
                aria-label={t("Caption text")}
                value={caption.text}
                onChange={(e) => editCaption({ text: e.target.value })}
                rows={3}
              />
              <div className="two-fields">
                <label>
                  {t("Start")}
                  <NumberInput
                    label="Caption start"
                    value={caption.start}
                    min={0}
                    max={caption.end - 0.1}
                    onCommit={(start) => editCaption({ start })}
                  />
                </label>
                <label>
                  {t("End")}
                  <NumberInput
                    label="Caption end"
                    value={caption.end}
                    min={caption.start + 0.1}
                    max={project.duration}
                    onCommit={(end) => editCaption({ end })}
                  />
                </label>
              </div>
              <Range
                label="Text size"
                value={caption.size}
                min={14}
                max={90}
                display={t("{value}px", { value: caption.size })}
                onChange={(size) => editCaption({ size })}
              />
              <Range
                label="Vertical position"
                value={caption.y}
                max={1}
                step={0.01}
                display={`${Math.round(caption.y * 100)}%`}
                onChange={(y) => editCaption({ y })}
              />
              <div className="color-field">
                <label>{t("Text color")}</label>
                <input
                  type="color"
                  aria-label={t("Caption color")}
                  value={caption.color}
                  onChange={(e) => editCaption({ color: e.target.value })}
                />
              </div>
              <button
                className="outline-button full danger"
                onClick={() =>
                  update((p) => ({
                    ...p,
                    captions: p.captions.filter((c) => c.id !== caption.id),
                  }))
                }
              >
                <Trash2 size={14} />
                {t("Remove caption")}
              </button>
            </>
          ) : (
            <div className="empty-panel">
              <AlignCenter size={28} />
              <p>{t("Add timed text to tell your story.")}</p>
            </div>
          )}
          </details>
        </>
      )}
    </aside>
  );
}
