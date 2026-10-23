import type { SpringConfig } from "./core/spring.ts";
import type { CameraLayoutSettings } from "./core/camera.ts";
import type { CursorSettings } from "./core/cursor.ts";
import type { PreferencesAPI } from "./app-preferences.ts";
import type { CameraScene, CameraFaceTrack, CameraSilenceAnalysis, CameraProcessingSettings } from "./core/camera-effects.ts";
import type { ManualMask, RecordedShortcut, ShortcutSettings } from "./core/annotations.ts";
import type { TranscriptDocument, CaptionSettings, TranscriptServices } from "./core/transcript.ts";
import type { CameraAnalysisResult } from "./core/camera-effects.ts";
import type { DeviceFrameSettings, ScreenProcessingSettings, ScreenEnhancement } from "./core/screen-effects.ts";
import type { AudioSettings, AudioServices } from "./core/audio.ts";
import type { BackgroundPhoto, BackgroundLibraryServices } from "./BackgroundLibrary.tsx";

export interface CursorPoint {
  t: number;
  x: number;
  y: number;
  click: boolean;
  visible?: boolean;
  event?: "mouseMoved" | "mouseDragged" | "mouseDown" | "mouseUp";
  cursorType?: string;
  button?: "left" | "right" | "center";
  hover?: boolean;
}
export interface AudioWaveform {
  kind: "system" | "microphone";
  duration: number;
  peaks: Float32Array;
}
export interface Zoom {
  id: string;
  start: number;
  end: number;
  scale: number;
  x: number;
  y: number;
  mode: "auto" | "manual";
  instant?: boolean;
  presentation?: "screen" | "loupe";
  disabled?: boolean;
  loupeOptions?: { radius01: number; bevelRatio: number; chromaticAberration: number; hasGlassOptics: boolean };
}
export type BackgroundKind = "wallpaper" | "gradient" | "color" | "image";
export interface CustomCursorImage { path: string; name: string; width: number; height: number; sha256: string; enabled: boolean; hotspot: { x: number; y: number } }
export interface Appearance {
  backgroundKind: BackgroundKind;
  background: string;
  gradient: number;
  wallpaper: number;
  image: string | null;
  backgroundPhoto?: BackgroundPhoto;
  backgroundImageSource?: { sha256: string; downloadURL?: string; downloadedAt?: string };
  blur: number;
  padding: number;
  radius: number;
  shadow: number;
  screenShadow?: import("./core/screen-effects").ScreenShadowSettings;
  inset: number;
  aspect: "auto" | "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "4:5";
  cursorSize: number;
  cursorHidden: boolean;
  cursorSmooth: boolean;
  cursorHideIdle: boolean;
  cursorSettings?: CursorSettings;
  customCursor?: CustomCursorImage;
  clickEffect: "none" | "circle" | "ripple";
  cameraSize: number;
  cameraRadius: number;
  cameraX: number;
  cameraY: number;
  cameraMirror: boolean;
  cameraHidden: boolean;
  cameraLayout?: CameraLayoutSettings;
  cameraProcessing?: CameraProcessingSettings;
  cameraFollowFace?: boolean;
  cameraHideDuringSilence?: boolean;
  cameraSilenceMinimumSeconds?: number;
  cameraDelayMs?: number;
  cameraCrop?: { x: number; y: number; width: number; height: number };
  deviceFrame?: DeviceFrameSettings;
  screenProcessing?: ScreenProcessingSettings;
  avoidEmptyZoomArea?: boolean;
  cameraRadiusRatio?: number;
  volume: number;
  microphoneVolume: number;
  cameraVolume: number;
  fadeIn: number;
  fadeOut: number;
  zoomDuration: number;
  zoomStartEarly?: boolean;
  screenSpring?: SpringConfig;
  cursorSpring?: SpringConfig;
  motionBlur?: number;
  crop: { x: number; y: number; width: number; height: number };
}
export interface PrivacyRegion {
  start: number;
  end: number;
  kind: "email" | "phone" | "card" | "key" | "phrase" | "face";
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}
export interface PrivacyAnalysis {
  version: 1;
  source: { sha256: string; width: number; height: number; duration: number };
  settings: {
    sensitive: boolean;
    faces: boolean;
    customPhrases?: string[];
    sampleInterval: number;
    maximumAnalysisDimension?: number;
    ocrRevision?: number;
    faceRevision?: number;
    faceTrackingInterval?: number;
    faceTrackingMethod?: "vision-object-tracking";
    patternRevision?: number;
  };
  samples?: {
    requestedTime: number;
    actualTime: number;
    analysisWidth: number;
    analysisHeight: number;
  }[];
  coordinateSpace: "oriented-top-left-normalized";
  coverage: {
    complete: boolean;
    sampledFrames: number;
    trackedFrames?: number;
    plannedFrames?: number;
    intervals: { start: number; end: number }[];
    limitations: string[];
  };
  regions: PrivacyRegion[];
}
export interface TextOverlay {
  id: string;
  text: string;
  start: number;
  end: number;
  x: number;
  y: number;
  size: number;
  color: string;
}
export interface Slice {
  id: string;
  start: number;
  end: number;
  speed: number;
  volume: number;
  cursorHidden?: boolean;
  systemVolume?: number;
  cameraVolume?: number;
  cursorSmooth?: boolean;
}
export interface RecordingPauseMarker { time: number; duration?: number }
export interface RecordingFlag { id: string; time: number; label?: string }
export interface TypingRange { start: number; end: number; count: number }
export interface Project {
  version: 1;
  name: string;
  mediaPath: string | null;
  cameraPath: string | null;
  cameraSource?: { width: number; height: number };
  cameraStartTime?: number;
  cameraEndTime?: number;
  screenEnhancement?: ScreenEnhancement;
  cursorSourceSize?: { width: number; height: number };
  cameraMask?: CameraMask;
  microphonePath: string | null;
  duration: number;
  width: number;
  height: number;
  trimStart: number;
  trimEnd: number;
  speed: number;
  appearance: Appearance;
  zooms: Zoom[];
  cursor: CursorPoint[];
  captions: TextOverlay[];
  cameraScenes?: CameraScene[];
  cameraFaceTrack?: CameraFaceTrack;
  cameraSilence?: CameraSilenceAnalysis;
  masks?: ManualMask[];
  shortcuts?: RecordedShortcut[];
  shortcutSettings?: ShortcutSettings;
  transcript?: TranscriptDocument;
  captionSettings?: CaptionSettings;
  audio?: AudioSettings;
  slices?: Slice[];
  pauseMarkers?: RecordingPauseMarker[];
  recordingFlags?: RecordingFlag[];
  recoverySource?: RecoverySource;
  recoveryIssues?: RecoveryIssue[];
  typingRanges?: TypingRange[];
  resolvedTypingSuggestions?: number[];
  privacy?: {
    sensitive: boolean;
    faces: boolean;
    customPhrases?: string[];
    analysis: PrivacyAnalysis | null;
  };
}
export interface CameraMask {
  path: string;
  sourcePath: string;
  sourceSHA256: string;
  sourceTimeOrigin: number;
  duration: number;
  width: number;
  height: number;
}
export interface MediaInfo {
  path: string;
  name: string;
  duration: number;
  width: number;
  height: number;
}
export interface SavedPreset { id: string; name: string; appearance: Appearance }
export interface CaptureSource {
  id: string;
  name: string;
  kind: "display" | "window" | "device";
  width: number;
  height: number;
  thumbnail?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  ownerPID?: number;
  zIndex?: number;
}
export interface CaptureDevice { id: string; name: string; default: boolean }
export interface CaptureDeviceInventory { cameras: CaptureDevice[]; microphones: CaptureDevice[]; screenDevices?: (CaptureDevice & { width: number; height: number })[]; screenDeviceIssue?: string }
export interface AudioApplication { id: string; name: string; processID: number }
export interface SpeakerNotesSettings { text: string; fontSize: number; opacity: number; speed: number }
export interface InputLevel { deviceID: string; rms: number; peak: number; timestamp?: number }
export interface CameraPreviewFrame { deviceID: string; jpegBase64: string; width: number; height: number }
export interface InputError { message: string; code?: string; recoverable?: boolean; deviceID?: string; mediaType?: "camera" | "microphone" }
export interface InputMonitorState {
  phase: "idle" | "starting" | "ready" | "stopping" | "error";
  camera: boolean;
  cameraDeviceID: string | null;
  activeCameraDeviceID: string | null;
  microphones: "none" | "all" | "selected";
  microphoneDeviceID: string | null;
  microphonePermission: "unknown" | "granted" | "denied" | "restricted" | "not-determined";
  microphoneDeviceIDs: string[];
  errors: InputError[];
  updatedAt: number;
}
export interface InputMonitorSnapshot { state: InputMonitorState; levels: InputLevel[] }
export type CapturePermission = "granted" | "denied" | "restricted" | "not-determined" | "unknown";
export type ScreenPermission = CapturePermission | "not-granted";
export interface ScreenCaptureIssue { reason: "access-unconfirmed" | "no-windows" | "no-displays"; sourceKind: "display" | "window" | "area"; permission: ScreenPermission }
export interface RecordingPopoverData {
  kind: "camera" | "microphone" | "system-audio" | "settings" | "screen-permission";
  screenIssue?: ScreenCaptureIssue;
  preferences: RecordingPreferences;
  devices: CaptureDeviceInventory;
  applications?: AudioApplication[];
  levels: InputLevel[];
}
export interface RecordingPreferences {
  fps: 24 | 30 | 60;
  countdown: 0 | 3 | 5 | 10;
  systemAudio: boolean;
  systemAudioApplications?: string[] | null;
  recordShortcuts?: boolean;
  hideDesktopIcons?: boolean;
  microphone: boolean;
  camera: boolean;
  microphoneDeviceID: string | null;
  cameraDeviceID: string | null;
  cameraMaxResolution: 720 | 1080 | 2160;
  cameraPreview: boolean;
  cameraPreviewWhileRecording: boolean;
  autoZoom: boolean;
  afterRecording: "project" | "clipboard" | "file";
  quickExportSettings: QuickExportSettings;
}
export interface QuickExportSettings {
  format: "mp4" | "prores" | "gif";
  fps: 24 | 30 | 60;
  resolution: 720 | 1080 | 2160;
  quality: "high" | "balanced" | "small" | "tiny";
  codec: "h264" | "hevc" | "both";
  encoding?: "software" | "hardware";
  proresProfile: "422-lt" | "422" | "422-hq" | "4444";
  gifHighQuality: boolean;
  gifLoop: boolean;
}
export interface RecordingPanelState { status: "idle" | "recording" | "finishing"; startedAt: number | null; paused?: boolean; elapsedMs?: number; stateUpdatedAt?: number }
export interface CaptureOptions {
  source: CaptureSource;
  fps: number;
  systemAudio: boolean;
  systemAudioApplications?: string[] | null;
  recordShortcuts?: boolean;
  microphone: boolean;
  camera: boolean;
  microphoneDeviceID?: string | null;
  cameraDeviceID?: string | null;
  cameraMaxResolution?: 720 | 1080 | 2160;
  area?: { x: number; y: number; width: number; height: number };
}
export interface RecordingResult extends MediaInfo {
  cursor: CursorPoint[];
  microphonePath?: string;
  cameraPath?: string;
  cameraSource?: { width: number; height: number };
  cameraStartTime?: number;
  cameraEndTime?: number;
  cursorSourceSize?: { width: number; height: number };
  pauseMarkers?: RecordingPauseMarker[];
  recordingFlags?: RecordingFlag[];
  shortcuts?: RecordedShortcut[];
  typingRanges?: TypingRange[];
  afterRecording?: { destination: "project" | "clipboard" | "file"; autoZoom: boolean; settings: QuickExportSettings };
  recoverySource?: RecoverySource;
  issues?: RecoveryIssue[];
}
export interface RecoverySource { directory: string; journalPath: string; journalId: string; ownerId: string; reportPath: string; rawDirectory: string; checkpointDuration: number; reportSHA256?: string }
export interface RecoveryIssue { code: string; message: string; path?: string }
export interface RecoveryCandidate { id: string; journalId: string; name: string; directory: string; journalPath: string; source: string; createdAt: string; updatedAt: string; status: "recording" | "finalizing" | "failed"; checkpointDuration: number; width: number; height: number; hasCamera: boolean; hasMicrophone: boolean; error?: string; recoveredPath?: string }
export interface RecoveryListing { recordings: RecoveryCandidate[]; issues: RecoveryIssue[] }
export interface RecoveryResult extends RecordingResult { issues: RecoveryIssue[]; recoverySource: RecoverySource }
export interface ExportOptions {
  format: "mp4" | "prores" | "gif";
  fps: number;
  width: number;
  height: number;
  quality: "high" | "balanced" | "small" | "tiny";
  codec?: "h264" | "hevc" | "both";
  encoding?: "software" | "hardware";
  proresProfile?: "422-lt" | "422" | "422-hq" | "4444";
  gifHighQuality?: boolean;
  gifLoop?: boolean;
  destination?: "file" | "clipboard";
  project: Project;
}
export interface RevaAPI extends PreferencesAPI {
  platform: string;
  copyFrameImage(png: Uint8Array, width: number, height: number): Promise<boolean>;
  extractRawFiles(project: Project): Promise<string | null>;
  setProjectOpen(value: boolean): Promise<void>;
  onRecorderAction(callback: (action: string) => void): () => void;
  getLanguage(): Promise<"ru" | "en">;
  editCrop(data: {mediaPath: string; time: number; crop: { x: number; y: number; width: number; height: number }}): Promise<{ x: number; y: number; width: number; height: number } | null>;
  getCropEditor(): Promise<{mediaPath: string; width: number; height: number; time: number; crop: { x: number; y: number; width: number; height: number }} | null>;
  completeCropEditor(crop: { x: number; y: number; width: number; height: number } | null): Promise<void>;
  setLanguage(language: "ru" | "en"): Promise<void>;
  mediaURL(path: string): string;
  importVideo(): Promise<MediaInfo | null>;
  importImage(): Promise<string | null>;
  importCursorImage(): Promise<CustomCursorImage | null>;
  getWaveform(
    path: string,
    requestID: string,
  ): Promise<{ duration: number; peaks: Float32Array }>;
  cancelWaveform(requestID: string): Promise<void>;
  importScreenStudio(): Promise<{
    mediaInfo: MediaInfo;
    cameraPath?: string;
    cameraSource?: { width: number; height: number };
    cursorSourceSize?: { width: number; height: number };
    microphonePath?: string;
    cursor: CursorPoint[];
    zooms: Zoom[];
    slices: Slice[];
    pauseMarkers?: RecordingPauseMarker[];
    typingRanges?: TypingRange[];
    resolvedTypingSuggestions?: number[];
    appearancePatch: Partial<Appearance>;
    cameraScenes?: CameraScene[];
    masks?: ManualMask[];
    audio?: AudioSettings;
    captionSettings?: CaptionSettings;
    warnings: string[];
  } | null>;
  openProject(): Promise<{ project: Project; path: string } | null>;
  saveProject(project: Project, path?: string | null): Promise<string | null>;
  autoSaveProject(project: Project, path: string | null, documentID: string): Promise<string>;
  quickExportProjectDecision(): Promise<"save" | "keep">;
  listPresets(): Promise<{ presets: SavedPreset[]; issues: { file: string; message: string }[]; defaultPresetID: string | null }>;
  savePreset(project: Project, name: string): Promise<SavedPreset>;
  updatePreset(id: string, changes: { name?: string; project?: Project }): Promise<SavedPreset>;
  revealPreset(id: string): Promise<void>;
  removePreset(id: string): Promise<void>;
  importPreset(): Promise<{ name: string; appearance: Appearance } | null>;
  exportPreset(project: Project, name: string): Promise<string | null>;
  setDefaultPreset(id: string | null): Promise<string | null>;
  getNewProjectAppearance(): Promise<Appearance | null>;
  rememberProjectAppearance(project: Project): Promise<void>;
  exportPortableProject(project: Project): Promise<string | null>;
  getSources(): Promise<CaptureSource[]>;
  openRecordingPanel(): Promise<void>;
  closeRecordingPanel(): Promise<void>;
  getRecordingPanel(): Promise<RecordingPanelState & { preferences: RecordingPreferences; screenIssue: ScreenCaptureIssue | null }>;
  getRecordingAreaCover(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  getCaptureDevices(): Promise<CaptureDeviceInventory>;
  showRecordingMenu(kind: "camera" | "microphone" | "system-audio" | "settings" | "screen-permission", position: { x: number; y: number }): Promise<{ preferences: RecordingPreferences; language: "ru" | "en"; retrySource?: boolean }>;
  getRecordingPopover(): Promise<RecordingPopoverData>;
  closeRecordingPopover(): Promise<void>;
  retryScreenSource(): Promise<void>;
  onScreenCaptureIssue(callback: (issue: ScreenCaptureIssue | null) => void): () => void;
  patchRecordingPreferences(patch: Partial<RecordingPreferences>): Promise<RecordingPreferences>;
  showRecordingShortcuts(): Promise<void>;
  getCameraPreview(): Promise<{frame: CameraPreviewFrame | null; preferences: RecordingPreferences}>;
  showCameraEffects(): Promise<{ deviceID: string }>;
  onCameraPreviewFrame(callback: (frame: CameraPreviewFrame | null) => void): () => void;
  onRecordingPreferences(callback: (preferences: RecordingPreferences) => void): () => void;
  onInputLevel(callback: (level: InputLevel) => void): () => void;
  onInputError(callback: (error: InputError) => void): () => void;
  getInputMonitorState(): Promise<InputMonitorSnapshot>;
  onInputMonitorState(callback: (state: InputMonitorState) => void): () => void;
  retryMicrophoneMonitoring(): Promise<InputMonitorSnapshot>;
  openCapturePrivacySettings(kind: "microphone" | "screen"): Promise<void>;
  chooseRecordingSource(kind: "display" | "window" | "area" | "device", position: { x: number; y: number }): Promise<{ source: CaptureSource; area?: { x: number; y: number; width: number; height: number } } | { issue: ScreenCaptureIssue } | null>;
  getCapturePicker(): Promise<import("./CapturePicker").CapturePickerData>;
  completeCapturePicker(result: import("./CapturePicker").CapturePickerResult | null): Promise<void>;
  saveCaptureArea(input: {name: string; rect: {x: number; y: number; width: number; height: number}}): Promise<import("./CapturePicker").SavedCaptureArea[]>;
  openRecordingsFolder(): Promise<void>;
  onRecordingPanelState(callback: (state: RecordingPanelState) => void): () => void;
  onRecordingStarted(callback: (timestamp: number) => void): () => void;
  onRecordingIdle(callback: () => void): () => void;
  getPermissions(): Promise<{
    screen: ScreenPermission;
    microphone: CapturePermission;
    camera: CapturePermission;
    keyboard?: ScreenPermission;
  }>;
  startRecording(options: CaptureOptions): Promise<void | { issue: ScreenCaptureIssue }>;
  stopRecording(): Promise<RecordingResult>;
  pauseRecording(): Promise<void>;
  resumeRecording(): Promise<void>;
  restartRecording(): Promise<void>;
  discardRecording(): Promise<void>;
  addRecordingFlag(): Promise<RecordingFlag>;
  listRecordingRecovery(): Promise<RecoveryListing>;
  recoverRecording(id: string): Promise<RecoveryResult | null>;
  cancelRecordingRecovery(): Promise<void>;
  showSpeakerNotes(): Promise<void>;
  closeSpeakerNotes(): Promise<void>;
  getSpeakerNotes(): Promise<SpeakerNotesSettings>;
  saveSpeakerNotes(settings: SpeakerNotesSettings): Promise<void>;
  onSpeakerNotesAction(callback: (action: string) => void): () => void;
  restoreDesktopIcons(): Promise<void>;
  resizeCaptureWindow(source: CaptureSource, width: number, height: number): Promise<CaptureSource>;
  exportStart(
    options: ExportOptions,
  ): Promise<{ id: string; path: string; paths: string[] } | null>;
  exportFrame(id: string, png: Uint8Array): Promise<void>;
  exportFinish(id: string): Promise<string>;
  exportCancel(id: string): Promise<void>;
  analyzePrivacy(
    path: string,
    settings: { sensitive: boolean; faces: boolean; customPhrases?: string[] },
  ): Promise<PrivacyAnalysis | null>;
  cancelPrivacy(): Promise<void>;
  segmentCamera(path: string): Promise<CameraMask | null>;
  upscaleScreen(path: string): Promise<ScreenEnhancement | null>;
  cancelScreenUpscale(): Promise<void>;
  onScreenUpscaleProgress(callback: (progress: number) => void): () => void;
  openModelAttribution(url: string): Promise<void>;
  analyzeCamera(path: string, settings: { faces: boolean; silence: boolean; audioPath?: string; silenceThresholdDB?: number; silenceMinimumSeconds?: number }): Promise<CameraAnalysisResult | null>;
  cancelCameraAnalysis(): Promise<void>;
  onCameraAnalysisProgress(callback: (progress: number) => void): () => void;
  speech: TranscriptServices;
  audio: AudioServices;
  backgrounds: BackgroundLibraryServices;
  renderAudioPreview(project: Project, request: { id: string; start: number; duration: number }): Promise<{ key: string; path: string; start: number; duration: number } | null>;
  cancelAudioPreview(id: string): Promise<void>;
  onSpeechProgress(callback: (progress: number) => void): () => void;
  cancelCameraSegmentation(): Promise<void>;
  onCameraSegmentationProgress(callback: (progress: number) => void): () => void;
  onPrivacyProgress(callback: (progress: number) => void): () => void;
  revealFile(path: string): Promise<void>;
  windowAction(action: "close" | "minimize" | "maximize"): void;
  onMenuAction(callback: (action: string) => void): () => void;
  onRecordingStopped(callback: (result: RecordingResult) => void): () => void;
  onError(callback: (message: string) => void): () => void;
}
declare global {
  interface Window {
    reva?: RevaAPI;
  }
}
