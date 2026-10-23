import test from "node:test";
import assert from "node:assert/strict";
import { defaultExportPreferences, exportPreferenceKey, readExportPreferences, writeExportPreferences } from "../src/core/export-settings.ts";

function storage() {
  const values = new Map<string, string>(), writes: string[] = [];
  return { values, writes, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { writes.push(key); values.set(key, value); } };
}
test("reopening full export preferences preserves each format and paired codec independently of widget preferences", () => {
  const local = storage(), settings = defaultExportPreferences();
  settings.format = "gif"; settings.destination = "clipboard";
  settings.modes.mp4 = { ...settings.modes.mp4, height: 2160, fps: 24, codec: "both", encoding: "hardware" };
  settings.modes.gif = { ...settings.modes.gif, height: 720, fps: 20, gifHighQuality: true, gifLoop: false };
  settings.modes.prores = { ...settings.modes.prores, height: 1080, fps: 30, proresProfile: "4444" };
  local.values.set("widget-export-settings", "unrelated preference");
  assert.equal(writeExportPreferences(settings, local).ok, true);
  assert.deepEqual(readExportPreferences(local), { value: settings });
  assert.equal(local.values.get("widget-export-settings"), "unrelated preference");
  const before = local.writes.length; writeExportPreferences(settings, local);
  assert.equal(local.writes.length, before, "unchanged preferences are idempotent");
});
test("malformed saved settings are reported and backed up byte for byte before defaults replace them", () => {
  const local = storage(), malformed = '{"version":1,"modes":';
  local.values.set(exportPreferenceKey, malformed);
  const restored = readExportPreferences(local);
  assert.ok(restored.issue); assert.deepEqual(restored.value, defaultExportPreferences());
  assert.equal(writeExportPreferences(restored.value, local).ok, true);
  assert.equal(local.values.get(`${exportPreferenceKey}.backup`), malformed);
  assert.equal(readExportPreferences(local).issue, undefined);
});
test("a failed backup leaves previous preferences intact and invalid new input never writes", () => {
  const local = storage(), previous = defaultExportPreferences();
  writeExportPreferences(previous, local); const raw = local.getItem(exportPreferenceKey);
  const next = defaultExportPreferences(); next.modes.mp4.codec = "both";
  const failed = writeExportPreferences(next, { getItem: local.getItem, setItem: () => { throw new Error("storage unavailable"); } });
  assert.deepEqual(failed, { ok: false, error: "storage unavailable" }); assert.equal(local.getItem(exportPreferenceKey), raw);
  next.modes.gif.fps = 60;
  const before = local.writes.length;
  assert.equal(writeExportPreferences(next, local).ok, false); assert.equal(local.writes.length, before);
  local.values.set(exportPreferenceKey, " ".repeat(16_385)); assert.match(readExportPreferences(local).issue!, /size limit/);
});
