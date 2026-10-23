"use strict";
const { choice } = require("./core.cjs");

function capturePrivacySettingsURL(kind) {
  const selected = choice(kind, ["microphone", "screen"], "Capture privacy setting");
  const pane = selected === "microphone" ? "Privacy_Microphone" : "Privacy_ScreenCapture";
  return `x-apple.systempreferences:com.apple.preference.security?${pane}`;
}
module.exports = { capturePrivacySettingsURL };
