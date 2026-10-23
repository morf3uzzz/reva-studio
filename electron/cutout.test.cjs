"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { CameraSegmenter } = require("./cutout.cjs");
const { MediaGrants, runProcess } = require("./media.cjs");

const ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].find(existsSync);
const ffprobe = ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "/usr/bin/ffprobe"].find(existsSync);
const mediaTest = { skip: !ffmpeg || !ffprobe, timeout: 30000 };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const pause = ms => new Promise(r => setTimeout(r, ms));
let templates;

test.before(async () => {
  if (mediaTest.skip) return;
  templates = await fs.mkdtemp(path.join(os.tmpdir(), "reva-cutout-media-"));
  await runProcess(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=64x36:r=10:d=0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(templates, "source.mp4")]);
  await runProcess(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=white:s=32x24:r=10:d=0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(templates, "mask.mp4")]);
});
test.after(async () => { if (templates) await fs.rm(templates, { recursive: true, force: true }); });

// Simulates only the native JSONL/file protocol. The source and mask are real
// H.264 fixtures inspected by production ffprobe, not Vision-generated masks.
async function fixture(t, mode = "success", options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reva-cutout-wrapper-"));
  const directory = await fs.realpath(root), source = path.join(directory, "камера.mp4");
  const maskFixture = path.join(directory, "mask-fixture.mp4"), outside = path.join(directory, "unrelated.txt");
  await fs.copyFile(path.join(templates, "source.mp4"), source);
  await fs.copyFile(path.join(templates, "mask.mp4"), maskFixture);
  await fs.writeFile(outside, "unrelated file must survive");
  const hash = crypto.createHash("sha256").update(await fs.readFile(source)).digest("hex");
  const manifest = {
    version: 1, coordinateSpace: "oriented-top-left-normalized",
    source: { path: source, sha256: hash, width: 64, height: 36, duration: 0.5, orientation: 1 },
    mask: { file: "camera-mask.mp4", width: 32, height: 24, codec: "h264", channel: "red", background: 0, foreground: 1 },
    timing: { sourceTimeOrigin: 0, duration: 0.5, frameCount: 5, preservesVariableFrameRate: true,
      firstPTS: { value: 0, timescale: 10, seconds: 0 }, lastPTS: { value: 4, timescale: 10, seconds: 0.4 }, sourceEnd: { value: 5, timescale: 10, seconds: 0.5 } },
    settings: { quality: "balanced", visionRevision: 1, outputPixelFormat: "OneComponent8" },
  };
  const helper = path.join(directory, "protocol-helper.cjs"), marker = path.join(directory, "started");
  await fs.writeFile(helper, `#!${process.execPath}
"use strict";
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2), mode = ${JSON.stringify(mode)};
const output = args[args.indexOf("--output-directory") + 1];
const outside = ${JSON.stringify(outside)}, maskFixture = ${JSON.stringify(maskFixture)};
const manifest = ${JSON.stringify(manifest)};
manifest.source.path = args[args.indexOf("--input") + 1];
manifest.settings.quality = args[args.indexOf("--quality") + 1];
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
const ready = () => emit({type:"ready", duration:0.5, width:64, height:36, quality:manifest.settings.quality});
let cancelling = false;
const cancel = () => {
  if (cancelling) return; cancelling = true;
  if (mode === "startup") ready(); // Deliberately late handshake after stop.
  setTimeout(() => {
    fs.writeFileSync(path.join(path.dirname(output), "late-owned.tmp"), "child drained before exit");
    emit({type:"cancelled"}); process.stdout.write("", () => process.exit(130));
  }, 30);
};
process.stdin.on("data", cancel); process.stdin.on("end", cancel); process.on("SIGTERM", cancel);
fs.writeFileSync(${JSON.stringify(marker)}, "started");
if (mode === "startup") { setInterval(() => {}, 1000); }
else if (mode === "oversized-message") { process.stdout.write("x".repeat(65537)); }
else if (mode === "before-ready") { emit({type:"completed", outputDirectory:output}); process.exit(0); }
else {
  ready();
  emit({type:"progress", phase:mode === "finalizing" ? "finalizing" : "segmenting", progress:mode === "finalizing" ? 0.95 : 0.1, t:0, frames:1});
  if (["active", "finalizing"].includes(mode)) { setInterval(() => {}, 1000); }
  else {
    fs.mkdirSync(output);
    const maskPath = path.join(output, "camera-mask.mp4"), manifestPath = path.join(output, "manifest.json");
    if (mode === "wrong-source") manifest.source.path = outside;
    if (mode === "wrong-hash") manifest.source.sha256 = "a".repeat(64);
    if (mode === "wrong-dimensions") manifest.mask.width = 34;
    if (mode === "wrong-clock") manifest.timing.sourceTimeOrigin = -90000;
    if (mode === "wrong-frames") manifest.timing.frameCount = 4;
    if (mode === "beyond-source") { manifest.timing.duration = 4; manifest.timing.sourceEnd = {value:40,timescale:10,seconds:4}; }
    if (mode === "wrong-quality") manifest.settings.quality = "unsupported";
    if (mode === "mask-symlink") fs.symlinkSync(maskFixture, maskPath);
    else fs.copyFileSync(maskFixture, maskPath);
    if (mode === "malformed-json") fs.writeFileSync(manifestPath, "{");
    else if (mode === "manifest-symlink") fs.symlinkSync(outside, manifestPath);
    else if (mode === "oversized-file") { const fd=fs.openSync(manifestPath,"wx");fs.ftruncateSync(fd,1048577);fs.closeSync(fd); }
    else fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    emit({type:"completed", outputDirectory:output, maskPath, manifestPath, frames:manifest.timing.frameCount, duration:manifest.timing.duration});
    if (mode === "conflicting-terminal") emit({type:"cancelled"});
    process.stdout.write("", () => process.exit(0));
  }
}
`, { mode: 0o700 });
  const grants = options.grants ?? new MediaGrants();
  if (options.grant !== false) await grants.grant(source);
  const started = deferred(), progress = [];
  // Lifecycle cases use the production idle deadline, with hangs bounded by
  // the test runner. A shorter fixture default also counts cold Node bootstrap
  // and can expire before the phase whose cancellation this test exercises.
  // Only the dedicated inactivity test opts into a short idle deadline.
  const segmenter = new CameraSegmenter({ helper, cacheRoot: path.join(directory, "cache"), ffprobe, grants,
    idleTimeout: options.idleTimeout, onProgress(n) { progress.push(n); started.resolve(); } });
  t.after(async () => { try { await segmenter.dispose(); } finally { await fs.rm(directory, { recursive: true, force: true }); } });
  return { directory, source, outside, marker, segmenter, grants, progress, started, hash };
}

async function emptyCache(f) {
  assert.equal(f.segmenter.active, false);
  assert.deepEqual(await fs.readdir(f.segmenter.cacheRoot).catch(e => { if (e.code === "ENOENT") return []; throw e; }), []);
  assert.equal(await fs.readFile(f.outside, "utf8"), "unrelated file must survive");
}
async function awaitFile(file) {
  const end = Date.now() + 5000;
  while (!(await fs.stat(file).catch(() => null))) {
    assert.ok(Date.now() < end, "owned child should start"); await pause(5);
  }
}
class BlockingGrants extends MediaGrants {
  constructor(at) { super(); this.at = at; this.calls = 0; this.entered = deferred(); this.release = deferred(); }
  async assert(file) { if (++this.calls === this.at) { this.entered.resolve(); await this.release.promise; } return super.assert(file); }
}

test("camera wrapper validates real media, exact source identity and distinct Vision aspect, retaining handed-off artifacts", mediaTest, async t => {
  const f = await fixture(t), result = await f.segmenter.segment(f.source, { quality: "accurate" });
  assert.deepEqual(result, { path: result.path, sourcePath: f.source, sourceSHA256: f.hash, sourceTimeOrigin: 0, duration: 0.5, width: 32, height: 24 });
  assert.deepEqual(f.progress, [0.1]);
  assert.equal(f.segmenter.active, false);
  await assert.rejects(f.grants.assert(result.path), /not been selected/, "only the IPC owner can grant returned outputs");
  await f.segmenter.dispose();
  assert.ok((await fs.stat(result.path)).isFile(), "dispose cannot invalidate a handed-off project asset");
  const denied = await fixture(t, "success", { grant: false });
  await assert.rejects(denied.segmenter.segment(denied.source), /not been selected/);
  await assert.rejects(fs.stat(denied.marker), { code: "ENOENT" });
  await emptyCache(denied);
});

test("camera cancellation before source grant prevents process startup", mediaTest, async t => {
  const grants = new BlockingGrants(1), f = await fixture(t, "success", { grants });
  const result = f.segmenter.segment(f.source);
  await grants.entered.promise;
  const cancelled = f.segmenter.cancel(); grants.release.resolve();
  assert.equal(await result, null); await cancelled;
  await assert.rejects(fs.stat(f.marker), { code: "ENOENT" });
  await emptyCache(f);
});

test("camera cancellation owns startup, active and finalizing helper exit before cleanup", mediaTest, async t => {
  for (const mode of ["startup", "active", "finalizing"]) await t.test(mode, async t => {
    const f = await fixture(t, mode), result = f.segmenter.segment(f.source);
    if (mode === "startup") await awaitFile(f.marker); else await f.started.promise;
    const child = f.segmenter.session.child;
    assert.throws(() => f.segmenter.segment(f.source), /already running/);
    await f.segmenter.cancel(); assert.equal(await result, null);
    assert.equal(child.exitCode, 130); assert.equal(child.signalCode, null);
    await emptyCache(f);
  });
});

test("camera cancellation terminates the owned ffprobe and waits for close", mediaTest, async t => {
  const f = await fixture(t), probeMarker = path.join(f.directory, "probe-started"), probe = path.join(f.directory, "slow-probe.cjs");
  await fs.writeFile(probe, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(probeMarker)},'started');setInterval(()=>{},1000);\n`, { mode: 0o700 });
  f.segmenter.ffprobe = probe;
  const result = f.segmenter.segment(f.source); await awaitFile(probeMarker);
  const child = f.segmenter.session.child;
  await f.segmenter.cancel(); assert.equal(await result, null);
  assert.equal(child.signalCode, "SIGTERM");
  await emptyCache(f);
});

test("camera cancellation after native completion suppresses output during source revalidation", mediaTest, async t => {
  const grants = new BlockingGrants(2), f = await fixture(t, "success", { grants });
  const result = f.segmenter.segment(f.source); await grants.entered.promise;
  assert.equal(f.segmenter.session.exited, true);
  const cancelled = f.segmenter.cancel(); grants.release.resolve();
  assert.equal(await result, null); await cancelled; await emptyCache(f);
});

test("camera cancellation remains active through final cleanup and cleanup failure is retryable", mediaTest, async t => {
  const f = await fixture(t, "active"), entered = deferred(), release = deferred(), remove = fs.rm;
  let failures = 1;
  t.mock.method(fs, "rm", async (file, options) => {
    if (path.dirname(file) === f.segmenter.cacheRoot) {
      entered.resolve(); await release.promise;
      if (failures-- > 0) throw Object.assign(new Error("simulated cleanup failure"), { code: "EBUSY" });
    }
    return remove(file, options);
  });
  const result = f.segmenter.segment(f.source), rejected = assert.rejects(result, /simulated cleanup failure/);
  await f.started.promise;
  const cancelled = f.segmenter.cancel(); await entered.promise;
  assert.equal(f.segmenter.active, true);
  assert.throws(() => f.segmenter.segment(f.source), /already running/);
  release.resolve(); await rejected; await cancelled;
  t.mock.restoreAll(); await emptyCache(f);
});

test("camera cleanup retains ownership after a persistent failure for concurrent retries", mediaTest, async t => {
  const f = await fixture(t, "malformed-json"), remove = fs.rm;
  t.mock.method(fs, "rm", async (file, options) => {
    if (path.dirname(file) === f.segmenter.cacheRoot) throw new Error("retained cleanup failure");
    return remove(file, options);
  });
  await assert.rejects(f.segmenter.segment(f.source), /retained cleanup failure/);
  assert.equal(f.segmenter.active, true); assert.equal(f.segmenter.session.exited, true);
  t.mock.restoreAll();
  await Promise.all([f.segmenter.dispose(), f.segmenter.cancel()]);
  await emptyCache(f);
});

test("camera cleanup refuses an externally replaced job directory", mediaTest, async t => {
  const grants = new BlockingGrants(2), f = await fixture(t, "success", { grants });
  const result = f.segmenter.segment(f.source), rejected = assert.rejects(result, /owned camera directory was replaced/);
  await grants.entered.promise;
  const owned = f.segmenter.session.directory, moved = path.join(f.directory, "owned-moved");
  await fs.rename(owned, moved); await fs.mkdir(owned); await fs.writeFile(path.join(owned, "foreign.txt"), "preserve");
  grants.release.resolve(); await rejected;
  assert.equal(f.segmenter.active, true);
  assert.equal(await fs.readFile(path.join(owned, "foreign.txt"), "utf8"), "preserve");
  await fs.rename(owned, path.join(f.directory, "foreign-preserved")); await fs.rename(moved, owned);
  await f.segmenter.dispose(); await emptyCache(f);
});

test("camera source mutation invalidates an otherwise completed mask", mediaTest, async t => {
  const grants = new BlockingGrants(2), f = await fixture(t, "success", { grants });
  const result = f.segmenter.segment(f.source), rejected = assert.rejects(result, /source changed/);
  await grants.entered.promise;
  const source = await fs.open(f.source, "r+");
  await source.write(Buffer.from([0x61]), 0, 1, 20); await source.close();
  grants.release.resolve(); await rejected; await emptyCache(f);
});

test("camera validates protocol, bounded manifest, media encoding and source timing before publishing", mediaTest, async t => {
  for (const [mode, pattern] of [
    ["wrong-source", /another source/], ["wrong-hash", /SHA256/],
    ["wrong-dimensions", /encoding or frame coverage/], ["wrong-clock", /time origin/],
    ["wrong-frames", /every source video frame/], ["beyond-source", /beyond.*duration/],
    ["wrong-quality", /settings do not match/], ["malformed-json", /JSON|property|position/i],
    ["mask-symlink", /ELOOP/], ["manifest-symlink", /ELOOP/],
    ["oversized-file", /memory budget/], ["oversized-message", /oversized message/],
    ["before-ready", /unexpected result/], ["conflicting-terminal", /after its terminal/],
  ]) await t.test(mode, async t => {
    const f = await fixture(t, mode);
    await assert.rejects(f.segmenter.segment(f.source), pattern); await emptyCache(f);
  });
});

test("camera helper timeout waits for cancellation and removes partial files", mediaTest, async t => {
  const f = await fixture(t, "active", { idleTimeout: 100 });
  await assert.rejects(f.segmenter.segment(f.source), /stopped responding/);
  await emptyCache(f);
});
