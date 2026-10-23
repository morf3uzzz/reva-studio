"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { constants } = require("node:fs");
const { spawn } = require("node:child_process");
const { RecordingRecovery, readCommittedPrefix, OWNER_FILE, MAX_PREFIX_BYTES } = require("./recovery.cjs");
const { MediaGrants, findTool, runProcess } = require("./media.cjs");

const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reva-recovery-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return fs.realpath(root);
}
async function tools(t) {
  try { return { ffmpeg: await findTool("ffmpeg"), ffprobe: await findTool("ffprobe") }; }
  catch { t.skip("Existing local FFmpeg and ffprobe are required; nothing is installed by this test."); return null; }
}
async function waitFor(check, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error("The fixture did not reach its expected production boundary.");
}
async function owned(root, { status = "recording", withOwner = true, directoryName = "Recording-", media } = {}) {
  const directory = await fs.mkdtemp(path.join(root, directoryName)), stat = await fs.lstat(directory), createdAt = new Date().toISOString();
  const output = path.join(directory, "screen.mp4"), cursorOutput = path.join(directory, "screen.cursor.json"), activityOutput = path.join(directory, "screen.activity.json"), journalPath = path.join(directory, "screen.recovery.json");
  const cursor = [{ t: 0, x: .1, y: .2, click: false }, { t: .5, x: .3, y: .4, click: true, event: "mouseDown", button: "left" }, { t: 4.5, x: .9, y: .8, click: false }];
  const activity = [{ type: "typing", time: .2, count: 2 }, { type: "typing", time: .4, count: 3 }, { type: "pause", time: .5, duration: 7 }, { type: "flag", id: "late-flag", time: 4.5 }];
  const cursorPrefix = Buffer.from(JSON.stringify(cursor).slice(0, -1)), activityPrefix = Buffer.from(JSON.stringify(activity).slice(0, -1));
  const owner = { type: "reva-recording-owner", version: 1, id: crypto.randomUUID(), directory: { dev: String(stat.dev), ino: String(stat.ino) }, source: "display:7", output, cursorOutput, activityOutput, createdAt };
  const journal = { type: "reva-recording-recovery", schemaVersion: 1, id: crypto.randomUUID(), createdAt, updatedAt: createdAt, status, source: owner.source, output, cursorOutput, activityOutput, fps: 12, width: 96, height: 64, duration: 5, cursorPrefixBytes: cursorPrefix.length, activityPrefixBytes: activityPrefix.length };
  if (media) await fs.copyFile(media, output); else await fs.writeFile(output, "synthetic-unprobed-media");
  // Simulate a crash after a committed prefix and during a later append.
  await fs.writeFile(cursorOutput, Buffer.concat([cursorPrefix, Buffer.from(',{"t":garbage-uncommitted-tail')]));
  await fs.writeFile(activityOutput, Buffer.concat([activityPrefix, Buffer.from(',{"type":"uncommitted')]));
  if (withOwner) await fs.writeFile(path.join(directory, OWNER_FILE), JSON.stringify(owner));
  await fs.writeFile(journalPath, JSON.stringify(journal));
  return { directory, owner, journal, journalPath, output, cursorOutput, activityOutput, cursor, activity };
}
async function killedFragment(t, root, local) {
  const file = path.join(root, "interrupted.mp4"), child = spawn(local.ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=12", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "60", "-c:v", "libx264", "-preset", "ultrafast", "-g", "12", "-bf", "0", "-c:a", "aac", "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "500000", "-flush_packets", "1", file], { stdio: ["ignore", "ignore", "pipe"] });
  let errors = ""; child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-4000); });
  const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await done; } });
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`The real FFmpeg producer exited before interruption: ${errors}`);
    try { const info = JSON.parse(await runProcess(local.ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "json", file])); return Number(info.format?.duration) >= 1.5; } catch { return false; }
  }, 15000);
  child.kill("SIGKILL"); const exit = await done; assert.equal(exit.signal, "SIGKILL"); return file;
}
async function failedTool(t, root) {
  const script = path.join(root, "controlled-tool.cjs"), ready = path.join(root, "tool-ready.json");
  await fs.writeFile(script, `const fs=require('node:fs'); const output=process.argv.at(-1); fs.writeFileSync(output,'partial',{flag:'wx'}); fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,output})); process.on('SIGTERM',()=>setTimeout(()=>process.exit(130),30)); if(process.argv.includes('--wait'))setInterval(()=>{},1000); else process.exit(2);`);
  return { ready, spawnProcess: (command, args, options) => command === "controlled-ffmpeg" ? spawn(process.execPath, [script, ...(t ? ["--wait"] : []), ...args], options) : spawn(command, args, options) };
}

test("committed byte prefixes ignore all later bytes and reject short, oversized or symbolic input", async t => {
  const root = await temporary(t), file = path.join(root, "prefix.json"), prefix = Buffer.from('[{"label":"é","time":0}');
  await fs.writeFile(file, Buffer.concat([prefix, Buffer.from('],{"never":"parse"}')]));
  assert.deepEqual(await readCommittedPrefix(file, prefix.length), [{ label: "é", time: 0 }]);
  await assert.rejects(readCommittedPrefix(file, (await fs.stat(file)).size + 1), /exceeds/);
  await assert.rejects(readCommittedPrefix(file, MAX_PREFIX_BYTES + 1), /invalid/);
  const link = path.join(root, "link.json"); await fs.symlink(file, link); await assert.rejects(readCommittedPrefix(link, prefix.length));
  await fs.writeFile(file, '[{"time":'); await assert.rejects(readCommittedPrefix(file, 9));
});

test("listing requires directory identity and exact owned paths, reports unknown journals, and ignores complete/current captures", async t => {
  const root = await temporary(t), good = await owned(root), unmarked = await owned(root, { withOwner: false }), complete = await owned(root, { status: "complete", withOwner: false }), active = await owned(root, { withOwner: false }), wrong = await owned(root);
  wrong.owner.directory.ino = "0"; await fs.writeFile(path.join(wrong.directory, OWNER_FILE), JSON.stringify(wrong.owner));
  const outside = await owned(root); outside.journal.output = good.output; await fs.writeFile(outside.journalPath, JSON.stringify(outside.journal));
  const recovery = new RecordingRecovery({ root, grants: new MediaGrants(), currentDirectory: () => active.directory });
  const result = await recovery.list();
  assert.deepEqual(result.recordings.map(entry => entry.id), [good.owner.id]); assert.notEqual(good.owner.id, good.journal.id);
  assert.ok(result.issues.some(entry => entry.path.startsWith(unmarked.directory) && entry.code === "unowned-journal"));
  assert.ok(result.issues.some(entry => entry.path.startsWith(wrong.directory) && entry.code === "unowned-journal"));
  assert.ok(result.issues.some(entry => entry.path.startsWith(outside.directory) && entry.code === "unowned-journal"));
  assert.equal(result.issues.some(entry => entry.path.startsWith(complete.directory) || entry.path.startsWith(active.directory)), false);
  assert.throws(() => recovery.recover(unmarked.owner.id), /current recovery list/);
  await recovery.dispose(); assert.ok(await fs.stat(good.output));
});

test("a real SIGKILL fragment recovers screen, exact committed metadata and source copies while preserving partial auxiliary failures", async t => {
  const local = await tools(t); if (!local) return;
  const root = await temporary(t), media = await killedFragment(t, root, local), fixture = await owned(root, { media });
  fixture.journal.microphonePath = path.join(fixture.directory, "screen.microphone.m4a"); await fs.writeFile(fixture.journal.microphonePath, "broken microphone fragment");
  fixture.journal.cameraPath = path.join(fixture.directory, "screen.camera.mp4"); fixture.journal.cameraStartTime = .25; await fs.writeFile(fixture.journal.cameraPath, "broken camera fragment");
  await fs.writeFile(fixture.journalPath, JSON.stringify(fixture.journal));
  const sourceFiles = (await fs.readdir(fixture.directory)).map(name => path.join(fixture.directory, name)), before = new Map(await Promise.all(sourceFiles.map(async file => [file, digest(await fs.readFile(file))])));
  const grants = new MediaGrants(), recovery = new RecordingRecovery({ root, ...local, grants });
  const listed = await recovery.list(); assert.equal(listed.recordings[0].checkpointDuration, 5);
  const result = await recovery.recover(fixture.owner.id); assert.ok(result); assert.equal(recovery.active, false);
  assert.ok(result.path.startsWith(path.join(root, "Recovered-"))); assert.ok(result.duration > 1 && result.duration < 4);
  assert.equal(result.width, 96); assert.equal(result.height, 64); assert.deepEqual(result.cursor, fixture.cursor.slice(0, 2));
  assert.deepEqual(result.pauseMarkers, [{ time: .5, duration: 7 }]); assert.deepEqual(result.typingRanges, []); assert.equal(result.recordingFlags, undefined);
  for (const code of ["incomplete-media", "cursor-truncated", "activity-truncated", "microphone-unavailable", "camera-unavailable"]) assert.ok(result.issues.some(entry => entry.code === code), code);
  assert.equal(result.microphonePath, undefined); assert.equal(result.cameraPath, undefined); assert.equal(await grants.assert(result.path), result.path);
  const report = JSON.parse(await fs.readFile(result.recoverySource.reportPath, "utf8"));
  assert.equal(report.journal.duration, 5); assert.equal(report.recoverySource.journalId, fixture.journal.id); assert.equal(report.sourceFiles.output.sha256, before.get(fixture.output));
  assert.equal(result.recoverySource.reportSHA256, digest(await fs.readFile(result.recoverySource.reportPath))); assert.equal(await grants.assert(result.recoverySource.reportPath), result.recoverySource.reportPath);
  assert.equal((await recovery.list()).recordings[0].recoveredPath, result.path);
  for (const [file, expected] of before) { assert.equal(digest(await fs.readFile(file)), expected); assert.equal(digest(await fs.readFile(path.join(result.recoverySource.rawDirectory, path.basename(file)))), expected); }
  const decoded = await runProcess(local.ffmpeg, ["-nostdin", "-v", "error", "-i", result.path, "-f", "null", "-"]); assert.equal(decoded, "");
  await recovery.dispose(); assert.ok(await fs.stat(result.path));
});

test("durable receipts match exact journal bytes and reject changed reports, replaced outputs and copied directory identities", async t => {
  const local = await tools(t); if (!local) return;
  const root = await temporary(t), media = path.join(root, "source.mp4"); await runProcess(local.ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=blue:size=96x64:rate=12", "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", media]);
  const fixture = await owned(root, { media }), grants = new MediaGrants(), recovery = new RecordingRecovery({ root, ...local, grants }); await recovery.list(); const result = await recovery.recover(fixture.owner.id);
  const restarted = new RecordingRecovery({ root, ...local, grants: new MediaGrants() }); assert.equal((await restarted.list()).recordings[0].recoveredPath, result.path);
  const originalJournal = await fs.readFile(fixture.journalPath); await fs.appendFile(fixture.journalPath, "\n"); assert.equal((await restarted.list()).recordings[0].recoveredPath, undefined);
  await fs.writeFile(fixture.journalPath, originalJournal); assert.equal((await restarted.list()).recordings[0].recoveredPath, result.path);
  const copied = await fs.mkdtemp(path.join(root, "Recovered-copied-")); await fs.cp(path.dirname(result.path), copied, { recursive: true });
  assert.ok((await restarted.list()).issues.some(entry => entry.path === copied && entry.code === "recovery-receipt-unavailable"));
  await fs.appendFile(result.recoverySource.reportPath, "\n"); let list = await restarted.list(); assert.equal(list.recordings[0].recoveredPath, undefined); assert.ok(list.issues.some(entry => entry.path === path.dirname(result.path)));
  const repeated = await restarted.recover(fixture.owner.id); assert.equal((await restarted.list()).recordings[0].recoveredPath, repeated.path);
  const preserved = repeated.path + ".preserved"; await fs.rename(repeated.path, preserved); await fs.copyFile(preserved, repeated.path);
  list = await restarted.list(); assert.equal(list.recordings[0].recoveredPath, undefined); assert.ok(await fs.stat(preserved)); assert.ok(await fs.stat(repeated.path));
});

test("invalid committed metadata remains available in raw copies and does not discard usable screen", async t => {
  const local = await tools(t); if (!local) return;
  const root = await temporary(t), media = path.join(root, "source.mp4");
  await runProcess(local.ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=blue:size=96x64:rate=12", "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", media]);
  const fixture = await owned(root, { media }); fixture.journal.cursorPrefixBytes = 200000; fixture.journal.activityPrefixBytes = MAX_PREFIX_BYTES + 1; await fs.writeFile(fixture.journalPath, JSON.stringify(fixture.journal));
  const recovery = new RecordingRecovery({ root, ...local, grants: new MediaGrants() }); await recovery.list(); const result = await recovery.recover(fixture.owner.id);
  assert.deepEqual(result.cursor, []); assert.deepEqual(result.pauseMarkers, []); assert.ok(result.issues.some(entry => entry.code === "cursor-unavailable")); assert.ok(result.issues.some(entry => entry.code === "activity-unavailable"));
  assert.deepEqual(await fs.readFile(path.join(result.recoverySource.rawDirectory, path.basename(fixture.cursorOutput))), await fs.readFile(fixture.cursorOutput));
});

test("screen-only recovery retains a leading empty edit in the project's source duration", async t => {
  const local = await tools(t); if (!local) return;
  const root = await temporary(t), media = path.join(root, "delayed-screen.mp4");
  await runProcess(local.ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=blue:size=96x64:rate=12:duration=1", "-vf", "setpts=PTS+0.25/TB", "-fps_mode", "passthrough", "-c:v", "libx264", "-preset", "ultrafast", "-use_editlist", "1", "-movie_timescale", "600000", media]);
  const fixture = await owned(root, { media }), recovery = new RecordingRecovery({ root, ...local, grants: new MediaGrants() }); await recovery.list(); const result = await recovery.recover(fixture.owner.id);
  assert.ok(Math.abs(result.duration - 1.25) < 1e-6);
  const report = JSON.parse(await fs.readFile(result.recoverySource.reportPath)); assert.equal(report.probes.screen.streams[0].start, .25); assert.equal(report.probes.screen.formatDuration, 1); assert.equal(report.probes.screen.duration, 1.25);
});

test("real native camera recovery returns its complete presentation end including the leading empty edit", async t => {
  const local = await tools(t); if (!local) return;
  const helper = path.resolve(__dirname, "../native/build/reva-capture");
  try { if (process.platform !== "darwin") throw new Error("not macOS"); await fs.access(helper, constants.X_OK); }
  catch { t.skip("The compiled macOS camera recovery helper is required; no build or installation occurs in this test."); return; }
  const root = await temporary(t), screen = path.join(root, "screen-source.mp4");
  await runProcess(local.ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=blue:size=96x64:rate=12:duration=2", "-c:v", "libx264", "-preset", "ultrafast", screen]);
  const fixture = await owned(root, { media: screen }); fixture.journal.cameraPath = path.join(fixture.directory, "screen.camera.mp4"); fixture.journal.cameraStartTime = .25;
  await runProcess(local.ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=red:size=96x64:rate=12:duration=1", "-vf", "setpts=PTS+0.25/TB", "-fps_mode", "passthrough", "-c:v", "libx264", "-preset", "ultrafast", "-use_editlist", "1", "-movie_timescale", "600000", fixture.journal.cameraPath]);
  await fs.writeFile(fixture.journalPath, JSON.stringify(fixture.journal)); const before = digest(await fs.readFile(fixture.journal.cameraPath));
  const recovery = new RecordingRecovery({ root, ...local, helper, grants: new MediaGrants() }); await recovery.list(); const result = await recovery.recover(fixture.owner.id);
  assert.ok(result.cameraPath, JSON.stringify(result.issues)); assert.equal(result.cameraStartTime, .25); assert.ok(Math.abs(result.cameraEndTime - 1.25) < 1e-6);
  const report = JSON.parse(await fs.readFile(result.recoverySource.reportPath)); assert.equal(report.probes.camera.formatDuration, 1); assert.equal(report.probes.camera.duration, 1.25); assert.equal(digest(await fs.readFile(fixture.journal.cameraPath)), before);
});

test("selection is revalidated when recording becomes active or ownership changes", async t => {
  const root = await temporary(t), fixture = await owned(root); let active = null;
  const recovery = new RecordingRecovery({ root, grants: new MediaGrants(), currentDirectory: () => active }); await recovery.list(); active = fixture.directory;
  await assert.rejects(recovery.recover(fixture.owner.id), /still active/); assert.equal(recovery.active, false);
  active = null; await recovery.list(); fixture.owner.id = crypto.randomUUID(); await fs.writeFile(path.join(fixture.directory, OWNER_FILE), JSON.stringify(fixture.owner));
  await assert.rejects(recovery.recover([...recovery.candidates.keys()][0]), /changed after selection/);
  assert.equal((await fs.readdir(root)).some(name => name.startsWith("Recovered-")), false);
});

test("cancellation waits for tool exit before removing only new owned files", async t => {
  const local = await tools(t); if (!local) return;
  const root = await temporary(t), media = path.join(root, "source.mp4"); await runProcess(local.ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=blue:size=96x64:rate=12", "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", media]);
  const fixture = await owned(root, { media }), control = await failedTool(true, root), before = await fs.readFile(fixture.output);
  const recovery = new RecordingRecovery({ root, ...local, ffmpeg: "controlled-ffmpeg", grants: new MediaGrants(), spawnProcess: control.spawnProcess }); await recovery.list(); const pending = recovery.recover(fixture.owner.id);
  const { pid } = await waitFor(async () => fs.readFile(control.ready, "utf8").then(JSON.parse).catch(() => null));
  await recovery.cancel(); assert.equal(await pending, null); assert.equal(recovery.active, false);
  assert.throws(() => process.kill(pid, 0), /ESRCH/); assert.equal((await fs.readdir(root)).some(name => name.startsWith("Recovered-")), false); assert.deepEqual(await fs.readFile(fixture.output), before);
});

test("failed final cleanup retains ownership and retries without deleting unrelated files", async t => {
  const local = await tools(t); if (!local) return;
  const root = await temporary(t), media = path.join(root, "source.mp4"); await runProcess(local.ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=blue:size=96x64:rate=12", "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", media]);
  const fixture = await owned(root, { media }), control = await failedTool(false, root); let deny = true;
  const recovery = new RecordingRecovery({ root, ...local, ffmpeg: "controlled-ffmpeg", grants: new MediaGrants(), spawnProcess: control.spawnProcess, unlink: async file => { if (deny) throw Object.assign(new Error("controlled permission failure"), { code: "EACCES" }); await fs.unlink(file); } });
  await recovery.list(); await assert.rejects(recovery.recover(fixture.owner.id), /cleanup needs retry/); assert.equal(recovery.active, true);
  const ownedOutput = recovery.session.directory, foreign = path.join(ownedOutput, "unrelated.txt"); await fs.writeFile(foreign, "preserve this file"); deny = false;
  await assert.rejects(recovery.cancel(), /cleanup is incomplete/); assert.equal(await fs.readFile(foreign, "utf8"), "preserve this file"); assert.equal(recovery.active, true);
  await fs.unlink(foreign); await recovery.dispose(); assert.equal(recovery.active, false); assert.ok(await fs.stat(fixture.output)); assert.equal((await fs.readdir(root)).some(name => name.startsWith("Recovered-")), false);
});

test("cancellation arriving during final cleanup prevents a completed result", async t => {
  const local = await tools(t); if (!local) return;
  const root = await temporary(t), media = path.join(root, "source.mp4"); await runProcess(local.ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=blue:size=96x64:rate=12", "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", media]);
  const fixture = await owned(root, { media }), control = await failedTool(false, root); let release, entered;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; }); let first = true;
  const recovery = new RecordingRecovery({ root, ...local, ffmpeg: "controlled-ffmpeg", grants: new MediaGrants(), spawnProcess: control.spawnProcess, unlink: async file => { if (first) { first = false; entered(); await gate; } await fs.unlink(file); } });
  await recovery.list(); const pending = recovery.recover(fixture.owner.id); await started; const cancelling = recovery.cancel(); release(); await cancelling; assert.equal(await pending, null); assert.equal(recovery.active, false); assert.ok(await fs.stat(fixture.output));
});

test("late cancellation while handing off the report removes the finished copies before returning", async t => {
  const local = await tools(t); if (!local) return;
  const root = await temporary(t), media = path.join(root, "source.mp4"); await runProcess(local.ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=blue:size=96x64:rate=12", "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", media]);
  const fixture = await owned(root, { media }), realGrants = new MediaGrants(); let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const recovery = new RecordingRecovery({ root, ...local, grants: { grant: async file => { const result = await realGrants.grant(file); if (file.endsWith("recovery-report.json")) { entered(); await gate; } return result; } } });
  await recovery.list(); const pending = recovery.recover(fixture.owner.id); await started; assert.equal(recovery.active, true); const cancelling = recovery.cancel(); release(); await cancelling;
  assert.equal(await pending, null); assert.equal(recovery.active, false); assert.equal((await fs.readdir(root)).some(name => name.startsWith("Recovered-")), false); assert.ok(await fs.stat(fixture.output));
});
