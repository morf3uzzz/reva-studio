"use strict";

const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const russian = require("../locales/ru-native.json");
const { recordingPreferences } = require("./recording-preferences.cjs");
const { appPreferences, patchAppPreferences } = require("./app-preferences.cjs");

const MAX_SETTINGS_BYTES = 64 * 1024;
const isLanguage = (value) => value === "ru" || value === "en";
const sameFile = (a, b) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;

function validateSavedAreas(value) {
  if (!Array.isArray(value)) throw new Error("Saved recording areas must be a list.");
  const ids = new Set();
  return value.map(item => {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !/^[a-f0-9-]{36}$/.test(item.id) || ids.has(item.id) || typeof item.name !== "string" || !item.name.trim() || item.name.length > 100) throw new Error("A saved recording area is invalid.");
    const r = item.rect;
    if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.x < 0 || r.y < 0 || r.width < 150 || r.height < 150 || r.x + r.width > 32768 || r.y + r.height > 32768) throw new Error("A saved recording area is invalid.");
    ids.add(item.id);
    return { id: item.id, name: item.name.trim(), rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
  });
}

async function readSettings(file) {
  let handle;
  try {
    const before = await fsp.lstat(file);
    if (!before.isFile() || before.isSymbolicLink())
      throw new Error("Application settings must be a regular file.");
    if (before.size > MAX_SETTINGS_BYTES)
      throw new Error("Application settings exceed the size limit.");
    handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!sameFile(before, stat))
      throw new Error("Application settings changed while saving. Try again.");
    const bytes = await handle.readFile();
    if (!sameFile(stat, await handle.stat()) || bytes.length !== stat.size)
      throw new Error("Application settings changed while saving. Try again.");
    let data = {};
    let malformed = false;
    try {
      const parsed = JSON.parse(bytes.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Not an object");
      data = parsed;
    } catch {
      // A later explicit choice may replace invalid JSON, preserving its bytes
      // in settings.json.bak first. Merely launching never rewrites it.
      malformed = true;
    }
    return { bytes, data, stat, malformed };
  } catch (error) {
    if (error.code === "ENOENT")
      return { bytes: null, data: {}, stat: null, malformed: false };
    throw error;
  } finally {
    await handle?.close();
  }
}

class SettingsStore {
  constructor(file) {
    this.file = file;
    this.language = "ru";
    this.recording = recordingPreferences();
    this.savedAreas = [];
    this.preferences = appPreferences();
    this.defaultPresetID = null;
    this.loadIssue = null;
    this.pending = Promise.resolve();
    this.cleanupPaths = new Set();
  }

  async load() {
    try {
      const state = await readSettings(this.file);
      this.language = isLanguage(state.data.language) ? state.data.language : "ru";
      try { this.recording = recordingPreferences(state.data.recording ?? {}); }
      catch (error) { this.recording = recordingPreferences(); this.loadIssue = error; }
      try { this.savedAreas = validateSavedAreas(state.data.savedCaptureAreas ?? []); } catch (error) { this.savedAreas = []; this.loadIssue = error; }
      try { this.preferences = appPreferences(state.data.preferences ?? {}, this.recording); } catch (error) { this.preferences = appPreferences({}, this.recording); this.loadIssue = error; }
      this.defaultPresetID = typeof state.data.defaultPresetID === "string" && /^[a-f0-9-]{36}$/.test(state.data.defaultPresetID) ? state.data.defaultPresetID : null;
      if (state.malformed)
        this.loadIssue = new Error(
          "Application settings could not be read. Default language is used.",
        );
    } catch (error) {
      this.loadIssue = error;
      this.language = "ru";
      this.recording = recordingPreferences();
    }
    return this.language;
  }

  setLanguage(language) {
    if (!isLanguage(language))
      return Promise.reject(new Error("Unsupported interface language."));
    // Serialize writes, but a failed write must not poison future choices.
    const operation = this.pending.then(() => this.writePatch({ language }));
    this.pending = operation.catch(() => {});
    return operation;
  }

  patchPreferences(input) {
    const operation = this.pending.then(() => this.writePatch(prior => {
      const recording = recordingPreferences(prior.recording ?? this.recording);
      const preferences = patchAppPreferences(appPreferences(prior.preferences ?? {}, recording), input, recording);
      return { preferences, recording: recordingPreferences({ ...recording, fps: preferences.fps, cameraMaxResolution: preferences.cameraMaxResolution, autoZoom: preferences.autoZoom, quickExportSettings: preferences.quickExportSettings }) };
    }));
    this.pending = operation.catch(() => {});
    return operation.then(() => this.preferences);
  }

  resetPreferences() {
    const operation = this.pending.then(() => this.writePatch({ preferences: appPreferences(), recording: recordingPreferences() }));
    this.pending = operation.catch(() => {});
    return operation.then(() => this.preferences);
  }
  setDefaultPreset(id) {
    if (id !== null && (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))) return Promise.reject(new Error("Invalid default preset."));
    const operation = this.pending.then(() => this.writePatch({ defaultPresetID: id })); this.pending = operation.catch(() => {}); return operation;
  }

  setRecording(value) {
    let recording;
    try { recording = recordingPreferences(value); }
    catch (error) { return Promise.reject(error); }
    const operation = this.pending.then(() => this.writePatch({ recording }));
    this.pending = operation.catch(() => {});
    return operation;
  }

  patchRecording(input) {
    let patch;
    try {
      const parsed = recordingPreferences({ ...this.recording, ...input });
      patch = Object.fromEntries(Object.keys(input).filter(key => Object.hasOwn(parsed, key)).map(key => [key, parsed[key]]));
    } catch (error) { return Promise.reject(error); }
    const operation = this.pending.then(() => this.writePatch(prior => ({ recording: recordingPreferences({ ...(prior.recording ?? this.recording), ...patch }) })));
    this.pending = operation.catch(() => {});
    return operation;
  }

  saveCaptureArea(area) {
    const operation = this.pending.then(() => this.writePatch(prior => {
      const areas = validateSavedAreas(prior.savedCaptureAreas ?? []);
      areas.push(area);
      return { savedCaptureAreas: validateSavedAreas(areas) };
    }));
    this.pending = operation.catch(() => {});
    return operation.then(() => this.savedAreas);
  }

  async writePatch(change) {
    await this.cleanup();
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const prior = await readSettings(this.file);
    const patch = typeof change === "function" ? change(prior.data) : change;
    if (!prior.malformed && Object.entries(patch).every(([key, value]) => JSON.stringify(prior.data[key]) === JSON.stringify(value))) {
      if (patch.language) this.language = patch.language;
      if (patch.recording) this.recording = patch.recording;
      if (patch.savedCaptureAreas) this.savedAreas = patch.savedCaptureAreas;
      if (patch.preferences || patch.recording) this.preferences = appPreferences(patch.preferences ?? this.preferences, patch.recording ?? this.recording);
      if (Object.hasOwn(patch, "defaultPresetID")) this.defaultPresetID = patch.defaultPresetID;
      return;
    }
    const next = Buffer.from(
      `${JSON.stringify({ ...prior.data, ...patch }, null, 2)}\n`,
    );
    if (next.length > MAX_SETTINGS_BYTES)
      throw new Error("Application settings exceed the size limit.");
    let failure;
    try {
      const temporary = await this.stage(next);
      if (prior.bytes) {
        const backup = await this.stage(prior.bytes);
        await fsp.rename(backup, `${this.file}.bak`);
        this.cleanupPaths.delete(backup);
      }
      let current = null;
      try {
        current = await fsp.lstat(this.file);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (
        prior.stat
          ? !current || !sameFile(prior.stat, current)
          : current !== null
      )
        throw new Error("Application settings changed while saving. Try again.");
      await fsp.rename(temporary, this.file);
      this.cleanupPaths.delete(temporary);
      if (patch.language) this.language = patch.language;
      if (patch.recording) this.recording = patch.recording;
      if (patch.savedCaptureAreas) this.savedAreas = patch.savedCaptureAreas;
      if (patch.preferences || patch.recording) this.preferences = appPreferences(patch.preferences ?? this.preferences, patch.recording ?? this.recording);
      if (Object.hasOwn(patch, "defaultPresetID")) this.defaultPresetID = patch.defaultPresetID;
      this.loadIssue = null;
    } catch (error) {
      failure = error;
    }
    try {
      await this.cleanup();
    } catch (error) {
      if (!failure) failure = error;
      else failure.cleanupPaths = [...this.cleanupPaths];
    }
    if (failure) throw failure;
  }

  async stage(bytes) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const handle = await fsp.open(temporary, "wx", 0o600);
    this.cleanupPaths.add(temporary);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return temporary;
  }

  async cleanup() {
    for (const file of [...this.cleanupPaths]) {
      try {
        await fsp.unlink(file);
        this.cleanupPaths.delete(file);
      } catch (error) {
        if (error.code === "ENOENT") this.cleanupPaths.delete(file);
      }
    }
    if (this.cleanupPaths.size) {
      const error = new Error("Settings cleanup is incomplete.");
      error.cleanupPaths = [...this.cleanupPaths];
      throw error;
    }
  }

  async flush() {
    await this.pending;
    await this.cleanup();
  }
}

function translate(message, language, values = {}) {
  const template = language === "ru" && Object.hasOwn(russian, message)
    ? russian[message]
    : message;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : match,
  );
}

function compileTemplate(template) {
  const names = [];
  let previous = 0;
  let pattern = "^";
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    pattern += template.slice(previous, match.index).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    pattern += "([\\s\\S]*?)";
    names.push(match[1]);
    previous = match.index + match[0].length;
  }
  pattern += template.slice(previous).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
  return { regex: new RegExp(pattern), names };
}

const templates = Object.entries(russian)
  .filter(([message]) => /\{\w+\}/.test(message))
  // Specific messages precede generic validation templates.
  .sort(([a], [b]) => b.replace(/\{\w+\}/g, "").length - a.replace(/\{\w+\}/g, "").length)
  .map(([message, translation]) => ({
    message,
    ...compileTemplate(message),
    translated: compileTemplate(translation).regex,
  }));
const translatedMessages = new Set(Object.values(russian));

function localizeMessage(message, language, depth = 0) {
  message = String(message);
  if (language !== "ru") return message;
  if (Object.hasOwn(russian, message)) return russian[message];
  if (depth > 4) return message;
  if (translatedMessages.has(message) || templates.some((t) => t.translated.test(message)))
    return message;
  for (const template of templates) {
    const match = template.regex.exec(message);
    if (!match) continue;
    const values = {};
    template.names.forEach((name, index) => {
      const value = match[index + 1];
      // Paths, ids and tool diagnostics retain their literal source values.
      values[name] = name === "message"
        ? localizeMessage(value, language, depth + 1)
        : name === "label" || name === "device"
          ? translate(value, language)
          : value;
    });
    return translate(template.message, language, values);
  }
  return message;
}

function localizeError(error, language) {
  const original = error instanceof Error ? error : new Error(String(error));
  let message = localizeMessage(original.message, language);
  if (
    language === "ru" &&
    message === original.message &&
    !translatedMessages.has(message) &&
    !templates.some((template) => template.translated.test(message))
  )
    message = translate("Operation failed: {message}", language, { message });
  const output = new Error(message, { cause: original });
  output.name = original.name;
  if (original.code !== undefined) output.code = original.code;
  return output;
}

module.exports = { SettingsStore, translate, localizeMessage, localizeError };
