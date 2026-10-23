"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { CameraAnalyzer } = require("./camera-analysis.cjs");
const { MediaGrants } = require("./media.cjs");
const { parseCameraAnalysis, parseCameraScenes, parseCameraProcessing } = require("../shared/camera-effects.cjs");

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, mode = "success", Analyzer = CameraAnalyzer) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reva-camera-wrapper-")), file = path.join(directory, "camera.mp4"), helper = path.join(directory, "helper.cjs"), cacheRoot = path.join(directory, "cache"), marker = path.join(directory, "started");
  await fs.writeFile(file, "Synthetic lifecycle input; no Vision detection is claimed by this test.");
  const sha256 = crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex"), source = { path: await fs.realpath(file), sha256, duration: 1, width: 640, height: 360 };
  const result = { faceTrack: { version: 1, coordinateSpace: "oriented-top-left-normalized", source, sampleInterval: .2, samples: [{ t: 0, requestedTime: 0, face: { x: .1, y: .2, width: .2, height: .3, confidence: .9 } }, { t: .2, face: null }], coverage: { complete: true, intervals: [{ start: 0, end: 1 }], limitations: ["Synthetic protocol fixture, not real Vision output."] } } };
  await fs.writeFile(helper, `#!${process.execPath}
const fs=require('node:fs'); const path=require('node:path');
const args=process.argv.slice(2), output=args[args.indexOf('--output')+1], mode=${JSON.stringify(mode)}, result=${JSON.stringify(result)};
result.faceTrack.source.path=args[args.indexOf('--input')+1];
const emit=m=>process.stdout.write(JSON.stringify(m)+'\\n');
fs.writeFileSync(${JSON.stringify(marker)},'started');
let stopping=false;
const cancel=()=>{if(stopping)return;stopping=true;setTimeout(()=>{if(mode==='startup')emit({type:'ready',duration:1});fs.writeFileSync(path.join(path.dirname(output),'finalized.tmp'),'owned late cleanup');emit({type:'cancelled'});process.exit(130)},25)};
process.stdin.on('data',cancel);process.stdin.on('end',cancel);process.on('SIGTERM',cancel);
if(mode==='startup'){setInterval(()=>{},1000)}
else {emit({type:'ready',duration:1});emit({type:'progress',progress:.5});
  if(mode==='active'){setInterval(()=>{},1000)} else {
    if(mode==='wrong-source')result.faceTrack.source.path='/unselected.mp4';
    if(mode==='wrong-hash')result.faceTrack.source.sha256='0'.repeat(64);
    if(mode==='invalid-face')result.faceTrack.samples[0].face.x=2;
    if(mode==='symlink'){fs.writeFileSync(output+'.outside','unrelated');fs.symlinkSync(output+'.outside',output)}
    else fs.writeFileSync(output,JSON.stringify(result));
    emit({type:'completed',output});process.stdout.write('',()=>process.exit(0));
  }
}
`, { mode: 0o700 });
  const grants = new MediaGrants(); await grants.grant(file);
  const ready = deferred(), analyzer = new Analyzer({ helper, cacheRoot, grants, onProgress: ready.resolve });
  t.after(async () => { try { await analyzer.dispose(); } finally { await fs.rm(directory, { recursive: true, force: true }); } });
  return { analyzer, directory, file, cacheRoot, result, ready, marker };
}
async function empty(f) { assert.equal(f.analyzer.active, false); assert.deepEqual(await fs.readdir(f.cacheRoot).catch(error => { if (error.code === "ENOENT") return []; throw error; }), []); }

test("camera helper validates source provenance and retains measured no-face facts", async t => {
  const f = await fixture(t), result = await f.analyzer.analyze(f.file, { faces: true, silence: false });
  assert.deepEqual(result, f.result); assert.equal(result.faceTrack.samples[1].face, null); await empty(f);
  for (const mode of ["wrong-source", "wrong-hash", "invalid-face", "symlink"]) {
    const invalid = await fixture(t, mode);
    await assert.rejects(invalid.analyzer.analyze(invalid.file, { faces: true, silence: false })); await empty(invalid);
  }
});
test("camera cancellation drains helper finalization before removing owned output", async t => {
  const f = await fixture(t, "active"), done = f.analyzer.analyze(f.file, { faces: true, silence: false });
  await f.ready.promise; await f.analyzer.cancel(); assert.equal(await done, null); await empty(f);
});
test("camera cancellation tolerates a late startup handshake from its owned helper", async t => {
  const f = await fixture(t, "startup"), done = f.analyzer.analyze(f.file, { faces: true, silence: false });
  const deadline = Date.now() + 5000;
  while (!await fs.stat(f.marker).then(() => true, () => false)) { if (Date.now() > deadline) throw new Error("Helper did not start."); await new Promise(resolve => setTimeout(resolve, 10)); }
  await f.analyzer.cancel(); assert.equal(await done, null); await empty(f);
});
test("camera cancellation remains meaningful during final cleanup", async t => {
  const entered = deferred(), release = deferred();
  class BlockingCleanup extends CameraAnalyzer { async removeDirectory(s) { entered.resolve(); await release.promise; return super.removeDirectory(s); } }
  const f = await fixture(t, "success", BlockingCleanup), done = f.analyzer.analyze(f.file, { faces: true, silence: false });
  await entered.promise; const cancelled = f.analyzer.cancel(); release.resolve(); await cancelled;
  assert.equal(await done, null); await empty(f);
});
test("camera cleanup failures retain ownership for a successful disposal retry", async t => {
  class RetryCleanup extends CameraAnalyzer { attempts = 0; async removeDirectory(s) { if (this.attempts++ === 0) throw new Error("injected cleanup failure"); return super.removeDirectory(s); } }
  const f = await fixture(t, "success", RetryCleanup);
  await assert.rejects(f.analyzer.analyze(f.file, { faces: true, silence: false }), /injected cleanup failure/);
  assert.equal(f.analyzer.active, true); await f.analyzer.dispose(); await empty(f);
});
test("camera persistence boundary rejects unsampled coverage and malformed LUT expansion", () => {
  const base = { version: 1, coordinateSpace: "oriented-top-left-normalized", source: { path: "media/camera.mp4", sha256: "a".repeat(64), duration: 2, width: 640, height: 360 }, sampleInterval: .2, samples: [{ t: 0, face: null }], coverage: { complete: true, intervals: [{ start: 0, end: 2 }], limitations: [] } };
  assert.equal(parseCameraAnalysis({ faceTrack: base }).faceTrack.source.path, "media/camera.mp4", "portable source identity survives until the project boundary resolves it");
  assert.throws(() => parseCameraAnalysis({ faceTrack: { ...base, samples: [{ t: 2, face: null }] } }), /outside/);
  assert.throws(() => parseCameraAnalysis({ faceTrack: { ...base, samples: [{ t: 0, face: null }, { t: 0, face: null }] } }), /increasing/);
  assert.throws(() => parseCameraScenes([{ id: "bad", start: 1, end: .5, layout: { type: "screen-only" } }], 2));
  const processing = { look: "none", sharpen: 0, grain: 0, lutIntensity: 1, lut: { title: "Malformed", size: 65, domainMin: [0, 0, 0], domainMax: [1, 1, 1], data: [0, 0, 0] } };
  assert.throws(() => parseCameraProcessing(processing), /declared 3D size/);
});
