"use strict";
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");
const { validateProject, projectAssets, mapProjectAssets, verifyProjectSources, MAX_PROJECT_BYTES } = require("./core.cjs");
const MAGIC = Buffer.from("REVASTUDIO-BUNDLE-1\n");
const same = (a, b) => a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const chunkSize = 1024 * 1024;
async function readExactly(handle, buffer, position) { let offset = 0; while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset); if (!bytesRead) throw new Error("The project bundle is incomplete."); offset += bytesRead; } }
async function inspect(file) {
  const handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("A project asset is not a regular file.");
    const hash = crypto.createHash("sha256"), buffer = Buffer.allocUnsafe(chunkSize);
    let offset = 0;
    while (offset < stat.size) { const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset); if (!bytesRead) throw new Error("A project asset changed while reading."); hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead; }
    if (!same(stat, await handle.stat()) || !same(stat, await fsp.lstat(file))) throw new Error("A project asset changed while reading.");
    return { stat, sha256: hash.digest("hex") };
  } finally { await handle.close(); }
}
async function copyRange(source, destination, start, length, expectedHash) {
  const hash = crypto.createHash("sha256"), buffer = Buffer.allocUnsafe(chunkSize);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, length - offset), start + offset);
    if (!bytesRead) throw new Error("The project bundle is incomplete.");
    hash.update(buffer.subarray(0, bytesRead));
    let written = 0;
    while (written < bytesRead) { const result = await destination.write(buffer, written, bytesRead - written); if (!result.bytesWritten) throw new Error("The project destination could not be written."); written += result.bytesWritten; }
    offset += bytesRead;
  }
  if (expectedHash && hash.digest("hex") !== expectedHash) throw new Error("A bundled project asset failed its checksum.");
}
async function isProjectBundle(file) {
  const handle = await fsp.open(file, "r");
  try { const bytes = Buffer.alloc(MAGIC.length); await handle.read(bytes, 0, bytes.length, 0); return bytes.equals(MAGIC); }
  finally { await handle.close(); }
}
async function writeProjectBundle(file, input, assertGranted) {
  const project = validateProject(input), assets = [], mapping = new Map();
  await verifyProjectSources(project);
  for (const source of new Set(projectAssets(project))) {
    const real = await assertGranted(source), info = await inspect(real);
    const name = `${assets.length}${path.extname(real).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 12)}`;
    assets.push({ name, source: real, size: info.stat.size, sha256: info.sha256, stat: info.stat }); mapping.set(source, name);
  }
  const manifest = Buffer.from(JSON.stringify({ version: 1, project: mapProjectAssets(project, asset => mapping.get(asset)), assets: assets.map(({ name, size, sha256 }) => ({ name, size, sha256 })) }));
  if (manifest.length > MAX_PROJECT_BYTES) throw new Error("Project metadata exceeds the 64 MiB limit.");
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`), header = Buffer.alloc(4);
  header.writeUInt32BE(manifest.length);
  let output;
  try {
    output = await fsp.open(temporary, "wx", 0o600);
    await output.writeFile(Buffer.concat([MAGIC, header, manifest]));
    for (const asset of assets) {
      const input = await fsp.open(asset.source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try { if (!same(asset.stat, await input.stat())) throw new Error("A project asset changed before bundling."); await copyRange(input, output, 0, asset.size, asset.sha256); if (!same(asset.stat, await input.stat()) || !same(asset.stat, await fsp.lstat(asset.source))) throw new Error("A project asset changed while bundling."); }
      finally { await input.close(); }
    }
    await output.sync(); await output.close(); output = null;
    try { const existing = await fsp.lstat(file); if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("The project destination must be a regular file."); await fsp.copyFile(file, `${temporary}.bak`, fs.constants.COPYFILE_EXCL); await fsp.rename(`${temporary}.bak`, `${file}.bak`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await fsp.rename(temporary, file);
    return file;
  } finally { await output?.close(); await fsp.rm(temporary, { force: true }); await fsp.rm(`${temporary}.bak`, { force: true }); }
}
async function readProjectBundle(file, cacheRoot) {
  const input = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let directory;
  try {
    const before = await input.stat();
    if (!before.isFile()) throw new Error("Choose a regular project file.");
    const header = Buffer.alloc(MAGIC.length + 4); await readExactly(input, header, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("This is not a REVA Studio project bundle.");
    const length = header.readUInt32BE(MAGIC.length);
    if (!length || length > MAX_PROJECT_BYTES || header.length + length > before.size) throw new Error("The project bundle manifest is invalid.");
    const bytes = Buffer.alloc(length); await readExactly(input, bytes, header.length);
    const manifest = JSON.parse(bytes.toString("utf8"));
    if (manifest.version !== 1 || !Array.isArray(manifest.assets) || manifest.assets.length > 10000) throw new Error("Unsupported project bundle.");
    const project = validateProject(manifest.project), names = new Set(), mapping = new Map();
    let total = header.length + length;
    for (const asset of manifest.assets) {
      if (!asset || typeof asset.name !== "string" || !/^\d+(?:\.[a-z0-9]{1,12})?$/.test(asset.name) || names.has(asset.name) || !Number.isSafeInteger(asset.size) || asset.size < 0 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error("A project bundle asset entry is invalid.");
      names.add(asset.name); total += asset.size; if (!Number.isSafeInteger(total) || total > before.size) throw new Error("The project bundle is truncated.");
    }
    if (total !== before.size || projectAssets(project).some(name => !names.has(name))) throw new Error("The project bundle asset inventory does not match its media.");
    await fsp.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    directory = await fsp.mkdtemp(path.join(cacheRoot, "Project-"));
    let offset = header.length + length;
    for (const asset of manifest.assets) {
      const target = path.join(directory, asset.name), output = await fsp.open(target, "wx", 0o600);
      try { await copyRange(input, output, offset, asset.size, asset.sha256); await output.sync(); }
      finally { await output.close(); }
      offset += asset.size; mapping.set(asset.name, target);
    }
    if (!same(before, await input.stat()) || !same(before, await fsp.lstat(file))) throw new Error("The project bundle changed while opening.");
    const resolved = mapProjectAssets(project, name => mapping.get(name));
    directory = null; return resolved;
  } finally { await input.close(); if (directory) await fsp.rm(directory, { recursive: true, force: true }); }
}
module.exports = { MAGIC, isProjectBundle, writeProjectBundle, readProjectBundle };
