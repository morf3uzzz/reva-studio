# 0.1.0 preview status

This is an early independent application. Passing automated checks does not
establish complete hardware, UI or algorithm parity with another product.

## Verified for this release

- TypeScript/Vite build; 481 automated editor/backend tests: 480 passed,
  one optional Vision hardware integration check skipped.
- Native permission response parsing, including the actual CoreGraphics
  `keyboard: "not-granted"` response. The absence of Input Monitoring does not
  block opening screen selection when shortcut recording is off.
- Explicit spacing for custom privacy phrases, device-frame/processing sections
  and the motion-preset selector.
- Actual browser layout audit: 56 panel/language/width states, expanded settings,
  zero overflowing buttons/summaries after fixes. Feature-row hover and leave retain
  identical preview/workspace geometry, including layouts, masks and captions.
- A real AVAssetWriter test reproduced the recording failure when a checkpoint
  overtook a delayed captured frame. The writer now rejects stale/duplicate video
  timestamps; the same sequence saves a playable file with ordered timestamps.
  Actual owned-window ScreenCaptureKit acquisition at 60fps also passed with
  pause/resume and flags. That acquisition used the operator tool's already
  granted permission, not a grant for a freshly signed REVA app.
- The installed app recorded actual built-in camera/microphone video after macOS
  privacy access was refreshed. Its 368-frame camera track completed real Apple
  Vision segmentation, including a leading empty edit, with no source-time error.
- Window recording preserves source content while extending transparent outer
  edges before H.264 encoding. The actual captured test-window corner contained
  no white matte pixels after this fix. Native encoder regressions cover timing,
  original pixel ownership and decoded output.
- Source selection uses the actual native client frame after macOS menu-bar
  repositioning. Window hit testing and region selection share that coordinate map.
  The active recorder is 160×36 points; EN/RU controls and a 24-hour timer fit.
- Camera/microphone authorization is requested by the app before timed native
  workers start. Waiting for the OS response has no worker-readiness deadline;
  stop/discard/quit cancel admission and late consent cannot revive a canceled job.
- Camera-dependent left tools, hover insertion, mask preview focus, range-only camera
  edits, animation cards and the preset action popover have component integration checks.
- Real Web Audio/React checks on an operator-owned speech WAV exercised slow, fast and
  reverse pointer targets: eight 140ms forward grains, all at 1x and zero detune.
  Audio transport in this check uses an already mixed fixture; backend PCM/DSP has
  separate real encoder tests. This is not a claim of listening on every audio device.
- Universal release packaging checks Intel and arm64 slices in the main Electron
  executable, Electron framework and REVA capture helper. See the release's build
  report for actual executed checks; compilation is not physical Intel testing.

Earlier local development checks also exercised owned-window capture,
pause/resume/flags, real H.264/HEVC/paired exports, local Vision/CoreML and
interrupted-recording recovery. Those used private synthetic fixtures; user
recordings and research screenshots are not part of this repository.

## Remaining verification and limitations

- Ad hoc rebuilds change the macOS code identity. A prior privacy grant may no
  longer match; grant access to the installed copy in System Settings and restart
  that app. A helper launched by a terminal/tool has a different responsible
  permission identity and does not verify the installed app's access.
- Physical camera/microphone/USB-device acquisition, removal and synchronization
  need a wider hardware matrix. Connected-device capture depends on Trust/Unlock.
- Shortcut capture requires Input Monitoring. Ordinary typed text is not logged.
- Actual speech recognition needs explicit macOS authorization and compatible
  installed on-device language support. No cloud fallback is used.
- macOS camera-effects UI, actual Finder-icon changes and Accessibility window
  resizing were not included in release acceptance.
- Unsplash live authenticated search requires a user-provided session key.
- Screen Studio import supports known schema-4 single-scene/display-channel
  structures with aligned sessions and fixed dimensions. Unknown window/device/
  dynamic/cropped variants fail or warn. Original transcript storage and music
  asset locations are not guessed.
- Geometric motion blur, device bezels/social guides, image/audio processing and
  GIF/encoder quality are independent implementations. Exact proprietary
  algorithm/quality equivalence is not claimed.
- Automatic OCR/face masking can miss content. Review before distributing video.
- No hosted projects, share links, cloud uploads, viewer analytics or comments.
- Windows requires a new native capture and analysis backend; no Windows build
  is provided.

## Reporting a bug

Include macOS version, Intel/Apple Silicon, the action and the full error text.
Attach an intentionally selected minimal test project only if you want to share
its contents publicly. Avoid uploading private recordings or credentials.
