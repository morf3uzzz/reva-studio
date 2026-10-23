"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { ScreenUpscaler } = require("./upscale.cjs");
const { MediaGrants } = require("./media.cjs");
const { parseScreenEnhancement } = require("../shared/camera-effects.cjs");

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, mode = "success", Upscaler = ScreenUpscaler) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reva-upscale-wrapper-")), file = path.join(directory, "source.mp4"), helper = path.join(directory, "helper.cjs"), modelPath = path.join(directory, "PiperSR_2x.mlmodel"), cacheRoot = path.join(directory, "cache");
  await fs.writeFile(file, "Synthetic protocol input; this test does not claim neural inference."); await fs.writeFile(modelPath, "Synthetic protocol model.");
  const sha256 = crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
  const manifest = { version: 1, source: { path: file, sha256, width: 160, height: 120, duration: 1 }, model: { path: modelPath, sha256: "b".repeat(64), name: "PiperSR_2x", inputName: "input_image", outputName: "output_image", inputWidth: 128, inputHeight: 128, outputWidth: 256, outputHeight: 256, scale: 2, overlap: 16 }, video: { file: "enhanced.mp4", codec: "h264", width: 320, height: 240 }, timing: { firstPTS: .25, lastPTS: .75, endTime: 1, duration: 1, frames: 3, preservesVariableFrameRate: true } };
  await fs.writeFile(helper, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),output=args[args.indexOf('--output-directory')+1],mode=${JSON.stringify(mode)},manifest=${JSON.stringify(manifest)};
manifest.source.path=args[args.indexOf('--input')+1];
const emit=m=>process.stdout.write(JSON.stringify(m)+'\\n');
fs.mkdirSync(output);const video=path.join(output,'enhanced.mp4');
let stopping=false;const cancel=()=>{if(stopping)return;stopping=true;setTimeout(()=>{fs.writeFileSync(path.join(output,'late-cleanup'),'owned');emit({type:'cancelled'});process.exit(130)},25)};
process.stdin.on('data',cancel);process.stdin.on('end',cancel);process.on('SIGTERM',cancel);
emit({type:'ready',duration:1,width:320,height:240,scale:2,model:'PiperSR_2x'});emit({type:'progress',progress:.5});
if(mode==='active'){setInterval(()=>{},1000)}else{
  if(mode==='wrong-hash')manifest.source.sha256='0'.repeat(64);
  if(mode==='bad-timing')manifest.timing.lastPTS=1;
  if(mode==='bad-model')manifest.model.outputWidth=384;
  if(mode==='wrong-dimensions')manifest.video.height=256;
  const bytes=Buffer.from([0,0,0,16,102,116,121,112,113,116,32,32,0,0,0,0]);
  if(mode==='symlink'){fs.writeFileSync(video+'.outside',bytes);fs.symlinkSync(video+'.outside',video)}else fs.writeFileSync(video,bytes);
  fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(manifest));emit({type:'completed',output});process.stdout.write('',()=>process.exit(0));
}`, { mode: 0o700 });
  const grants = new MediaGrants(); await grants.grant(file);
  const ready = deferred(), upscaler = new Upscaler({ helper, cacheRoot, grants, modelPath, onProgress: ready.resolve });
  t.after(async () => { try { await upscaler.dispose(); } finally { await fs.rm(directory, { recursive: true, force: true }); } });
  return { directory, file, cacheRoot, grants, ready, upscaler };
}
async function empty(f) { assert.equal(f.upscaler.active, false); assert.deepEqual(await fs.readdir(f.cacheRoot).catch(error => { if (error.code === "ENOENT") return []; throw error; }), []); }

test("upscale publishes an immutable derived asset and transfers successful output ownership", async t => {
  const f = await fixture(t), asset = await f.upscaler.upscale(f.file);
  assert.equal(asset.sourcePath, await fs.realpath(f.file)); assert.equal(asset.sourceStartTime, .25); assert.equal(asset.scale, 2); assert.match(asset.attribution, /CC BY 4.0/);
  assert.equal(await f.grants.assert(asset.path), asset.path); assert.equal(f.upscaler.active, false);
  await f.upscaler.dispose(); assert.equal((await fs.stat(asset.path)).isFile(), true, "successful project media survives processor disposal");
});
test("upscale rejects inconsistent source, model, dimensions, timing, and symlink assets", async t => {
  for (const mode of ["wrong-hash", "bad-timing", "bad-model", "wrong-dimensions", "symlink"]) {
    const f = await fixture(t, mode); await assert.rejects(f.upscaler.upscale(f.file)); await empty(f);
  }
});
test("upscale cancellation drains owned native work before removing its output", async t => {
  const f = await fixture(t, "active"), done = f.upscaler.upscale(f.file);
  await f.ready.promise; await f.upscaler.cancel(); assert.equal(await done, null); await empty(f);
});
test("upscale cancellation during final source validation prevents media handoff", async t => {
  const entered = deferred(), release = deferred();
  class BlockingVerification extends ScreenUpscaler { async verifySource(...args) { entered.resolve(); await release.promise; return super.verifySource(...args); } }
  const f = await fixture(t, "success", BlockingVerification), done = f.upscaler.upscale(f.file);
  await entered.promise; const cancelled = f.upscaler.cancel(); release.resolve(); await cancelled;
  assert.equal(await done, null); await empty(f);
});
test("upscale cancellation while granting final media still removes unpublished output", async t => {
  const entered = deferred(), release = deferred(), f = await fixture(t), grant = f.grants.grant.bind(f.grants);
  f.grants.grant = async file => { entered.resolve(); await release.promise; return grant(file); };
  const done = f.upscaler.upscale(f.file); await entered.promise;
  const cancelled = f.upscaler.cancel(); release.resolve(); await cancelled; assert.equal(await done, null); await empty(f);
});
test("upscale cleanup failure retains exact ownership for disposal retry", async t => {
  class RetryCleanup extends ScreenUpscaler { attempts = 0; async removeDirectory(s) { if (this.attempts++ === 0) throw new Error("injected cleanup failure"); return super.removeDirectory(s); } }
  const f = await fixture(t, "wrong-hash", RetryCleanup);
  await assert.rejects(f.upscaler.upscale(f.file), /Cleanup/); assert.equal(f.upscaler.active, true);
  await f.upscaler.dispose(); await empty(f);
});
test("enhancement persistence preserves portable identity and rejects malformed capacity or coverage", () => {
  const asset = { path: "media/enhanced.mov", sourcePath: "media/screen.mp4", sourceSHA256: "a".repeat(64), modelSHA256: "b".repeat(64), modelName: "Local model", width: 3840, height: 2160, duration: 1, sourceStartTime: .25, scale: 2, enabled: true };
  assert.deepEqual(parseScreenEnhancement(asset), asset);
  for (const change of [{ width: 3840, height: 3840 }, { sourceStartTime: 1 }, { scale: 1 }, { modelSHA256: "unknown" }, { path: asset.sourcePath }]) assert.throws(() => parseScreenEnhancement({ ...asset, ...change }));
});
