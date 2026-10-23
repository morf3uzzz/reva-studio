"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), { randomUUID } = require("node:crypto");
const { validateProject, writePortableProject } = require("./core.cjs");
const { isProjectBundle, writeProjectBundle } = require("./project-bundle.cjs");
/** Serializes document writes, retaining failed automatic destinations for retry. */
class ProjectDocuments {
  constructor({ grants, projects, defaultFolder }) { Object.assign(this, { grants, projects, defaultFolder }); this.writes = new Map(); this.unsaved = new Map(); }
  write(file, input, { bundle = false } = {}) {
    const project = validateProject(input), previous = this.writes.get(file) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const existingBundle = await isProjectBundle(file).catch(error => { if (error.code === "ENOENT") return false; throw error; });
      await (bundle || existingBundle ? writeProjectBundle : writePortableProject)(file, project, source => this.grants.assert(source));
      this.projects.add(file); await this.grants.grant(file); return file;
    }).finally(() => { if (this.writes.get(file) === operation) this.writes.delete(file); });
    this.writes.set(file, operation); return operation;
  }
  async automatic(input, existing = null, documentID) {
    const project = validateProject(input);
    if (!project.mediaPath) throw new Error("Open a recording before saving a project.");
    if (existing !== null) { if (typeof existing !== "string" || !this.projects.has(existing)) throw new Error("Choose this project with Save As before updating it."); return this.write(existing, project); }
    if (typeof documentID !== "string" || !/^[a-f0-9-]{36}$/.test(documentID)) throw new Error("A stable document identity is required for automatic saving.");
    let file = this.unsaved.get(documentID);
    if (!file) {
      const folder = await this.defaultFolder(); await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      const name = project.name.replace(/[\x00-\x1f/\\:]/g, "-").slice(0, 100) || "Recording";
      file = path.join(await fs.realpath(folder), `${name}-${randomUUID()}.revastudio`); this.unsaved.set(documentID, file);
    }
    await this.write(file, project); return file;
  }
  async flush() { await Promise.all([...this.writes.values()]); }
}
module.exports = { ProjectDocuments };
