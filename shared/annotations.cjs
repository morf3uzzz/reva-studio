"use strict";
const obj = (value, label) => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`); return value; };
const num = (value, min, max, label) => { if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} is out of range.`); return value; };
const text = (value, max, label) => { if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new Error(`${label} is invalid.`); return value; };
function parseManualMasks(value, duration) {
  if (!Array.isArray(value) || value.length > 100000) throw new Error("Masks must be a bounded list.");
  const ids = new Set(), result = value.map(input => {
    const mask = obj(input, "Mask"), id = text(mask.id, 256, "Mask identity"), start = num(mask.start, 0, duration, "Mask start"), end = num(mask.end, start, duration, "Mask end");
    if (ids.has(id) || end <= start) throw new Error("Masks need unique identities and positive durations."); ids.add(id);
    if (!["sensitive-data", "highlight"].includes(mask.type)) throw new Error("Choose a mask or highlight.");
    if (!Array.isArray(mask.bounds) || !mask.bounds.length || mask.bounds.length > 1000) throw new Error("A mask needs one or more rectangles.");
    const bounds = mask.bounds.map(input => { const r = obj(input, "Mask rectangle"), rect = { x: num(r.x, 0, 1, "Mask x"), y: num(r.y, 0, 1, "Mask y"), width: num(r.width, Number.EPSILON, 1, "Mask width"), height: num(r.height, Number.EPSILON, 1, "Mask height") }; if (rect.x + rect.width > 1.000001 || rect.y + rect.height > 1.000001) throw new Error("A mask must fit inside the source."); return rect; });
    if (mask.disabled !== undefined && typeof mask.disabled !== "boolean") throw new Error("Mask disabled must be a boolean.");
    return { id, start, end, type: mask.type, bounds, blur: num(mask.blur ?? 32, 0, 100, "Mask blur"), opacity: num(mask.opacity ?? .5, 0, 1, "Highlight opacity"), ...(mask.disabled === undefined ? {} : { disabled: mask.disabled }) };
  });
  const active = result.filter(item => !item.disabled).sort((a, b) => a.start - b.start);
  const latest = { "sensitive-data": -1, highlight: -1 };
  for (const mask of active) { const other = mask.type === "highlight" ? "sensitive-data" : "highlight"; if (mask.start < latest[other]) throw new Error("A mask and highlight cannot be active at the same time."); latest[mask.type] = Math.max(latest[mask.type], mask.end); }
  return result;
}
const KEY_NAMES = new Set(["command", "option", "control", "shift", "Enter", "Tab", "Space", "Escape", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
function parseShortcuts(value, duration) {
  if (!Array.isArray(value) || value.length > 100000) throw new Error("Shortcut events must be a bounded list.");
  let previous = -1;
  return value.map((input, index) => {
    const event = obj(input, "Shortcut"), time = num(event.time, Math.max(0, previous), duration + 1, "Shortcut time"); previous = time;
    if (!Array.isArray(event.keys) || !event.keys.length || event.keys.length > 8 || event.keys.some(key => typeof key !== "string" || (!KEY_NAMES.has(key) && !/^(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|[\[\];',.\/\\`=\-])$/.test(key)))) throw new Error("A recorded shortcut contains an unsupported key label.");
    if (event.hidden !== undefined && typeof event.hidden !== "boolean") throw new Error("Shortcut hidden must be a boolean.");
    return { id: text(event.id ?? `shortcut-${index}`, 256, "Shortcut identity"), time, keys: [...event.keys], ...(event.keyCode === undefined ? {} : { keyCode: (() => { const value = num(event.keyCode, 0, 65535, "Shortcut key code"); if (!Number.isInteger(value)) throw new Error("Shortcut key code must be an integer."); return value; })() }), ...(event.duration === undefined ? {} : { duration: num(event.duration, .1, 30, "Shortcut duration") }), ...(event.hidden === undefined ? {} : { hidden: event.hidden }) };
  });
}
function parseShortcutSettings(input) {
  const value = obj(input, "Shortcut appearance");
  if (typeof value.enabled !== "boolean") throw new Error("Shortcut visibility must be a boolean.");
  if (!["mac", "windows"].includes(value.style)) throw new Error("Choose Mac or Windows shortcut labels.");
  const position = obj(value.position, "Shortcut position");
  return { enabled: value.enabled, style: value.style, sizeRatio: num(value.sizeRatio, .02, .3, "Shortcut size"), position: { x: num(position.x, 0, 1, "Shortcut x"), y: num(position.y, 0, 1, "Shortcut y") }, duration: num(value.duration, .1, 10, "Shortcut visibility duration"), background: text(value.background, 128, "Shortcut background"), color: text(value.color, 128, "Shortcut color") };
}
module.exports = { parseManualMasks, parseShortcuts, parseShortcutSettings };
