"use strict";
const { contextBridge, ipcRenderer } = require("electron");

async function invoke(channel, ...args) {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (error) {
    // Electron adds an English transport prefix to otherwise localized errors.
    // Keep the actual main-process error text and its diagnostic details.
    if (error instanceof Error)
      error.message = error.message.replace(
        /^Error invoking remote method '[^']+': (?:Error: )?/,
        "",
      );
    throw error;
  }
}

function subscribe(channel, callback) {
  if (typeof callback !== "function")
    throw new TypeError("A callback is required.");
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld(
  "reva",
  Object.freeze({
    platform: process.platform,
    getLanguage: () => invoke("reva:get-language"),
    setLanguage: (language) => invoke("reva:set-language", language),
    getAppPreferences: () => invoke("reva:app-preferences"),
    patchAppPreferences: patch => invoke("reva:app-preferences-patch", patch),
    choosePreferencesDirectory: kind => invoke("reva:preferences-directory", kind),
    resetAppPreferences: () => invoke("reva:preferences-reset"),
    openPreferences: tab => invoke("reva:preferences-open", tab),
    closePreferences: () => invoke("reva:preferences-close"),
    resizePreferences: height => invoke("reva:preferences-resize", height),
    getPreferencesTab: () => invoke("reva:preferences-tab"),
    onPreferencesTab: callback => subscribe("reva:preferences-tab", callback),
    onAppPreferences: callback => subscribe("reva:app-preferences", callback),
    setProjectOpen: value => invoke("reva:project-open-state", value),
    onRecorderAction: callback => subscribe("reva:recorder-action", callback),
    mediaURL: (file) => `reva-media://asset/?path=${encodeURIComponent(file)}`,
    importVideo: () => invoke("reva:import-video"),
    listRecordingRecovery: () => invoke("reva:recovery-list"),
    recoverRecording: id => invoke("reva:recovery-start", id),
    cancelRecordingRecovery: () => invoke("reva:recovery-cancel"),
    importImage: () => invoke("reva:import-image"),
    importCursorImage: () => invoke("reva:import-cursor-image"),
    upscaleScreen: file => invoke("reva:screen-upscale", file),
    cancelScreenUpscale: () => invoke("reva:screen-upscale-cancel"),
    onScreenUpscaleProgress: callback => subscribe("reva:screen-upscale-progress", callback),
    openModelAttribution: url => invoke("reva:model-attribution", url),
    getWaveform: (file, requestID) =>
      invoke("reva:waveform", file, requestID),
    cancelWaveform: (requestID) =>
      invoke("reva:waveform-cancel", requestID),
    importScreenStudio: () => invoke("reva:import-screenstudio"),
    openProject: () => invoke("reva:open-project"),
    saveProject: (project, file) =>
      invoke("reva:save-project", project, file),
    autoSaveProject: (project, file, documentID) => invoke("reva:project-autosave", project, file, documentID),
    quickExportProjectDecision: () => invoke("reva:quick-export-project"),
    listPresets: () => invoke("reva:presets-list"),
    savePreset: (project, name) => invoke("reva:preset-save", project, name),
    updatePreset: (id, changes) => invoke("reva:preset-update", id, changes),
    revealPreset: id => invoke("reva:preset-reveal", id),
    removePreset: id => invoke("reva:preset-remove", id),
    importPreset: () => invoke("reva:preset-import"),
    exportPreset: (project, name) => invoke("reva:preset-export", project, name),
    setDefaultPreset: id => invoke("reva:default-preset", id),
    getNewProjectAppearance: () => invoke("reva:new-project-appearance"),
    rememberProjectAppearance: project => invoke("reva:last-project-appearance", project),
    exportPortableProject: project => invoke("reva:project-bundle-export", project),
    getSources: () => invoke("reva:sources"),
    getPermissions: () => invoke("reva:permissions"),
    openRecordingPanel: () => invoke("reva:recorder-open"),
    closeRecordingPanel: () => invoke("reva:recorder-close"),
    getRecordingPanel: () => invoke("reva:recorder-state"),
    getRecordingAreaCover: () => invoke("reva:recording-area-cover"),
    onRecordingAreaCover: callback => subscribe("reva:recording-area-cover", callback),
    getCaptureDevices: () => invoke("reva:recorder-devices"),
    showRecordingMenu: (kind, position) => invoke("reva:recorder-menu", kind, position),
    getRecordingPopover: () => invoke("reva:recorder-popover-info"),
    closeRecordingPopover: () => invoke("reva:recorder-popover-close"),
    retryScreenSource: () => invoke("reva:screen-source-retry"),
    onScreenCaptureIssue: callback => subscribe("reva:screen-capture-issue", callback),
    patchRecordingPreferences: patch => invoke("reva:recorder-preferences", patch),
    showRecordingShortcuts: () => invoke("reva:recorder-shortcuts"),
    getCameraPreview: () => invoke("reva:camera-preview-info"),
    showCameraEffects: () => invoke("reva:camera-effects"),
    onCameraPreviewFrame: callback => subscribe("reva:camera-preview-frame", callback),
    onRecordingPreferences: callback => subscribe("reva:recording-preferences", callback),
    onInputLevel: callback => subscribe("reva:input-level", callback),
    onInputError: callback => subscribe("reva:input-error", callback),
    getInputMonitorState: () => invoke("reva:input-monitor-state"),
    onInputMonitorState: callback => subscribe("reva:input-monitor-state", callback),
    retryMicrophoneMonitoring: () => invoke("reva:microphone-retry"),
    openCapturePrivacySettings: kind => invoke("reva:capture-privacy-settings", kind),
    chooseRecordingSource: (kind, position) => invoke("reva:recorder-source", kind, position),
    getCapturePicker: () => invoke("reva:capture-picker-info"),
    onCapturePickerViewport: callback => subscribe("reva:capture-picker-viewport", callback),
    completeCapturePicker: result => invoke("reva:capture-picker-complete", result),
    saveCaptureArea: input => invoke("reva:capture-area-save", input),
    openRecordingsFolder: () => invoke("reva:recorder-folder"),
    editCrop: data => invoke("reva:crop-open", data),
    getCropEditor: () => invoke("reva:crop-info"),
    completeCropEditor: crop => invoke("reva:crop-complete", crop),
    onRecordingPanelState: callback => subscribe("reva:recorder-state", callback),
    onRecordingStarted: callback => subscribe("reva:recording-started", callback),
    onRecordingIdle: callback => subscribe("reva:recording-idle", callback),
    startRecording: (options) =>
      invoke("reva:record-start", options),
    stopRecording: () => invoke("reva:record-stop"),
    pauseRecording: () => invoke("reva:record-pause"),
    resumeRecording: () => invoke("reva:record-resume"),
    restartRecording: () => invoke("reva:record-restart"),
    discardRecording: () => invoke("reva:record-discard"),
    addRecordingFlag: () => invoke("reva:record-flag"),
    showSpeakerNotes: () => invoke("reva:speaker-notes-show"),
    closeSpeakerNotes: () => invoke("reva:speaker-notes-close"),
    getSpeakerNotes: () => invoke("reva:speaker-notes-get"),
    saveSpeakerNotes: settings => invoke("reva:speaker-notes-save", settings),
    onSpeakerNotesAction: callback => subscribe("reva:speaker-notes-action", callback),
    restoreDesktopIcons: () => invoke("reva:desktop-restore"),
    resizeCaptureWindow: (source, width, height) => invoke("reva:window-resize", source, width, height),
    exportStart: (options) => invoke("reva:export-start", options),
    exportFrame: (id, png) => invoke("reva:export-frame", id, png),
    exportFinish: (id) => invoke("reva:export-finish", id),
    exportCancel: (id) => invoke("reva:export-cancel", id),
    analyzePrivacy: (file, settings) =>
      invoke("reva:privacy-analyze", file, settings),
    cancelPrivacy: () => invoke("reva:privacy-cancel"),
    segmentCamera: file => invoke("reva:camera-segment", file),
    cancelCameraSegmentation: () => invoke("reva:camera-segment-cancel"),
    analyzeCamera: (file, settings) => invoke("reva:camera-analyze", file, settings),
    cancelCameraAnalysis: () => invoke("reva:camera-analysis-cancel"),
    onCameraAnalysisProgress: callback => subscribe("reva:camera-analysis-progress", callback),
    speech: Object.freeze({ status: locale => invoke("reva:speech-status", locale), generate: (file, options) => invoke("reva:speech-generate", file, options), cancel: () => invoke("reva:speech-cancel"), importFile: duration => invoke("reva:transcript-import", duration), exportSRT: (content, name) => invoke("reva:transcript-export", content, name) }),
    audio: Object.freeze({ importFile: () => invoke("reva:audio-import"), saveVoiceover: (data, mime) => invoke("reva:voiceover-save", data, mime), mediaURL: file => `reva-media://asset/?path=${encodeURIComponent(file)}`, listLibrary: () => invoke("reva:music-library"), openLibrary: () => invoke("reva:music-library-open") }),
    backgrounds: Object.freeze({ importImage: () => invoke("reva:import-image"), search: (query, page, key) => invoke("reva:background-search", query, page, key), importPhoto: (photo, key) => invoke("reva:background-import", photo, key), listFavorites: () => invoke("reva:background-favorites"), saveFavorite: value => invoke("reva:background-favorite-save", value), removeFavorite: id => invoke("reva:background-favorite-remove", id), reveal: file => invoke("reva:reveal-file", file), openURL: url => invoke("reva:background-link", url), mediaURL: file => `reva-media://asset/?path=${encodeURIComponent(file)}` }),
    renderAudioPreview: (project, request) => invoke("reva:audio-preview", project, request),
    cancelAudioPreview: id => invoke("reva:audio-preview-cancel", id),
    onSpeechProgress: callback => subscribe("reva:speech-progress", callback),
    copyFrameImage: (png, width, height) => invoke("reva:clipboard-image", png, width, height),
    extractRawFiles: project => invoke("reva:raw-extract", project),
    onCameraSegmentationProgress: callback => subscribe("reva:camera-segment-progress", callback),
    onPrivacyProgress: (callback) =>
      subscribe("reva:privacy-progress", callback),
    revealFile: (file) => invoke("reva:reveal-file", file),
    windowAction: (action) => ipcRenderer.send("reva:window", action),
    onMenuAction: (callback) => subscribe("reva:menu-action", callback),
    onRecordingStopped: (callback) =>
      subscribe("reva:recording-stopped", callback),
    onError: (callback) => subscribe("reva:error", callback),
  }),
);
