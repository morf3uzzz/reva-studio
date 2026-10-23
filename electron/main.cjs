"use strict";

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  ipcMain,
  protocol,
  net,
  dialog,
  shell,
  globalShortcut,
  session,
  clipboard,
  ClipboardItem,
  screen,
  systemPreferences,
} = require("electron");
const fs = require("node:fs").promises;
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { MediaGrants, findTool, probe, mediaResponse } = require("./media.cjs");
const { Capture } = require("./capture.cjs");
const { RecordingWindows } = require("./recording-windows.cjs");
const { CropWindow, cropRectangle } = require("./crop-window.cjs");
const { PreferencesWindow } = require("./preferences-window.cjs");
const { writeProjectBundle } = require("./project-bundle.cjs");
const { PresetLibrary, presetProject } = require("./presets.cjs");
const { ProjectDocuments } = require("./project-documents.cjs");
const { DesktopIcons } = require("./desktop-icons.cjs");
const { SpeakerNotesStore } = require("./speaker-notes.cjs");
const { AudioPreview } = require("./audio-preview.cjs");
const { AudioLibrary } = require("./audio-library.cjs");
const { BackgroundAssets } = require("./unsplash.cjs");
const { effectiveShortcuts, accelerator, patchAppPreferences: parsePreferencesPatch } = require("./app-preferences.cjs");
const { InputMonitor, inputErrorData } = require("./input-monitor.cjs");
const { LiveInputs } = require("./live-inputs.cjs");
const { CameraPreviewFrames } = require("./camera-preview-frames.cjs");
const { capturePrivacySettingsURL, CaptureMediaPermissions } = require("./capture-permissions.cjs");
const { Exporter } = require("./exporter.cjs");
const {
  contained,
  validateProject,
  projectAssets,
  readPortableProject,
  writePortableProject,
} = require("./core.cjs");
const {
  SettingsStore,
  translate,
  localizeError,
} = require("./settings.cjs");

app.setName("REVA Studio");
app.setPath("userData", path.join(app.getPath("appData"), "REVA Studio Community"));
protocol.registerSchemesAsPrivileged([
  {
    scheme: "reva-app",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: "reva-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

const APP_ROOT = path.resolve(__dirname, "..");
const settings = new SettingsStore(path.join(app.getPath("userData"), "settings.json"));
const tnative = (message, values) => translate(message, settings.language, values);
const { PrivacyAnalyzer } = require("./privacy.cjs");
const { CameraSegmenter } = require("./cutout.cjs");
const { CameraAnalyzer } = require("./camera-analysis.cjs");
const { ScreenUpscaler } = require("./upscale.cjs");
const { RecordingRecovery } = require("./recovery.cjs");
const { SpeechTranscriber, importTranscriptFile } = require("./transcription.cjs");
const { getWaveform } = require("./waveform.cjs");
const {
  importScreenStudio,
  cleanupScreenStudioImports,
} = require("./screenstudio.cjs");
const DIST = path.join(APP_ROOT, "dist");
const DEV_URL =
  !app.isPackaged && process.env.REVA_DEV_URL === "http://127.0.0.1:5178"
    ? process.env.REVA_DEV_URL
    : null;
const grants = new MediaGrants();
const presetLibrary = new PresetLibrary({ cacheRoot: path.join(app.getPath("userData"), "PresetCache"), grants });
const presetFolder = () => settings.preferences.presetsFolderPath ?? path.join(app.getPath("userData"), "Presets");
const projectCache = path.join(app.getPath("userData"), "ProjectCache");
const notesStore = new SpeakerNotesStore(path.join(app.getPath("userData"), "speaker-notes.json"));
const desktopIcons = new DesktopIcons({ helper: path.join(APP_ROOT, "native", "build", "reva-capture"), journal: path.join(app.getPath("userData"), "desktop-visibility-recovery.json") });
const audioLibrary = new AudioLibrary({ root: path.join(app.getPath("userData"), "Music"), grants });
const backgroundAssets = new BackgroundAssets({ root: path.join(app.getPath("userData"), "Backgrounds"), grants, validateImage: async file => { if (nativeImage.createFromPath(file).isEmpty()) throw new Error("The selected background image could not be decoded."); } });
let audioPreview = null;
const recorder = new RecordingWindows({
  BrowserWindow, screen, preload: path.join(__dirname, "preload.cjs"),
  url: role => DEV_URL ? `${DEV_URL}/?surface=${role}` : `reva-app://app/index.html?surface=${role}`,
  onCancel: () => { restoreWindow(); void syncLiveInputs(); }, onError: (error, role) => role === "camera-preview" ? reportInputError(error) : report(error),
  onPopoverClosed: () => { void syncLiveInputs(); },
  onPreviewClosed: () => { void settings.patchRecording({ cameraPreview: false }).then(() => { publishRecordingPreferences(); void syncLiveInputs(); }).catch(reportInputError); },
});
const cropEditor = new CropWindow({ BrowserWindow, screen, preload: path.join(__dirname, "preload.cjs"), url: DEV_URL ? `${DEV_URL}/?surface=crop` : "reva-app://app/index.html?surface=crop" });
const preferencesWindow = new PreferencesWindow({ BrowserWindow, screen, preload: path.join(__dirname, "preload.cjs"), url: DEV_URL ? `${DEV_URL}/?surface=preferences` : "reva-app://app/index.html?surface=preferences", onError: report });
let projectOpen = false;
let registeredShortcuts = new Map();
let shortcutRegistrationErrors = [];
function publicPreferences() { return { ...settings.preferences, homeDirectory: app.getPath("home"), shortcutRegistrationErrors }; }
function syncDockVisibility() {
  if (!app.dock) return;
  if (settings.preferences.hideDockIcon && !projectOpen && !capture?.active) app.dock.hide();
  else void app.dock.show();
}
function publishAppPreferences() { const value = publicPreferences(); send("reva:app-preferences", value); preferencesWindow.send("reva:app-preferences", value); recorder.broadcast("reva:app-preferences", value); }
function shortcutAction(id) {
  if (id === "recordStartStop") { if (capture?.active) void stopRecording().catch(report); else { void recorder.open().then(() => mainWindow?.hide()).catch(report); } }
  else if (id === "pauseRecording") { if (capture?.active) void (capture.session?.state?.status === "paused" ? capture.resume() : capture.pause()).catch(report); }
  else if (id === "restartRecording") { if (capture?.active) void capture.restart().catch(report); }
  else if (id === "toggleRecordingWidget") { const window = recorder.toolbar; if (window && !window.isDestroyed()) { if (window.isVisible()) window.hide(); else window.showInactive(); } }
  else if (id === "recordDisplay" || id === "recordWindow" || id === "recordArea") { void recorder.open().then(() => { mainWindow?.hide(); recorder.toolbar?.webContents.send("reva:recorder-action", id); }).catch(report); }
  else if (id === "toggleShowSpeakerNotes" || id === "toggleSpeakerNotesPrompter") void speakerNotesAction(id).catch(report);
  else if (id === "addRecordingMarker") void addRecordingFlag().catch(report);
  else menuAction(id);
}
function registerPreferenceShortcuts(preferences, strict = true) {
  const desired = new Map(effectiveShortcuts(preferences).filter(item => item.group === "recording" && item.keys).map(item => [accelerator(item.keys), item.id]));
  // Keep the long-established emergency stop entry available independently.
  if (!desired.has("CommandOrControl+Shift+2")) desired.set("CommandOrControl+Shift+2", "stop");
  const previous = registeredShortcuts;
  for (const key of previous.keys()) globalShortcut.unregister(key);
  const installed = new Map(), errors = [];
  for (const [key, id] of desired) {
    if (globalShortcut.register(key, () => id === "stop" ? capture?.active && void stopRecording().catch(report) : shortcutAction(id))) installed.set(key, id);
    else errors.push(`The shortcut ${key} could not be registered. Choose another combination in Settings.`);
  }
  if (strict && errors.length) {
    for (const key of installed.keys()) globalShortcut.unregister(key);
    for (const [key, id] of previous) globalShortcut.register(key, () => id === "stop" ? capture?.active && void stopRecording().catch(report) : shortcutAction(id));
    throw new Error(errors.join("\n"));
  }
  registeredShortcuts = installed; shortcutRegistrationErrors = errors;
}
const projects = new Set();
const projectDocuments = new ProjectDocuments({ grants, projects, defaultFolder: () => settings.preferences.projectsFolderPath ?? path.join(app.getPath("documents"), "REVA Studio") });
let mainWindow,
  tray,
  capture,
  exporter,
  privacy,
  cameraSegmenter,
  cameraAnalyzer,
  screenUpscaler,
  recordingRecovery,
  speechTranscriber,
  ffprobe,
  ffmpeg,
  toolsPromise,
  capturePromise,
  exporterPromise;
let capturePreferences = null;
let liveInputs = null;
let liveInputGeneration = 0;
let recordingMenuGeneration = 0;
let sourceRequestGeneration = 0;
let permissionRequestGeneration = 0;
let screenCaptureIssue = null;
function setScreenCaptureIssue(issue) {
  permissionRequestGeneration++;
  screenCaptureIssue = issue;
  recorder.broadcast("reva:screen-capture-issue", issue);
  return { issue };
}
async function refreshCapturePermissions() {
  const generation = ++permissionRequestGeneration;
  const permissions = await (await captureReady()).permissions();
  if (generation === permissionRequestGeneration) {
    if (permissions.screen === "granted" && screenCaptureIssue?.reason === "access-unconfirmed") setScreenCaptureIssue(null);
    else if (permissions.screen !== "granted" && screenCaptureIssue?.reason === "no-windows")
      setScreenCaptureIssue({ ...screenCaptureIssue, reason: "access-unconfirmed", permission: permissions.screen });
  }
  return permissions;
}
const cameraFrames = new CameraPreviewFrames(frame => {
  const window = recorder.windows.get("camera-preview");
  if (window && !window.isDestroyed()) window.webContents.send("reva:camera-preview-frame", frame);
});
const mediaPermissions = new CaptureMediaPermissions({ systemPreferences });
let liveInputAuthorization = null;
const inputLevels = new Map();
let inputMonitorState = { phase: "idle", camera: false, cameraDeviceID: null, activeCameraDeviceID: null, microphones: "none", microphoneDeviceID: null, microphonePermission: "unknown", microphoneDeviceIDs: [], errors: [], updatedAt: Date.now() };
function reportInputError(error) {
  const value = { ...inputErrorData(error), message: localizeError(error, settings.language).message };
  if (value.mediaType === "camera" && (!value.deviceID || value.deviceID === cameraFrames.actualDeviceID || value.deviceID === cameraFrames.requested.deviceID)) cameraFrames.clear();
  recorder.broadcast("reva:input-error", value);
}
function acceptInputMonitorState(state) {
  inputMonitorState = state;
  cameraFrames.monitorState(state);
  if (state.phase !== "ready") inputLevels.clear();
  recorder.broadcast("reva:input-monitor-state", state);
}
function inputMonitorSnapshot() { return { state: inputMonitorState, levels: [...inputLevels.values()].filter(level => Date.now() - level.timestamp < 400) }; }
function acceptInputLevel(level) { inputLevels.set(level.deviceID, { ...level, timestamp: Date.now() }); recorder.broadcast("reva:input-level", level); }
function acceptCameraFrame(frame, source) { cameraFrames.accept(frame, source); }
function liveInputsReady() {
  if (!liveInputs) liveInputs = new LiveInputs({ InputMonitor, helper: path.join(APP_ROOT, "native", "build", "reva-capture"), onCameraFrame: frame => acceptCameraFrame(frame, "monitor"), onInputLevels: acceptInputLevel, onError: reportInputError, onState: acceptInputMonitorState });
  return liveInputs;
}
async function disposeLiveInputs() {
  const owner = liveInputs;
  if (!owner) return;
  await owner.dispose();
  if (liveInputs === owner) liveInputs = null;
}
function publishRecordingPreferences() { recorder.broadcast("reva:recording-preferences", settings.recording); }
async function syncLiveInputs({ force = false } = {}) {
  const generation = ++liveInputGeneration;
  liveInputAuthorization?.abort();
  const authorization = new AbortController();
  liveInputAuthorization = authorization;
  const visible = !!recorder.toolbar && !recorder.toolbar.isDestroyed();
  const preferences = settings.recording;
  const recording = !!capture?.active;
  const camera = !quitting && preferences.camera && preferences.cameraPreview && (recording ? preferences.cameraPreviewWhileRecording : visible && !activityStarting);
  const cameraDeviceID = recording ? capture.session?.options.cameraDeviceID ?? null : preferences.cameraDeviceID;
  cameraFrames.request(camera, recording ? "recording" : "monitor", cameraDeviceID);
  if (recording && capture.session?.ready) cameraFrames.ready("recording", cameraDeviceID, capture.session.cameraDeviceID);
  try {
    if (camera) await recorder.showPreview(); else recorder.closePreview();
    if (generation !== liveInputGeneration) return;
    if (quitting || (!visible && !recording)) { await liveInputs?.stop(); inputLevels.clear(); return; }
    if (recording) {
      await liveInputs?.stop();
      if (generation !== liveInputGeneration) return;
      if (capture.session?.ready && capture.session?.cameraDeviceID && !capture.session.stopRequested) await capture.setCameraPreview(camera);
      return;
    }
    const microphoneMenu = recorder.popoverRequest?.data.kind === "microphone";
    const microphones = !quitting && !activityStarting && visible ? (microphoneMenu ? "all" : preferences.microphone ? "selected" : "none") : "none";
    await mediaPermissions.request({ camera, microphone: microphones !== "none" }, { signal: authorization.signal });
    if (quitting || generation !== liveInputGeneration || authorization.signal.aborted) return;
    await liveInputsReady().configure({ camera, cameraDeviceID: preferences.cameraDeviceID, microphones, microphoneDeviceID: microphones === "selected" ? preferences.microphoneDeviceID : null }, { force });
  } catch (error) { if (!quitting && generation === liveInputGeneration) reportInputError(error); }
}
let importPromise = null;
const waveformJobs = new Map();
async function stopWaveforms(requestID) {
  const jobs = [...waveformJobs.values()].filter(
    (job) => requestID === undefined || job.id === requestID,
  );
  for (const job of jobs) job.controller.abort();
  await Promise.allSettled(jobs.map((job) => job.promise));
}
let quitting = false,
  exitReady = false,
  dialogActive = false,
  activityStarting = false;
let recordingInTray = false;

function send(channel, value) {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send(channel, value);
}
function report(error) {
  const message = localizeError(error, settings.language).message;
  send("reva:error", message);
  recorder.toolbar?.webContents.send("reva:error", message);
}
function restoreWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}
function trusted(event, roles = ["editor"]) {
  if (roles.includes("crop") && cropEditor.owns(event)) return true;
  if (roles.includes("preferences") && preferencesWindow.owns(event)) return true;
  if (roles.some(role => role !== "editor" && recorder.owns(event, role))) return true;
  if (!roles.includes("editor")) return false;
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  )
    return false;
  const url = event.senderFrame.url;
  if (DEV_URL) {
    try {
      return new URL(url).origin === DEV_URL;
    } catch {
      return false;
    }
  }
  return url === "reva-app://app/index.html";
}
function handle(channel, listener, roles = ["editor"]) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      if (!trusted(event, roles))
        throw new Error("This request did not come from the REVA Studio editor.");
      return await listener(...args);
    } catch (error) {
      throw localizeError(error, settings.language);
    }
  });
}
async function withDialog(operation) {
  if (dialogActive) throw new Error("Finish the open file dialog first.");
  dialogActive = true;
  try {
    return await operation();
  } finally {
    dialogActive = false;
  }
}
async function toolsReady() {
  if (!toolsPromise)
    toolsPromise = Promise.all([
      findTool("ffmpeg", process.resourcesPath),
      findTool("ffprobe", process.resourcesPath),
    ])
      .then(([encoder, inspector]) => {
        ffmpeg = encoder;
        ffprobe = inspector;
        return { ffmpeg, ffprobe };
      })
      .catch((error) => {
        toolsPromise = null;
        throw error;
      });
  return toolsPromise;
}
async function captureReady() {
  if (!capturePromise)
    capturePromise = (async () => {
      const found = await toolsReady();
      const helper = path.join(APP_ROOT, "native", "build", "reva-capture");
      try {
        await fs.access(helper);
      } catch {
        throw new Error(
          "The native recorder has not been built. Run npm run build:native, then restart REVA Studio.",
        );
      }
      capture = new Capture({
        helper,
        recordingRoot: path.join(app.getPath("userData"), "Recordings"),
        ffprobe: found.ffprobe,
        grants,
        excludeProcessID: process.pid,
        requestMediaAccess: (inputs, options) => mediaPermissions.request(inputs, options),
        onReady: () => {
          setRecordingTray(true);
          mainWindow?.hide();
          recorder.setState({ status: "recording", startedAt: Date.now() });
          send("reva:recording-started", Date.now());
          void syncLiveInputs();
          if (!settings.preferences.showRecordingWidget) recorder.toolbar?.hide();
          if (settings.preferences.recordingAreaCover && capture.session) void recorder.showAreaCover(capture.session.options.source, capture.session.options.area).catch(report);
          syncDockVisibility();
        },
        onStopped: (result) => {
          recorder.close(false);
          restoreWindow();
          const preferences = capturePreferences ?? settings.recording;
          capturePreferences = null;
          send("reva:recording-stopped", { ...result, afterRecording: { destination: settings.preferences.showQuickExportWidget ? preferences.afterRecording : "project", autoZoom: preferences.autoZoom, settings: preferences.quickExportSettings } });
          void syncLiveInputs();
        },
        onIdle: () => {
          setRecordingTray(false);
          send("reva:recording-idle");
          if (recorder.state.status !== "idle") { recorder.close(false); restoreWindow(); }
          void syncLiveInputs();
          syncDockVisibility();
          void desktopIcons.restore().catch(report);
        },
        onError: report,
        onCameraFrame: frame => acceptCameraFrame(frame, "recording"),
        onInputLevels: acceptInputLevel,
        onInputError: reportInputError,
        onState: state => recorder.setState({ ...recorder.state, status: "recording", paused: state.status === "paused", elapsedMs: state.elapsedMs, stateUpdatedAt: Date.now() }),
      });
      return capture;
    })().catch((error) => {
      capturePromise = null;
      throw error;
    });
  return capturePromise;
}
async function exporterReady() {
  if (!exporterPromise)
    exporterPromise = toolsReady()
      .then((found) => {
        exporter = new Exporter({ grants, ...found });
        return exporter;
      })
      .catch((error) => {
        exporterPromise = null;
        throw error;
      });
  return exporterPromise;
}
async function startActivity(operation) {
  if (
    activityStarting ||
    capture?.active ||
    exporter?.active ||
    privacy?.active || cameraSegmenter?.active || cameraAnalyzer?.active || speechTranscriber?.active || screenUpscaler?.active || recordingRecovery?.active
  )
    throw new Error(
      "Finish the current recording, export, or privacy analysis first.",
    );
  activityStarting = true;
  try {
    return await operation();
  } finally {
    activityStarting = false;
  }
}
async function stopRecording() {
  if (!capture?.active) throw new Error("No recording is active.");
  recorder.setState({ status: "finishing", startedAt: recorder.state.startedAt });
  return capture.stop();
}
async function addRecordingFlag() { if (!capture?.active) throw new Error("No recording is active."); return capture.addFlag(); }
async function speakerNotesAction(action = "show") {
  let window = recorder.windows.get("speaker-notes");
  if (action === "toggleShowSpeakerNotes" && window && !window.isDestroyed() && window.isVisible()) { window.webContents.send("reva:speaker-notes-action", "stop-prompter"); window.hide(); return; }
  if (!window || window.isDestroyed()) { const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea; window = await recorder.create("speaker-notes", { title: "REVA Studio — Speaker notes", type: "panel", width: 520, height: 320, resizable: true, x: Math.round(area.x + (area.width - 520) / 2), y: area.y + 60 }); }
  window.showInactive(); if (action === "toggleSpeakerNotesPrompter") window.webContents.send("reva:speaker-notes-action", "toggle-prompter");
}
function setRecordingTray(recording) {
  recordingInTray = recording;
  if (!tray) return;
  tray.setTitle(recording ? "● REC" : "");
  tray.setToolTip(
    recording ? tnative("REVA Studio — recording. ⌘⇧2 to stop.") : "REVA Studio",
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: tnative("Show REVA Studio"), click: restoreWindow },
      {
        label: tnative("Stop Recording"),
        enabled: recording,
        accelerator: "CommandOrControl+Shift+2",
        click: () => stopRecording().catch(report),
      },
      { type: "separator" },
      { label: tnative("Quit REVA Studio"), click: () => app.quit() },
    ]),
  );
}
function menuAction(action) {
  restoreWindow();
  send("reva:menu-action", action);
}

function popup(template, position) {
  const window = recorder.toolbar;
  if (!window || window.isDestroyed()) throw new Error("The recording panel is not open.");
  return new Promise(resolve => {
    let selected = null;
    const decorate = items => items.map(item => ({ ...item,
      ...(item.submenu ? { submenu: decorate(item.submenu) } : {}),
      ...(item.result !== undefined ? { click: () => { selected = item.result; } } : {}),
    }));
    const menu = Menu.buildFromTemplate(decorate(template));
    const bounds = window.getBounds();
    const x = Math.round(Math.min(bounds.width - 1, Math.max(0, Number(position?.x) || 0)));
    const y = Math.round(Math.min(bounds.height - 1, Math.max(0, Number(position?.y) || bounds.height - 1)));
    menu.popup({ window, x, y, callback: () => resolve(selected) });
  });
}

async function recordingMenu(kind, position) {
  if (!["camera", "microphone", "system-audio", "settings", "screen-permission"].includes(kind)) throw new Error("Unsupported recording menu.");
  sourceRequestGeneration++;
  const generation = ++recordingMenuGeneration, toolbar = recorder.toolbar;
  const devices = kind === "camera" || kind === "microphone" ? await (await captureReady()).devices() : { cameras: [], microphones: [] };
  const applications = kind === "system-audio" ? await (await captureReady()).audioApplications() : undefined;
  if (generation !== recordingMenuGeneration || recorder.toolbar !== toolbar || !toolbar || toolbar.isDestroyed() || recorder.captureRequest || activityStarting || recorder.state.status !== "idle") return { preferences: settings.recording, language: settings.language };
  if (kind === "screen-permission" && !screenCaptureIssue) return { preferences: settings.recording, language: settings.language, retrySource: true };
  const closed = recorder.showPopover({ kind, devices, applications, preferences: settings.recording, ...(kind === "screen-permission" ? { screenIssue: screenCaptureIssue } : {}) }, position);
  void syncLiveInputs();
  const action = await closed;
  return { preferences: settings.recording, language: settings.language, retrySource: action === "retry" && generation === recordingMenuGeneration && recorder.toolbar === toolbar && !toolbar.isDestroyed() && !quitting && !activityStarting && recorder.state.status === "idle" };
}

async function chooseCaptureSource(kind, position) {
  recordingMenuGeneration++;
  if (!["display", "window", "area", "device"].includes(kind)) throw new Error("Unsupported recording source.");
  const generation = ++sourceRequestGeneration, toolbar = recorder.toolbar;
  const current = () => generation === sourceRequestGeneration && toolbar && !toolbar.isDestroyed() && recorder.toolbar === toolbar && !quitting && !activityStarting && !capture?.active && !recorder.captureRequest && recorder.state.status === "idle";
  if (!current()) return null;
  if (kind === "device") {
    const devices = await (await captureReady()).devices(); if (!current()) return null;
    const available = devices.screenDevices ?? [];
    if (!available.length) throw new Error(devices.screenDeviceIssue ?? "No wired iPhone or iPad screen is available. Connect the device by USB, unlock it and trust this Mac, then retry.");
    const source = await popup(available.map(device => ({ label: device.name, sublabel: `${device.width} × ${device.height}`, result: { id: `device:${device.id}`, name: device.name, kind: "device", width: device.width, height: device.height } })), position);
    return source && current() ? { source } : null;
  }
  let permissions, sources;
  try {
    permissions = await refreshCapturePermissions();
    if (!current()) return null;
    sources = await (await captureReady()).sources();
  } catch (error) { if (!current()) return null; throw error; }
  if (!current()) return null;
  const candidates = sources.filter(source => source.kind === (kind === "window" ? "window" : "display"));
  if (!candidates.length) return setScreenCaptureIssue({ reason: kind === "window" ? permissions.screen === "granted" ? "no-windows" : "access-unconfirmed" : "no-displays", sourceKind: kind, permission: permissions.screen });
  setScreenCaptureIssue(null);
  const display = kind !== "window" && candidates.length > 1 ? await popup(candidates.map(source => ({ label: source.name, sublabel: `${Math.round(source.width)} × ${Math.round(source.height)}`, result: source })), position) : kind !== "window" ? candidates[0] : undefined;
  if (display === null || !current()) return null;
  return recorder.selectSource(kind, sources, settings.recording, settings.savedAreas, display);
}

function makeMenu() {
  const item = (label, action, accelerator) => ({
    label: tnative(label),
    accelerator,
    click: () => menuAction(action),
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "REVA Studio",
        submenu: [
          { role: "about", label: tnative("About REVA Studio") },
          item("Settings…", "preferences", "CommandOrControl+,"),
          { type: "separator" },
          { role: "services", label: tnative("Services") },
          { type: "separator" },
          { role: "hide", label: tnative("Hide REVA Studio") },
          { role: "hideOthers", label: tnative("Hide Others") },
          { role: "unhide", label: tnative("Show All") },
          { type: "separator" },
          { role: "quit", label: tnative("Quit REVA Studio") },
        ],
      },
      {
        label: tnative("File"),
        submenu: [
          item("New Recording", "record", "CommandOrControl+N"),
          item("Import Video…", "import", "CommandOrControl+Shift+O"),
          item("Import Screen Studio Project…", "import-screenstudio"),
          item("Open Project…", "open", "CommandOrControl+O"),
          { role: "recentDocuments", label: tnative("Open Recent"), submenu: [{ role: "clearRecentDocuments", label: tnative("Clear Menu") }] },
          { type: "separator" },
          item("Save Project", "save", "CommandOrControl+S"),
          item("Save Project As…", "save-as", "CommandOrControl+Shift+S"),
          item("Export Portable Project…", "portable-project"),
          item("Recover Interrupted Recording…", "recover-recording"),
          item("Extract Raw Recording Files…", "extract-raw"),
          { type: "separator" },
          item("Export…", "export", "CommandOrControl+E"),
          { role: "close", label: tnative("Close Window") },
        ],
      },
      {
        label: tnative("Edit"),
        submenu: [
          item("Undo", "undo", "CommandOrControl+Z"),
          item("Redo", "redo", "CommandOrControl+Shift+Z"),
          item("Copy Current Frame as Image", "copy-frame", "CommandOrControl+Shift+C"),
          { type: "separator" },
          { role: "cut", label: tnative("Cut") },
          { role: "copy", label: tnative("Copy") },
          { role: "paste", label: tnative("Paste") },
          { role: "selectAll", label: tnative("Select All") },
        ],
      },
      {
        label: tnative("View"),
        submenu: [
          item("Command Menu…", "commands", "CommandOrControl+K"),
          { role: "togglefullscreen", label: tnative("Toggle Full Screen") },
          ...(DEV_URL ? [{ role: "toggleDevTools", label: tnative("Toggle Developer Tools") }] : []),
        ],
      },
      {
        label: tnative("Window"),
        submenu: [
          { role: "minimize", label: tnative("Minimize") },
          { role: "zoom", label: tnative("Zoom Window") },
          { type: "separator" },
          { role: "front", label: tnative("Bring All to Front") },
        ],
      },
    ]),
  );
}

function installIPC() {
  handle("reva:get-language", () => settings.language, ["editor", "recorder", "crop", "capture-picker", "recorder-popover", "camera-preview", "preferences", "speaker-notes"]);
  handle("reva:app-preferences", publicPreferences, ["editor", "recorder", "recorder-popover", "preferences"]);
  handle("reva:app-preferences-patch", async input => {
    const next = parsePreferencesPatch(settings.preferences, input, settings.recording), previous = settings.preferences;
    registerPreferenceShortcuts(next);
    try { await settings.patchPreferences(input); }
    catch (error) { registerPreferenceShortcuts(previous, false); throw error; }
    if (process.platform === "darwin" && next.startAtLogin !== previous.startAtLogin) app.setLoginItemSettings({ openAtLogin: next.startAtLogin });
    syncDockVisibility(); publishRecordingPreferences(); publishAppPreferences(); void syncLiveInputs();
    return publicPreferences();
  }, ["editor", "preferences"]);
  handle("reva:preferences-open", tab => preferencesWindow.open(tab ?? "general", mainWindow));
  handle("reva:preferences-close", () => preferencesWindow.close(), ["preferences"]);
  handle("reva:preferences-tab", () => preferencesWindow.getTab(), ["preferences"]);
  handle("reva:preferences-resize", height => preferencesWindow.resize(height), ["preferences"]);
  handle("reva:preferences-directory", kind => withDialog(async () => {
    if (!["projects", "presets"].includes(kind)) throw new Error("Choose projects or presets.");
    const result = await dialog.showOpenDialog(preferencesWindow.window ?? mainWindow, { properties: ["openDirectory", "createDirectory"], buttonLabel: tnative("Choose") });
    if (result.canceled || !result.filePaths[0]) return null;
    const folder = await fs.realpath(result.filePaths[0]);
    await fs.access(folder, require("node:fs").constants.R_OK | require("node:fs").constants.W_OK);
    await settings.patchPreferences({ [kind === "projects" ? "projectsFolderPath" : "presetsFolderPath"]: folder });
    publishAppPreferences(); return publicPreferences();
  }), ["editor", "preferences"]);
  handle("reva:preferences-reset", () => withDialog(async () => {
    const answer = await dialog.showMessageBox(preferencesWindow.window ?? mainWindow, { type: "question", message: tnative("Reset all application and recording preferences?"), buttons: [tnative("Cancel"), tnative("Reset")], cancelId: 0, defaultId: 0 });
    if (answer.response !== 1) return null;
    await settings.resetPreferences(); registerPreferenceShortcuts(settings.preferences, false); syncDockVisibility(); publishAppPreferences(); publishRecordingPreferences(); return publicPreferences();
  }), ["preferences"]);
  handle("reva:project-open-state", value => { if (typeof value !== "boolean") throw new Error("Invalid project state."); projectOpen = value; syncDockVisibility(); });
  handle("reva:set-language", async (language) => {
    await settings.setLanguage(language);
    makeMenu();
    setRecordingTray(recordingInTray);
    updateAboutPanel();
  }, ["editor", "recorder-popover"]);
  handle("reva:import-screenstudio", () =>
    startActivity(() => {
      importPromise = withDialog(async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
          title: tnative("Import Screen Studio project"),
          properties: ["openFile", "openDirectory", "treatPackageAsDirectory"],
          filters: [{ name: "Screen Studio", extensions: ["screenstudio"] }],
          buttonLabel: tnative("Import project"),
        });
        if (result.canceled || !result.filePaths[0]) return null;
        const selected = result.filePaths[0];
        if (path.extname(selected).toLowerCase() !== ".screenstudio")
          throw new Error("Select a .screenstudio project folder.");
        const found = await toolsReady();
        const imported = await importScreenStudio(selected, {
          ...found,
          cacheRoot: path.join(app.getPath("userData"), "Imports"),
        });
        for (const file of [
          imported.mediaInfo.path,
          imported.microphonePath,
          imported.cameraPath,
          ...((imported.audio?.voiceovers ?? []).map(clip => clip.path)),
        ])
          if (file) await grants.grant(file);
        await fs.writeFile(
          path.join(
            imported.provenance.normalization.directory,
            "source-provenance.json",
          ),
          JSON.stringify(imported.provenance, null, 2),
          { flag: "wx", mode: 0o600 },
        );
        return imported;
      }).finally(() => {
        importPromise = null;
      });
      return importPromise;
    }),
  );
  handle("reva:import-video", () =>
    withDialog(async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: tnative("Import a recording"),
        buttonLabel: tnative("Import"),
        properties: ["openFile"],
        filters: [
          { name: tnative("Video"), extensions: ["mp4", "mov", "m4v", "webm", "mkv"] },
        ],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      const found = await toolsReady();
      const file = await fs.realpath(result.filePaths[0]);
      const info = await probe(file, found.ffprobe);
      if (info.width < 1 || info.height < 1 || info.duration <= 0)
        throw new Error("This file does not contain a supported video stream.");
      await grants.grant(file);
      return {
        path: file,
        name: info.name,
        duration: info.duration,
        width: info.width,
        height: info.height,
      };
    }),
  );
  handle("reva:import-image", () =>
    withDialog(async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: tnative("Choose a background"),
        buttonLabel: tnative("Choose"),
        properties: ["openFile"],
        filters: [
          { name: tnative("Images"), extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
        ],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      const stat = await fs.stat(result.filePaths[0]);
      if (!stat.isFile() || stat.size > 100 * 1024 * 1024)
        throw new Error("Choose an image smaller than 100 MiB.");
      return grants.grant(result.filePaths[0]);
    }),
  );
  handle("reva:import-cursor-image", () => withDialog(async () => {
    const selected = await dialog.showOpenDialog(mainWindow, { title: tnative("Import cursor PNG"), properties: ["openFile"], filters: [{ name: "PNG cursor", extensions: ["png"] }] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    return require("./cursor-image.cjs").importCursorImage(selected.filePaths[0], { grants, decodeImage: bytes => { const image = nativeImage.createFromBuffer(bytes); return image.isEmpty() ? null : image.getSize(); } });
  }));
  handle("reva:open-project", () =>
    withDialog(async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: tnative("Open REVA Studio project"),
        buttonLabel: tnative("Open"),
        properties: ["openFile"],
        filters: [{ name: "REVA Studio", extensions: ["revastudio"] }],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      const file = await fs.realpath(result.filePaths[0]);
      const project = await readPortableProject(file, projectCache);
      for (const asset of projectAssets(project)) await grants.grant(asset);
      projects.add(file);
      app.addRecentDocument(file);
      await grants.grant(file);
      return { project, path: file };
    }),
  );
  handle("reva:save-project", (input, existing) =>
    withDialog(async () => {
      const project = validateProject(input);
      for (const asset of projectAssets(project)) await grants.assert(asset);
      let file;
      if (existing != null) {
        if (typeof existing !== "string" || !projects.has(existing))
          throw new Error("Choose this project using Save As first.");
        file = existing;
      } else {
        const safeName =
          project.name.replace(/[\x00-\x1f/\\:]/g, "-").slice(0, 100) ||
          tnative("Untitled recording");
        const result = await dialog.showSaveDialog(mainWindow, {
          title: tnative("Save REVA Studio project"),
          buttonLabel: tnative("Save"),
          defaultPath: path.join(settings.preferences.projectsFolderPath ?? app.getPath("documents"), `${safeName}.revastudio`),
          filters: [{ name: "REVA Studio", extensions: ["revastudio"] }],
          properties: ["createDirectory", "showOverwriteConfirmation"],
        });
        if (result.canceled || !result.filePath) return null;
        file = result.filePath.endsWith(".revastudio")
          ? result.filePath
          : `${result.filePath}.revastudio`;
      }
      await projectDocuments.write(file, project);
      projects.add(file);
      app.addRecentDocument(file);
      await grants.grant(file);
      return file;
    }),
  );
  handle("reva:presets-list", async () => ({ ...await presetLibrary.list(presetFolder()), defaultPresetID: settings.defaultPresetID }));
  const recoveryReady = async () => { recordingRecovery ??= new RecordingRecovery({ root: path.join(app.getPath("userData"), "Recordings"), ...await toolsReady(), grants, helper: path.join(APP_ROOT, "native", "build", "reva-capture"), currentDirectory: () => capture?.session?.directory ?? null }); return recordingRecovery; };
  handle("reva:recovery-list", async () => (await recoveryReady()).list());
  handle("reva:recovery-start", id => startActivity(async () => (await recoveryReady()).recover(id)));
  handle("reva:recovery-cancel", () => recordingRecovery?.cancel());
  handle("reva:project-autosave", (input, existing, documentID) => projectDocuments.automatic(input, existing, documentID));
  handle("reva:quick-export-project", input => withDialog(async () => {
    if (settings.preferences.alwaysSaveProjectAfterQuickExport) return "save";
    const selected = await dialog.showMessageBox(mainWindow, { type: "question", title: tnative("Save the editable project?"), message: tnative("Export complete. Save the editable project as well?"), detail: tnative("The original recording stays on this Mac. You can keep editing even if you skip saving now."), buttons: [tnative("Save Project"), tnative("Keep Editing")], defaultId: 0, cancelId: 1 });
    return selected.response === 0 ? "save" : "keep";
  }));
  handle("reva:project-bundle-export", input => withDialog(async () => {
    const project = validateProject(input);
    for (const asset of projectAssets(project)) await grants.assert(asset);
    const selected = await dialog.showSaveDialog(mainWindow, { title: tnative("Export portable project"), defaultPath: `${project.name.replace(/[\x00-\x1f/\\:]/g, "-")}-portable.revastudio`, filters: [{ name: "REVA Studio", extensions: ["revastudio"] }] });
    if (selected.canceled || !selected.filePath) return null;
    const file = selected.filePath.endsWith(".revastudio") ? selected.filePath : `${selected.filePath}.revastudio`;
    await projectDocuments.write(file, project, { bundle: true }); app.addRecentDocument(file); return file;
  }));
  handle("reva:preset-save", async (project, name) => {
    if (typeof name !== "string" || !name.trim() || name.length > 512) throw new Error("Enter a preset name.");
    return presetLibrary.save(presetFolder(), { ...validateProject(project), name: name.trim() });
  });
  handle("reva:preset-update", (id, changes) => presetLibrary.update(presetFolder(), id, changes));
  handle("reva:preset-reveal", async id => { shell.showItemInFolder(await presetLibrary.file(presetFolder(), id)); });
  handle("reva:preset-remove", async id => { await presetLibrary.remove(presetFolder(), id); if (settings.defaultPresetID === id) await settings.setDefaultPreset(null); });
  handle("reva:preset-import", () => withDialog(async () => {
    const selected = await dialog.showOpenDialog(mainWindow, { properties: ["openFile"], filters: [{ name: "REVA Studio preset", extensions: ["revapreset"] }] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const preset = await presetLibrary.read(selected.filePaths[0]);
    send("reva:preset-imported", preset);
    return preset;
  }));
  handle("reva:preset-export", (input, name) => withDialog(async () => {
    const project = presetProject({ ...validateProject(input), name: typeof name === "string" && name.trim() ? name.trim() : input.name });
    const selected = await dialog.showSaveDialog(mainWindow, { defaultPath: `${project.name.replace(/[\x00-\x1f/\\:]/g, "-")}.revapreset`, filters: [{ name: "REVA Studio preset", extensions: ["revapreset"] }] });
    if (selected.canceled || !selected.filePath) return null;
    const file = selected.filePath.endsWith(".revapreset") ? selected.filePath : `${selected.filePath}.revapreset`;
    await writeProjectBundle(file, project, file => grants.assert(file)); return file;
  }));
  handle("reva:new-project-appearance", async () => {
    if (settings.defaultPresetID) { const entry = (await presetLibrary.list(presetFolder())).presets.find(item => item.id === settings.defaultPresetID); if (!entry) throw new Error("The default preset could not be loaded from the selected folder."); return entry.appearance; }
    if (!settings.preferences.useLastProjectConfigForNewProjects) return null;
    try { return (await presetLibrary.read(path.join(app.getPath("userData"), "last-project.revapreset"))).appearance; }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  });
  handle("reva:last-project-appearance", async input => {
    const project = presetProject(input);
    await writePortableProject(path.join(app.getPath("userData"), "last-project.revapreset"), project, file => grants.assert(file));
  });
  handle("reva:default-preset", async id => {
    if (id !== null && !(await presetLibrary.list(presetFolder())).presets.some(item => item.id === id)) throw new Error("Choose an existing preset.");
    await settings.setDefaultPreset(id); return id;
  });
  handle("reva:sources", async () => (await captureReady()).sources());
  handle("reva:permissions", refreshCapturePermissions, ["editor", "recorder", "recorder-popover", "capture-picker"]);
  handle("reva:record-start", (options) =>
    startActivity(async () => {
      liveInputGeneration++;
      liveInputAuthorization?.abort();
      recordingMenuGeneration++;
      sourceRequestGeneration++;
      recorder.closePopover();
      recorder.toolbar?.hide();
      capturePreferences = settings.recording;
      try {
        await liveInputs?.stop();
        const preferences = capturePreferences;
        if (preferences.hideDesktopIcons) await desktopIcons.hide();
        return await (await captureReady()).start({ ...options, previewCamera: !!options.camera && preferences.cameraPreview && preferences.cameraPreviewWhileRecording, monitorMicrophone: !!options.microphone });
      }
      catch (error) {
        capturePreferences = null; recorder.toolbar?.show();
        if (!capture?.active) recorder.setState({ status: "idle" });
        if (!capture?.active) await desktopIcons.restore().catch(report);
        if (error?.code === "screen_permission_denied") {
          // A rejected readiness promise precedes child close. Do not offer a
          // retry until the failed recorder has actually released its inputs.
          if (capture?.active) {
            try { await capture.stop(); }
            catch (cleanupError) { if (capture.active) throw cleanupError; }
          }
          const permissions = await refreshCapturePermissions().catch(() => ({ screen: "unknown" }));
          return setScreenCaptureIssue({ reason: "access-unconfirmed", sourceKind: options.area ? "area" : options.source.kind, permission: permissions.screen });
        }
        throw error;
      }
      finally { setImmediate(() => { void syncLiveInputs(); }); }
    }), ["editor", "recorder"],
  );
  handle("reva:record-stop", stopRecording, ["editor", "recorder"]);
  handle("reva:record-pause", () => capture?.pause(), ["editor", "recorder"]);
  handle("reva:record-resume", () => capture?.resume(), ["editor", "recorder"]);
  handle("reva:record-flag", addRecordingFlag, ["editor", "recorder"]);
  handle("reva:speaker-notes-show", () => speakerNotesAction(), ["editor", "recorder", "recorder-popover"]);
  handle("reva:speaker-notes-close", () => { const window = recorder.windows.get("speaker-notes"); if (window && !window.isDestroyed()) { window.webContents.send("reva:speaker-notes-action", "stop-prompter"); window.hide(); } }, ["speaker-notes"]);
  handle("reva:speaker-notes-get", () => notesStore.read(), ["editor", "speaker-notes"]);
  handle("reva:speaker-notes-save", value => notesStore.save(value), ["speaker-notes"]);
  handle("reva:desktop-restore", () => desktopIcons.restore(), ["editor", "recorder", "recorder-popover"]);
  handle("reva:window-resize", async (input, width, height) => {
    const request = recorder.captureRequest;
    if (!request || request.data.mode !== "window") throw new Error("Choose a window before resizing it.");
    const selected = request.data.sources.find(source => source.id === input?.id && source.kind === "window" && source.ownerPID === input.ownerPID);
    if (!selected?.ownerPID || !Number.isFinite(width) || !Number.isFinite(height) || width < 150 || height < 150 || width > 16384 || height > 16384) throw new Error("Choose a window and a size between 150 and 16384 points.");
    await require("./media.cjs").runProcess(path.join(APP_ROOT, "native", "build", "reva-capture"), ["resize-window", "--window-id", selected.id.slice(7), "--owner-pid", String(selected.ownerPID), "--width", String(width), "--height", String(height)], { timeout: 10000 });
    const sources = await (await captureReady()).sources();
    if (recorder.captureRequest !== request) throw new Error("The window picker was closed while resizing.");
    request.data.sources = sources; const actual = sources.find(source => source.id === selected.id && source.ownerPID === selected.ownerPID); if (!actual) throw new Error("The resized window could not be read back."); return actual;
  }, ["capture-picker"]);
  handle("reva:record-restart", () => withDialog(async () => {
    const answer = await dialog.showMessageBox(recorder.toolbar ?? mainWindow, { type: "question", message: tnative("Discard this recording and start again?"), buttons: [tnative("Cancel"), tnative("Restart")], cancelId: 0, defaultId: 0 });
    if (answer.response === 1) await capture?.restart();
  }), ["editor", "recorder"]);
  handle("reva:record-discard", () => withDialog(async () => {
    const answer = await dialog.showMessageBox(recorder.toolbar ?? mainWindow, { type: "question", message: tnative("Delete this recording?"), buttons: [tnative("Cancel"), tnative("Delete")], cancelId: 0, defaultId: 0 });
    if (answer.response === 1) await capture?.discard();
  }), ["editor", "recorder"]);
  handle("reva:recorder-open", async () => {
    if (activityStarting || exporter?.active || privacy?.active || cameraSegmenter?.active || importPromise) throw new Error("Finish the current recording, export, or privacy analysis first.");
    await recorder.open(); if (recorder.toolbar && !recorder.toolbar.isDestroyed()) { mainWindow?.hide(); void syncLiveInputs(); }
  });
  handle("reva:recorder-close", () => { recordingMenuGeneration++; sourceRequestGeneration++; recorder.close(); }, ["recorder"]);
  handle("reva:recorder-state", () => ({ ...recorder.state, preferences: settings.recording, screenIssue: screenCaptureIssue }), ["recorder"]);
  handle("reva:recording-area-cover", () => recorder.areaCoverInfo(), ["recording-area-cover"]);
  handle("reva:recorder-devices", async () => (await captureReady()).devices(), ["recorder"]);
  handle("reva:input-monitor-state", inputMonitorSnapshot, ["recorder", "recorder-popover"]);
  handle("reva:camera-effects", async () => {
    if (capture?.active) return capture.showCameraEffects();
    if (liveInputs?.monitor?.state.activeCameraDeviceID) return liveInputs.monitor.showCameraEffects();
    throw new Error("Enable a live camera preview to open macOS camera effects.");
  }, ["recorder", "recorder-popover", "camera-preview"]);
  handle("reva:microphone-retry", async () => {
    if (capture?.active || activityStarting) throw new Error("Finish the current recording before restarting microphone monitoring.");
    await syncLiveInputs({ force: true });
    return inputMonitorSnapshot();
  }, ["recorder", "recorder-popover"]);
  handle("reva:capture-privacy-settings", kind => shell.openExternal(capturePrivacySettingsURL(kind)), ["editor", "recorder", "recorder-popover", "capture-picker"]);
  handle("reva:recorder-menu", recordingMenu, ["recorder"]);
  handle("reva:recorder-popover-info", () => ({ ...recorder.popoverInfo(), preferences: settings.recording, levels: [...inputLevels.values()].filter(level => Date.now() - level.timestamp < 400) }), ["recorder-popover"]);
  handle("reva:recorder-popover-close", () => recorder.closePopover(), ["recorder-popover"]);
  handle("reva:screen-source-retry", () => {
    if (recorder.popoverRequest?.data.kind !== "screen-permission") throw new Error("No Screen Recording help is open.");
    recorder.closePopover("retry");
  }, ["recorder-popover"]);
  handle("reva:recorder-preferences", async patch => {
    await settings.patchRecording(patch);
    publishRecordingPreferences();
    void syncLiveInputs();
    return settings.recording;
  }, ["recorder", "recorder-popover", "camera-preview"]);
  handle("reva:camera-preview-info", () => ({ frame: cameraFrames.frame, preferences: settings.recording }), ["camera-preview"]);
  handle("reva:recorder-shortcuts", () => { recorder.closePopover(); void preferencesWindow.open("shortcuts", mainWindow).catch(report); }, ["recorder-popover"]);
  handle("reva:recorder-source", chooseCaptureSource, ["recorder"]);
  handle("reva:capture-picker-info", () => recorder.captureInfo(), ["capture-picker"]);
  handle("reva:capture-picker-complete", async input => {
    const prepared = recorder.prepareCapture(input);
    if (input !== null) await settings.patchRecording({ autoZoom: input.autoZoom, afterRecording: input.afterRecording, quickExportSettings: input.quickExportSettings });
    recorder.finishCapture(prepared);
  }, ["capture-picker"]);
  handle("reva:capture-area-save", async input => {
    const data = recorder.captureInfo();
    const source = data.sources.find(source => source.kind === "display" && source.bounds?.x === data.display.x && source.bounds?.y === data.display.y);
    if (!source || !input || typeof input.name !== "string") throw new Error("A saved recording area is invalid.");
    const rect = recorder.captureArea(input.rect, source);
    return settings.saveCaptureArea({ id: randomUUID(), name: input.name, rect });
  }, ["capture-picker"]);
  handle("reva:recorder-folder", async () => {
    const directory = (await captureReady()).recordingRoot;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
  }, ["recorder"]);
  handle("reva:crop-open", data => withDialog(async () => {
    if (!data || typeof data !== "object" || typeof data.mediaPath !== "string" || !Number.isFinite(data.time)) throw new Error("Choose a recording to crop first.");
    const mediaPath = await grants.assert(data.mediaPath);
    const info = await probe(mediaPath, (await toolsReady()).ffprobe);
    const crop = cropRectangle(data.crop);
    return cropEditor.open({ mediaPath, width: info.width, height: info.height, time: Math.max(0, Math.min(info.duration - 0.001, data.time)), crop }, mainWindow);
  }));
  handle("reva:crop-info", () => cropEditor.getData(), ["crop"]);
  handle("reva:crop-complete", value => cropEditor.complete(value), ["crop"]);
  handle("reva:privacy-analyze", (file, settings) =>
    startActivity(async () => {
      if (!privacy)
        privacy = new PrivacyAnalyzer({
          helper: path.join(APP_ROOT, "native", "build", "reva-capture"),
          cacheRoot: path.join(app.getPath("userData"), "Analysis"),
          grants,
          onProgress: (progress) => send("reva:privacy-progress", progress),
        });
      return privacy.analyze(file, settings);
    }),
  );
  handle("reva:privacy-cancel", () => privacy?.cancel());
  handle("reva:camera-segment", file => startActivity(async () => {
    const found = await toolsReady();
    if (!cameraSegmenter) cameraSegmenter = new CameraSegmenter({
      helper: path.join(APP_ROOT, "native", "build", "reva-capture"), cacheRoot: path.join(app.getPath("userData"), "CameraMasks"), grants, ffprobe: found.ffprobe,
      onProgress: progress => send("reva:camera-segment-progress", progress),
    });
    const result = await cameraSegmenter.segment(file);
    if (result) await grants.grant(result.path);
    return result;
  }));
  handle("reva:camera-segment-cancel", () => cameraSegmenter?.cancel());
  handle("reva:camera-analyze", (file, options) => startActivity(async () => {
    cameraAnalyzer ??= new CameraAnalyzer({ helper: path.join(APP_ROOT, "native", "build", "reva-capture"), cacheRoot: path.join(app.getPath("userData"), "CameraAnalysis"), grants, onProgress: progress => send("reva:camera-analysis-progress", progress) });
    return cameraAnalyzer.analyze(file, options);
  }));
  handle("reva:camera-analysis-cancel", () => cameraAnalyzer?.cancel());
  handle("reva:screen-upscale", file => startActivity(async () => {
    screenUpscaler ??= new ScreenUpscaler({ helper: path.join(APP_ROOT, "native", "build", "reva-capture"), cacheRoot: path.join(app.getPath("userData"), "ScreenEnhancement"), grants, modelPath: path.join(APP_ROOT, "resources", "models", "PiperSR_2x.mlpackage"), onProgress: progress => send("reva:screen-upscale-progress", progress) });
    return screenUpscaler.upscale(file);
  }));
  handle("reva:screen-upscale-cancel", () => screenUpscaler?.cancel());
  handle("reva:model-attribution", url => { if (!["https://modelpiper.com", "https://creativecommons.org/licenses/by/4.0/"].includes(url)) throw new Error("Choose the bundled model's attribution or license link."); return shell.openExternal(url); });
  handle("reva:audio-preview", async (project, request) => { audioPreview ??= new AudioPreview({ root: path.join(app.getPath("userData"), "AudioPreview"), grants, ...await toolsReady() }); return audioPreview.render(project, request); });
  handle("reva:audio-preview-cancel", id => audioPreview?.cancel(id));
  handle("reva:audio-import", () => withDialog(async () => {
    const selected = await dialog.showOpenDialog(mainWindow, { properties: ["openFile"], filters: [{ name: "Audio", extensions: ["mp3", "m4a", "wav", "aac", "aiff", "flac", "ogg", "webm", "mp4", "mov"] }] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const file = await fs.realpath(selected.filePaths[0]), found = await toolsReady(), info = await probe(file, found.ffprobe);
    if (!info.hasAudio || info.duration <= 0) throw new Error("Choose a file with a supported audio stream."); await grants.grant(file); return { path: file, name: path.basename(file), duration: info.duration };
  }));
  handle("reva:voiceover-save", async (input, mime) => {
    if (!(input instanceof Uint8Array) || !input.length || input.length > 64 * 1024 * 1024 || !["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].includes(mime)) throw new Error("The local narration is invalid or exceeds 64 MiB.");
    const folder = path.join(app.getPath("userData"), "Voiceovers"); await fs.mkdir(folder, { recursive: true, mode: 0o700 }); const file = path.join(folder, `${randomUUID()}.${mime === "audio/mp4" ? "m4a" : "webm"}`);
    await fs.writeFile(file, Buffer.from(input.buffer, input.byteOffset, input.byteLength), { flag: "wx", mode: 0o600 });
    const info = await probe(file, (await toolsReady()).ffprobe); if (!info.hasAudio || info.duration <= 0) throw new Error(`The narration could not be decoded. Its original bytes remain at ${file}`); await grants.grant(file); return { path: file, name: `Narration ${new Date().toLocaleString()}`, duration: info.duration };
  });
  handle("reva:music-library", () => audioLibrary.list());
  handle("reva:music-library-open", async () => { const folder = await audioLibrary.directory(), error = await shell.openPath(folder); if (error) throw new Error(error); });
  handle("reva:background-search", (query, page, key) => backgroundAssets.search(query, page, key));
  handle("reva:background-import", (photo, key) => backgroundAssets.importPhoto(photo, key));
  handle("reva:background-favorites", () => backgroundAssets.listFavorites());
  handle("reva:background-favorite-save", value => backgroundAssets.saveFavorite(value));
  handle("reva:background-favorite-remove", id => backgroundAssets.removeFavorite(id));
  handle("reva:background-link", url => { let parsed; try { parsed = new URL(url); } catch { throw new Error("Invalid attribution URL."); } if (parsed.protocol !== "https:" || !["unsplash.com", "www.unsplash.com"].includes(parsed.hostname) || parsed.username || parsed.password || parsed.port) throw new Error("Choose an official Unsplash attribution link."); return shell.openExternal(url); });
  const speechReady = () => speechTranscriber ??= new SpeechTranscriber({ helper: path.join(APP_ROOT, "native", "build", "reva-capture"), cacheRoot: path.join(app.getPath("userData"), "Transcription"), grants, onProgress: progress => send("reva:speech-progress", progress) });
  handle("reva:speech-status", locale => speechReady().status(locale));
  handle("reva:speech-generate", (file, options) => startActivity(() => speechReady().transcribe(file, options)));
  handle("reva:speech-cancel", () => speechTranscriber?.cancel());
  handle("reva:transcript-import", duration => withDialog(async () => {
    const selected = await dialog.showOpenDialog(mainWindow, { properties: ["openFile"], filters: [{ name: "Transcript", extensions: ["srt", "json"] }] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    await grants.grant(selected.filePaths[0]); return importTranscriptFile(selected.filePaths[0], duration, grants);
  }));
  handle("reva:transcript-export", (content, name) => withDialog(async () => {
    if (typeof content !== "string" || Buffer.byteLength(content) > 32 * 1024 * 1024 || typeof name !== "string") throw new Error("Invalid subtitle export.");
    const selected = await dialog.showSaveDialog(mainWindow, { defaultPath: `${name.replace(/[\x00-\x1f/\\:]/g, "-")}.srt`, filters: [{ name: "SubRip subtitles", extensions: ["srt"] }] });
    if (selected.canceled || !selected.filePath) return false;
    const file = selected.filePath.endsWith(".srt") ? selected.filePath : `${selected.filePath}.srt`, temporary = `${file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, content, { flag: "wx", mode: 0o600 }); await fs.rename(temporary, file); } finally { await fs.rm(temporary, { force: true }); }
    return true;
  }));
  handle("reva:clipboard-image", (png, width, height) => {
    const { validatePng } = require("./core.cjs"), bytes = validatePng(png, width, height), image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new Error("The current frame could not be copied."); clipboard.writeImage(image); return true;
  });
  handle("reva:raw-extract", input => withDialog(async () => {
    const project = validateProject(input), selected = await dialog.showOpenDialog(mainWindow, { title: tnative("Extract raw recording files"), properties: ["openDirectory", "createDirectory"] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    return require("./raw-extract.cjs").extractRawRecording(project, selected.filePaths[0], grants);
  }));
  handle("reva:waveform", (file, requestID) => {
    if (
      typeof requestID !== "string" ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(requestID)
    )
      throw new Error("A waveform request identifier is required.");
    if (waveformJobs.has(requestID) || waveformJobs.size >= 2)
      throw new Error(
        "Wait for the previous audio waveform request to finish.",
      );
    const previous = stopWaveforms();
    const job = {
      id: requestID,
      controller: new AbortController(),
      promise: null,
    };
    job.promise = (async () => {
      await previous;
      job.controller.signal.throwIfAborted();
      const found = await toolsReady();
      return getWaveform(file, {
        grants,
        ...found,
        signal: job.controller.signal,
      });
    })().finally(() => {
      if (waveformJobs.get(requestID) === job) waveformJobs.delete(requestID);
    });
    waveformJobs.set(requestID, job);
    return job.promise;
  });
  handle("reva:waveform-cancel", (requestID) => {
    if (typeof requestID !== "string")
      throw new Error("A waveform request identifier is required.");
    return stopWaveforms(requestID);
  });
  handle("reva:export-start", (options) =>
    startActivity(async () => {
      const encoder = await exporterReady();
      return encoder.start(options, (validated) =>
        withDialog(async () => {
          const extension =
            validated.format === "prores" ? "mov" : validated.format;
          const name =
            validated.project.name
              .replace(/[\x00-\x1f/\\:]/g, "-")
              .slice(0, 100) || tnative("Untitled recording");
          if (validated.destination === "clipboard") {
            const directory = path.join(app.getPath("userData"), "Clipboard");
            await fs.mkdir(directory, { recursive: true });
            return path.join(directory, `${name}-${randomUUID()}.${extension}`);
          }
          const result = await dialog.showSaveDialog(mainWindow, {
            title: tnative("Export video"),
            buttonLabel: tnative("Export"),
            defaultPath: `${name}.${extension}`,
            filters: [
              {
                name: validated.format.toUpperCase(),
                extensions: [extension],
              },
            ],
            properties: ["createDirectory", "showOverwriteConfirmation"],
          });
          if (result.canceled || !result.filePath) return null;
          return result.filePath.endsWith(`.${extension}`)
            ? result.filePath
            : `${result.filePath}.${extension}`;
        }),
      );
    }),
  );
  handle("reva:export-frame", (id, png) => {
    if (!exporter) throw new Error("No export is active.");
    return exporter.frame(id, png);
  });
  handle("reva:export-finish", async (id) => {
    if (!exporter) throw new Error("No export is active.");
    const destination = exporter.getSession(id).options.destination;
    const output = await exporter.finish(id);
    if (destination === "clipboard") {
      const fileURL = pathToFileURL(output).toString();
      await clipboard.write([
        new ClipboardItem({
          'electron application/osclipboard;format="public.file-url"': new Blob(
            [fileURL],
          ),
        }),
      ]);
    }
    return output;
  });
  handle("reva:export-cancel", (id) => {
    if (!exporter) throw new Error("No export is active.");
    return exporter.cancel(id);
  });
  handle("reva:reveal-file", async (file) => {
    const real = await grants.assert(file);
    shell.showItemInFolder(real);
  });
  ipcMain.on("reva:window", (event, action) => {
    if (!trusted(event)) return;
    if (action === "close") mainWindow.close();
    if (action === "minimize") mainWindow.minimize();
    if (action === "maximize")
      mainWindow.isMaximized()
        ? mainWindow.unmaximize()
        : mainWindow.maximize();
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1512,
    height: 854,
    minWidth: 1000,
    minHeight: 680,
    title: "REVA Studio",
    backgroundColor: "#1c1c1e",
    frame: false,
    titleBarStyle: "hidden",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  mainWindow.setWindowButtonVisibility?.(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== (DEV_URL ? `${DEV_URL}/` : "reva-app://app/index.html"))
      event.preventDefault();
  });
  mainWindow.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  mainWindow.webContents.on("will-prevent-unload", (event) => {
    const response = dialog.showMessageBoxSync(mainWindow, {
      type: "question",
      title: tnative("Keep your changes?"),
      message: tnative("This recording has unsaved changes."),
      detail: tnative(
        "Keep editing to save your project, or discard these unsaved edits.",
      ),
      buttons: [tnative("Keep Editing"), tnative("Discard")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response === 1) event.preventDefault();
    else {
      quitting = false;
      exitReady = false;
      restoreWindow();
    }
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") {
      liveInputGeneration++;
      recorder.close(false);
      liveInputs?.stop().catch(console.error);
      exporter?.dispose().catch(console.error);
      privacy?.dispose().catch(console.error);
      cameraSegmenter?.dispose().catch(console.error);
      cameraAnalyzer?.dispose().catch(console.error);
      speechTranscriber?.dispose().catch(console.error);
      screenUpscaler?.dispose().catch(console.error);
      recordingRecovery?.dispose().catch(console.error);
      audioPreview?.dispose().catch(console.error);
      stopWaveforms().catch(console.error);
      if (capture?.active) capture.stop().catch(console.error);
    }
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("close", (event) => {
    if (
      (capture?.active ||
        exporter?.active ||
        privacy?.active ||
        cameraSegmenter?.active ||
        cameraAnalyzer?.active || speechTranscriber?.active || screenUpscaler?.active || recordingRecovery?.active ||
        importPromise ||
        waveformJobs.size > 0) &&
      !exitReady
    ) {
      event.preventDefault();
      app.quit();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  if (DEV_URL) await mainWindow.loadURL(DEV_URL);
  else await mainWindow.loadURL("reva-app://app/index.html");
}

function updateAboutPanel() {
  app.setAboutPanelOptions({
    applicationName: "REVA Studio",
    applicationVersion: app.getVersion(),
    copyright: tnative("Independent local macOS recording and editing app."),
  });
}

app
  .whenReady()
  .then(async () => {
    await settings.load();
    if (settings.loadIssue) console.warn(localizeError(settings.loadIssue, settings.language));
    updateAboutPanel();
    const editorMediaRequest = (contents, details) => contents === mainWindow?.webContents && details?.isMainFrame === true && details.requestingUrl === (DEV_URL ? `${DEV_URL}/` : "reva-app://app/index.html");
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(permission === "media" && editorMediaRequest(contents, details) && Array.isArray(details.mediaTypes) && details.mediaTypes.length === 1 && details.mediaTypes[0] === "audio"));
    session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => permission === "media" && editorMediaRequest(contents, details) && details.mediaType === "audio");
    protocol.handle("reva-media", (request) => mediaResponse(request, grants));
    protocol.handle("reva-app", async (request) => {
      try {
        const url = new URL(request.url);
        if (
          url.hostname !== "app" ||
          (request.method !== "GET" && request.method !== "HEAD")
        )
          return new Response(null, { status: 404 });
        const file = path.resolve(DIST, `.${decodeURIComponent(url.pathname)}`);
        if (
          !contained(DIST, file) ||
          !contained(await fs.realpath(DIST), await fs.realpath(file))
        )
          return new Response(null, { status: 404 });
        return net.fetch(pathToFileURL(file).toString());
      } catch {
        return new Response(null, { status: 404 });
      }
    });
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      try {
        const url = new URL(details.url);
        const own = ["reva-app:", "reva-media:", "data:", "blob:"].includes(
          url.protocol,
        );
        const builtAsset =
          url.protocol === "file:" &&
          contained(DIST, decodeURIComponent(url.pathname));
        const development =
          DEV_URL &&
          ((url.protocol === "http:" && url.origin === DEV_URL) ||
            (url.protocol === "ws:" &&
              url.hostname === "127.0.0.1" &&
              url.port === "5178"));
        const backgroundThumbnail = url.protocol === "https:" && ["images.unsplash.com", "hd.unsplash.com", "plus.unsplash.com"].includes(url.hostname) && details.resourceType === "image";
        callback({ cancel: !own && !builtAsset && !development && !backgroundThumbnail });
      } catch {
        callback({ cancel: true });
      }
    });
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const devConnect = DEV_URL ? ` ${DEV_URL} ws://127.0.0.1:5178` : "";
      const devScripts = DEV_URL ? " 'unsafe-inline'" : "";
      const csp = `default-src 'self'; script-src 'self'${devScripts}; style-src 'self' 'unsafe-inline'; img-src 'self' reva-media: data: blob: https://images.unsplash.com https://hd.unsplash.com https://plus.unsplash.com; media-src 'self' reva-media: blob:; font-src 'self' data:; connect-src 'self' reva-media:${devConnect}; object-src 'none'; frame-src 'none'; base-uri 'none'`;
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [csp],
        },
      });
    });
    const trayImage = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAAPklEQVR4nGNgGCrgPwFMFUOIMoyQYqIMI8XpeNWiS+LzElEG4fIGLvmRaBDVApvi6MfmClLl8SqmaX4bAgAAkHx/gWwSv1AAAAAASUVORK5CYII=",
    );
    trayImage.setTemplateImage(true);
    tray = new Tray(trayImage);
    tray.on("click", restoreWindow);
    setRecordingTray(false);
    makeMenu();
    installIPC();
    registerPreferenceShortcuts(settings.preferences, false);
    await createWindow();
    void desktopIcons.restore().catch(report);
    syncDockVisibility();
  })
  .catch((error) => {
    dialog.showErrorBox(
      tnative("REVA Studio could not start"),
      localizeError(error, settings.language).message,
    );
    app.exit(1);
  });

app.on("activate", () => {
  if (mainWindow) restoreWindow();
  else createWindow().catch(report);
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", (event) => {
  if (exitReady) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  liveInputGeneration++;
  liveInputAuthorization?.abort();
  recordingMenuGeneration++;
  recorder.dispose();
  cropEditor.dispose();
  preferencesWindow.dispose();
  Promise.allSettled([
    settings.flush(),
    projectDocuments.flush(),
    notesStore.dispose(),
    desktopIcons.dispose(),
    audioPreview?.dispose(),
    audioLibrary.dispose(),
    backgroundAssets.dispose(),
    disposeLiveInputs(),
    capture?.dispose(),
    exporter?.dispose(),
    privacy?.dispose(),
    cameraSegmenter?.dispose(),
    cameraAnalyzer?.dispose(),
    screenUpscaler?.dispose(),
    recordingRecovery?.dispose(),
    speechTranscriber?.dispose(),
    stopWaveforms(),
    importPromise,
    cleanupScreenStudioImports(),
  ]).then((results) => {
    const failure = results.find((result) => result.status === "rejected");
    if (failure) {
      quitting = false;
      restoreWindow();
      report(failure.reason);
      return;
    }
    exitReady = true;
    app.quit();
  });
});
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  tray?.destroy();
});
