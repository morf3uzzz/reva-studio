"use strict";
const fs = require("node:fs"), fsp = fs.promises, path = require("node:path"), crypto = require("node:crypto");
const { validatePng } = require("./core.cjs");
const { parseCustomCursor } = require("../shared/cursor-image.cjs");
async function importCursorImage(file, { grants, decodeImage }) {
  const real = await fsp.realpath(file), handle = await fsp.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 45 || before.size > 20 * 1024 * 1024) throw new Error("Choose a PNG cursor smaller than 20 MiB.");
    const bytes = await handle.readFile();
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height || width > 2048 || height > 2048) throw new Error("Cursor artwork can be up to 2048 × 2048 pixels (16 MiB decoded).");
    validatePng(bytes, width, height);
    const decoded = decodeImage(bytes);
    if (!decoded || decoded.width !== width || decoded.height !== height) throw new Error("The selected cursor PNG could not be decoded.");
    const after = await handle.stat(), current = await fsp.lstat(real);
    if ([after, current].some(stat => !stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs)) throw new Error("The cursor image changed during import.");
    await grants.grant(real);
    return parseCustomCursor({ path: real, name: path.basename(real), width, height, enabled: true, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), hotspot: { x: 0, y: 0 } });
  } finally { await handle.close(); }
}
module.exports = { importCursorImage };
