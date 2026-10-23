"use strict";
/** Canonical project/preset representation. A disabled image keeps its provenance. */
function parseCustomCursor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Custom cursor must be an object.");
  const text = (input, max, label) => { if (typeof input !== "string" || !input || input.length > max || input.includes("\0")) throw new Error(`${label} is invalid.`); return input; };
  const size = (input, label) => { if (!Number.isInteger(input) || input < 1 || input > 2048) throw new Error(`${label} must be between 1 and 2048 pixels.`); return input; };
  const unit = input => { if (typeof input !== "number" || !Number.isFinite(input) || input < 0 || input > 1) throw new Error("Cursor hotspot must fit inside the image."); return input; };
  if (!/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error("Custom cursor needs its source SHA-256.");
  if (typeof value.enabled !== "boolean" || !value.hotspot || typeof value.hotspot !== "object") throw new Error("Custom cursor settings are invalid.");
  return { path: text(value.path, 32768, "Custom cursor path"), name: text(value.name, 512, "Custom cursor name"), width: size(value.width, "Custom cursor width"), height: size(value.height, "Custom cursor height"), sha256: value.sha256, enabled: value.enabled, hotspot: { x: unit(value.hotspot.x), y: unit(value.hotspot.y) } };
}
module.exports = { parseCustomCursor };
