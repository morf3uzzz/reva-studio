"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { object, number, string } = require("./core.cjs");
function parseSpeakerNotes(input) { const value = object(input, "Speaker notes"); return { text: string(value.text, 200000, "Speaker notes text"), fontSize: number(value.fontSize, 14, 60, "Speaker notes font size"), opacity: number(value.opacity, .15, 1, "Speaker notes opacity"), speed: number(value.speed, 5, 120, "Prompter speed") }; }
class SpeakerNotesStore {
  constructor(file) { this.file = file; this.pending = Promise.resolve(); }
  async read() { try { const stat = await fs.lstat(this.file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("Speaker notes storage is invalid or too large."); return parseSpeakerNotes(JSON.parse(await fs.readFile(this.file, "utf8"))); } catch (error) { if (error.code === "ENOENT") return { text: "", fontSize: 28, opacity: .9, speed: 30 }; throw error; } }
  save(input) { const value = parseSpeakerNotes(input); const operation = this.pending.then(async () => { await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 }); const temporary = `${this.file}.${randomUUID()}.tmp`; try { const handle = await fs.open(temporary, "wx", 0o600); try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); } try { const stat = await fs.lstat(this.file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Speaker notes storage is not a regular file."); await fs.copyFile(this.file, `${temporary}.bak`, require("node:fs").constants.COPYFILE_EXCL); await fs.rename(`${temporary}.bak`, `${this.file}.bak`); } catch (error) { if (error.code !== "ENOENT") throw error; } await fs.rename(temporary, this.file); } finally { await fs.rm(temporary, { force: true }); await fs.rm(`${temporary}.bak`, { force: true }); } }); this.pending = operation.catch(() => {}); return operation; }
  dispose() { return this.pending; }
}
module.exports = { parseSpeakerNotes, SpeakerNotesStore };
