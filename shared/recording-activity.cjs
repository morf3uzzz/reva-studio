"use strict";
const { parseShortcuts } = require("./annotations.cjs");
const { deriveTypingRanges } = require("./typing-markers.mjs");
function parseRecordingActivity(activity, capturedDuration, mediaDuration, fps) {
  if (!Array.isArray(activity) || activity.length > 2_000_000) throw new Error("The recording activity has invalid samples.");
  if (![capturedDuration, mediaDuration, fps].every(Number.isFinite) || capturedDuration < 0 || mediaDuration < 0 || fps <= 0) throw new Error("Recording activity clock is invalid.");
  const pauseMarkers = [], typingSamples = [], recordingFlags = [], shortcuts = [], flagIDs = new Set(); let previous = 0;
  for (const entry of activity) {
    if (!entry || typeof entry !== "object" || typeof entry.time !== "number" || !Number.isFinite(entry.time) || entry.time < previous || entry.time > capturedDuration || entry.time > mediaDuration + 1 / fps) throw new Error("Recording activity exceeds its ordered source clock.");
    previous = entry.time; const time = Math.min(entry.time, mediaDuration);
    if (entry.type === "pause") { if (!Number.isFinite(entry.duration) || entry.duration < 0) throw new Error("Recording pause duration is invalid."); pauseMarkers.push({ time, duration: entry.duration }); }
    else if (entry.type === "typing") { if (!Number.isInteger(entry.count) || entry.count < 1 || entry.count > 4294967295) throw new Error("Typing activity count is invalid."); typingSamples.push({ time, count: entry.count }); }
    else if (entry.type === "flag") { if (typeof entry.id !== "string" || !entry.id || entry.id.length > 256 || flagIDs.has(entry.id)) throw new Error("Recording flag identity is invalid."); flagIDs.add(entry.id); recordingFlags.push({ id: entry.id, time }); }
    else if (entry.type === "shortcut") shortcuts.push({ ...entry, time, id: entry.id ?? `recorded-shortcut-${shortcuts.length}` });
    else throw new Error("The recorder returned an unknown activity type.");
  }
  const typingRanges = deriveTypingRanges(typingSamples);
  if ([pauseMarkers, typingRanges, recordingFlags, shortcuts].some(items => items.length > 100000)) throw new Error("Recording activity exceeds the project marker limit.");
  return { pauseMarkers, typingRanges, ...(recordingFlags.length ? { recordingFlags } : {}), ...(shortcuts.length ? { shortcuts: parseShortcuts(shortcuts, mediaDuration) } : {}) };
}
module.exports = { parseRecordingActivity };
