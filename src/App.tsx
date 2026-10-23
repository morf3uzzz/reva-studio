import { t, useLanguage, initializeLanguage } from "./i18n";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUpFromLine,
  Check,
  ChevronDown,
  Command,
  Crop,
  FolderOpen,
  LoaderCircle,
  MessageSquare,
  Quote,
  Plus,
  Redo2,
  Save,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  Video,
  WandSparkles,
  X,
  ZoomIn,
  Focus,
  PanelLeft,
  UserRound,
  UserRoundX,
  RectangleEllipsis,
  CircleDot,
  Highlighter,
  Shield,
} from "lucide-react";
import type {
  AudioWaveform,
  Appearance,
  ExportOptions,
  MediaInfo,
  Project,
  QuickExportSettings,
  RecordingResult,
  SavedPreset,
} from "./types";
import { SHORTCUTS, shortcutKeys, type AppPreferences } from "./app-preferences";
import { matchesShortcut } from "./core/shortcuts";
import { nextShuttleRate, shuttlePosition } from "./core/shuttle";
import { useProject, seekVideo, loadVideo, loadImage } from "./hooks";
import {
  BACKGROUNDS,
  clamp,
  createProject,
  defaultAppearance,
  formatTime,
  generateAutoZooms,
  getDuration,
  getLastFrameTime,
  getMediaTime,
  getOutputTime,
  formatTimecode,
  getOutputSizeForHeight,
  getOutputAspect,
  getScreenGeometry,
  createScreenAnimator,
  sourcePointToScreen,
} from "./core/model";
import { drawCompositeFrame as drawFrame } from "./core/compositor";
import { createPreviewRenderer } from "./core/preview-render";
import { createPlaybackController, previewMediaRate, seekMedia, mediaTimelineEnd } from "./core/playback";
import { CameraMatte } from "./core/camera-matte";
import { cameraSourceTime } from "./core/camera-effects";
import type { SocialSafeArea } from "./core/screen-effects";
import { cursorGeometryAt, prepareCursorAssets } from "./core/cursor-render";
import { useMixedAudio } from "./useMixedAudio";
import RecoveryDialog from "./RecoveryDialog";
import { previewLayerAt, previewLayerRect } from "./core/preview-hit";
import { wallpaperURL } from "./core/wallpapers";
import {
  getSlices,
  selectSlice,
  splitSlice,
  splitZoom,
  newZoomRange,
  removeSlice,
} from "./core/timeline";
import {
  IconButton,
  Modal,
  ScissorsIcon,
  TransportButton,
} from "./components";
import Inspector, { type Panel } from "./Inspector";
import Timeline from "./Timeline";
import PreviewToolbar from "./PreviewToolbar";
import ReferenceIcon from "./ReferenceIcon";
import Tooltip from "./Tooltip";
import PlaybackSpeed from "./PlaybackSpeed";
import PresetsPopover from "./PresetsPopover";
import InsertionOverlay, { type InsertTool } from "./InsertionOverlay";
import { addManualMask, newCameraScene } from "./core/editor-insert";
import type { CameraSceneLayout } from "./core/camera-effects";
import { MaskEditorOverlay } from "./AnnotationsPanel";
import CommandPalette, { type EditorCommand } from "./CommandPalette";
import { fittedPreviewHeight, nextPreviewHeight, previewBackingSize, PREVIEW_HEIGHTS } from "./core/preview";
import { timelineVisibleSeconds, timelineSliderValue, timelineSliderSeconds, timelineZoomLabel } from "./core/timeline-viewport";
import { ExportDialog, ShortcutsDialog } from "./Dialogs";

const TAB_ITEMS = [
  { id: "background", icon: "inset.filled.square.dashed", label: "General" },
  { id: "cursor", icon: "cursorarrow", label: "Cursor" },
  { id: "camera", icon: "inset.filled.rectangle.and.person.filled", label: "Camera Layout" },
  { id: "camera-processing", icon: "person.fill.viewfinder", label: "Camera Style" },
  { id: "captions", icon: "captions.bubble", label: "Captions" },
  { id: "transcript", icon: "captions.bubble", label: "Transcript" },
  { id: "audio", icon: "speaker.wave.1", label: "Audio" },
  { id: "shortcuts", icon: "command", label: "Recorded shortcuts" },
  { id: "motion", icon: "point.topleft.down.to.point.bottomright.curvepath.fill", label: "Animations" },
] as const;
const EMPTY = createProject();
const mediaURL = (path: string) => window.reva?.mediaURL(path) ?? path;

function previewFrameAt(project: Project, time: number, width: number, height: number, animator: ReturnType<typeof createScreenAnimator>) {
  const frame = getScreenGeometry(project, time, width, height, 60, animator);
  const cursor = cursorGeometryAt(project, time, frame.crop, frame.rect, { fps: 60 });
  return { ...frame, cursor: cursor?.bounds ?? null };
}

export default function App() {
  const [language, changeLanguage] = useLanguage();
  const previewAnimator = useRef(createScreenAnimator(60));
  const previewMatte = useRef(new CameraMatte());
  const renderPreview = useRef(createPreviewRenderer());
  const playback = useRef<ReturnType<typeof createPlaybackController> | null>(null);
  const previewPointer = useRef<{ x: number; y: number } | null>(null);
  const previewHoverTime = useRef<number | null>(null);
  const renderError = useRef<string | null>(null);
  const { project, update, reset, undo, redo, canUndo, canRedo } =
    useProject(EMPTY);
  const projectRef = useRef(project);
  const projectGeneration = useRef(0);
  const automaticDocument = useRef({ generation: -1, id: crypto.randomUUID() });
  const automaticDocumentID = () => { if (automaticDocument.current.generation !== projectGeneration.current) automaticDocument.current = { generation: projectGeneration.current, id: crypto.randomUUID() }; return automaticDocument.current.id; };
  const initialProjectTime = useRef<number | null>(null);
  projectRef.current = project;
  const canvas = useRef<HTMLCanvasElement>(null),
    video = useRef<HTMLVideoElement>(null),
    camera = useRef<HTMLVideoElement>(null),
    cameraMask = useRef<HTMLVideoElement>(null),
    mic = useRef<HTMLAudioElement>(null),
    backgroundImage = useRef<HTMLImageElement | null>(null);
  const [hoverPreviewTime, setHoverPreviewTime] = useState<number | null>(null);
  const [time, setTime] = useState(0),
    timeRef = useRef(0),
    [playing, setPlaying] = useState(false);
  // The inspector owns the timeline selection: switching panels cannot leave a
  // hidden selection behind that keeps unrelated clips dimmed.
  const [inspector, setInspector] = useState<{ panel: Panel; itemId: string | null }>({ panel: "background", itemId: null });
  const [insertTool, setInsertTool] = useState<InsertTool | null>(null);
  useEffect(() => setInsertTool(null), [project.mediaPath]);
  useEffect(() => { if (!insertTool) return; const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setInsertTool(null); } }; window.addEventListener("keydown", cancel); return () => window.removeEventListener("keydown", cancel); }, [insertTool]);
  const panel = inspector.panel;
  const selectedZoom = panel === "zoom" ? inspector.itemId : null;
  const selectedSlice = panel === "slice" ? inspector.itemId : null;
  const selectedMask = panel === "masks" ? inspector.itemId : null;
  const selectedScene = panel === "camera-scene" ? inspector.itemId : null;
  const setPanel = useCallback((panel: Panel) => setInspector({ panel, itemId: null }), []);
  const selectTimelineItem = useCallback((panel: "slice" | "zoom" | "masks" | "camera-scene", itemId: string | null) => setInspector({ panel, itemId }), []);
  useEffect(() => {
    if (inspector.itemId && !(panel === "zoom" ? project.zooms : panel === "masks" ? project.masks ?? [] : panel === "camera-scene" ? project.cameraScenes ?? [] : getSlices(project)).some(item => item.id === inspector.itemId)) setPanel("background");
  }, [inspector, panel, project, setPanel]);
  const quickExport = useRef<(project: Project, settings: QuickExportSettings, destination: "file" | "clipboard") => void>(() => {});
  const quickExportOwner = useRef<{ generation: number; mediaPath: string | null } | null>(null);
  const [requestedTimelineSeconds, setTimelineSeconds] = useState(30);
  const timelineDuration = getDuration(project) || 15;
  const visibleTimelineSeconds = timelineVisibleSeconds(timelineDuration, requestedTimelineSeconds);
  const timelineScale = timelineDuration / visibleTimelineSeconds;
  const setTimelineScale = useCallback((scale: number) => setTimelineSeconds(timelineDuration / scale), [timelineDuration]);
  useEffect(() => setTimelineSeconds(30), [project.mediaPath]);
  const [previewMaximumHeight, setPreviewMaximumHeight] = useState(() => {
    try { const value = Number(localStorage.getItem("reva-preview-height")); return PREVIEW_HEIGHTS.some(height => height === value) ? value : 1080; } catch { return 1080; }
  });
  const [previewQuality, setPreviewQuality] = useState(() => {
    try { const saved = Number(localStorage.getItem("reva-preview-quality")); return [1, 0.5, 0.25].includes(saved) ? saved : 1; } catch { return 1; }
  });
  const [cutLatched, setCutLatched] = useState(false), [cutHeld, setCutHeld] = useState(false);
  const cutMode = cutLatched || cutHeld;
  const [previewRate, setPreviewRate] = useState(1), previewRateRef = useRef(previewRate);
  previewRateRef.current = previewRate;
  const [audioScrubber, setAudioScrubber] = useState(false);
  const [reversePlaying, setReversePlaying] = useState(false);
  const reversePlayingRef = useRef(false); reversePlayingRef.current = reversePlaying;
  const [socialSafeArea, setSocialSafeArea] = useState<SocialSafeArea>("off");
  const playbackSlice = useRef<string | null>(null);
  const [dialog, setDialog] = useState<
      "export" | "shortcuts" | "presets" | "commands" | "recovery" | null
    >(null),
    [projectPath, setProjectPath] = useState<string | null>(null),
    [savedSnapshot, setSavedSnapshot] = useState(JSON.stringify(EMPTY));
  const [notice, setNotice] = useState<string | null>(null),
    noticeTimer = useRef<number | undefined>(undefined);
  const [waveforms, setWaveforms] = useState<AudioWaveform[]>([]),
    [recording, setRecording] = useState(false),
    [recordingAt, setRecordingAt] = useState(0),
    [elapsed, setElapsed] = useState(0);
  const [exportProgress, setExportProgress] = useState<number | null>(null),
    [exportOutput, setExportOutput] = useState<string | null>(null),
    [exportOutputs, setExportOutputs] = useState<string[]>([]),
    exportState = useRef<{ id: string | null; cancelled: boolean }>({
      id: null,
      cancelled: false,
    });
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null),
    [renaming, setRenaming] = useState(false);
  const [privacyProgress, setPrivacyProgress] = useState<number | null>(null);
  const [cutoutProgress, setCutoutProgress] = useState<number | null>(null);
  const cutoutJob = useRef<{ path: string; cancelled: boolean } | null>(null);
  const [importing, setImporting] = useState(false);
  const privacyJob = useRef<{ source: string; cancelled: boolean } | null>(
    null,
  );
  const [presets, setPresets] = useState<SavedPreset[]>([]);
  const [appPreferences, setAppPreferences] = useState<AppPreferences | null>(null);
  const [defaultPreset, setDefaultPreset] = useState<string | null>(null);
  const presetButton = useRef<HTMLButtonElement>(null);
  const allowClose = useRef(false);
  const stage = useRef<HTMLDivElement>(null),
    [stageSize, setStageSize] = useState({ width: 950, height: 560 });
  const [previewPixelRatio, setPreviewPixelRatio] = useState(() => window.devicePixelRatio || 1);
  const dirty =
    !!project.mediaPath && savedSnapshot !== JSON.stringify(project);
  const [recovering, setRecovering] = useState(false);
  const busy =
    exportProgress !== null ||
    recording ||
    privacyProgress !== null ||
    cutoutProgress !== null ||
    importing || recovering;
  const automaticSaveState = useRef({ projectPath, savedSnapshot, busy }); automaticSaveState.current = { projectPath, savedSnapshot, busy };
  const savingAutomatically = useRef(false);
  const previewAspect = getOutputAspect(project);
  const fittedHeight = Math.max(1, fittedPreviewHeight(stageSize.width, stageSize.height, previewAspect, previewMaximumHeight));
  const fittedWidth = fittedHeight * previewAspect;
  const size = previewBackingSize(fittedWidth, fittedHeight, previewPixelRatio, previewQuality);
  const smallerPreview = nextPreviewHeight(stageSize.width, stageSize.height, previewAspect, previewMaximumHeight, "smaller");
  const largerPreview = nextPreviewHeight(stageSize.width, stageSize.height, previewAspect, previewMaximumHeight, "larger");
  const setPreviewHeight = (value: number) => { setPreviewMaximumHeight(value); localStorage.setItem("reva-preview-height", String(value)); };
  const notify = useCallback((message: string) => {
    setNotice(message);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 6000);
  }, []);
  const errorMessage = (e: unknown) =>
    e instanceof Error ? e.message : String(e);
  const { audition: auditionTimeline, stop: stopScrubber } = useMixedAudio({ project, time, scrubEnabled: audioScrubber, playing: playing || reversePlaying, rate: reversePlaying ? -previewRate : previewRate, onError: notify });
  playback.current ??= createPlaybackController(setPlaying, error => notify(errorMessage(error)));
  useEffect(() => {
    void initializeLanguage().catch((error) => notify(errorMessage(error)));
    void window.reva?.getAppPreferences().then(setAppPreferences).catch(error => notify(errorMessage(error)));
    return window.reva?.onAppPreferences(setAppPreferences);
  }, [notify]);
  useEffect(() => { void window.reva?.setProjectOpen(!!project.mediaPath).catch(error => notify(errorMessage(error))); }, [project.mediaPath, notify]);
  const refreshPresets = useCallback(async () => {
    if (!window.reva) return;
    const library = await window.reva.listPresets(); setPresets(library.presets); setDefaultPreset(library.defaultPresetID);
    if (library.issues.length) notify(library.issues.map(issue => `${issue.file}: ${issue.message}`).join("\n"));
  }, [notify]);
  useEffect(() => { if (dialog === "presets") void refreshPresets().catch(error => notify(errorMessage(error))); }, [dialog, appPreferences?.presetsFolderPath, refreshPresets, notify]);
  useEffect(() => {
    if (!project.mediaPath || !window.reva) return;
    const timer = window.setTimeout(() => { void window.reva?.rememberProjectAppearance(projectRef.current).catch(error => notify(errorMessage(error))); }, 1500);
    return () => clearTimeout(timer);
  }, [project.appearance, project.mediaPath, notify]);
  useEffect(() => {
    if (!appPreferences?.autoSaveProject || !project.mediaPath || !window.reva) return;
    const timer = window.setInterval(() => {
      const snapshot = projectRef.current, current = automaticSaveState.current, serialized = JSON.stringify(snapshot), generation = projectGeneration.current;
      if (current.busy || savingAutomatically.current || !snapshot.mediaPath || current.savedSnapshot === serialized) return;
      savingAutomatically.current = true;
      void window.reva!.autoSaveProject(snapshot, current.projectPath, automaticDocumentID()).then(file => { if (generation === projectGeneration.current) { setProjectPath(file); setSavedSnapshot(serialized); } }).catch(error => notify(errorMessage(error))).finally(() => { savingAutomatically.current = false; });
    }, 30000);
    return () => clearInterval(timer);
  }, [appPreferences?.autoSaveProject, !!project.mediaPath, notify]);

  const changePrivacy = async (
    kind: "sensitive" | "faces",
    enabled: boolean,
  ) => {
    const p = projectRef.current;
    if (!p.mediaPath || privacyJob.current) return;
    const privacy = p.privacy ?? {
      sensitive: false,
      faces: false,
      analysis: null,
    };
    const phrasesCurrent = JSON.stringify([...(privacy.customPhrases ?? [])].sort()) === JSON.stringify([...(privacy.analysis?.settings.customPhrases ?? [])].sort());
    if (!enabled || (privacy.analysis?.settings[kind] && (kind !== "sensitive" || phrasesCurrent))) {
      update((p) => ({ ...p, privacy: { ...privacy, [kind]: enabled } }));
      return;
    }
    const api = window.reva;
    if (!api) {
      notify("Open the macOS app to analyze your recording.");
      return;
    }
    const job = { source: p.mediaPath, cancelled: false };
    privacyJob.current = job;
    setPrivacyProgress(0);
    try {
      const settings = {
        sensitive:
          privacy.sensitive ||
          !!privacy.analysis?.settings.sensitive ||
          kind === "sensitive",
        faces:
          privacy.faces ||
          !!privacy.analysis?.settings.faces ||
          kind === "faces",
        customPhrases: privacy.customPhrases ?? [],
      };
      const analysis = await api.analyzePrivacy(job.source, settings);
      if (
        analysis &&
        !job.cancelled &&
        projectRef.current.mediaPath === job.source
      ) {
        update((p) => ({
          ...p,
          privacy: { ...privacy, [kind]: true, analysis },
        }));
        notify(
          t(
            "Analysis complete. {count} detected regions. Review the video before sharing.",
            { count: analysis.regions.length },
          ),
        );
      }
    } catch (e) {
      if (!job.cancelled) notify(errorMessage(e));
    } finally {
      if (privacyJob.current === job) {
        privacyJob.current = null;
        setPrivacyProgress(null);
      }
    }
  };
  const cancelPrivacy = async () => {
    if (privacyJob.current) privacyJob.current.cancelled = true;
    await window.reva?.cancelPrivacy();
  };
  useEffect(
    () =>
      window.reva?.onPrivacyProgress((progress) => {
        if (privacyJob.current) setPrivacyProgress(progress);
      }),
    [],
  );

  const segmentCamera = async () => {
    const api = window.reva, path = projectRef.current.cameraPath;
    if (!api || !path || cutoutJob.current) return;
    const job = { path, cancelled: false };
    cutoutJob.current = job; setCutoutProgress(0);
    try {
      const mask = await api.segmentCamera(path);
      if (mask && !job.cancelled) update(p => p.cameraPath === path ? { ...p, cameraMask: mask } : p);
    } catch (error) { if (!job.cancelled) notify(errorMessage(error)); }
    finally { if (cutoutJob.current === job) { cutoutJob.current = null; setCutoutProgress(null); } }
  };
  const cancelCameraSegmentation = async () => {
    if (cutoutJob.current) cutoutJob.current.cancelled = true;
    await window.reva?.cancelCameraSegmentation();
  };
  useEffect(() => window.reva?.onCameraSegmentationProgress(progress => {
    if (cutoutJob.current) setCutoutProgress(progress);
  }), []);
  useEffect(() => () => previewMatte.current.dispose(), []);

  const positionMedia = useCallback((next: number) => {
    const p = projectRef.current;
    const selected = selectSlice(
      p,
      getOutputTime(p, clamp(next, 0, p.duration)),
    );
    const t = selected?.sourceTime ?? 0;
    for (const [media, path, volume] of [
      [video.current, p.mediaPath, p.appearance.volume],
      [camera.current, p.cameraPath, p.appearance.cameraVolume],
      [mic.current, p.microphonePath, p.appearance.microphoneVolume],
    ] as const)
      if (media && path) {
        seekMedia(media, media === camera.current ? cameraSourceTime(p, t, mediaTimelineEnd(media, p.cameraEndTime ?? p.duration)) : t);
        media.playbackRate = previewMediaRate(selected?.slice.speed ?? p.speed, previewRateRef.current);
        media.volume = volume * (selected?.slice.volume ?? 1);
      }
    if (cameraMask.current && p.cameraMask) {
      seekMedia(cameraMask.current, clamp(cameraSourceTime(p, t) - p.cameraMask.sourceTimeOrigin, 0, Math.max(0, p.cameraMask.duration - 0.001)));
      cameraMask.current.playbackRate = previewMediaRate(selected?.slice.speed ?? p.speed, previewRateRef.current);
    }
    return { time: t, slice: selected?.slice.id ?? null };
  }, []);
  const seek = useCallback((next: number) => {
    previewHoverTime.current = null;
    setHoverPreviewTime(null);
    const selected = positionMedia(next);
    playbackSlice.current = selected.slice;
    timeRef.current = selected.time;
    setTime(selected.time);
  }, [positionMedia]);
  useLayoutEffect(() => {
    // A same-file project reload does not emit loadedmetadata again. Position
    // media after React commits the new project even when its src is unchanged.
    const initial = initialProjectTime.current;
    if (initial === null) return;
    initialProjectTime.current = null;
    seek(initial);
  }, [project, seek]);
  const previewTimelineTime = useCallback((next: number | null) => {
    if (playback.current?.requested || !video.current?.paused) return;
    previewHoverTime.current = next;
    setHoverPreviewTime(next);
    positionMedia(next ?? timeRef.current);
    auditionTimeline(next);
  }, [positionMedia, auditionTimeline]);
  const seekTimeline = useCallback((next: number) => {
    seek(next);
    if (!playback.current?.requested && video.current?.paused) auditionTimeline(next);
  }, [seek, auditionTimeline]);
  const pause = useCallback(() => {
    stopScrubber();
    if (video.current && !video.current.paused) {
      timeRef.current = video.current.currentTime;
      setTime(timeRef.current);
    }
    playback.current?.pause(); setReversePlaying(false);
  }, [stopScrubber]);
  useEffect(() => () => playback.current?.pause(), []);
  const playForward = useCallback(() => {
    stopScrubber(); setReversePlaying(false);
    const v = video.current, p = projectRef.current; if (!v || !p.mediaPath) return;
    const start = previewHoverTime.current === null ? v.currentTime : timeRef.current;
    seek(getMediaTime(p, getOutputTime(p, start) >= getDuration(p) - .02 ? 0 : getOutputTime(p, start)));
    playback.current?.play(v, [p.cameraPath ? camera.current : null, p.cameraMask ? cameraMask.current : null, p.microphonePath ? mic.current : null].filter(media => media !== null));
  }, [seek, stopScrubber]);
  const togglePlay = useCallback(() => {
    stopScrubber();
    const v = video.current,
      p = projectRef.current;
    if (!v || !p.mediaPath) return;
    if (reversePlayingRef.current || playback.current?.requested || !v.paused) {
      pause();
      return;
    }
    playForward();
  }, [pause, playForward, stopScrubber]);
  useEffect(() => {
    if (!reversePlaying) return;
    let frame = 0, last = performance.now();
    const tick = (now: number) => { if (now - last >= 1000 / 30) { const position = shuttlePosition(projectRef.current, timeRef.current, (now - last) / 1000, -previewRate); last = now; seek(position.sourceTime); if (position.atEnd) { pause(); return; } } frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [reversePlaying, previewRate, seek, pause]);
  useEffect(() => { if (project.mediaPath) positionMedia(timeRef.current); }, [project.appearance.cameraDelayMs, positionMedia, project.mediaPath]);
  const guard = (action: () => void) => {
    pause();
    if (dirty) setPendingAction(() => action);
    else action();
  };
  const loadProject = (p: Project, path: string | null = null) => {
    pause();
    projectGeneration.current++;
    previewHoverTime.current = null;
    initialProjectTime.current = getMediaTime(p, 0);
    reset(p);
    setProjectPath(path);
    setSavedSnapshot(path ? JSON.stringify(p) : "");
    setTime(getMediaTime(p, 0));
    timeRef.current = getMediaTime(p, 0);
    playbackSlice.current = getSlices(p)[0]?.id ?? null;
    setCutLatched(false); setCutHeld(false);
    setPanel("background");
  };
  const importVideo = async () => {
    try {
      if (!window.reva) {
        notify("Open REVA Studio.app to import and edit local videos.");
        return;
      }
      const media = await window.reva.importVideo();
      if (media) {
        const next = createProject(media), appearance = await window.reva.getNewProjectAppearance();
        if (appearance) next.appearance = { ...appearance, crop: next.appearance.crop };
        loadProject(next);
      }
    } catch (e) {
      notify(errorMessage(e));
    }
  };
  const openProject = async () => {
    try {
      const result = await window.reva?.openProject();
      if (result) loadProject(result.project, result.path);
    } catch (e) {
      notify(errorMessage(e));
    }
  };
  const importScreenStudioProject = async () => {
    const api = window.reva;
    if (!api) return;
    setImporting(true);
    try {
      const result = await api.importScreenStudio();
      if (!result) return;
      const base = createProject(result.mediaInfo);
      loadProject({
        ...base,
        cameraPath: result.cameraPath ?? null,
        cameraSource: result.cameraSource,
        cursorSourceSize: result.cursorSourceSize,
        pauseMarkers: result.pauseMarkers,
        typingRanges: result.typingRanges,
        resolvedTypingSuggestions: result.resolvedTypingSuggestions,
        microphonePath: result.microphonePath ?? null,
        cursor: result.cursor,
        zooms: result.zooms,
        slices: result.slices,
        appearance: { ...base.appearance, ...result.appearancePatch },
        cameraScenes: result.cameraScenes,
        masks: result.masks,
        audio: result.audio,
        captionSettings: result.captionSettings,
      });
      notify(
        result.warnings.length
          ? `Project imported. ${result.warnings.join(" ")}`
          : "Screen Studio project imported.",
      );
    } catch (e) {
      notify(errorMessage(e));
    } finally {
      setImporting(false);
    }
  };
  const save = async (saveAs = false) => {
    try {
      if (!project.mediaPath) return null;
      const path = await window.reva?.saveProject(
        project,
        saveAs ? null : projectPath,
      );
      if (path) {
        setProjectPath(path);
        setSavedSnapshot(JSON.stringify(project));
        notify("Project saved.");
        return path;
      }
      return null;
    } catch (e) {
      notify(errorMessage(e));
      return null;
    }
  };
  const addZoom = (at = time, point?: { x: number; y: number; presentation: "screen" | "loupe" }) => {
    if (!project.mediaPath) return;
    const range = newZoomRange(project, at);
    if (!range) return;
    const id = crypto.randomUUID();
    update((p) => ({
      ...p,
      zooms: [
        ...p.zooms,
        {
          id,
          ...range,
          scale: 2,
          x: point?.x ?? 0.5,
          y: point?.y ?? 0.5,
          presentation: point?.presentation,
          mode: !point && p.cursor.length ? ("auto" as const) : ("manual" as const),
        },
      ].sort((a, b) => a.start - b.start),
    }));
    selectTimelineItem("zoom", id);
  };
  const insertScene = (type: CameraSceneLayout["type"], point?: { x: number; y: number }) => {
    const scene = newCameraScene(project, time, type, point); if (!scene) return;
    update(p => ({ ...p, cameraScenes: [...(p.cameraScenes ?? []), scene] })); selectTimelineItem("camera-scene", scene.id); setInsertTool(null);
    if (type === "cutout-camera" && project.cameraPath && !project.cameraMask) void segmentCamera();
  };
  useEffect(() => { if (!project.cameraPath && (insertTool === "camera-overlay" || insertTool === "cutout-camera")) setInsertTool(null); }, [project.cameraPath, insertTool]);
  const beginInsert = (tool: InsertTool) => { pause(); setInsertTool(value => value === tool ? null : tool); };
  const splitClip = (id: string, at: number) => {
    try {
      update((p) => ({ ...p, slices: splitSlice(p, id, at) }));
    } catch (e) {
      notify(errorMessage(e));
    }
  };
  const splitZoomClip = (id: string, at: number) => {
    update(p => {
      const zooms = splitZoom(p, id, at);
      return zooms === p.zooms ? p : { ...p, zooms };
    });
  };
  const removeClip = () => {
    const p = projectRef.current;
    if (!selectedSlice || getSlices(p).length <= 1) return;
    pause();
    update({ ...p, slices: removeSlice(p, selectedSlice) });
    setPanel("background");
  };
  const trimAtPlayhead = (edge: "start" | "end") => {
    update((p) => {
      const slices = getSlices(p).flatMap((s) => {
        const start = edge === "start" ? Math.max(s.start, time) : s.start;
        const end = edge === "end" ? Math.min(s.end, time) : s.end;
        return end - start >= 0.05 ? [{ ...s, start, end }] : [];
      });
      return slices.length
        ? {
            ...p,
            slices,
            trimStart: slices[0].start,
            trimEnd: slices.at(-1)!.end,
          }
        : p;
    });
  };
  const autoZoom = () => {
    if (!project.cursor.length) {
      notify(
        "Automatic zoom uses clicks captured during a REVA Studio recording. Add a manual zoom for imported videos.",
      );
      return;
    }
    const zooms = generateAutoZooms(project.cursor, project.duration);
    update((p) => ({ ...p, zooms }));
    notify(
      t("{count} zooms created from your clicks.", { count: zooms.length }),
    );
  };
  const handleRecorded = useCallback(
    async (result: RecordingResult) => {
      pause();
      projectGeneration.current++;
      previewHoverTime.current = null;
      let p = createProject(result);
      initialProjectTime.current = 0;
      p.cursor = result.cursor ?? [];
      p.cameraPath = result.cameraPath ?? null;
      p.cameraSource = result.cameraSource;
      p.cameraStartTime = result.cameraStartTime;
      p.cameraEndTime = result.cameraEndTime;
      p.cursorSourceSize = result.cursorSourceSize;
      p.pauseMarkers = result.pauseMarkers;
      p.recordingFlags = result.recordingFlags;
      p.recoverySource = result.recoverySource;
      p.recoveryIssues = result.issues;
      p.shortcuts = result.shortcuts;
      p.typingRanges = result.typingRanges;
      p.microphonePath = result.microphonePath ?? null;
      p.zooms = result.afterRecording?.autoZoom === false ? [] : generateAutoZooms(p.cursor, p.duration);
      const generation = projectGeneration.current;
      try {
        const appearance = await window.reva?.getNewProjectAppearance();
        if (generation !== projectGeneration.current) return;
        if (appearance) p = { ...p, appearance: { ...appearance, crop: p.appearance.crop } };
      } catch (error) { notify(errorMessage(error)); }
      if (generation !== projectGeneration.current) return;
      reset(p);
      setProjectPath(null);
      setSavedSnapshot("");
      setTime(0);
      timeRef.current = 0;
      setPanel("background");
      setRecording(false);
      setDialog(null);
      notify(result.issues?.length ? `Recording recovered. ${result.issues.map(issue => issue.message).join(" ")}` : "Recording ready. Make it yours.");
      if (result.afterRecording && result.afterRecording.destination !== "project") quickExport.current(p, result.afterRecording.settings, result.afterRecording.destination);
    },
    [reset, notify, pause],
  );
  const openRecording = async () => {
    pause();
    try { await window.reva?.openRecordingPanel(); }
    catch (error) { notify(errorMessage(error)); }
  };
  useEffect(() => {
    const owner = projectGeneration.current; let mounted = true;
    void window.reva?.listRecordingRecovery().then(listing => { if (mounted && owner === projectGeneration.current && listing.recordings.some(item => !item.recoveredPath)) setDialog("recovery"); }).catch(error => { if (mounted) notify(errorMessage(error)); });
    return () => { mounted = false; };
  }, [notify]);
  const openCrop = async () => {
    const p = projectRef.current;
    if (!window.reva || !p.mediaPath) return;
    const owner = projectGeneration.current;
    pause();
    try {
      const crop = await window.reva.editCrop({ mediaPath: p.mediaPath, time: timeRef.current, crop: p.appearance.crop });
      if (crop && owner === projectGeneration.current) update(current => current.mediaPath === p.mediaPath ? { ...current, appearance: { ...current.appearance, crop } } : current, "crop");
    } catch (error) { notify(errorMessage(error)); }
  };
  const stopRecording = async () => {
    try {
      await window.reva?.stopRecording();
    } catch (e) {
      notify(errorMessage(e));
    }
  };

  useEffect(() => {
    const api = window.reva;
    if (!api) return;
    const started = api.onRecordingStarted(timestamp => { setRecording(true); setRecordingAt(timestamp); setElapsed(0); });
    const idle = api.onRecordingIdle(() => setRecording(false));
    const off = api.onRecordingStopped(handleRecorded),
      err = api.onError((message) => {
        notify(message);
      });
    return () => {
      started();
      idle();
      off();
      err();
    };
  }, [handleRecorded, notify]);
  useEffect(() => {
    if (!stage.current) return;
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setStageSize({ width, height });
    });
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let resolution: MediaQueryList;
    const changed = () => {
      resolution?.removeEventListener("change", changed);
      const ratio = window.devicePixelRatio || 1;
      setPreviewPixelRatio(ratio);
      resolution = window.matchMedia(`(resolution: ${ratio}dppx)`);
      resolution.addEventListener("change", changed);
    };
    changed();
    return () => resolution.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(
      () => setElapsed((Date.now() - recordingAt) / 1000),
      250,
    );
    return () => clearInterval(timer);
  }, [recording, recordingAt]);
  useEffect(() => {
    const p = project;
    const selected = selectSlice(p, getOutputTime(p, timeRef.current));
    playbackSlice.current = selected?.slice.id ?? null;
    const speed = previewMediaRate(selected?.slice.speed ?? p.speed, previewRate);
    const volume = selected?.slice.volume ?? 1;
    if (selected && Math.abs(selected.sourceTime - timeRef.current) > 0.001)
      seek(selected.sourceTime);
    if (video.current) {
      video.current.playbackRate = speed;
      video.current.volume = p.appearance.volume * volume;
    }
    if (camera.current) {
      camera.current.playbackRate = speed;
      camera.current.volume = p.appearance.cameraVolume * volume;
    }
    if (mic.current) {
      mic.current.playbackRate = speed;
      mic.current.volume = p.appearance.microphoneVolume * volume;
    }
    if (cameraMask.current) cameraMask.current.playbackRate = speed;
  }, [
    previewRate,
    project.speed,
    project.slices,
    project.trimStart,
    project.trimEnd,
    project.appearance.volume,
    project.appearance.microphoneVolume,
    project.appearance.cameraVolume,
    seek,
  ]);
  useEffect(() => {
    backgroundImage.current = null;
    const appearance = project.appearance;
    const url =
      appearance.backgroundKind === "wallpaper"
        ? wallpaperURL(appearance.wallpaper)
        : appearance.backgroundKind === "image" && appearance.image
          ? mediaURL(appearance.image)
          : null;
    if (!url) return;
    let live = true;
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (live) backgroundImage.current = img;
    };
    img.onerror = () => notify("The background image could not be loaded.");
    img.src = url;
    return () => {
      live = false;
    };
  }, [
    project.appearance.image,
    project.appearance.backgroundKind,
    project.appearance.wallpaper,
    notify,
  ]);
  useEffect(() => {
    let id = 0,
      lastUpdate = 0,
      live = true;
    // Asset completion redraws the current project at the current source time.
    // Reuse one pending frame so a late SVG cannot revive an old preview loop.
    const requestDraw = () => {
      if (!live) return;
      cancelAnimationFrame(id);
      id = requestAnimationFrame(draw);
    };
    const draw = () => {
      const p = projectRef.current,
        v = video.current;
      let sourceTime = p.mediaPath && v ? v.currentTime : timeRef.current;
      if (v && !v.paused) {
        const slices = getSlices(p);
        const current =
          slices.find((s) => s.id === playbackSlice.current) ?? slices[0];
        const end = slices.at(-1)?.end ?? p.trimEnd;
        if (sourceTime >= end) {
          pause();
          seek(end);
        } else if (current && sourceTime >= current.end) {
          const nextOutput =
            getOutputTime(p, current.end) +
            (sourceTime - current.end) / current.speed;
          sourceTime = getMediaTime(p, nextOutput);
          seek(sourceTime);
        } else if (sourceTime < (slices[0]?.start ?? 0))
          seek(getMediaTime(p, 0));
        else if (performance.now() - lastUpdate > 32) {
          setTime(sourceTime);
          timeRef.current = sourceTime;
          lastUpdate = performance.now();
        }
        if (
          camera.current &&
          Math.abs(camera.current.currentTime - cameraSourceTime(p, sourceTime, mediaTimelineEnd(camera.current, p.cameraEndTime ?? p.duration))) > 0.15
        )
          camera.current.currentTime = cameraSourceTime(p, sourceTime, mediaTimelineEnd(camera.current, p.cameraEndTime ?? p.duration));
        if (
          mic.current &&
          Math.abs(mic.current.currentTime - sourceTime) > 0.15
        )
          mic.current.currentTime = sourceTime;
        if (cameraMask.current && p.cameraMask && Math.abs(cameraMask.current.currentTime - (cameraSourceTime(p, sourceTime) - p.cameraMask.sourceTimeOrigin)) > 0.15)
          cameraMask.current.currentTime = clamp(cameraSourceTime(p, sourceTime) - p.cameraMask.sourceTimeOrigin, 0, Math.max(0, p.cameraMask.duration - 0.001));
      }
      const c = canvas.current,
        ctx = c?.getContext("2d");
      if (c && ctx) try {
        const painted = renderPreview.current(ctx, p, sourceTime, {
          socialSafeArea,
          fps: 60,
          screenAnimator: previewAnimator.current,
          onCursorAssetReady: requestDraw,
          cameraMatte: previewMatte.current,
          cameraMask: cameraMask.current ?? undefined,
          placeholder: {
            title: t("Your next great recording"),
            subtitle: t("Record your screen or import a video"),
          },
          width: c.width,
          height: c.height,
          screen: p.mediaPath && v ? v : undefined,
          camera:
            p.cameraPath && camera.current && camera.current.readyState >= 2
              ? camera.current
              : undefined,
          background: backgroundImage.current ?? undefined,
        });
        if (!painted) { requestDraw(); return; }
        const pointer = previewPointer.current;
        if (pointer && p.mediaPath) {
          const frame = previewFrameAt(p, sourceTime, c.width, c.height, previewAnimator.current);
          const layer = previewLayerAt(frame, pointer.x * c.width, pointer.y * c.height, c.width, c.height, !!p.cameraPath && !p.appearance.cameraHidden);
          if (layer) {
            const box = previewLayerRect(frame, layer, c.width, c.height);
            const border = c.width / Math.max(1, c.clientWidth);
            ctx.save();
            if (layer === "cursor") {
              ctx.beginPath(); ctx.rect(frame.screenClip.x, frame.screenClip.y, frame.screenClip.width, frame.screenClip.height); ctx.clip();
              ctx.beginPath(); ctx.roundRect(frame.rect.x, frame.rect.y, frame.rect.width, frame.rect.height, frame.screenRadius); ctx.clip();
            }
            ctx.beginPath(); ctx.roundRect(box.rect.x, box.rect.y, box.rect.width, box.rect.height, Math.min(box.radius, box.rect.width / 2, box.rect.height / 2));
            ctx.fillStyle = "#ffffff09"; ctx.strokeStyle = "#ffffff40"; ctx.lineWidth = border;
            ctx.fill(); ctx.stroke(); ctx.restore();
          }
        }
        renderError.current = null;
      } catch (error) {
        const message = errorMessage(error);
        if (renderError.current !== message) { renderError.current = message; notify(message); }
      }
      requestDraw();
    };
    requestDraw();
    return () => { live = false; cancelAnimationFrame(id); };
  }, [pause, seek, notify, socialSafeArea]);
  useEffect(() => {
    setWaveforms([]);
    const api = window.reva;
    if (!project.mediaPath || !api) return;
    const requestID = crypto.randomUUID();
    let live = true;
    (async () => {
      try {
        const sources = [
          { kind: "system" as const, path: project.mediaPath! },
          ...(project.microphonePath
            ? [{ kind: "microphone" as const, path: project.microphonePath }]
            : []),
        ];
        const results: AudioWaveform[] = [];
        for (const source of sources) {
          if (!live) break;
          const result = await api.getWaveform(source.path, requestID);
          results.push({ ...result, kind: source.kind });
          if (live) setWaveforms([...results]);
        }
      } catch (error) {
        if (live)
          notify(
            t("Audio waveform unavailable: {message}", {
              message: errorMessage(error),
            }),
          );
      }
    })();
    return () => {
      live = false;
      void api.cancelWaveform(requestID);
    };
  }, [project.mediaPath, project.microphonePath, notify]);

  const cancelExport = async () => {
    exportState.current.cancelled = true;
    const id = exportState.current.id;
    if (id) await window.reva?.exportCancel(id);
  };
  const exportVideo = async (options: ExportOptions) => {
    const api = window.reva;
    if (!api || !options.project.mediaPath) return;
    pause();
    exportState.current = { id: null, cancelled: false };
    setExportOutput(null);
    setExportOutputs([]);
    let source: HTMLVideoElement | undefined, cam: HTMLVideoElement | undefined, mask: HTMLVideoElement | undefined;
    const matte = new CameraMatte();
    try {
      if (options.project.cameraPath && !options.project.appearance.cameraHidden && options.project.appearance.cameraLayout?.type === "cutout-camera" && !options.project.cameraMask)
        throw new Error(t("Remove the camera background before exporting this layout."));
      const session = await api.exportStart(options);
      if (!session) return;
      exportState.current.id = session.id;
      setExportProgress(0);
      source = await loadVideo(mediaURL(options.project.screenEnhancement?.enabled ? options.project.screenEnhancement.path : options.project.mediaPath));
      if (options.project.cameraPath)
        cam = await loadVideo(mediaURL(options.project.cameraPath));
      if (options.project.cameraMask) mask = await loadVideo(mediaURL(options.project.cameraMask.path));
      const background =
        options.project.appearance.backgroundKind === "wallpaper"
          ? await loadImage(wallpaperURL(options.project.appearance.wallpaper))
          : options.project.appearance.backgroundKind === "image" &&
              options.project.appearance.image
            ? await loadImage(mediaURL(options.project.appearance.image))
            : undefined;
      const c = document.createElement("canvas");
      c.width = options.width;
      c.height = options.height;
      const ctx = c.getContext("2d")!;
      const frames = Math.ceil(getDuration(options.project) * options.fps);
      const animator = createScreenAnimator(options.fps);
      await prepareCursorAssets(options.project.appearance);
      for (let i = 0; i < frames; i++) {
        if (exportState.current.cancelled) break;
        const t = getMediaTime(options.project, i / options.fps);
        await seekVideo(source, t, options.project.screenEnhancement?.enabled ? options.project.screenEnhancement.duration : options.project.duration);
        if (cam) await seekVideo(cam, cameraSourceTime(options.project, t, mediaTimelineEnd(cam, options.project.cameraEndTime ?? options.project.duration)), options.project.cameraEndTime ?? options.project.duration);
        if (mask) await seekVideo(mask, clamp(cameraSourceTime(options.project, t) - options.project.cameraMask!.sourceTimeOrigin, 0, Math.max(0, options.project.cameraMask!.duration - 0.001)));
        drawFrame(ctx, options.project, t, {
          fps: options.fps,
          screenAnimator: animator,
          outputTime: i / options.fps,
          width: c.width,
          height: c.height,
          screen: source,
          camera: cam,
          cameraMask: mask,
          cameraMatte: matte,
          background,
        });
        const blob = await new Promise<Blob>((resolve, reject) =>
          c.toBlob(
            (b) =>
              b ? resolve(b) : reject(new Error("Frame rendering failed.")),
            "image/png",
          ),
        );
        if (exportState.current.cancelled) break;
        await api.exportFrame(
          session.id,
          new Uint8Array(await blob.arrayBuffer()),
        );
        setExportProgress(Math.min(0.99, ((i + 1) / frames) * 0.99));
      }
      if (exportState.current.cancelled) {
        await api.exportCancel(session.id);
        notify("Export cancelled.");
      } else {
        setExportProgress(0.99);
        const path = await api.exportFinish(session.id);
        setExportOutput(path);
        setExportOutputs(session.paths);
        const owner = quickExportOwner.current;
        if (owner && owner.generation === projectGeneration.current && owner.mediaPath === options.project.mediaPath) {
          quickExportOwner.current = null;
          if (await api.quickExportProjectDecision() === "save") {
            const saved = await api.autoSaveProject(options.project, automaticSaveState.current.projectPath, automaticDocumentID());
            if (owner.generation === projectGeneration.current) { setProjectPath(saved); setSavedSnapshot(JSON.stringify(options.project)); notify("Editable project saved."); }
          }
        }
      }
    } catch (e) {
      const id = exportState.current.id;
      if (id) await api.exportCancel(id).catch(() => {});
      if (!exportState.current.cancelled) notify(errorMessage(e));
    } finally {
      matte.dispose();
      for (const v of [source, cam, mask])
        if (v) {
          v.removeAttribute("src");
          v.load();
        }
      setExportProgress(null);
      exportState.current.id = null;
      quickExportOwner.current = null;
    }
  };

  const actions = useRef<(action: string) => void>(() => {});
  quickExport.current = (project, settings, destination) => {
    quickExportOwner.current = { generation: projectGeneration.current, mediaPath: project.mediaPath };
    setDialog("export"); setExportOutput(null);
    void exportVideo({ ...settings, ...getOutputSizeForHeight(project, settings.resolution), project, destination });
  };
  const copyCurrentFrame = async () => {
    const p = projectRef.current, screen = video.current;
    if (!window.reva || !p.mediaPath || !screen || screen.readyState < 2) return;
    pause();
    try {
      const sourceTime = timeRef.current;
      await prepareCursorAssets(p.appearance);
      await Promise.all([seekVideo(screen, sourceTime, p.screenEnhancement?.enabled ? p.screenEnhancement.duration : p.duration), ...(camera.current && p.cameraPath ? [seekVideo(camera.current, cameraSourceTime(p, sourceTime, mediaTimelineEnd(camera.current, p.cameraEndTime ?? p.duration)), p.cameraEndTime ?? p.duration)] : []), ...(cameraMask.current && p.cameraMask ? [seekVideo(cameraMask.current, clamp(cameraSourceTime(p, sourceTime) - p.cameraMask.sourceTimeOrigin, 0, Math.max(0, p.cameraMask.duration - .001)))] : [])]);
      const background = p.appearance.backgroundKind === "wallpaper" ? await loadImage(wallpaperURL(p.appearance.wallpaper)) : p.appearance.backgroundKind === "image" && p.appearance.image ? await loadImage(mediaURL(p.appearance.image)) : undefined;
      const output = getOutputSizeForHeight(p, Math.min(2160, p.height)), frame = document.createElement("canvas"); frame.width = output.width; frame.height = output.height;
      const matte = new CameraMatte();
      try { drawFrame(frame.getContext("2d")!, p, sourceTime, { ...output, fps: 60, screen, camera: camera.current ?? undefined, cameraMask: cameraMask.current ?? undefined, cameraMatte: matte, background, screenAnimator: createScreenAnimator(60) }); }
      finally { matte.dispose(); }
      const blob = await new Promise<Blob>((resolve, reject) => frame.toBlob(value => value ? resolve(value) : reject(new Error("The frame could not be encoded.")), "image/png"));
      await window.reva.copyFrameImage(new Uint8Array(await blob.arrayBuffer()), output.width, output.height); notify("Current frame copied as an image.");
    } catch (error) { notify(errorMessage(error)); }
  };
  actions.current = (action: string) => {
    if (busy && action !== "stop") return;
    switch (action) {
      case "new":
      case "record":
        guard(() => void openRecording());
        break;
      case "open":
        guard(() => void openProject());
        break;
      case "import":
        guard(() => void importVideo());
        break;
      case "import-screenstudio":
        guard(() => void importScreenStudioProject());
        break;
      case "save":
        void save();
        break;
      case "preferences":
        void window.reva?.openPreferences().catch(e => notify(errorMessage(e)));
        break;
      case "recover-recording": guard(() => setDialog("recovery")); break;
      case "shortcuts":
        setDialog("shortcuts");
        break;
      case "commands":
        setDialog("commands");
        break;
      case "copy-frame":
        void copyCurrentFrame();
        break;
      case "extract-raw":
        void window.reva?.extractRawFiles(project).then(folder => { if (folder) { notify("Raw recording files extracted."); void window.reva?.revealFile(folder); } }).catch(error => notify(errorMessage(error)));
        break;
      case "portable-project":
        void window.reva?.exportPortableProject(project).then(file => { if (file) notify("Portable project exported as a single file."); }).catch(error => notify(errorMessage(error)));
        break;
      case "save-as":
        void save(true);
        break;
      case "undo":
        undo();
        break;
      case "redo":
        redo();
        break;
      case "export":
        if (project.mediaPath) {
          pause();
          setExportOutput(null);
          setDialog("export");
        }
        break;
      case "play-pause":
        togglePlay();
        break;
      case "playForwardOrIncreaseSpeed": {
        const rate = nextShuttleRate(reversePlaying ? -previewRate : playback.current?.requested ? previewRate : 0, 1); setPreviewRate(rate); previewRateRef.current = rate; if (reversePlaying) pause(); playForward(); break;
      }
      case "playBackwardOrIncreaseSpeed": {
        const rate = nextShuttleRate(reversePlaying ? -previewRate : playback.current?.requested ? previewRate : 0, -1); pause(); setPreviewRate(Math.abs(rate)); previewRateRef.current = Math.abs(rate); setReversePlaying(true); break;
      }
      case "stopAndResetSpeed":
        pause(); setPreviewRate(1); previewRateRef.current = 1;
        break;
      case "splitSliceAtCurrentTime": { const slice = selectSlice(project, getOutputTime(project, timeRef.current)); if (slice) splitClip(slice.slice.id, timeRef.current); break; }
      case "rippleRemoveSlice": { const slice = selectSlice(project, getOutputTime(project, timeRef.current)); if (slice && getSlices(project).length > 1) { pause(); update(p => ({ ...p, slices: removeSlice(p, slice.slice.id) })); } break; }
      case "stop":
        void stopRecording();
        break;
    }
  };
  useEffect(
    () => window.reva?.onMenuAction((action) => actions.current(action)),
    [],
  );
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty && !allowClose.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (dialog || pendingAction || e.defaultPrevented) return;
      if (e.key === "Escape") {
        e.preventDefault();
        setCutLatched(false); setCutHeld(false);
        setPanel(panel === "slice" || panel === "zoom" ? "background" : panel);
        return;
      }
      if (el.matches('input,textarea,select,[contenteditable="true"]')) return;
      const editingShortcut = SHORTCUTS.find(definition => definition.group === "editing" && matchesShortcut(e, appPreferences ? shortcutKeys(appPreferences, definition) : definition.defaultKeys));
      if (editingShortcut && !busy) { e.preventDefault(); actions.current(editingShortcut.id); return; }
      if ((e.key === "Control" || e.key === "Alt") && !busy && project.mediaPath) {
        e.preventDefault(); setCutHeld(true); return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (mod) {
        if (e.key.toLowerCase() === "k") { e.preventDefault(); setDialog("commands"); return; }
        if (e.key === "/") { e.preventDefault(); setDialog("shortcuts"); return; }
        if (e.shiftKey && e.key.toLowerCase() === "c") { e.preventDefault(); void copyCurrentFrame(); return; }
        if (!busy && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
          e.preventDefault(); pause(); seek(getMediaTime(project, e.key === "ArrowLeft" ? 0 : getLastFrameTime(project))); return;
        }
        const action =
          e.key.toLowerCase() === "z"
            ? e.shiftKey
              ? "redo"
              : "undo"
            : e.key.toLowerCase() === "o"
              ? e.shiftKey
                ? "import"
                : "open"
              : e.key.toLowerCase() === "s"
                ? e.shiftKey
                  ? "save-as"
                  : "save"
                : e.key.toLowerCase() === "n"
                  ? "record"
                  : e.key.toLowerCase() === "e"
                    ? "export"
                    : null;
        if (action) {
          e.preventDefault();
          actions.current(action);
        }
        return;
      }
      if (busy) return;
      if (e.key === "4") { e.preventDefault(); setPanel("masks"); return; }
      if (e.code === "Space") {
        e.preventDefault();
        if (!e.repeat) togglePlay();
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        pause();
        seek(
          getMediaTime(
            project,
            getOutputTime(project, time) +
              (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 1 / 60),
          ),
        );
      }
      if (e.key.toLowerCase() === "z") addZoom();
      if (e.key === "[" && project.mediaPath) trimAtPlayhead("start");
      if (e.key === "]" && project.mediaPath) trimAtPlayhead("end");
      if ((e.key === "Backspace" || e.key === "Delete") && panel === "slice")
        removeClip();
      if ((e.key === "Backspace" || e.key === "Delete") && selectedZoom) {
        update((p) => ({
          ...p,
          zooms: p.zooms.filter((z) => z.id !== selectedZoom),
        }));
        setPanel("zoom");
      }
    };
    const releaseCut = (event: KeyboardEvent) => { if (event.key === "Alt" || event.key === "Control") setCutHeld(event.altKey || event.ctrlKey); };
    const blur = () => { setCutLatched(false); setCutHeld(false); previewTimelineTime(null); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", releaseCut);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", releaseCut);
      window.removeEventListener("blur", blur);
    };
  });
  const selected = project.zooms.find((z) => z.id === selectedZoom);
  const { rect: screenRect, crop: activeCrop } = getScreenGeometry(
    project,
    time,
    size.width,
    size.height,
    60,
    previewAnimator.current,
  );
  const focusPoint = selected
    ? sourcePointToScreen(selected, activeCrop, screenRect)
    : null;
  const editingMask = project.masks?.find(mask => mask.id === selectedMask);
  const commands: EditorCommand[] = [
    { id: "recover-recording", label: "Recover interrupted recording…", section: "File", run: () => actions.current("recover-recording") },
    ...TAB_ITEMS.map(tab => ({ id: `panel-${tab.id}`, label: tab.label, section: "Tools", run: () => setPanel(tab.id) })),
    { id: "record", label: "New recording", section: "Recording", shortcut: "⌘N", run: () => actions.current("record") },
    ...[{ id: "open", label: "Open project…" }, { id: "import", label: "Import video…" }, { id: "import-screenstudio", label: "Import Screen Studio project…" }, { id: "save", label: "Save project" }, { id: "save-as", label: "Save project as…" }, { id: "portable-project", label: "Export portable project…" }, { id: "extract-raw", label: "Extract raw recording files…" }, { id: "copy-frame", label: "Copy current frame as image" }, { id: "export", label: "Export video…" }].map(command => ({ ...command, section: "File", disabled: !project.mediaPath && !["open", "import", "import-screenstudio"].includes(command.id), run: () => actions.current(command.id) })),
    { id: "undo", label: "Undo", section: "Editing", disabled: !canUndo, shortcut: "⌘Z", run: undo }, { id: "redo", label: "Redo", section: "Editing", disabled: !canRedo, run: redo },
    { id: "zoom", label: "Add zoom at playhead", section: "Editing", disabled: !project.mediaPath, run: () => addZoom() }, { id: "crop", label: "Crop recording…", section: "Editing", disabled: !project.mediaPath, run: () => void openCrop() },
    { id: "auto-zoom", label: "Create automatic zooms", section: "Editing", disabled: !project.cursor.length, run: autoZoom },
    { id: "presets", label: "Presets", section: "Settings", run: () => setDialog("presets") }, { id: "preferences", label: "Settings…", section: "Settings", run: () => actions.current("preferences") }, { id: "shortcut-help", label: "Keyboard shortcuts", section: "Settings", shortcut: "⌘/", run: () => setDialog("shortcuts") },
  ];

  return (
    <div className="studio-shell">
      <header className="titlebar">
        <div className="titlebar-left">
          <div className="traffic-lights">
            <button
              title={t("Close window")}
              className="red"
              onClick={() =>
                guard(() => {
                  allowClose.current = true;
                  window.reva?.windowAction("close");
                })
              }
            />
            <button
              title={t("Minimize")}
              className="yellow"
              onClick={() => window.reva?.windowAction("minimize")}
            />
            <button
              title={t("Maximize")}
              className="green"
              onClick={() => window.reva?.windowAction("maximize")}
            />
          </div>
          <span className="toolbar-divider" />
          <IconButton
            title={t("Open project · ⌘O")}
            onClick={() => guard(() => void openProject())}
          >
            <FolderOpen size={19} />
          </IconButton>
          <Tooltip label={t("New recording")} shortcut="⌘ N"><button
            className="record-button"
            aria-label={t("New recording")}
            onClick={() => guard(() => void openRecording())}
          >
            <span className="record-dot" aria-hidden="true" />
            <span>REC</span>
          </button></Tooltip>
          <IconButton
            title={t("Save project · ⌘S")}
            disabled={!project.mediaPath}
            onClick={() => void save()}
          >
            <Save size={17} />
          </IconButton>
        </div>
        <div className="project-title" onDoubleClick={() => setRenaming(true)}>
          {renaming ? (
            <input
              aria-label={t("Project name")}
              autoFocus
              value={project.name}
              onChange={(e) =>
                update((p) => ({ ...p, name: e.target.value }), "name")
              }
              onBlur={() => setRenaming(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setRenaming(false);
              }}
            />
          ) : (
            <>
              <span>
                {project.name && project.name !== "Untitled recording"
                  ? project.name
                  : t("Untitled recording")}
              </span>
              <span className="file-extension">.revastudio</span>
              {dirty && <i title={t("Unsaved changes")} />}
            </>
          )}
        </div>
        <div className="titlebar-right">
          <div
            className="language-switch"
            role="group"
            aria-label={t("Interface language")}
          >
            {(["ru", "en"] as const).map((locale) => (
              <button
                key={locale}
                aria-pressed={language === locale}
                className={language === locale ? "selected" : ""}
                title={locale === "ru" ? "Русский" : "English"}
                onClick={() =>
                  void changeLanguage(locale).catch((error) =>
                    notify(errorMessage(error)),
                  )
                }
              >
                {locale.toUpperCase()}
              </button>
            ))}
          </div>
          <IconButton
            title={t("Keyboard shortcuts")}
            onClick={() => setDialog("shortcuts")}
          >
            <Command size={17} />
          </IconButton>
          <span className="toolbar-divider" />
          <IconButton
            title={t("Undo · ⌘Z")}
            disabled={!canUndo || busy}
            onClick={undo}
          >
            <Undo2 size={19} />
          </IconButton>
          <IconButton
            title={t("Redo · ⌘⇧Z")}
            disabled={!canRedo || busy}
            onClick={redo}
          >
            <Redo2 size={19} />
          </IconButton>
          <span className="toolbar-divider" />
          <Tooltip label={t("Presets")}><button
            className="presets-button"
            ref={presetButton}
            aria-expanded={dialog === "presets"}
            onClick={() => setDialog(dialog === "presets" ? null : "presets")}
          >
            <WandSparkles size={18} />
            <span>{t("Presets")}</span>
            <ChevronDown size={13} />
          </button></Tooltip>
          <Tooltip label={t("Export")} shortcut="⌘ E"><button
            className="export-button"
            disabled={!project.mediaPath || busy}
            onClick={() => actions.current("export")}
          >
            <ArrowUpFromLine size={17} /> {t("Export")}
          </button></Tooltip>
        </div>
      </header>
      <main className="editor-workspace">
        <div
          className="preview-section"
          style={
            { "--preview-width": `${fittedWidth}px` } as React.CSSProperties
          }
        >
          <PreviewToolbar aspect={project.appearance.aspect} setAspect={aspect => update(p => ({ ...p, appearance: { ...p.appearance, aspect } }))} quality={previewQuality} setQuality={value => { setPreviewQuality(value); localStorage.setItem("reva-preview-quality", String(value)); }} fullResolutionHeight={Math.ceil(fittedHeight * previewPixelRatio)} crop={() => void openCrop()} canCrop={!!project.mediaPath} smaller={smallerPreview === null ? null : () => setPreviewHeight(smallerPreview)} larger={largerPreview === null ? null : () => setPreviewHeight(largerPreview)} />
          <div className="canvas-stage" ref={stage}>
            <div
              className="canvas-wrap"
              style={{
                width: fittedWidth,
                height: fittedHeight,
                aspectRatio: `${previewAspect}`,
              }}
            >
              <canvas
                ref={canvas}
                width={size.width}
                height={size.height}
                aria-label={t("Video preview")}
                onPointerMove={event => { const rect = event.currentTarget.getBoundingClientRect(); previewPointer.current = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }; }}
                onPointerLeave={() => { previewPointer.current = null; }}
                onClick={(e) => {
                  if (panel === "zoom" && selected?.mode === "manual") {
                    const r = e.currentTarget.getBoundingClientRect(),
                      px = ((e.clientX - r.left) / r.width) * size.width,
                      py = ((e.clientY - r.top) / r.height) * size.height;
                    if (
                      px < screenRect.x ||
                      px > screenRect.x + screenRect.width ||
                      py < screenRect.y ||
                      py > screenRect.y + screenRect.height
                    )
                      return;
                    const x =
                        activeCrop.x +
                        ((px - screenRect.x) / screenRect.width) *
                          activeCrop.width,
                      y =
                        activeCrop.y +
                        ((py - screenRect.y) / screenRect.height) *
                          activeCrop.height;
                    update(
                      (p) => ({
                        ...p,
                        zooms: p.zooms.map((z) =>
                          z.id === selectedZoom
                            ? { ...z, x: clamp(x), y: clamp(y) }
                            : z,
                        ),
                      }),
                      "zoom-focus",
                    );
                  } else if (project.mediaPath) {
                    const c = e.currentTarget, rect = c.getBoundingClientRect();
                    const p = projectRef.current, currentTime = video.current?.currentTime ?? timeRef.current;
                    const frame = previewFrameAt(p, currentTime, c.width, c.height, previewAnimator.current);
                    const layer = previewLayerAt(frame, (e.clientX - rect.left) / rect.width * c.width, (e.clientY - rect.top) / rect.height * c.height, c.width, c.height, !!p.cameraPath && !p.appearance.cameraHidden);
                    setPanel(layer === "camera" ? "camera" : layer === "cursor" ? "cursor" : "background");
                  }
                }}
              />
              {!project.mediaPath && (
                <div className="empty-canvas-actions">
                  <button
                    className="primary-button"
                    onClick={() => void openRecording()}
                  >
                    <CircleRecord /> {t("New recording")}
                  </button>
                  <button className="light-button" onClick={importVideo}>
                    <FolderOpen size={15} /> {t("Import video")}
                  </button>
                  <span>{t("⌘ N to record · ⌘ ⇧ O to import")}</span>
                </div>
              )}
              {panel === "zoom" &&
                selected?.mode === "manual" &&
                focusPoint?.inside && (
                  <div
                    className="focus-reticle"
                    style={{
                      left: `${(focusPoint.x / size.width) * 100}%`,
                      top: `${(focusPoint.y / size.height) * 100}%`,
                    }}
                  >
                    <Focus size={28} />
                  </div>
                )}
              {insertTool && <InsertionOverlay tool={insertTool} cancel={() => setInsertTool(null)} automatic={() => { setInsertTool(null); autoZoom(); }} place={(point, drawn) => {
                if (insertTool === "camera-overlay" || insertTool === "cutout-camera") { insertScene(insertTool, point); return; }
                const px = point.x * size.width, py = point.y * size.height;
                if (!drawn && (px < screenRect.x || py < screenRect.y || px > screenRect.x + screenRect.width || py > screenRect.y + screenRect.height)) return;
                const source = { x: clamp(activeCrop.x + (px - screenRect.x) / screenRect.width * activeCrop.width), y: clamp(activeCrop.y + (py - screenRect.y) / screenRect.height * activeCrop.height) };
                if (insertTool === "zoom" || insertTool === "loupe") addZoom(time, { ...source, presentation: insertTool === "loupe" ? "loupe" : "screen" });
                else {
                  const mask = addManualMask(project, time, insertTool, source);
                  if (!mask) { notify(t("A mask and highlight cannot overlap in time.")); return; }
                  if (drawn) {
                    const left = clamp((drawn.x * size.width - screenRect.x) / screenRect.width), top = clamp((drawn.y * size.height - screenRect.y) / screenRect.height);
                    const right = clamp(((drawn.x + drawn.width) * size.width - screenRect.x) / screenRect.width), bottom = clamp(((drawn.y + drawn.height) * size.height - screenRect.y) / screenRect.height);
                    if (right <= left || bottom <= top) return;
                    mask.bounds = [{ x: activeCrop.x + left * activeCrop.width, y: activeCrop.y + top * activeCrop.height, width: (right - left) * activeCrop.width, height: (bottom - top) * activeCrop.height }];
                  }
                  update(p => ({ ...p, masks: [...(p.masks ?? []), mask] })); selectTimelineItem("masks", mask.id);
                }
                setInsertTool(null);
              }} />}
              {editingMask && !playing && time >= editingMask.start && time < editingMask.end && <MaskEditorOverlay mask={editingMask} crop={activeCrop} screen={screenRect} width={size.width} height={size.height} update={(bounds, gesture) => update(p => ({ ...p, masks: p.masks?.map(mask => mask.id === editingMask.id ? { ...mask, bounds } : mask) }), gesture)} />}
            </div>
            <div className="floating-tools" aria-label={t("Insert tools")}>
              <IconButton title="Zoom" disabled={!project.mediaPath} active={insertTool === "zoom"} onClick={() => beginInsert("zoom")}><ZoomIn size={20} /></IconButton>
              <IconButton title="Loupe" disabled={!project.mediaPath} active={insertTool === "loupe"} onClick={() => beginInsert("loupe")}><CircleDot size={20} /></IconButton>
              {!!project.cameraPath && <>
              <span className="tool-divider" aria-hidden="true" />
              <IconButton title="Camera overlay" disabled={!project.mediaPath} active={insertTool === "camera-overlay"} onClick={() => beginInsert("camera-overlay")}><Video size={20} /></IconButton>
              <IconButton title="Split screen" disabled={!project.mediaPath} onClick={() => { pause(); insertScene("split-screen"); }}><PanelLeft size={20} /></IconButton>
              <IconButton title="Camera cutout" disabled={!project.mediaPath} active={insertTool === "cutout-camera"} onClick={() => beginInsert("cutout-camera")}><UserRound size={20} /></IconButton>
              <IconButton title="Fullscreen camera" disabled={!project.mediaPath} onClick={() => { pause(); insertScene("fullscreen-camera"); }}><RectangleEllipsis size={20} /></IconButton>
              <IconButton title="Only screen" disabled={!project.mediaPath} onClick={() => { pause(); insertScene("screen-only"); }}><UserRoundX size={20} /></IconButton>
              </>}
              <span className="tool-divider" aria-hidden="true" />
              <IconButton title="Sensitive data mask" disabled={!project.mediaPath} active={insertTool === "sensitive-data"} onClick={() => beginInsert("sensitive-data")}><Shield size={20} /></IconButton>
              <IconButton title="Highlight" disabled={!project.mediaPath} active={insertTool === "highlight"} onClick={() => beginInsert("highlight")}><Highlighter size={20} /></IconButton>
            </div>
          </div>
          <div className="playback-toolbar">
            <div className="playback-left">
              <TransportButton
                label="Cut recording"
                shortcut="⌃ / ⌥"
                keys="Control Alt"
                disabled={!project.mediaPath}
                className={`cut-tool-button ${cutMode ? "active" : ""}`}
                pressed={cutMode}
                onClick={() => setCutLatched((value) => !value)}
              >
                <ScissorsIcon size={17} />
              </TransportButton>
            </div>
            <div className="transport">
              <span className="timecode">
                {formatTimecode(getOutputTime(project, time), 60)}
              </span>
              <TransportButton
                label="Go to first frame" shortcut="⌘ ←" keys="Meta+ArrowLeft"
                disabled={!project.mediaPath}
                onClick={() => { pause(); seek(getMediaTime(project, 0)); }}
              >
                <ReferenceIcon name="backward.end" size={16} />
              </TransportButton>
              <TransportButton
                className="play-button"
                label={playing || reversePlaying ? "Pause" : "Play"} shortcut="Space" keys="Space"
                disabled={!project.mediaPath}
                onClick={togglePlay}
              >
                <ReferenceIcon name={playing || reversePlaying ? "pause.circle" : "play.circle"} size={20} />
              </TransportButton>
              <TransportButton
                label="Go to last frame" shortcut="⌘ →" keys="Meta+ArrowRight"
                disabled={!project.mediaPath}
                onClick={() => {
                  pause();
                  seek(getMediaTime(project, getLastFrameTime(project)));
                }}
              >
                <ReferenceIcon name="forward.end" size={16} />
              </TransportButton>
              <span className="timecode">
                {formatTimecode(getDuration(project), 60)}
              </span>
            </div>
            <div className="playback-right">
              <TransportButton label={audioScrubber ? "Disable audio scrubber" : "Enable audio scrubber (experimental)"} pressed={audioScrubber} className={audioScrubber ? "active" : ""} disabled={!project.mediaPath} onClick={() => { stopScrubber(); setAudioScrubber(value => !value); }}><ReferenceIcon name="waveform.badge.magnifyingglass" size={18} /></TransportButton>
              <span className="playback-divider" aria-hidden="true" />
              <PlaybackSpeed value={previewRate} onChange={setPreviewRate} disabled={!project.mediaPath} />
              <Tooltip label={timelineZoomLabel(visibleTimelineSeconds, language)} placement="bottom" interactive compact>
              <input
                aria-label={t("Timeline zoom")}
                type="range"
                min={0}
                max={1}
                step={0.001}
                disabled={!project.mediaPath || timelineDuration <= 2}
                aria-valuetext={timelineZoomLabel(visibleTimelineSeconds, language)}
                value={timelineSliderValue(timelineDuration, visibleTimelineSeconds)}
                onChange={(e) => setTimelineSeconds(timelineSliderSeconds(timelineDuration, +e.target.value))}
              />
              </Tooltip>
            </div>
          </div>
        </div>
        <nav className="inspector-tabs" aria-label={t("Editor tools")}>
          {TAB_ITEMS.map(({ id, icon, label }) => (
            <IconButton
              key={id}
              title={label}
              className={`inspector-${id}`}
              active={panel === id}
              onClick={() => setPanel(id)}
            >
              {id === "shortcuts" ? <Command size={16} /> : id === "transcript" ? <Quote size={16} /> : <ReferenceIcon name={icon} size={16} />}
            </IconButton>
          ))}
        </nav>
        <Inspector
          panel={panel}
          onCloseTranscript={() => setPanel("captions")}
          project={project}
          update={update}
          time={time}
          selectedZoom={selectedZoom}
          selectedSlice={selectedSlice}
          cameraPreview={camera.current}
          previewTime={hoverPreviewTime ?? time}
          selectedScene={selectedScene}
          selectScene={id => id ? selectTimelineItem("camera-scene", id) : setPanel("camera")}
          selectedMask={selectedMask}
          selectMask={id => selectTimelineItem("masks", id)}
          onSeek={seekTimeline}
          onVolumeAudition={(project, time) => auditionTimeline(time, project, true)}
          socialSafeArea={socialSafeArea}
          onSocialSafeAreaChange={setSocialSafeArea}
          onRemoveSlice={removeClip}
          onCloseSlice={() => setPanel("background")}
          selectZoom={id => selectTimelineItem("zoom", id)}
          notify={notify}
          privacyProgress={privacyProgress}
          onPrivacyChange={changePrivacy}
          onCutout={() => void segmentCamera()}
          cutoutProgress={cutoutProgress}
          onCancelCutout={() => void cancelCameraSegmentation().catch(error => notify(errorMessage(error)))}
          onPrivacyCancel={() =>
            void cancelPrivacy().catch((e) => notify(errorMessage(e)))
          }
        />
      </main>
      <Timeline
        onAddFeature={(kind, start, end) => {
          if (kind === "layouts") {
            const type = project.cameraScenes?.find(item => item.id === selectedScene)?.layout.type ?? project.cameraScenes?.at(-1)?.layout.type ?? project.appearance.cameraLayout?.type ?? "camera-overlay";
            const scene = newCameraScene(project, start, type, undefined, end); if (!scene) return;
            update(p => ({ ...p, cameraScenes: [...(p.cameraScenes ?? []), scene] })); selectTimelineItem("camera-scene", scene.id);
          } else {
            const type = project.masks?.find(item => item.id === selectedMask)?.type ?? project.masks?.at(-1)?.type ?? "sensitive-data";
            const mask = addManualMask(project, start, type, undefined, end); if (!mask) return;
            update(p => ({ ...p, masks: [...(p.masks ?? []), mask] })); selectTimelineItem("masks", mask.id);
          }
          seekTimeline(start);
        }}
        project={project}
        time={time}
        playing={playing || reversePlaying}
        onHoverTime={previewTimelineTime}
        seek={seekTimeline}
        update={update}
        selectedZoom={selectedZoom}
        selectedSlice={selectedSlice}
        onSelectSlice={id => selectTimelineItem("slice", id)}
        selectedMask={selectedMask}
        selectedScene={selectedScene}
        onSelectScene={id => selectTimelineItem("camera-scene", id)}
        onSelectMask={id => selectTimelineItem("masks", id)}
        onShowPanel={setPanel}
        onVolumeAudition={(project, time) => auditionTimeline(time, project, true)}
        cutMode={cutMode}
        onSplit={splitClip}
        onSplitZoom={splitZoomClip}
        onSelectZoom={id => selectTimelineItem("zoom", id)}
        onAddZoom={addZoom}
        waveforms={waveforms}
        scale={timelineScale}
        onScaleChange={setTimelineScale}
      />
      <video
        ref={video}
        className="hidden-media"
        preload="auto"
        crossOrigin="anonymous"
        muted
        src={project.mediaPath ? mediaURL(project.screenEnhancement?.enabled ? project.screenEnhancement.path : project.mediaPath) : undefined}
        onLoadedMetadata={() => seek(clamp(timeRef.current, 0, projectRef.current.duration))}
        onEnded={() => {
          pause();
          seek(
            getMediaTime(projectRef.current, getDuration(projectRef.current)),
          );
        }}
        onError={() => {
          if (projectRef.current.mediaPath)
            notify(
              "This video could not be loaded. Check that the source file still exists.",
            );
        }}
      />
      <video
        ref={camera}
        className="hidden-media"
        preload="auto"
        crossOrigin="anonymous"
        muted
        src={project.cameraPath ? mediaURL(project.cameraPath) : undefined}
        onLoadedMetadata={() => {
          const v = camera.current;
          if (v && v.videoWidth && v.videoHeight) update(p => p.cameraSource?.width === v.videoWidth && p.cameraSource?.height === v.videoHeight ? p : { ...p, cameraSource: { width: v.videoWidth, height: v.videoHeight } });
        }}
      />
      <video ref={cameraMask} className="hidden-media" preload="auto" crossOrigin="anonymous" muted src={project.cameraMask ? mediaURL(project.cameraMask.path) : undefined} onLoadedMetadata={() => {
        const p = projectRef.current;
        if (cameraMask.current && p.cameraMask) cameraMask.current.currentTime = clamp(cameraSourceTime(p, timeRef.current) - p.cameraMask.sourceTimeOrigin, 0, Math.max(0, p.cameraMask.duration - 0.001));
      }} />
      <audio
        ref={mic}
        crossOrigin="anonymous"
        muted
        src={
          project.microphonePath ? mediaURL(project.microphonePath) : undefined
        }
      />
      {recording && (
        <div className="recording-pill">
          <i />
          <span>{formatTime(elapsed)}</span>
          <button onClick={stopRecording}>
            <Square size={12} fill="currentColor" /> {t("Stop recording")}
          </button>
        </div>
      )}
      {notice && (
        <div className="toast" role="status">
          <span>{t(notice)}</span>
          <button
            aria-label={t("Dismiss notification")}
            onClick={() => setNotice(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {importing && (
        <Modal
          title={t("Importing Screen Studio project")}
          subtitle={t("Preparing recording, audio and cursor tracks.")}
          onClose={() => {}}
        >
          <div className="sources-loading">
            <LoaderCircle className="spin" size={24} />
            <span>{t("Importing project…")}</span>
          </div>
        </Modal>
      )}
      {dialog === "export" && (
        <ExportDialog
          project={project}
          onClose={() => setDialog(null)}
          onExport={exportVideo}
          progress={exportProgress}
          output={exportOutput}
          outputs={exportOutputs}
          onReveal={path => { void window.reva?.revealFile(path); }}
          onCancel={() => void cancelExport()}
        />
      )}
      {dialog === "shortcuts" && (
        <ShortcutsDialog onClose={() => setDialog(null)} />
      )}
      {dialog === "commands" && <CommandPalette commands={commands} onClose={() => setDialog(null)} />}
      {dialog === "recovery" && <RecoveryDialog onClose={() => setDialog(null)} onBusy={setRecovering} onRecovered={handleRecorded} />}
      {dialog === "presets" && <PresetsPopover anchor={presetButton.current} project={project} presets={presets} defaultID={defaultPreset} changed={refreshPresets} apply={appearance => update(p => ({ ...p, appearance }))} close={() => setDialog(null)} notify={notify} />}
      {pendingAction && (
        <Modal
          title={t("Save your changes?")}
          subtitle={t("Keep your edits before opening another recording.")}
          onClose={() => setPendingAction(null)}
        >
          <div className="modal-actions">
            <button
              className="text-button"
              onClick={() => {
                const action = pendingAction;
                setPendingAction(null);
                action();
              }}
            >
              {t("Discard changes")}
            </button>
            <button
              className="outline-button"
              onClick={() => setPendingAction(null)}
            >
              {t("Cancel")}
            </button>
            <button
              className="primary-button"
              onClick={async () => {
                if (await save()) {
                  const action = pendingAction;
                  setPendingAction(null);
                  action();
                }
              }}
            >
              {t("Save project")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function CircleRecord() {
  return <span className="record-icon" />;
}
