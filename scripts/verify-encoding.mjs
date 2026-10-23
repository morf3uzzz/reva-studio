import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const { findTool, runProcess, probe, MediaGrants } = require("../electron/media.cjs");
const { Exporter } = require("../electron/exporter.cjs");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "reva-encoder-verification-")), ffmpeg = await findTool("ffmpeg"), ffprobe = await findTool("ffprobe"), source = path.join(root, "source.mp4"), pngPath = path.join(root, "frame.png");
await Promise.all([
  runProcess(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=64x48:r=10:d=0.2", "-c:v", "libx264", "-threads", "1", source]),
  runProcess(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x48:d=0.1", "-frames:v", "1", "-threads", "1", pngPath]),
]);
const project = { version: 1, name: "Encoder verification", mediaPath: source, cameraPath: null, microphonePath: null, duration: .2, width: 64, height: 48, trimStart: 0, trimEnd: .2, speed: 1, zooms: [], cursor: [], captions: [], appearance: { backgroundKind: "color", background: "#000000", gradient: 0, wallpaper: 0, image: null, blur: 0, padding: .1, radius: 0, shadow: 0, inset: 0, aspect: "auto", cursorSize: 30, cursorHidden: false, cursorSmooth: false, cursorHideIdle: false, clickEffect: "none", cameraSize: .2, cameraRadius: 0, cameraX: .8, cameraY: .8, cameraMirror: false, cameraHidden: false, volume: 1, microphoneVolume: 1, cameraVolume: 0, fadeIn: 0, fadeOut: 0, zoomDuration: .5, crop: { x: 0, y: 0, width: 1, height: 1 } } };
const grants = new MediaGrants(); await grants.grant(source); const png = new Uint8Array(await fs.readFile(pngPath)), results = [];
for (const encoding of ["software", "hardware"]) for (const codec of ["h264", "hevc", "both"]) {
  const exporter = new Exporter({ grants, ffmpeg, ffprobe }), output = path.join(root, `${encoding}-${codec}.mp4`), started = performance.now();
  try {
    const session = await exporter.start({ project, encoding, codec, format: "mp4", quality: "balanced", fps: 10, width: 64, height: 48 }, () => output);
    await exporter.frame(session.id, png); await exporter.frame(session.id, png); await exporter.finish(session.id);
    const files = [];
    for (const [index, file] of session.paths.entries()) {
      const info = await probe(file, ffprobe); assert.equal(info.width, 64); assert.equal(info.height, 48); assert.ok(Math.abs(info.duration - .2) < .02);
      const streams = JSON.parse(await runProcess(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,nb_frames,color_range,color_space", "-of", "json", file])).streams;
      const expectedCodec = codec === "both" ? index ? "hevc" : "h264" : codec;
      assert.equal(streams[0].codec_name, expectedCodec); assert.equal(Number(streams[0].nb_frames), 2);
      files.push({ output: file, stream: streams[0] });
    }
    assert.equal(files.length, codec === "both" ? 2 : 1);
    results.push({ encoding, codec, status: "passed", elapsedMs: performance.now() - started, files });
  } catch (error) { results.push({ encoding, codec, status: "failed", elapsedMs: performance.now() - started, error: error.message }); }
  finally { await exporter.dispose(); }
}
const report = { type: "reva-real-encoder-verification", root, results }; await fs.writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2)); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (results.some(result => result.status !== "passed")) process.exitCode = 1;
