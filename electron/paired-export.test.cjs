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
  let exporter;
  t.after(async () => { await exporter?.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  const ffmpeg = await findTool("ffmpeg"), ffprobe = await findTool("ffprobe");
  const source = path.join(directory, "source.mp4"), image = path.join(directory, "frame.png");
  await runProcess(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x48:r=10:d=0.2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.2", "-c:v", "libx264", "-threads", "1", "-c:a", "aac", "-shortest", source]);
  await runProcess(ffmpeg, ["-v", "error", "-i", source, "-frames:v", "1", "-threads", "1", image]);
  const { createProject } = await import("../src/core/model.ts");
  const project = createProject({ path: source, name: "Paired", width: 64, height: 48, duration: .2 });
  const grants = new MediaGrants(); await grants.grant(source);
  exporter = new Exporter({ grants: { assert: file => grants.assert(file), grant: async file => { if (grantOutput) await grantOutput(file); return grants.grant(file); } }, ffmpeg, ffprobe });
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

test("invalid staged encodings never replace the selected file or install its companion", async t => {
  for (const damage of ["unreadable container", "wrong dimensions", "truncated duration"]) await t.test(damage, async t => {
    const f = await fixture(t);
    await fs.writeFile(f.output, "preserve selected original");
    const session = await f.start();
    const owned = f.exporter.getSession(session.id);
    owned.child.stdin.end();
    await owned.completion;
    const staged = owned.outputs[0].temporary;
    if (damage === "unreadable container") await fs.writeFile(staged, "nonempty damaged recording");
    else await runProcess(f.ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=red:s=${damage === "wrong dimensions" ? "32x24" : "64x48"}:r=10:d=${damage === "truncated duration" ? "0.1" : "0.2"}`, "-c:v", "libx264", "-threads", "1", staged]);
    await assert.rejects(f.exporter.finish(session.id), /encoded export|decode|container/i);
    assert.equal(await fs.readFile(f.output, "utf8"), "preserve selected original");
    await assert.rejects(fs.stat(f.companion), { code: "ENOENT" });
    await f.exporter.cancel(session.id);
    await noTemps(f.directory);
  });
});

test("partial last frames and a single GIF frame keep the renderer's frame count and bounded endpoint", async t => {
  for (const format of ["mp4", "prores", "gif"]) for (const duration of [.01, .02]) await t.test(`${format} ${duration}s`, async t => {
    const f = await fixture(t), project = { ...f.options.project, trimEnd: duration };
    const session = await f.exporter.start({ ...f.options, project, format, codec: "h264", fps: 60 }, () => f.output);
    const image = new Uint8Array(await fs.readFile(path.join(f.directory, "frame.png")));
    const frames = Math.ceil(duration * 60);
    for (let frame = 0; frame < frames; frame++) await f.exporter.frame(session.id, image);
    await f.exporter.finish(session.id);
    const data = JSON.parse(await runProcess(f.ffprobe, ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames,duration:format=duration", "-of", "json", f.output]));
    assert.equal(Number(data.streams[0].nb_read_frames), frames);
    assert.ok(Math.abs(Number(data.format.duration) - frames / 60) <= .01);
    await noTemps(f.directory);
  });
});

test("cancellation during encoded-file validation joins the probe and preserves the prior destination", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.output, "preserve selected original");
  const session = await f.start(), began = path.join(f.directory, "probe-began"), release = path.join(f.directory, "probe-release");
  const wrapper = path.join(f.directory, "controlled-probe.cjs");
  await fs.writeFile(wrapper, `#!/usr/bin/env node\nconst fs=require('node:fs/promises'),{spawn}=require('node:child_process');(async()=>{await fs.writeFile(${JSON.stringify(began)},'ready');while(!await fs.access(${JSON.stringify(release)}).then(()=>true,()=>false))await new Promise(r=>setTimeout(r,10));const child=spawn(${JSON.stringify(f.ffprobe)},process.argv.slice(2),{stdio:'inherit'});child.on('error',()=>process.exit(1));child.on('close',code=>process.exit(code??1));})().catch(()=>process.exit(1));\n`, { mode: 0o700 });
  f.exporter.ffprobe = wrapper;
  const finishing = assert.rejects(f.exporter.finish(session.id), /Export cancelled/);
  try {
    const deadline = Date.now() + 5000;
    while (!await fs.access(began).then(() => true, () => false)) {
      assert.ok(Date.now() < deadline, "The actual validation process did not start");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const cancelling = f.exporter.cancel(session.id);
    assert.equal(f.exporter.active, true);
    assert.equal(await fs.readFile(f.output, "utf8"), "preserve selected original");
    await fs.writeFile(release, "release");
    await Promise.all([finishing, cancelling]);
    assert.equal(f.exporter.active, false);
    assert.equal(await fs.readFile(f.output, "utf8"), "preserve selected original");
    await assert.rejects(fs.stat(f.companion), { code: "ENOENT" });
    await noTemps(f.directory);
  } finally {
    await fs.writeFile(release, "release").catch(() => {});
    await finishing.catch(() => {});
  }
});

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
