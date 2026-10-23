"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const os = require("node:os");
const { Capture, parseSources, parseDevices } = require("./capture.cjs");
const { MediaGrants, runProcess } = require("./media.cjs");

const ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].find(existsSync);
const ffprobe = ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe", "/usr/bin/ffprobe"].find(existsSync);
const mediaTest = { skip: !ffmpeg || !ffprobe, timeout: 15000 };
let templates;
const previewJPEG = Buffer.from([255,216,255,192,0,17,8,0,2,0,3,3,1,17,0,2,17,0,3,17,0,255,217]).toString("base64");
const source = { id: "display:1", name: "Left display", kind: "display", width: 1920, height: 1080, bounds: { x: -1920, y: -100, width: 1920, height: 1080 } };
const devices = { cameras: [{ id: "cam USB — 01", name: "External camera", default: false }, { id: "camera:built-in", name: "Built-in camera", default: true }], microphones: [{ id: "mic:Built-in", name: "Built-in microphone", default: true }] };
const options = () => ({ source: { ...source, width: 1, bounds: { x: 0, y: 0, width: 1, height: 1 } }, fps: 30, systemAudio: false, camera: true, microphone: true,
  cameraDeviceID: devices.cameras[0].id, microphoneDeviceID: devices.microphones[0].id, cameraMaxResolution: 2160 });

test.before(async () => {
  if (mediaTest.skip) return;
  templates = await fs.mkdtemp(path.join(os.tmpdir(), "reva-capture-media-"));
  for (const [name, size, duration] of [["screen", "64x36", 0.5], ["camera", "32x24", 0.5], ["activity", "64x36", 2]]) {
    await runProcess(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", `testsrc2=s=${size}:r=10:d=${duration}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(templates, `${name}.mp4`)]);
  }
});
test.after(async () => { if (templates) await fs.rm(templates, { recursive: true, force: true }); });

async function fixture(t, mode = "normal") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reva-capture-wrapper-"));
  const helper = path.join(directory, "helper.cjs"), log = path.join(directory, "calls.jsonl"), devicesFile = path.join(directory, "devices.json"), marker = path.join(directory, "devices-started");
  await fs.writeFile(devicesFile, JSON.stringify(devices));
  await fs.writeFile(helper, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
if (args[0] === 'list') { console.log(JSON.stringify([${JSON.stringify(source)}])); process.exit(0); }
if (args[0] === 'list-devices') {
  fs.writeFileSync(${JSON.stringify(marker)}, 'started');
  const result = () => { process.stdout.write(fs.readFileSync(${JSON.stringify(devicesFile)})); process.stdout.write('',()=>process.exit(0)); };
  if (${JSON.stringify(mode)} === 'slow-devices') setTimeout(result,250); else result();
} else if (args[0] === 'permissions') { console.log(JSON.stringify({screen:'not-granted',microphone:'unknown',camera:'granted',keyboard:'not-granted'})); process.exit(0);
} else if (${JSON.stringify(mode)} === 'screen-permission') {
  console.log(JSON.stringify({type:'error',code:'screen_permission_denied',message:'Native screen permission diagnostic'})); process.exitCode=1;
} else {
  const value = flag => args[args.indexOf(flag)+1];
  const output = value('--output'), cursorOutput = value('--cursor-output');
  const selectedCamera=value('--camera')==='true'?(args.includes('--camera-device-id')?value('--camera-device-id'):${JSON.stringify(devices.cameras[1].id)}):undefined;
  const selectedMic=value('--microphone')==='true'?(args.includes('--microphone-device-id')?value('--microphone-device-id'):${JSON.stringify(devices.microphones[0].id)}):undefined;
  const frame={type:'camera-frame',deviceID:selectedCamera,width:3,height:2,jpegBase64:${JSON.stringify(previewJPEG)}};
  console.log(JSON.stringify({type:'ready',output,cursorOutput,cameraDeviceID:selectedCamera,microphoneDeviceID:selectedMic}));
  console.log(JSON.stringify({type:'state',status:'recording',elapsedMs:0}));
  if(${JSON.stringify(mode)}==='live-inputs') { console.log(JSON.stringify({type:'levels',deviceID:selectedMic,rms:.25,peak:.5}));console.log(JSON.stringify(frame)); }
  require('node:readline').createInterface({input:process.stdin}).on('line',command=>{
    if(command.startsWith('preview-camera ')){fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(['stdin',command])+'\\n');if(${JSON.stringify(mode)}==='live-inputs')console.log(JSON.stringify(frame));return;}
    if(command==='pause'||command==='resume'){fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(['stdin',command])+'\\n');setTimeout(()=>console.log(JSON.stringify({type:'state',status:command==='pause'?'paused':'recording',elapsedMs:100})),10);return;}
    if(command!=='stop')return;
    const finish=()=>{
    fs.copyFileSync(${JSON.stringify(path.join(templates, "screen.mp4"))},output); fs.writeFileSync(cursorOutput,${JSON.stringify(mode)}==='live-inputs'?JSON.stringify([{t:.1,x:.5,y:.5,click:true,visible:true,event:'mouseDown',button:'right'},{t:.2,x:.5,y:.5,click:false,visible:true,event:'mouseUp',button:'right'}]):'[]');
    let cameraPath;
    if(value('--camera')==='true') {cameraPath=path.join(path.dirname(output),'screen.camera.mp4');fs.copyFileSync(${JSON.stringify(path.join(templates, "camera.mp4"))},cameraPath);}
    console.log(JSON.stringify({type:'stopped',output,cursorOutput,duration:0.5,cameraPath,...(${JSON.stringify(mode)}==='live-inputs'?{cursorSourceSize:{width:400.5,height:300.25}}:{})})); process.stdout.write('',()=>process.exit(0));
    }; if(${JSON.stringify(mode)}==='slow-stop')setTimeout(finish,120);else finish();
  });
}
`, { mode: 0o700 });
  const capture = new Capture({ helper, recordingRoot: path.join(directory, "recordings"), ffprobe, grants: new MediaGrants(), excludeProcessID: 12345 });
  t.after(async () => { try { await capture.dispose(); } finally { await fs.rm(directory, { recursive: true, force: true }); } });
  const calls = async () => (await fs.readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { capture, calls, directory, devicesFile, marker };
}

test("capture source metadata preserves negative global positions, fractional bounds and window stacking", () => {
  const window = { id: "window:22", name: "Window", kind: "window", width: 800, height: 600, bounds: { x: -500.5, y: 42.25, width: 800.5, height: 600.25 }, ownerPID: 42, zIndex: 0 };
  assert.deepEqual(parseSources([source, window]), [source, window]);
  for (const mutation of [
    s => { s.id = "display:0"; }, s => { s.id = "display:4294967296"; },
    s => { s.bounds.x = Infinity; }, s => { s.bounds.width = 3840; },
    s => { s.bounds.height = 0; }, s => { s.ownerPID = 0; }, s => { s.zIndex = -1; },
  ]) { const invalid = structuredClone(source); mutation(invalid); assert.throws(() => parseSources([invalid])); }
  assert.throws(() => parseSources([source, source]), /identity/);
});

test("capture device metadata keeps opaque IDs and rejects ambiguous identities/defaults", () => {
  assert.deepEqual(parseDevices(devices), devices);
  assert.deepEqual(parseDevices({ cameras: [], microphones: [] }), { cameras: [], microphones: [] });
  const invalid = [
    { ...devices, cameras: [devices.cameras[0], devices.cameras[0]] },
    { ...devices, cameras: [{ ...devices.cameras[0], id: "" }] },
    { ...devices, cameras: [{ ...devices.cameras[0], id: "😀".repeat(1025) }] },
    { ...devices, cameras: [{ ...devices.cameras[0], id: "invalid\0ID" }] },
    { ...devices, cameras: devices.cameras.map(d => ({ ...d, default: true })) },
    { ...devices, microphones: [{ ...devices.microphones[0], default: "true" }] },
  ];
  for (const value of invalid) assert.throws(() => parseDevices(value));
});

test("native screen permission results and startup failure codes survive the real child boundary", mediaTest, async t => {
  const f = await fixture(t, "screen-permission");
  assert.deepEqual(await f.capture.permissions(), { screen: "not-granted", microphone: "unknown", camera: "granted", keyboard: "not-granted" });
  await assert.rejects(f.capture.start({ ...options(), camera: false, microphone: false }), error => error.code === "screen_permission_denied" && error.message === "Native screen permission diagnostic");
  await f.capture.dispose().catch(() => {});
});

test("capture forwards fresh source/device identity, explicit process exclusion and local area without shell interpretation", mediaTest, async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.capture.sources(), [source]);
  assert.deepEqual(await f.capture.devices(), devices);
  await f.capture.start({ ...options(), area: { x: 12, y: 18, width: 400, height: 300 } });
  const result = await f.capture.stop();
  const calls = await f.calls(), record = calls.find(args => args[0] === "record");
  const value = flag => record[record.indexOf(flag) + 1];
  assert.equal(value("--camera-device-id"), devices.cameras[0].id);
  assert.equal(value("--microphone-device-id"), devices.microphones[0].id);
  assert.equal(value("--camera-max-resolution"), "2160");
  assert.equal(value("--exclude-process-id"), "12345");
  assert.equal(value("--area"), "12,18,400,300", "area is source-local; global negative display origin is not added");
  for (const args of calls.filter(a => a[0] === "list")) assert.deepEqual(args, ["list", "--exclude-process-id", "12345"]);
  assert.deepEqual(result.cameraSource, { width: 32, height: 24 });
  assert.equal(result.width, 64); assert.equal(result.height, 36);
  assert.equal(await f.capture.grants.assert(result.cameraPath), await fs.realpath(result.cameraPath));
});

test("capture uses system defaults only when requested and ignores disconnected devices that are disabled", mediaTest, async t => {
  const f = await fixture(t);
  await f.capture.start({ ...options(), cameraDeviceID: null, microphoneDeviceID: null, cameraMaxResolution: undefined });
  await f.capture.stop();
  let calls = await f.calls(), record = calls.find(a => a[0] === "record");
  assert.equal(record[record.indexOf("--camera-max-resolution") + 1], "1080");
  assert.equal(record.includes("--camera-device-id"), false);
  assert.equal(record.includes("--microphone-device-id"), false);
  assert.equal(calls.some(a => a[0] === "list-devices"), false);
  await fs.writeFile(f.devicesFile, JSON.stringify({ cameras: [], microphones: [] }));
  await f.capture.start({ ...options(), camera: false, microphone: false });
  await f.capture.stop();
  calls = await f.calls(); record = calls.filter(a => a[0] === "record").at(-1);
  assert.equal(record.includes("--camera-device-id"), false);
  assert.equal(record.includes("--microphone-device-id"), false);
  assert.equal(record.includes("--camera-max-resolution"), false);
  assert.equal(calls.some(a => a[0] === "list-devices"), false);
});

test("capture fails before recording when an explicitly selected device disappeared", mediaTest, async t => {
  for (const device of ["camera", "microphone"]) await t.test(device, async t => {
    const f = await fixture(t);
    await fs.writeFile(f.devicesFile, JSON.stringify({ ...devices, [device === "camera" ? "cameras" : "microphones"]: [] }));
    await assert.rejects(f.capture.start(options()), /selected.*no longer available/);
    assert.equal((await f.calls()).some(a => a[0] === "record"), false);
    assert.equal(f.capture.active, false);
    await assert.rejects(fs.stat(f.capture.recordingRoot), { code: "ENOENT" });
  });
});

test("capture validates device IDs and maximum resolution before creating a recording", mediaTest, async t => {
  const f = await fixture(t);
  for (const patch of [{ cameraDeviceID: "" }, { cameraDeviceID: "😀".repeat(1025) }, { microphoneDeviceID: "invalid\0ID" }, { microphoneDeviceID: 42 }, { cameraMaxResolution: 1440 }, { cameraMaxResolution: null }]) {
    await assert.rejects(f.capture.start({ ...options(), ...patch }), /device ID|resolution/);
  }
  assert.equal((await f.calls()).some(a => a[0] === "record"), false);
  assert.throws(() => new Capture({ excludeProcessID: -1 }), /Excluded process ID/);
});

test("capture disposal waits for pending device discovery and prevents late startup", mediaTest, async t => {
  const f = await fixture(t, "slow-devices"), starting = f.capture.start(options());
  const rejection = assert.rejects(starting, /startup was cancelled/);
  const deadline = Date.now() + 5000;
  while (!(await fs.stat(f.marker).catch(() => null))) { assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 5)); }
  let finished = false;
  const disposal = f.capture.dispose().then(() => { finished = true; });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(finished, false); assert.equal(f.capture.active, true);
  await disposal; await rejection;
  assert.equal(f.capture.active, false);
  assert.equal((await f.calls()).some(a => a[0] === "record"), false);
});

test("recording routes real-input events from the same helper, toggles camera preview and preserves logical cursor dimensions", mediaTest, async t => {
  const f = await fixture(t, "live-inputs"), levels = [], frames = [];
  f.capture.onInputLevels = value => levels.push(value); f.capture.onCameraFrame = value => frames.push(value);
  await f.capture.start({ ...options(), previewCamera: true, monitorMicrophone: true });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(levels, [{ deviceID: devices.microphones[0].id, rms: .25, peak: .5 }]);
  assert.equal(frames.length, 1); assert.equal(frames[0].deviceID, devices.cameras[0].id);
  await f.capture.setCameraPreview(false); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(frames.length, 1, "Late camera frame after disabling must not reach UI");
  await f.capture.setCameraPreview(true); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(frames.length, 2);
  const result = await f.capture.stop();
  assert.deepEqual(result.cursorSourceSize, { width: 400.5, height: 300.25 });
  assert.deepEqual(result.cursor.map(p => [p.event, p.button, p.click]), [["mouseDown", "right", true], ["mouseUp", "right", false]]);
  const calls = await f.calls(), record = calls.find(a => a[0] === "record");
  assert.equal(record[record.indexOf("--preview-camera") + 1], "true");
  assert.equal(record[record.indexOf("--monitor-microphone") + 1], "true");
  assert.deepEqual(calls.filter(a => a[0] === "stdin"), [["stdin", "preview-camera false"], ["stdin", "preview-camera true"]]);
  await assert.rejects(f.capture.setCameraPreview(true), /must be active/);
});

test("live record flags reject requests without their corresponding input", mediaTest, async t => {
  const f = await fixture(t);
  await assert.rejects(f.capture.start({ ...options(), camera: false, previewCamera: true }), /corresponding recording input/);
  await assert.rejects(f.capture.start({ ...options(), microphone: false, monitorMicrophone: true }), /corresponding recording input/);
  assert.equal(f.capture.active, false); assert.equal((await f.calls()).filter(a => a[0] === "record").length, 0);
});

test("pause/resume await native state, remain idempotent and finalize only on stop", mediaTest, async t => {
  const f = await fixture(t), states = [], results = [];
  f.capture.onState = state => states.push(state); f.capture.onStopped = value => results.push(value);
  await f.capture.start(options());
  const paused = await f.capture.pause();
  assert.deepEqual(paused, { status: "paused", elapsedMs: 100 });
  await f.capture.pause();
  assert.equal(results.length, 0); assert.equal(f.capture.active, true);
  await assert.rejects(fs.stat(f.capture.session.output), { code: "ENOENT" });
  assert.deepEqual(await f.capture.resume(), { status: "recording", elapsedMs: 100 });
  await f.capture.resume();
  assert.deepEqual((await f.calls()).filter(a => a[0] === "stdin"), [["stdin", "pause"], ["stdin", "resume"]]);
  assert.deepEqual(states, [{ status: "recording", elapsedMs: 0 }, { status: "paused", elapsedMs: 100 }, { status: "recording", elapsedMs: 100 }]);
  await f.capture.stop(); assert.equal(results.length, 1);
});

test("discard waits for actual process close, suppresses editor publication and removes only its recording", mediaTest, async t => {
  const f = await fixture(t, "slow-stop"), published = [];
  f.capture.onStopped = value => published.push(value);
  await f.capture.start(options());
  const current = f.capture.session.directory, child = f.capture.session.child;
  const other = path.join(f.capture.recordingRoot, "Recording-existing"); await fs.mkdir(other); await fs.writeFile(path.join(other, "keep"), "previous recording");
  const discarded = f.capture.discard();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(child.exitCode, null); assert.equal(f.capture.active, true); assert.equal((await fs.stat(current)).isDirectory(), true);
  await discarded;
  assert.equal(f.capture.active, false); assert.deepEqual(published, []);
  await assert.rejects(fs.stat(current), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(other, "keep"), "utf8"), "previous recording");
});

test("restart removes the old owned session before starting fresh with the same validated options", mediaTest, async t => {
  const f = await fixture(t), published = [], states = [];
  f.capture.onStopped = value => published.push(value); f.capture.onState = state => states.push(state);
  await f.capture.start({ ...options(), area: { x: 12, y: 18, width: 400, height: 300 } });
  const old = f.capture.session;
  await f.capture.pause(); await f.capture.restart();
  const current = f.capture.session;
  assert.notEqual(current.directory, old.directory); assert.notEqual(current.child, old.child);
  assert.equal(old.exited, true); assert.equal(old.released, true); assert.deepEqual(published, []);
  await assert.rejects(fs.stat(old.directory), { code: "ENOENT" });
  const calls = (await f.calls()).filter(a => a[0] === "record");
  const flags = args => args.filter((_, i) => ![args.indexOf("--output") + 1, args.indexOf("--cursor-output") + 1].includes(i));
  assert.deepEqual(flags(calls[1]), flags(calls[0]));
  assert.deepEqual(states.at(-1), { status: "recording", elapsedMs: 0 });
  await f.capture.stop(); assert.equal(published.length, 1);
});

async function controlledCapture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reva-capture-owned-"));
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter(); child.stdout.setEncoding = () => {};
  const commands = [], signals = [];
  child.stdin.end = command => commands.push(command);
  child.stdin.write = (command, callback) => { commands.push(command); callback?.(); };
  child.kill = signal => { signals.push(signal); return true; };
  const capture = new Capture({ helper: "controlled child", recordingRoot: directory, grants: new MediaGrants(), ffprobe, stopTimeoutMs: 5, killTimeoutMs: 5, exitTimeoutMs: 5,
    spawnProcess: (_, args) => { queueMicrotask(() => child.stdout.emit("data", JSON.stringify({ type: "ready", output: args[args.indexOf("--output") + 1], cursorOutput: args[args.indexOf("--cursor-output") + 1] }) + "\n")); return child; } });
  capture.sources = async () => [source];
  t.after(async () => { child.emit("close", 0); await capture.discard().catch(() => {}); await fs.rm(directory, { recursive: true, force: true }); });
  await capture.start({ source, fps: 30, systemAudio: false, microphone: false, camera: false });
  return { capture, child, directory, commands, signals };
}

test("failed discard retains helper and directory until cleanup retry observes close", async t => {
  const f = await controlledCapture(t), session = f.capture.session;
  await assert.rejects(f.capture.discard(), /retained for cleanup retry/);
  assert.equal(f.capture.session, session); assert.equal(f.capture.active, true); assert.equal((await fs.stat(session.directory)).isDirectory(), true);
  assert.deepEqual(f.signals, ["SIGTERM", "SIGKILL"]);
  await assert.rejects(f.capture.start({}), /already in progress/);
  const retry = f.capture.discard(); f.child.emit("close", 0); await retry;
  assert.equal(f.capture.active, false); await assert.rejects(fs.stat(session.directory), { code: "ENOENT" });
});

test("discard refuses replaced directory identity and retains cleanup ownership for retry", async t => {
  const f = await controlledCapture(t), session = f.capture.session, retained = session.directory + "-original";
  await fs.rename(session.directory, retained); await fs.mkdir(session.directory); await fs.writeFile(path.join(session.directory, "foreign"), "do not delete");
  const discard = f.capture.discard(); f.child.emit("close", 0);
  await assert.rejects(discard, /ownership no longer matches/);
  assert.equal(f.capture.session, session); assert.equal(await fs.readFile(path.join(session.directory, "foreign"), "utf8"), "do not delete");
  await fs.rm(session.directory, { recursive: true }); await fs.rename(retained, session.directory);
  await f.capture.discard(); assert.equal(f.capture.active, false);
});

test("discard during media finalization prevents a late project and retains directory until probing finishes", mediaTest, async t => {
  const f = await fixture(t), published = [];
  const actual = f.capture.readResult.bind(f.capture); let entered, release;
  const inProbe = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  f.capture.readResult = async s => { entered(); await blocked; return actual(s); };
  f.capture.onStopped = result => published.push(result);
  await f.capture.start(options()); const session = f.capture.session;
  const stopping = f.capture.stop(); await inProbe;
  const discarded = f.capture.discard();
  assert.equal(session.exited, true); assert.equal(f.capture.active, true); assert.equal((await fs.stat(session.directory)).isDirectory(), true);
  release(); await Promise.all([stopping, discarded]);
  assert.deepEqual(published, []); assert.equal(f.capture.active, false);
});

test("discard cancels restart during old-session cleanup before replacement can be admitted", mediaTest, async t => {
  const f = await fixture(t, "slow-stop"); await f.capture.start(options());
  const restarted = assert.rejects(f.capture.restart(), /restart was cancelled/);
  await f.capture.discard(); await restarted;
  assert.equal(f.capture.active, false); assert.equal((await f.calls()).filter(a => a[0] === "record").length, 1);
});

test("capture consumes owned activity metadata and applies the source-derived typing grouper once", mediaTest, async t => {
  const f = await fixture(t), original = f.capture.readResult.bind(f.capture);
  f.capture.readResult = async s => {
    await fs.copyFile(path.join(templates, "activity.mp4"), s.output);
    const activity = [.1, .35, .6, .85, 1.1, 1.35, 1.6].map(time => ({ type: "typing", time, count: 1 }));
    activity.splice(3, 0, { type: "pause", time: .6, duration: 5 });
    activity.push({ type: "pause", time: 2.0005, duration: 1 });
    s.resultMessage.activityOutput = path.join(s.directory, "screen.activity.json");
    s.resultMessage.duration = 2.0005;
    await fs.writeFile(s.resultMessage.activityOutput, JSON.stringify(activity));
    return original(s);
  };
  await f.capture.start(options()); const result = await f.capture.stop();
  assert.deepEqual(result.pauseMarkers, [{ time: .6, duration: 5 }, { time: 2, duration: 1 }]);
  assert.deepEqual(result.typingRanges, [{ start: .1, end: 1.6, count: 7 }]);
});

test("malformed activity cannot publish a project or silently invent typing", mediaTest, async t => {
  const f = await fixture(t), original = f.capture.readResult.bind(f.capture), published = [];
  f.capture.onStopped = value => published.push(value);
  f.capture.readResult = async s => {
    s.resultMessage.activityOutput = path.join(s.directory, "screen.activity.json");
    await fs.writeFile(s.resultMessage.activityOutput, JSON.stringify([{ type: "typing", time: .1, count: -1 }]));
    return original(s);
  };
  await f.capture.start(options()); await assert.rejects(f.capture.stop(), /Typing activity count/);
  assert.deepEqual(published, []);
});
