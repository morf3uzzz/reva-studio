"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { validateProject } = require("./core.cjs");
async function extractRawRecording(input, destination, grants) {
  const project = validateProject(input), directory = await fs.mkdtemp(path.join(await fs.realpath(destination), "REVA-raw-")), files = [];
  const metadata = { version: 1, id: crypto.randomUUID(), status: "extracting", duration: project.duration, width: project.width, height: project.height, cameraStartTime: project.cameraStartTime, cameraEndTime: project.cameraEndTime, cameraSource: project.cameraSource, cursorSourceSize: project.cursorSourceSize, cursor: project.cursor, pauseMarkers: project.pauseMarkers, typingRanges: project.typingRanges, shortcuts: project.shortcuts, flags: project.recordingFlags, recoverySource: project.recoverySource, files };
  const publish = async () => { const temporary = path.join(directory, ".recording-metadata.tmp"); await fs.writeFile(temporary, JSON.stringify(metadata, null, 2), { mode: 0o600 }); await fs.rename(temporary, path.join(directory, "recording-metadata.json")); };
  try {
    await publish();
    for (const [kind, source] of [["screen", project.mediaPath], ["camera", project.cameraPath], ["microphone", project.microphonePath]]) {
      if (!source) continue;
      const opened = await grants.open(source), name = `${kind}${path.extname(source)}`, temporary = path.join(directory, `.${name}.tmp`); let output;
      try {
        output = await fs.open(temporary, "wx", 0o600); const hash = crypto.createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024); let offset = 0;
        while (offset < opened.stat.size) { const { bytesRead } = await opened.handle.read(buffer, 0, Math.min(buffer.length, opened.stat.size - offset), offset); if (!bytesRead) throw new Error("A raw source changed during extraction."); hash.update(buffer.subarray(0, bytesRead)); let written = 0; while (written < bytesRead) { const result = await output.write(buffer, written, bytesRead - written); if (!result.bytesWritten) throw new Error("A raw recording file could not be written."); written += result.bytesWritten; } offset += bytesRead; }
        const after = await opened.handle.stat(); if (["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(key => after[key] !== opened.stat[key])) throw new Error("A raw source changed during extraction."); await grants.assert(source);
        await output.sync(); await output.close(); output = null; await fs.rename(temporary, path.join(directory, name));
        files.push({ kind, name, sourcePath: source, bytes: offset, sha256: hash.digest("hex") }); await publish();
      } finally { await output?.close(); await opened.handle.close(); }
    }
    metadata.status = "complete"; await publish(); return directory;
  } catch (error) { metadata.status = "failed"; metadata.error = error.message; await publish().catch(() => {}); throw new Error(`${error.message} Partial extracted files and metadata remain at ${directory}`, { cause: error }); }
}
module.exports = { extractRawRecording };
