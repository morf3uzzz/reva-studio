"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { MediaGrants } = require("./media.cjs");
const { SpeechTranscriber, parseSpeechOptions, importTranscriptFile } = require("./transcription.cjs");
const options = { locale: "en-US", track: "microphone", offset: 0, contextualStrings: ["REVA"] };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const waitFor = async file => {
  const deadline = Date.now() + 5000;
  while (!(await fs.stat(file).catch(() => null))) { assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 10)); }
};
async function fixture(t, mode = "success", overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reva-speech-test-"));
  const file = path.join(directory, "audio.m4a"), helper = path.join(directory, "helper.cjs"), cacheRoot = path.join(directory, "cache"), marker = path.join(directory, "started");
  const outside = path.join(directory, "outside.json");
  await fs.writeFile(file, "Synthetic lifecycle input, not recorded speech.");
  await fs.writeFile(outside, "Unrelated file must survive");
  const hash = crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
  await fs.writeFile(helper, `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2), mode = ${JSON.stringify(mode)}, emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
if (args[0] === "speech-status") { emit({available:true,method:"apple-on-device",permission:"not-determined",locale:"en-US",locales:["en-US"],reason:null,engine:"SFSpeechRecognizer (legacy, on-device only)"}); process.exit(0); }
const dir = args[args.indexOf("--output-directory") + 1], output = path.join(dir,"transcript.json"), input = args[args.indexOf("--input")+1];
fs.writeFileSync(${JSON.stringify(marker)},"started");
let cancelling = false;
const cancel = () => { if (cancelling) return; cancelling=true; if(mode === "late-ready") emit({type:"ready",duration:2}); setTimeout(() => { fs.writeFileSync(path.join(dir,"late-finalization"),"owned"); emit({type:"cancelled"}); process.exit(130); },30); };
process.on("SIGTERM",cancel); process.stdin.on("data",cancel); process.stdin.on("end",cancel);
if (["startup","late-ready","silent"].includes(mode)) { setInterval(()=>{},1000); }
else {
 if (mode !== "before-ready") emit({type:"ready",duration:2});
 if (mode === "active") { emit({type:"progress",progress:.5}); setInterval(()=>{},1000); }
 else {
 const document = {version:1,generator:"apple-on-device",language:"en-US",source:{path:input,sha256:${JSON.stringify(hash)},duration:2,offset:0,track:"microphone"},words:[{id:"one",start:.2,end:.5,text:"One",timing:"word"},{id:"two",start:1,end:1.5,text:"two.",timing:"word"}]};
 if(mode === "bad-digest") document.source.sha256="f".repeat(64);
 if(mode === "wrong-source") document.source.path=${JSON.stringify(outside)};
 if(mode === "bad-word") document.words[1].start=-1;
 if(mode === "symlink") fs.symlinkSync(${JSON.stringify(outside)},output);
 else if(mode === "malformed") fs.writeFileSync(output,"{");
 else fs.writeFileSync(output,JSON.stringify(document));
 emit({type:"completed",output});
 if(mode === "conflicting") emit({type:"cancelled"});
 if(mode === "oversized") process.stdout.write("x".repeat(65537));
 process.stdout.write("",()=>process.exit(0));
 }
}
`, { mode: 0o700 });
  const grants = overrides.grants ?? new MediaGrants();
  if (overrides.grant !== false) await grants.grant(file);
  const progress = [], started = deferred();
  const Transcriber = overrides.Transcriber ?? SpeechTranscriber;
  const transcriber = new Transcriber({ helper, cacheRoot, grants, idleTimeout: overrides.idleTimeout,
    onProgress(value) { progress.push(value); started.resolve(); } });
  t.after(async () => { try { await transcriber.dispose(); } finally { await fs.rm(directory, { recursive: true, force: true }); } });
  return { directory, file, marker, cacheRoot, transcriber, grants, progress, started, outside };
}
async function clean(f) {
  assert.equal(f.transcriber.active, false);
  assert.deepEqual(await fs.readdir(f.cacheRoot).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error)), []);
  assert.equal(await fs.readFile(f.outside, "utf8"), "Unrelated file must survive");
}

test("speech boundary rejects cloud/invalid options and reads status without starting transcription", async t => {
  assert.throws(() => parseSpeechOptions({ ...options, track: "cloud" }), /track/);
  assert.throws(() => parseSpeechOptions({ ...options, offset: -1 }), /offset/);
  assert.throws(() => parseSpeechOptions({ ...options, contextualStrings: [""] }), /empty/);
  const f = await fixture(t);
  assert.equal((await f.transcriber.status("en-US")).permission, "not-determined");
  await assert.rejects(fs.stat(f.marker), { code: "ENOENT" });
  await clean(f);
});

test("speech wrapper preserves word timing and provenance, requires source grants and cleans after exit", async t => {
  const f = await fixture(t);
  const document = await f.transcriber.transcribe(f.file, options);
  assert.equal(document.source.path, f.file);
  assert.deepEqual(document.words.map(w => [w.start, w.end, w.text]), [[.2,.5,"One"],[1,1.5,"two."]]);
  await clean(f);
  const denied = await fixture(t, "success", { grant: false });
  await assert.rejects(denied.transcriber.transcribe(denied.file, options), /not been selected/);
  await assert.rejects(fs.stat(denied.marker), { code: "ENOENT" });
  await clean(denied);
});

test("speech wrapper rejects mismatched evidence, invalid results and protocol sequences without touching unrelated files", async t => {
  for (const mode of ["bad-digest","wrong-source","bad-word","symlink","malformed","before-ready","conflicting","oversized"]) await t.test(mode, async t => {
    const f = await fixture(t, mode);
    await assert.rejects(f.transcriber.transcribe(f.file, options));
    await clean(f);
  });
});

test("speech cancellation handles startup, late readiness and active recognition then waits for final writes", async t => {
  for (const mode of ["startup","late-ready","active"]) await t.test(mode, async t => {
    const f = await fixture(t, mode);
    const result = f.transcriber.transcribe(f.file, options);
    if (mode === "active") await f.started.promise; else await waitFor(f.marker);
    await f.transcriber.cancel();
    assert.equal(await result, null);
    await clean(f);
  });
});

test("speech cancellation before grant validation completes does not spawn", async t => {
  const entered = deferred(), release = deferred();
  class BlockingGrants extends MediaGrants { async assert(file) { entered.resolve(); await release.promise; return super.assert(file); } }
  const f = await fixture(t, "success", { grants: new BlockingGrants() });
  const result = f.transcriber.transcribe(f.file, options);
  await entered.promise;
  const cancellation = f.transcriber.cancel(); release.resolve();
  await cancellation; assert.equal(await result, null);
  await assert.rejects(fs.stat(f.marker), { code: "ENOENT" }); await clean(f);
});

test("speech cancellation remains effective during final cleanup and failed cleanup stays retryable", async t => {
  const entered = deferred(), release = deferred();
  class BlockingCleanup extends SpeechTranscriber {
    async cleanup(s) { if (s.directory && !this.blocked) { this.blocked = true; entered.resolve(); await release.promise; } return super.cleanup(s); }
  }
  const f = await fixture(t, "success", { Transcriber: BlockingCleanup });
  const result = f.transcriber.transcribe(f.file, options);
  await entered.promise;
  const cancellation = f.transcriber.cancel(); release.resolve();
  await cancellation; assert.equal(await result, null); await clean(f);
  class FailedCleanup extends SpeechTranscriber {
    async cleanup(s) { if (s.directory && !this.failed) { this.failed = true; throw new Error("Synthetic cleanup failure"); } return super.cleanup(s); }
  }
  const retry = await fixture(t, "success", { Transcriber: FailedCleanup });
  await assert.rejects(retry.transcriber.transcribe(retry.file, options), /cleanup failure/);
  assert.equal(retry.transcriber.active, true);
  await retry.transcriber.dispose(); await clean(retry);
});

test("a silent speech helper times out and still completes exit-before-cleanup", async t => {
  const f = await fixture(t, "silent", { idleTimeout: 80 });
  await assert.rejects(f.transcriber.transcribe(f.file, options), /stopped responding/); await clean(f);
});

test("manual transcript import uses selected regular local files and validates project timing", async t => {
  const f = await fixture(t);
  const srt = path.join(f.directory, "captions.srt");
  await fs.writeFile(srt, "1\n00:00:00,125 --> 00:00:01,750\nHello world\n");
  await assert.rejects(importTranscriptFile(srt, 2, f.grants), /not been selected/);
  await f.grants.grant(srt);
  const document = await importTranscriptFile(srt, 2, f.grants);
  assert.equal(document.words[0].timing, "segment");
  assert.equal(document.words[0].text, "Hello world");
  await assert.rejects(importTranscriptFile(srt, 1, f.grants), /end/);
});
