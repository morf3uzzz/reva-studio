"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { runProcess } = require("./media.cjs");
class DesktopIcons {
  constructor({ helper, journal, run = runProcess }) { Object.assign(this, { helper, journal, run }); this.pending = Promise.resolve(); }
  state(value) { if (!value || typeof value !== "object" || !Object.hasOwn(value, "value") || (value.value !== null && typeof value.value !== "boolean")) throw new Error("Desktop visibility could not be established."); return value.value; }
  async current() { return this.state(JSON.parse(await this.run(this.helper, ["desktop-icons", "get"], { timeout: 5000 }))); }
  async change(value, expected) { const encode = value => value === null ? "absent" : String(value); return this.state(JSON.parse(await this.run(this.helper, ["desktop-icons", "set", "--value", encode(value), "--expected", encode(expected)], { timeout: 10000 }))); }
  async read() {
    try { const stat = await fs.lstat(this.journal); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("The desktop visibility recovery record is invalid."); const entry = JSON.parse(await fs.readFile(this.journal, "utf8")); if (entry.version !== 1 || (entry.original !== null && typeof entry.original !== "boolean") || entry.applied !== false) throw new Error("The desktop visibility recovery record is invalid."); return entry; }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  serialize(operation) { const result = this.pending.then(operation); this.pending = result.catch(() => {}); return result; }
  hide() { return this.serialize(async () => {
    const prior = await this.read(); if (prior) { if (await this.current() !== false) throw new Error("Desktop visibility changed outside REVA Studio. Restore it before hiding the desktop again."); return; }
    const original = await this.current(); if (original === false) return;
    await fs.mkdir(path.dirname(this.journal), { recursive: true, mode: 0o700 });
    const handle = await fs.open(this.journal, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ version: 1, original, applied: false })); await handle.sync(); } finally { await handle.close(); }
    await this.change(false, original);
  }); }
  restore() { return this.serialize(async () => { const entry = await this.read(); if (!entry) return; const current = await this.current(); if (current !== entry.original) await this.change(entry.original, false); await fs.rename(this.journal, `${this.journal}.restored`); }); }
  dispose() { return this.restore(); }
}
module.exports = { DesktopIcons };
