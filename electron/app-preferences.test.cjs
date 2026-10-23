"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { SettingsStore } = require("./settings.cjs");
const { appPreferences, patchAppPreferences, effectiveShortcuts, accelerator } = require("./app-preferences.cjs");
test("application preferences persist alongside recording settings without losing concurrent choices", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reva-prefs-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "settings.json"), store = new SettingsStore(file); await store.load();
  await Promise.all([store.patchPreferences({ hideDockIcon: true, customShortcuts: { addRecordingMarker: ["Meta", "Alt", "G"] } }), store.patchRecording({ microphone: true })]);
  const reopened = new SettingsStore(file); await reopened.load(); assert.equal(reopened.preferences.hideDockIcon, true); assert.equal(reopened.recording.microphone, true); assert.deepEqual(reopened.preferences.customShortcuts.addRecordingMarker, ["Meta", "Alt", "G"]);
  const before = await fs.readFile(file, "utf8"); await assert.rejects(store.patchPreferences({ customShortcuts: { addRecordingMarker: ["Meta", "Alt", "P"] } }), /already assigned/); assert.equal(await fs.readFile(file, "utf8"), before); assert.ok(await fs.readFile(`${file}.bak`));
});
test("shortcut parsing keeps action namespaces and rejects malformed or conflicting assignments", () => {
  const original = appPreferences(), changed = patchAppPreferences(original, { customShortcuts: { recordStartStop: ["Shift", "Meta", "R"] } }, {});
  assert.equal(accelerator(effectiveShortcuts(changed).find(item => item.id === "recordStartStop").keys), "CommandOrControl+Shift+R");
  assert.throws(() => patchAppPreferences(original, { customShortcuts: { stopAndResetSpeed: null } }, {}), /cannot be removed/);
  assert.throws(() => patchAppPreferences(original, { customShortcuts: { addRecordingMarker: ["A", "B"] } }, {}), /one key/);
  assert.throws(() => patchAppPreferences(original, { presetsFolderPath: "relative" }, {}), /absolute/);
});
