"use strict";
const { object, boolean, choice, string } = require("./core.cjs");

function quickExportSettings(value = {}) {
  const q = { format: "mp4", fps: 60, resolution: 1080, quality: "balanced", codec: "h264", proresProfile: "422", gifHighQuality: true, gifLoop: true, ...object(value, "Quick export settings") };
  return {
    format: choice(q.format, ["mp4", "prores", "gif"], "Export format"), fps: choice(q.fps, [24, 30, 60], "Export frame rate"), resolution: choice(q.resolution, [720, 1080, 2160], "Export resolution"), quality: choice(q.quality, ["high", "balanced", "small", "tiny"], "Export quality"), codec: choice(q.codec, ["h264", "hevc", "both"], "Export codec"), encoding: choice(q.encoding ?? "software", ["software", "hardware"], "Export encoding"), proresProfile: choice(q.proresProfile, ["422-lt", "422", "422-hq", "4444"], "ProRes profile"), gifHighQuality: boolean(q.gifHighQuality, "High quality GIF"), gifLoop: boolean(q.gifLoop, "Loop GIF"),
  };
}

const DEFAULT_RECORDING_PREFERENCES = Object.freeze({
  fps: 60,
  countdown: 0,
  systemAudio: false,
  systemAudioApplications: null,
  recordShortcuts: false,
  hideDesktopIcons: false,
  microphone: false,
  camera: false,
  microphoneDeviceID: null,
  cameraDeviceID: null,
  cameraMaxResolution: 1080,
  cameraPreview: true,
  cameraPreviewWhileRecording: true,
  autoZoom: false,
  afterRecording: "project",
  quickExportSettings: Object.freeze(quickExportSettings()),
});

function recordingPreferences(value = {}) {
  const input = object(value, "Recording preferences");
  const p = { ...DEFAULT_RECORDING_PREFERENCES, ...input };
  const deviceID = (id, label) => id === null ? null : string(id, 4096, label);
  const applications = p.systemAudioApplications;
  if (applications !== null && (!Array.isArray(applications) || !applications.length || applications.length > 10000 || applications.some(id => typeof id !== "string" || !id || id.length > 4096 || id.includes("\0")))) throw new Error("Choose at least one application for selected system audio.");
  return {
    fps: choice(p.fps, [24, 30, 60], "Recording frame rate"),
    countdown: choice(p.countdown, [0, 3, 5, 10], "Recording countdown"),
    systemAudio: boolean(p.systemAudio, "System audio"),
    systemAudioApplications: applications === null ? null : [...new Set(applications)],
    recordShortcuts: boolean(p.recordShortcuts, "Record keyboard shortcuts"),
    hideDesktopIcons: boolean(p.hideDesktopIcons, "Hide desktop icons"),
    microphone: boolean(p.microphone, "Microphone"),
    camera: boolean(p.camera, "Camera"),
    microphoneDeviceID: deviceID(p.microphoneDeviceID, "Microphone device"),
    cameraDeviceID: deviceID(p.cameraDeviceID, "Camera device"),
    cameraMaxResolution: choice(p.cameraMaxResolution, [720, 1080, 2160], "Camera resolution"),
    cameraPreview: boolean(p.cameraPreview, "Show camera preview"),
    cameraPreviewWhileRecording: boolean(p.cameraPreviewWhileRecording, "Keep camera preview while recording"),
    autoZoom: boolean(p.autoZoom, "Automatically create zooms"),
    afterRecording: choice(p.afterRecording, ["project", "clipboard", "file"], "After recording"),
    quickExportSettings: quickExportSettings(p.quickExportSettings),
  };
}

module.exports = { DEFAULT_RECORDING_PREFERENCES, recordingPreferences, quickExportSettings };
