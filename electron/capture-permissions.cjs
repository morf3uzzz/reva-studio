"use strict";
const { boolean, choice } = require("./core.cjs");

const cancelled = () => Object.assign(new Error("Recording startup was cancelled."), { code: "capture_permission_cancelled" });

// The app owns authorization; timed native capture/preview workers start only
// after it completes. Canceling a caller must not wait for the system dialog.
class CaptureMediaPermissions {
  constructor({ systemPreferences, platform = process.platform }) {
    this.systemPreferences = systemPreferences;
    this.platform = platform;
    this.pending = Promise.resolve();
  }
  async request(input, { signal } = {}) {
    const camera = boolean(input.camera, "Camera"), microphone = boolean(input.microphone, "Microphone");
    if (signal?.aborted) throw cancelled();
    if (this.platform !== "darwin") return;
    for (const kind of ["camera", "microphone"].filter(kind => kind === "camera" ? camera : microphone)) {
      const authorization = this.pending.then(async () => {
        if (signal?.aborted) throw cancelled();
        const status = this.systemPreferences.getMediaAccessStatus(kind);
        if (status === "granted") return;
        if (status === "not-determined" && await this.systemPreferences.askForMediaAccess(kind)) return;
        const message = kind === "camera"
          ? "Allow camera access for Reva Studio in System Settings → Privacy & Security."
          : "Allow microphone access for Reva Studio in System Settings → Privacy & Security.";
        throw Object.assign(new Error(message), { code: `${kind}_permission_${status === "restricted" ? "restricted" : "denied"}`, mediaType: kind, permission: status, recoverable: true });
      });
      // Serialize system dialogs, including requests from overlapping preview
      // generations. Re-read the OS status rather than caching grants.
      this.pending = authorization.catch(() => {});
      if (!signal) { await authorization; continue; }
      await new Promise((resolve, reject) => {
        const abort = () => reject(cancelled());
        signal.addEventListener("abort", abort, { once: true });
        authorization.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) abort();
      });
      if (signal.aborted) throw cancelled();
    }
  }
}

function capturePrivacySettingsURL(kind) {
  const selected = choice(kind, ["microphone", "screen"], "Capture privacy setting");
  const pane = selected === "microphone" ? "Privacy_Microphone" : "Privacy_ScreenCapture";
  return `x-apple.systempreferences:com.apple.preference.security?${pane}`;
}
module.exports = { capturePrivacySettingsURL, CaptureMediaPermissions };
