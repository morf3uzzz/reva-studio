"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { PrivacyAnalyzer } = require("./privacy.cjs");
const { MediaGrants, runProcess } = require("./media.cjs");
const { MAX_PROJECT_BYTES } = require("./core.cjs");

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// These executable helpers exercise the real process/file lifecycle only. They
// do not claim to exercise Vision; the opt-in native test below does that.
async function fixture(t, mode = "success", options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reva-privacy-wrapper-"));
  const file = path.join(directory, "synthetic-input.mp4");
  const helper = path.join(directory, "protocol-helper.cjs");
  const cacheRoot = path.join(directory, "cache");
  const marker = path.join(directory, "child-started");
  const outside = path.join(directory, "outside.json");
  await fs.writeFile(file, "Synthetic lifecycle input, not a video or actual recording.");
  await fs.writeFile(outside, "unrelated file must survive");
  const digest = crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
  const result = {
    version: 1,
    coordinateSpace: "oriented-top-left-normalized",
    source: { path: file, sha256: digest, width: 1280, height: 800, duration: 1 },
    settings: { sensitive: true, faces: false, sampleInterval: 0.5, maximumAnalysisDimension: 4096,
      ocrRevision: 3, faceRevision: 3, patternRevision: 1 },
    coverage: { complete: true, sampledFrames: 2, plannedFrames: 2, intervals: [{ start: 0, end: 1 }],
      limitations: ["Synthetic protocol fixture; no detector was run."] },
    samples: [0, 0.5].map((t) => ({ requestedTime: t, actualTime: t, analysisWidth: 1280, analysisHeight: 800 })),
    regions: [{ start: 0, end: 1, kind: "email", x: 0.1, y: 0.2, width: 0.3, height: 0.1, confidence: 0.99 }],
  };
  const script = `#!${process.execPath}
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const output = args[args.indexOf("--output") + 1];
const mode = ${JSON.stringify(mode)};
const marker = ${JSON.stringify(marker)};
const outside = ${JSON.stringify(outside)};
const result = ${JSON.stringify(result)};
result.source.path = args[args.indexOf("--input") + 1];
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let cancelling = false;
const cancel = () => {
  if (cancelling) return;
  cancelling = true;
  setTimeout(() => {
    fs.writeFileSync(path.join(path.dirname(output), "late-owned.tmp"), "finalized before exit");
    emit({type: "cancelled"});
    process.exit(130);
  }, 40);
};
process.on("SIGTERM", cancel);
process.stdin.on("data", cancel);
process.stdin.on("end", cancel);
fs.writeFileSync(marker, "started");
if (mode === "startup") { setInterval(() => {}, 1000); }
else if (mode === "oversized-message") { process.stdout.write("x".repeat(65537)); }
else if (mode === "before-ready") { emit({type:"completed", output}); process.exit(0); }
else {
  emit({type:"ready", duration:1, plannedFrames:2, sampleInterval:0.5});
  emit({type:"progress", progress:0, t:0, sampledFrames:0, plannedFrames:2});
  if (mode === "active") { setInterval(() => {}, 1000); }
  else {
    if (mode === "many-lines") {
      // The first complete line is near the limit; additional valid lines may
      // arrive in the same read. A limit on the whole read would reject it.
      const progress = JSON.stringify({type:"progress", progress:0.5, ignored:"x".repeat(65000)}) + "\\n";
      process.stdout.write(progress + Array(1000).fill(JSON.stringify({type:"progress", progress:0.5}) + "\\n").join(""));
    }
    if (mode === "wrong-source") result.source.path = outside;
    if (mode === "bad-region") result.regions[0].x = 1.5;
    if (mode === "malformed-json") fs.writeFileSync(output, "{");
    else if (mode === "oversized-file") { const fd=fs.openSync(output,"wx"); fs.ftruncateSync(fd,${MAX_PROJECT_BYTES + 1}); fs.closeSync(fd); }
    else if (mode === "symlink") fs.symlinkSync(outside, output);
    else fs.writeFileSync(output, JSON.stringify(result));
    emit({type:"completed", output, regions:result.regions.length, sampledFrames:2});
    if (mode === "conflicting-terminal") emit({type:"cancelled"});
    process.stdout.write("", () => process.exit(0));
  }
}
`;
  await fs.writeFile(helper, script, { mode: 0o700 });
  const grants = options.grants || new MediaGrants();
  if (options.grant !== false) await grants.grant(file);
  const progress = [];
  const started = deferred();
  // Lifecycle cases use the production idle deadline, with cancellation stages
  // bounded by the test runner. Cold Node bootstrap is not native inactivity;
  // only the dedicated silent-child test requests a short idle deadline.
  const analyzer = new PrivacyAnalyzer({ helper, cacheRoot, grants, idleTimeout: options.idleTimeout,
    onProgress(value) { progress.push(value); started.resolve(); } });
  t.after(async () => {
    try { await analyzer.dispose(); } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  return { analyzer, directory, file, cacheRoot, marker, outside, grants, result, progress, started };
}

async function emptyCache(f) {
  assert.equal(f.analyzer.active, false);
  assert.deepEqual(await fs.readdir(f.cacheRoot).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  }), []);
  assert.equal(await fs.readFile(f.outside, "utf8"), "unrelated file must survive");
}

class BlockingGrants extends MediaGrants {
  constructor(blockAt) { super(); this.blockAt = blockAt; this.calls = 0; this.entered = deferred(); this.release = deferred(); }
  async assert(file) {
    if (++this.calls === this.blockAt) { this.entered.resolve(); await this.release.promise; }
    return super.assert(file);
  }
}

test("privacy wrapper honors MediaGrants and preserves normalized region mapping", async (t) => {
  const f = await fixture(t);
  const result = await f.analyzer.analyze(f.file, { sensitive: true, faces: false });
  assert.deepEqual(result.regions, f.result.regions);
  assert.deepEqual(result.samples, f.result.samples);
  assert.deepEqual(result.settings, f.result.settings);
  assert.equal(result.coverage.plannedFrames, f.result.coverage.plannedFrames);
  assert.equal(result.source.sha256, f.result.source.sha256);
  assert.equal(Object.hasOwn(result.source, "path"), false);
  assert.deepEqual(f.progress, [0]);
  await emptyCache(f);
  const denied = await fixture(t, "success", { grant: false });
  await assert.rejects(denied.analyzer.analyze(denied.file, { sensitive: true, faces: false }), /not been selected/);
  await assert.rejects(fs.stat(denied.marker), { code: "ENOENT" });
  await emptyCache(denied);
});

test("privacy cancellation before source validation finishes prevents spawning", async (t) => {
  const grants = new BlockingGrants(1);
  const f = await fixture(t, "success", { grants });
  const result = f.analyzer.analyze(f.file, { sensitive: true, faces: false });
  await grants.entered.promise;
  const cancelled = f.analyzer.cancel();
  assert.equal(f.analyzer.active, true);
  grants.release.resolve();
  assert.equal(await result, null);
  await cancelled;
  await assert.rejects(fs.stat(f.marker), { code: "ENOENT" });
  await emptyCache(f);
});

test("privacy cancellation during startup or analysis waits for helper exit before cleanup", { timeout: 15000 }, async (t) => {
  for (const mode of ["startup", "active"]) await t.test(mode, async (t) => {
    const f = await fixture(t, mode);
    const result = f.analyzer.analyze(f.file, { sensitive: true, faces: false });
    if (mode === "active") await f.started.promise;
    else {
      const deadline = Date.now() + 3000;
      while (!(await fs.stat(f.marker).catch(() => null))) {
        assert.ok(Date.now() < deadline, "helper should start");
        await pause(5);
      }
    }
    const child = f.analyzer.session.child;
    await f.analyzer.cancel();
    assert.equal(await result, null);
    assert.equal(child.exitCode, 130);
    assert.equal(child.signalCode, null);
    await emptyCache(f);
  });
});

test("privacy cancellation after child exit suppresses the result during source revalidation", async (t) => {
  const grants = new BlockingGrants(2);
  const f = await fixture(t, "success", { grants });
  const result = f.analyzer.analyze(f.file, { sensitive: true, faces: false });
  await grants.entered.promise;
  assert.equal(f.analyzer.session.exited, true);
  const cancelled = f.analyzer.cancel();
  grants.release.resolve();
  assert.equal(await result, null);
  await cancelled;
  await emptyCache(f);
});

test("privacy cancellation during final cleanup suppresses an already parsed result", async (t) => {
  const f = await fixture(t);
  const entered = deferred(), release = deferred();
  const remove = fs.rm;
  t.mock.method(fs, "rm", async (file, options) => {
    if (path.dirname(file) === f.cacheRoot) { entered.resolve(); await release.promise; }
    return remove(file, options);
  });
  const result = f.analyzer.analyze(f.file, { sensitive: true, faces: false });
  await entered.promise;
  assert.equal(f.analyzer.active, true);
  assert.throws(() => f.analyzer.analyze(f.file, { sensitive: true, faces: false }), /already running/);
  const cancelled = f.analyzer.cancel();
  release.resolve();
  assert.equal(await result, null);
  await cancelled;
  t.mock.restoreAll();
  await emptyCache(f);
});

test("privacy retains failed cleanup ownership and allows concurrent retries", async (t) => {
  const f = await fixture(t);
  const remove = fs.rm;
  let failures = 1;
  t.mock.method(fs, "rm", async (file, options) => {
    if (path.dirname(file) === f.cacheRoot && failures-- > 0)
      throw Object.assign(new Error("simulated cleanup failure"), { code: "EBUSY" });
    return remove(file, options);
  });
  await assert.rejects(f.analyzer.analyze(f.file, { sensitive: true, faces: false }), /simulated cleanup failure/);
  assert.equal(f.analyzer.active, true);
  assert.equal(f.analyzer.session.exited, true);
  await Promise.all([f.analyzer.dispose(), f.analyzer.cancel()]);
  t.mock.restoreAll();
  await emptyCache(f);
});

test("privacy cleanup refuses a replaced directory and retains the owned session for retry", async (t) => {
  const grants = new BlockingGrants(2);
  const f = await fixture(t, "success", { grants });
  const result = f.analyzer.analyze(f.file, { sensitive: true, faces: false });
  const rejection = assert.rejects(result, /owned privacy directory was replaced/);
  await grants.entered.promise;
  const owned = f.analyzer.session.directory;
  const moved = path.join(f.directory, "owned-moved");
  await fs.rename(owned, moved);
  await fs.mkdir(owned);
  await fs.writeFile(path.join(owned, "foreign.txt"), "preserve replacement");
  grants.release.resolve();
  await rejection;
  assert.equal(f.analyzer.active, true);
  assert.equal(await fs.readFile(path.join(owned, "foreign.txt"), "utf8"), "preserve replacement");
  await fs.rename(owned, path.join(f.directory, "foreign-preserved"));
  await fs.rename(moved, owned);
  await f.analyzer.dispose();
  await emptyCache(f);
});

test("privacy rejects malformed, oversized, unowned, or conflicting helper results", { timeout: 20000 }, async (t) => {
  for (const [mode, message] of [
    ["malformed-json", /JSON|position|property/i],
    ["oversized-file", /too large/],
    ["oversized-message", /oversized message/],
    ["symlink", /ELOOP|symbolic link/i],
    ["wrong-source", /another recording/],
    ["bad-region", /out of range/],
    ["before-ready", /unexpected result/],
    ["conflicting-terminal", /after its terminal result/],
  ]) await t.test(mode, async (t) => {
    const f = await fixture(t, mode);
    await assert.rejects(f.analyzer.analyze(f.file, { sensitive: true, faces: false }), message);
    await emptyCache(f);
  });
});

test("privacy accepts coalesced valid JSON lines and times out a silent owned child", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, "many-lines");
  assert.equal((await f.analyzer.analyze(f.file, { sensitive: true, faces: false })).regions.length, 1);
  assert.equal(f.progress.length, 1002);
  await emptyCache(f);
  const silent = await fixture(t, "startup", { idleTimeout: 100 });
  await assert.rejects(silent.analyzer.analyze(silent.file, { sensitive: true, faces: false }), /stopped responding/);
  await emptyCache(silent);
});

test("privacy revalidates the MediaGrant after the helper exits", async (t) => {
  const grants = new BlockingGrants(2);
  const f = await fixture(t, "success", { grants });
  const result = f.analyzer.analyze(f.file, { sensitive: true, faces: false });
  const rejection = assert.rejects(result, /changed/);
  await grants.entered.promise;
  await fs.rename(f.file, `${f.file}.original`);
  await fs.writeFile(f.file, "replacement");
  grants.release.resolve();
  await rejection;
  await emptyCache(f);
});

test("native Apple Vision through PrivacyAnalyzer preserves OCR regions and rotated coordinates", {
  skip: process.platform !== "darwin" || process.env.REVA_PRIVACY_NATIVE_TESTS !== "1",
  timeout: 60000,
}, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reva-privacy-native-wrapper-"));
  const build = path.resolve(__dirname, "../native/build");
  const grants = new MediaGrants();
  const progress = [];
  const cacheRoot = path.join(directory, "cache");
  const analyzer = new PrivacyAnalyzer({ helper: path.join(build, "reva-capture"), cacheRoot, grants,
    onProgress: (value) => progress.push(value) });
  t.after(async () => {
    try { await analyzer.dispose(); } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  await runProcess(path.join(build, "privacy-fixtures"), [directory], { timeout: 30000 });
  for (const [filename, width, height] of [["synthetic-privacy.mp4", 1280, 800], ["synthetic-privacy-rotated.mov", 800, 1280]]) {
    const file = path.join(directory, filename);
    const before = await fs.readFile(file);
    await grants.grant(file);
    const result = await analyzer.analyze(file, { sensitive: true, faces: false });
    assert.deepEqual(new Set(result.regions.map((r) => r.kind)), new Set(["email", "phone", "card", "key"]));
    assert.equal(result.source.width, width);
    assert.equal(result.source.height, height);
    assert.equal(result.source.sha256, crypto.createHash("sha256").update(before).digest("hex"));
    assert.equal(result.coverage.complete, true);
    assert.equal(result.coverage.sampledFrames, 6);
    assert.equal(result.coverage.plannedFrames, 6);
    assert.equal(result.samples.length, 6);
    assert.equal(result.settings.ocrRevision, 3);
    for (const sample of result.samples) {
      assert.ok(sample.actualTime >= 0 && sample.actualTime <= result.source.duration);
      assert.equal(sample.analysisWidth, width);
      assert.equal(sample.analysisHeight, height);
    }
    for (const r of result.regions) {
      assert.ok(r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0);
      assert.ok(r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001);
      assert.ok(r.start >= 0 && r.end <= result.source.duration);
    }
    const email = result.regions.find((r) => r.kind === "email");
    if (width === 1280) assert.ok(email.y > 0.2 && email.y < 0.3);
    else assert.ok(email.x > 0.6 && email.x < 0.8);
    assert.deepEqual(await fs.readFile(file), before);
    assert.deepEqual(await fs.readdir(cacheRoot), []);
  }
  assert.equal(progress.length, 12);
  assert.equal(progress.at(-1), 1);
});
