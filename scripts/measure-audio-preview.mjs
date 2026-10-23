import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url), { AudioPreview } = require("../electron/audio-preview.cjs"), { findTool, runProcess, MediaGrants } = require("../electron/media.cjs"), { readPortableProject } = require("../electron/core.cjs"), { defaultAudioSettings } = require("../shared/audio.mjs");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "reva-long-audio-metrics-")), ffmpeg = await findTool("ffmpeg"), ffprobe = await findTool("ffprobe"), file = path.join(root, "twenty-minute-synthetic.flac");
await runProcess(ffmpeg, ["-v", "error", "-nostdin", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1200", "-c:a", "flac", "-threads", "1", file], { timeout: 120000 });
const project = await readPortableProject(process.argv[2]);
Object.assign(project, { mediaPath: file, microphonePath: file, cameraPath: null, cameraMask: undefined, cameraFaceTrack: undefined, cameraSilence: undefined, screenEnhancement: undefined, transcript: undefined, duration: 1200, trimStart: 0, trimEnd: 1200, speed: 1, slices: [{ id: "source", start: 0, end: 1200, speed: 1, volume: 1 }], zooms: [], cursor: [], masks: [], shortcuts: [], recordingFlags: [], audio: { ...defaultAudioSettings(), microphonePreset: "standard" } });
project.appearance.volume = 0; project.appearance.microphoneVolume = 1; project.appearance.cameraVolume = 0; project.appearance.fadeIn = project.appearance.fadeOut = 0;
const grants = new MediaGrants(); await grants.grant(file); const owner = new AudioPreview({ root: path.join(root, "preview"), ffmpeg, ffprobe, grants }), results = [];
try {
  for (const [name, start] of [["first-cold", 0], ["late-cold", 1186], ["late-warm", 1186]]) {
    const before = performance.now(), cpu = process.cpuUsage(); const output = await owner.render(project, { id: crypto.randomUUID(), start, duration: 14 }); const used = process.cpuUsage(cpu);
    results.push({ name, start, elapsedMs: performance.now() - before, parentCPUMs: (used.user + used.system) / 1000, bytes: (await fs.stat(output.path)).size });
  }
} finally { await owner.dispose(); }
const report = { type: "reva-actual-production-audio-preview-performance", root, duration: 1200, sampleRate: 48000, source: "Synthetic 20-minute FLAC tone; Standard microphone DSP; no physical acquisition", results, parentPeakRSSMiB: process.resourceUsage().maxRSS / 1024, limitations: ["Exact PCM-state preservation streams the prefix on an uncached late seek", "Parent CPU/RSS excludes FFmpeg children; total CPU and sampled family memory recorded separately when available", "Not a measured speech-quality or browser-latency result", "Token usage unmeasured"] };
await fs.writeFile("/private/tmp/reva-audio-preview-performance-20261022.json", JSON.stringify(report, null, 2)); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
