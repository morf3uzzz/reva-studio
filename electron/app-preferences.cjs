"use strict";
const path = require("node:path");
const { object, boolean, string, choice } = require("./core.cjs");
const definitions = require("../shared/preferences-shortcuts.json");
const { quickExportSettings } = require("./recording-preferences.cjs");

const DEFAULT_APP_PREFERENCES = Object.freeze({
  startAtLogin: false, hideDockIcon: false, projectsFolderPath: null, presetsFolderPath: null,
  recordingAreaCover: true, showRecordingWidget: true, useLastProjectConfigForNewProjects: false,
  autoSaveProject: true, showQuickExportWidget: true, alwaysSaveProjectAfterQuickExport: false,
  editProjectTitleBeforeUpload: true, customShortcuts: Object.freeze({}),
});
const booleanKeys = Object.keys(DEFAULT_APP_PREFERENCES).filter(key => typeof DEFAULT_APP_PREFERENCES[key] === "boolean");
const shortcutIDs = new Set([...definitions.map(item => item.id), "resumeRecording"]);
const modifiers = ["Meta", "Control", "Alt", "Shift"];
function shortcutKeys(value, label) {
  if (value === null) return null;
  if (!Array.isArray(value) || !value.length || value.length > 5 || value.some(key => typeof key !== "string" || key.length > 32)) throw new Error(`${label} is invalid.`);
  const regular = value.filter(key => !modifiers.includes(key));
  if (regular.length !== 1 || new Set(value).size !== value.length) throw new Error(`${label} needs one key and optional modifiers.`);
  return [...modifiers.filter(key => value.includes(key)), regular[0]];
}
function appPreferences(value = {}, recording = {}) {
  const input = { ...DEFAULT_APP_PREFERENCES, ...object(value, "Application preferences") };
  const result = Object.fromEntries(booleanKeys.map(key => [key, boolean(input[key], key)]));
  for (const key of ["projectsFolderPath", "presetsFolderPath"]) {
    const folder = input[key] === null ? null : string(input[key], 32768, key);
    if (folder !== null && !path.isAbsolute(folder)) throw new Error("Choose an absolute local folder.");
    result[key] = folder;
  }
  const custom = object(input.customShortcuts, "Custom shortcuts");
  result.customShortcuts = {};
  for (const [id, keys] of Object.entries(custom)) {
    if (!shortcutIDs.has(id)) throw new Error("Unknown shortcut action.");
    const definition = definitions.find(item => item.id === id);
    if (keys === null && definition?.clearable === false) throw new Error("This editing shortcut cannot be removed.");
    result.customShortcuts[id] = shortcutKeys(keys, "Shortcut");
  }
  const seen = new Map();
  for (const definition of definitions) {
    const keys = Object.hasOwn(result.customShortcuts, definition.id) ? result.customShortcuts[definition.id] : definition.defaultKeys;
    if (!keys) continue;
    const signature = keys.map(key => key.toLowerCase()).join("+");
    if (seen.has(signature)) throw new Error(`This shortcut is already assigned to ${seen.get(signature)}.`);
    seen.set(signature, definition.label);
  }
  return { ...result, fps: choice(recording.fps ?? 60, [24, 30, 60], "Recording frame rate"), cameraMaxResolution: choice(recording.cameraMaxResolution ?? 1080, [720, 1080, 2160], "Camera resolution"), autoZoom: boolean(recording.autoZoom ?? false, "Automatic zooms"), quickExportSettings: quickExportSettings(recording.quickExportSettings) };
}
function patchAppPreferences(prior, input, recording) {
  const patch = object(input, "Application preferences patch");
  const allowed = new Set([...Object.keys(DEFAULT_APP_PREFERENCES), "fps", "cameraMaxResolution", "autoZoom", "quickExportSettings"]);
  if (Object.keys(patch).some(key => !allowed.has(key))) throw new Error("Unknown application preference.");
  const nextRecording = { ...recording, ...Object.fromEntries(["fps", "cameraMaxResolution", "autoZoom"].filter(key => Object.hasOwn(patch, key)).map(key => [key, patch[key]])), ...(patch.quickExportSettings ? { quickExportSettings: { ...recording.quickExportSettings, ...patch.quickExportSettings } } : {}) };
  return appPreferences({ ...prior, ...patch, customShortcuts: { ...prior.customShortcuts, ...(patch.customShortcuts ?? {}) } }, nextRecording);
}
function accelerator(keys) {
  if (!keys) return null;
  return keys.map(key => ({ Meta: "CommandOrControl", Control: "Control", Alt: "Alt", Shift: "Shift", " ": "Space", ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", Backspace: "Backspace", Enter: "Return" })[key] ?? key).join("+");
}
function effectiveShortcuts(preferences) {
  return definitions.map(definition => ({ ...definition, keys: Object.hasOwn(preferences.customShortcuts, definition.id) ? preferences.customShortcuts[definition.id] : definition.defaultKeys }));
}
module.exports = { DEFAULT_APP_PREFERENCES, appPreferences, patchAppPreferences, shortcutKeys, effectiveShortcuts, accelerator };
