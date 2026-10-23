# Changelog

## 0.1.0 — 2026-10-23

First public preview of REVA Studio for macOS.

- Local recorder/editor, animated zooms, camera scenes, audio, captions and masks.
- Portable projects, presets, H.264/HEVC/paired/ProRes/GIF export and recovery.
- Original REVA logo, 18 original wallpapers, independent cursors and synthesized clicks.
- Universal Intel/Apple Silicon packaging with checksums and build metadata.
- Fixed screen selection rejecting the native keyboard `not-granted` permission.
- Fixed crowded spacing in privacy, screen-processing and animation settings.
- Added hover insertion and range dragging/trimming for the Layouts and Masks tracks.
- Added camera-dependent insertion tools, drawn masks and dedicated range editors.
- Added screen/cursor animation cards and the camera look gallery.
- Replaced the preset modal with a popover and rename/update/default/reveal/remove actions.
- Fixed scrubbed speech changing pitch with pointer speed, direction and timeline zoom.

See [release status](docs/STATUS.md) for unverified conditions and compatibility bounds.

- Fix recording failure when a queued video frame arrives behind a recovery checkpoint.
- Preserve native error domain, code and underlying cause in recording failures.
- Compact recording widget with stop/timer, pause, restart and delete controls.
- Stabilize preview geometry while timeline feature rows expand on hover.
- Add a separate transcript editor, advanced shadow controls and responsive labels.

Recording follow-up: correct window-selection coordinates below the macOS menu bar, a smaller 160×36 recording widget, clean transparent window corners before H.264 encoding, and camera cutout support for tracks with a leading empty edit.
