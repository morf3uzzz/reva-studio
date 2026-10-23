"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { validateProject, readPortableProject } = require("./core.cjs");
const { writeProjectBundle, readProjectBundle } = require("./project-bundle.cjs");
const presetProject = input => {
  const project = validateProject(input);
  return { ...project, mediaPath: null, cameraPath: null, microphonePath: null, cameraMask: undefined, cameraSource: undefined, cameraStartTime: undefined, cameraEndTime: undefined, cursorSourceSize: undefined, duration: 0, trimStart: 0, trimEnd: 0, zooms: [], slices: undefined, cursor: [], captions: [], pauseMarkers: undefined, typingRanges: undefined, resolvedTypingSuggestions: undefined, privacy: undefined, cameraScenes: undefined, cameraFaceTrack: undefined, cameraSilence: undefined, transcript: undefined, audio: undefined, masks: undefined, shortcuts: undefined, shortcutSettings: undefined, recordingFlags: undefined, captionSettings: undefined, screenEnhancement: undefined, recoverySource: undefined, recoveryIssues: undefined };
};
class PresetLibrary {
  constructor({ cacheRoot, grants }) { this.cacheRoot = cacheRoot; this.grants = grants; this.cache = new Map(); }
  async read(file) {
    const real = await fs.realpath(file), stat = await fs.stat(real), key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    let entry = this.cache.get(real);
    if (!entry || entry.key !== key) { entry = { key, project: await readPortableProject(real, this.cacheRoot) }; this.cache.set(real, entry); }
    if (entry.project.appearance.image) await this.grants.grant(entry.project.appearance.image);
    if (entry.project.appearance.customCursor) await this.grants.grant(entry.project.appearance.customCursor.path);
    return { name: entry.project.name, appearance: entry.project.appearance };
  }
  async list(folder) {
    let entries;
    try { entries = await fs.readdir(folder, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return { presets: [], issues: [] }; throw new Error(`Cannot read the selected preset folder: ${error.message}`); }
    const files = entries.filter(item => item.isFile() && /^[a-f0-9-]{36}\.revapreset$/.test(item.name));
    const presets = [], issues = [];
    for (const file of files) {
      try { presets.push({ id: file.name.slice(0, -11), ...await this.read(path.join(folder, file.name)) }); }
      catch (error) { issues.push({ file: path.join(folder, file.name), message: error.message }); }
    }
    return { presets: presets.sort((a, b) => a.name.localeCompare(b.name)), issues };
  }
  async save(folder, input, id = randomUUID()) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid preset identity.");
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const project = presetProject(input), file = path.join(folder, `${id}.revapreset`);
    await writeProjectBundle(file, project, file => this.grants.assert(file));
    return { id, name: project.name, appearance: project.appearance };
  }
  async file(folder, id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid preset identity.");
    const file = path.join(folder, `${id}.revapreset`), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("The selected preset is not a regular file.");
    return file;
  }
  async update(folder, id, changes) {
    const file = await this.file(folder, id);
    if (!changes || typeof changes !== "object" || Object.keys(changes).some(key => !["name", "project"].includes(key))) throw new Error("Invalid preset update.");
    if (changes.name !== undefined && (typeof changes.name !== "string" || !changes.name.trim() || changes.name.length > 512)) throw new Error("Enter a preset name.");
    const stored = await readPortableProject(file, this.cacheRoot);
    const input = changes.project === undefined ? stored : validateProject(changes.project);
    const result = await this.save(folder, { ...input, name: changes.name?.trim() ?? stored.name }, id);
    this.cache.delete(file);
    return result;
  }
  async remove(folder, id) {
    const file = await this.file(folder, id);
    await fs.rename(file, `${file}.deleted-${Date.now()}`);
    this.cache.delete(file);
  }
}
module.exports = { PresetLibrary, presetProject };
