"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { Exporter } = require("./exporter.cjs");
const { MediaGrants, findTool, runProcess } = require("./media.cjs");
const { quickExportSettings } = require("./recording-preferences.cjs");

async function fixture(t, grantOutput) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reva-paired-export-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ffmpeg = await findTool("ffmpeg"), ffprobe = await findTool("ffprobe");
  const source = path.join(directory, "source.mp4"), image = path.join(directory, "frame.png");
  await runProcess(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x48:r=10:d=0.2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.2", "-c:v", "libx264", "-threads", "1", "-c:a", "aac", "-shortest", source]);
  await runProcess(ffmpeg, ["-v", "error", "-i", source, "-frames:v", "1", "-threads", "1", image]);
  const { createProject } = await import("../src/core/model.ts");
  const project = createProject({ path: source, name: "Paired", width: 64, height: 48, duration: .2 });
  const grants = new MediaGrants(); await grants.grant(source);
  const exporter = new Exporter({ grants: { assert: file => grants.assert(file), grant: async file => { if (grantOutput) await grantOutput(file); return grants.grant(file); } }, ffmpeg, ffprobe });
  t.after(() => exporter.dispose());
  const options = { project, format: "mp4", codec: "both", quality: "balanced", fps: 10, width: 64, height: 48 };
  const output = path.join(directory, "result.mp4"), companion = path.join(directory, "result-hevc.mp4"), png = new Uint8Array(await fs.readFile(image));
  const start = async (extra = {}) => {
    const session = await exporter.start({ ...options, ...extra }, () => output);
    await exporter.frame(session.id, png); await exporter.frame(session.id, png);
    return session;
  };
  return { directory, exporter, options, output, companion, start, ffmpeg, ffprobe };
}
const noTemps = async directory => assert.equal((await fs.readdir(directory)).some(name => name.startsWith(".reva-export-")), false);

test("paired file export renders once to H.264 and HEVC with identical mixed audio; clipboard resolves to H.264", async t => {
  const f = await fixture(t), session = await f.start();
  assert.deepEqual(session.paths, [f.output, f.companion]);
  let failOnce = true; const cleanup = f.exporter.cleanup.bind(f.exporter);
  f.exporter.cleanup = async session => { if (failOnce) { failOnce = false; throw new Error("fixture cleanup failure"); } return cleanup(session); };
  await assert.rejects(f.exporter.finish(session.id), /cleanup failure/);
  assert.equal(f.exporter.active, true);
  assert.equal(await f.exporter.finish(session.id), f.output);
  const pcm = [];
  for (const [index, file] of session.paths.entries()) {
    const streams = JSON.parse(await runProcess(f.ffprobe, ["-v", "error", "-show_entries", "stream=codec_name,nb_frames,duration", "-of", "json", file])).streams;
    assert.equal(streams[0].codec_name, index ? "hevc" : "h264");
    assert.equal(streams[0].nb_frames, "2"); assert.equal(Number(streams[0].duration), .2);
    assert.equal(streams[1].codec_name, "aac");
    pcm.push(await runProcess(f.ffmpeg, ["-v", "error", "-i", file, "-map", "0:a", "-f", "hash", "-hash", "sha256", "-"]));
  }
  assert.equal(pcm[0], pcm[1]);
  const clipboard = await f.start({ destination: "clipboard" });
  assert.deepEqual(clipboard.paths, [f.output]); await f.exporter.finish(clipboard.id);
  const streams = JSON.parse(await runProcess(f.ffprobe, ["-v", "error", "-show_entries", "stream=codec_name", "-of", "json", f.output])).streams;
  assert.equal(streams[0].codec_name, "h264");
  assert.equal(quickExportSettings({ codec: "both" }).codec, "both");
  await noTemps(f.directory);
});

test("paired export rejects an existing inferred companion without changing selected destinations", async t => {
  const f = await fixture(t); await fs.writeFile(f.output, "selected prior file"); await fs.writeFile(f.companion, "unapproved companion");
  await assert.rejects(f.exporter.start(f.options, () => f.output), /companion export already exists/);
  assert.equal(await fs.readFile(f.output, "utf8"), "selected prior file"); assert.equal(await fs.readFile(f.companion, "utf8"), "unapproved companion");
  assert.equal(f.exporter.active, false); await noTemps(f.directory);
});

test("a late companion collision prevents the paired commit and cancellation preserves the external file", async t => {
  const f = await fixture(t, async file => {
    // The destination was absent at preparation and group validation. Another
    // owner creates it only after the first group member is installed.
    if (file === f.output) await fs.writeFile(f.companion, "late external file", { flag: "wx" });
  });
  await fs.writeFile(f.output, "prior file"); const session = await f.start();
  await assert.rejects(f.exporter.finish(session.id), { code: "EEXIST" }); await f.exporter.cancel(session.id);
  assert.equal(await fs.readFile(f.output, "utf8"), "prior file"); assert.equal(await fs.readFile(f.companion, "utf8"), "late external file"); await noTemps(f.directory);
});

test("failed second installation rolls back the first output before cleanup", async t => {
  const f = await fixture(t); await fs.writeFile(f.output, "prior file"); const session = await f.start(), link = fs.link;
  fs.link = async (source, destination) => { if (destination === f.companion) throw new Error("fixture second installation failure"); return link(source, destination); };
  try { await assert.rejects(f.exporter.finish(session.id), /second installation failure/); }
  finally { fs.link = link; }
  assert.equal(await fs.readFile(f.output, "utf8"), "prior file"); await assert.rejects(fs.stat(f.companion), { code: "ENOENT" });
  await f.exporter.cancel(session.id); await noTemps(f.directory);
});

test("failed destination rollback retains ownership and cancellation retries the exact prior file", async t => {
  const f = await fixture(t); await fs.writeFile(f.output, "prior file"); const session = await f.start(), link = fs.link, unlink = fs.unlink;
  fs.link = async (source, destination) => { if (destination === f.companion) throw new Error("fixture second installation failure"); return link(source, destination); };
  fs.unlink = async file => { if (file === f.output) throw new Error("fixture rollback unavailable"); return unlink(file); };
  try { await assert.rejects(f.exporter.finish(session.id), /rollback is incomplete/); assert.equal(f.exporter.active, true); assert.ok(f.exporter.getSession(session.id).outputs[0].backup); }
  finally { fs.link = link; fs.unlink = unlink; }
  await f.exporter.cancel(session.id); assert.equal(await fs.readFile(f.output, "utf8"), "prior file"); await noTemps(f.directory);
});

test("cancellation during paired installation joins finalization and restores the prior output", async t => {
  let began, release; const installed = new Promise(resolve => { began = resolve; });
  const f = await fixture(t, async file => { if (path.basename(file) === "result.mp4") { began(); await new Promise(resolve => { release = resolve; }); } });
  await fs.writeFile(f.output, "prior file"); const session = await f.start();
  const finishing = assert.rejects(f.exporter.finish(session.id), /Export cancelled/);
  await installed; const cancelling = f.exporter.cancel(session.id); assert.equal(f.exporter.active, true); release();
  await Promise.all([finishing, cancelling]);
  assert.equal(await fs.readFile(f.output, "utf8"), "prior file"); await assert.rejects(fs.stat(f.companion), { code: "ENOENT" });
  assert.equal(f.exporter.active, false); await noTemps(f.directory);
});
