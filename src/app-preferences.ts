import shortcuts from "../shared/preferences-shortcuts.json" with { type: "json" };
import type { QuickExportSettings, RecordingPreferences } from "./types";

export type PreferencesTab = "general" | "recording" | "editing" | "widget" | "shortcuts" | "advanced";
export type ShortcutAction = "recordStartStop" | "pauseRecording" | "resumeRecording" | "restartRecording" | "addRecordingMarker" | "recordDisplay" | "recordWindow" | "recordArea" | "toggleShowSpeakerNotes" | "toggleSpeakerNotesPrompter" | "toggleRecordingWidget" | "splitSliceAtCurrentTime" | "rippleRemoveSlice" | "playForwardOrIncreaseSpeed" | "playBackwardOrIncreaseSpeed" | "stopAndResetSpeed";
export interface ShortcutDefinition { id: Exclude<ShortcutAction, "resumeRecording">; label: string; group: "recording" | "editing"; defaultKeys: string[]; clearable: boolean }
export const SHORTCUTS = shortcuts as ShortcutDefinition[];

export interface AppPreferences extends Pick<RecordingPreferences, "fps" | "cameraMaxResolution" | "autoZoom" | "quickExportSettings"> {
  homeDirectory?: string;
  shortcutRegistrationErrors?: string[];
  startAtLogin: boolean;
  hideDockIcon: boolean;
  projectsFolderPath: string | null;
  presetsFolderPath: string | null;
  recordingAreaCover: boolean;
  showRecordingWidget: boolean;
  useLastProjectConfigForNewProjects: boolean;
  autoSaveProject: boolean;
  showQuickExportWidget: boolean;
  alwaysSaveProjectAfterQuickExport: boolean;
  editProjectTitleBeforeUpload: boolean;
  customShortcuts: Partial<Record<ShortcutAction, string[] | null>>;
}
export type AppPreferencesPatch = Partial<Omit<AppPreferences, "quickExportSettings" | "homeDirectory" | "shortcutRegistrationErrors">> & { quickExportSettings?: Partial<QuickExportSettings> };
export interface PreferencesAPI {
  getAppPreferences(): Promise<AppPreferences>;
  patchAppPreferences(patch: AppPreferencesPatch): Promise<AppPreferences>;
  choosePreferencesDirectory(kind: "projects" | "presets"): Promise<AppPreferences | null>;
  resetAppPreferences(): Promise<AppPreferences | null>;
  openPreferences(tab?: PreferencesTab): Promise<void>;
  closePreferences(): Promise<void>;
  resizePreferences(height: number): Promise<void>;
  getPreferencesTab(): Promise<PreferencesTab>;
  onPreferencesTab(callback: (tab: PreferencesTab) => void): () => void;
  onAppPreferences(callback: (preferences: AppPreferences) => void): () => void;
}

export function shortcutKeys(preferences: AppPreferences, definition: ShortcutDefinition): string[] | null {
  return Object.hasOwn(preferences.customShortcuts, definition.id) ? preferences.customShortcuts[definition.id] ?? null : definition.defaultKeys;
}
