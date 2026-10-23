"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const { InputMonitor, parseLevels, parseCameraFrame, monitorOptions, MAX_LINE_BYTES } = require("./input-monitor.cjs");
const { capturePrivacySettingsURL } = require("./capture-permissions.cjs");
// JPEG header fixture tests identity/dimension validation. The native synthetic
// suite independently decodes a real JPEG produced by the actual image encoder.
const jpeg = Buffer.from([255,216,255,192,0,17,8,0,2,0,3,3,1,17,0,2,17,0,3,17,0,255,217]).toString("base64");
const frame = { deviceID: "cam opaque — 1", jpegBase64: jpeg, width: 3, height: 2 };
test("live events preserve opaque source identity and reject malformed levels/JPEG before dispatch", () => {
  assert.deepEqual(parseLevels({ deviceID: "mic opaque:/ one", rms: .2, peak: .5 }), { deviceID: "mic opaque:/ one", rms: .2, peak: .5 });
  assert.deepEqual(parseCameraFrame(frame), frame);
  for (const v of [{ rms: NaN, peak: .5 }, { rms: -.1, peak: .5 }, { rms: .9, peak: .5 }, { rms: .2, peak: 2 }]) assert.throws(() => parseLevels({ deviceID: "mic", ...v }));
  for (const patch of [{ deviceID: "" }, { width: 361 }, { width: 2 }, { jpegBase64: "!" }, { jpegBase64: "" }, { jpegBase64: "A".repeat(MAX_LINE_BYTES) }, { jpegBase64: Buffer.from([255,216,255,192,0,0,255,217]).toString("base64") }]) assert.throws(() => parseCameraFrame({ ...frame, ...patch }));
  assert.deepEqual(monitorOptions({ camera: false, cameraDeviceID: "preserved while disabled" }).cameraDeviceID, "preserved while disabled");
  for (const v of [{ camera: "true" }, { microphones: "invalid" }, { cameraDeviceID: "bad\0id" }]) assert.throws(() => monitorOptions(v));
});
test("privacy settings navigation admits only the two capture panes, never renderer-supplied URLs", () => {
  assert.ok(capturePrivacySettingsURL("microphone").endsWith("?Privacy_Microphone"));
  assert.ok(capturePrivacySettingsURL("screen").endsWith("?Privacy_ScreenCapture"));
  for (const value of [null, {}, "__proto__", "https://example.test/", "microphone&otherPane", "camera"]) assert.throws(() => capturePrivacySettingsURL(value));
});
async function fixture(t, mode = "normal") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reva-input-monitor-")), helper = path.join(dir, "helper.cjs"), log = path.join(dir, "calls.json");
  await fs.writeFile(helper, `#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(log)},JSON.stringify(a));
const flag=n=>a[a.indexOf(n)+1],emit=v=>console.log(JSON.stringify(v)),camera=flag('--camera')==='true'?(a.includes('--camera-device-id')?flag('--camera-device-id'):${JSON.stringify(frame.deviceID)}):null;
const ready={type:'ready',kind:'input-monitor',cameraDeviceID:camera,microphoneDeviceIDs:flag('--microphones')==='all'?['mic:one','mic:two'].filter(id=>!a.includes('--exclude-microphone-device-id')||id!==flag('--exclude-microphone-device-id')):[]};
const mode=${JSON.stringify(mode)};
if(mode==='permission-denied'){ready.microphoneDeviceIDs=[];ready.microphonePermission='denied';emit({type:'permission',mediaType:'microphone',status:'not-determined'});emit({type:'permission',mediaType:'microphone',status:'denied'});emit({type:'error',code:'microphone_permission_denied',message:'Allow microphone access',mediaType:'microphone',recoverable:true});}
if(mode==='malformed')console.log('not JSON');
else if(mode!=='late'){if(mode==='partial')emit({type:'error',code:'input_unavailable',message:'One microphone unavailable',deviceID:'mic:failed',mediaType:'microphone',recoverable:true});emit(ready);if(ready.microphoneDeviceIDs.length)emit({type:'levels',deviceID:ready.microphoneDeviceIDs[0],rms:.25,peak:.5});if(camera)emit({...${JSON.stringify(frame)},type:'camera-frame',deviceID:camera});}
if(mode==='fatal')setTimeout(()=>emit({type:'error',code:'input_failed',message:'Device vanished',recoverable:false}),30);
process.stdin.once('data',()=>{if(mode==='late'){emit(ready);emit({type:'levels',deviceID:'mic:one',rms:.9,peak:1});}if(mode!=='missing-ack')emit({type:'stopped',kind:'input-monitor'});process.stdout.write('',()=>process.exit(0));});
if(mode==='late')process.send('fixture-listening');
`, { mode: 0o700 });
  const levels = [], frames = [], errors = [], states = [];
  let resolveListening, rejectListening, bootstrapMs;
  const listening = mode === "late" ? new Promise((resolve, reject) => { resolveListening = resolve; rejectListening = reject; }) : Promise.resolve();
  listening.catch(() => {});
  const spawnProcess = mode !== "late" ? undefined : (executable, args, options) => {
    const started = performance.now(), child = spawn(executable, args, { ...options, stdio: [...options.stdio, "ipc"] });
    // This is a fixture bootstrap barrier, deliberately separate from native
    // monitor readiness on stdout. Cold Node startup under parallel FFmpeg work
    // must not consume the deadline intended to test stop/late-ready ordering.
    child.once("message", value => {
      if (value !== "fixture-listening") { rejectListening(new Error("Unexpected input fixture bootstrap message.")); return; }
      bootstrapMs = performance.now() - started; resolveListening();
    });
    child.once("error", rejectListening);
    child.once("close", (code, signal) => rejectListening(new Error(`Input fixture exited before listening: code=${code}, signal=${signal}.`)));
    return child;
  };
  const monitor = new InputMonitor({ helper, spawnProcess, onInputLevels: v => levels.push(v), onCameraFrame: v => frames.push(v), onError: e => errors.push(e), onState: state => states.push(state), readyTimeoutMs: 5000, stopTimeoutMs: 2000, killTimeoutMs: 100, exitTimeoutMs: 100 });
  t.after(async () => { await monitor.dispose().catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); });
  return { monitor, levels, frames, errors, states, listening, get bootstrapMs() { return bootstrapMs; }, calls: async () => JSON.parse(await fs.readFile(log)) };
}
test("real child protocol routes all requested microphones and one bounded camera, then acknowledges cleanup", async t => {
  const f = await fixture(t);
  const ready = await f.monitor.start({ camera: true, cameraDeviceID: frame.deviceID, microphones: "all", excludeMicrophoneDeviceID: "mic:two" });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(ready, { cameraDeviceID: frame.deviceID, microphoneDeviceIDs: ["mic:one"] });
  assert.deepEqual(f.levels, [{ deviceID: "mic:one", rms: .25, peak: .5 }]);
  assert.deepEqual(f.frames, [frame]);
  assert.deepEqual(await f.calls(), ["monitor-inputs", "--microphones", "all", "--camera", "true", "--camera-device-id", frame.deviceID, "--exclude-microphone-device-id", "mic:two"]);
  await assert.rejects(f.monitor.start(), /already active/);
  await Promise.all([f.monitor.stop(), f.monitor.stop()]);
  assert.equal(f.monitor.active, false);
  await f.monitor.dispose(); await assert.rejects(f.monitor.start(), /disposed/);
});
test("one device failure preserves successful child inputs and its typed diagnostic", async t => {
  const f = await fixture(t, "partial"); await f.monitor.start();
  assert.equal(f.errors.length, 1); assert.equal(f.errors[0].deviceID, "mic:failed"); assert.equal(f.errors[0].recoverable, true);
  assert.equal(f.monitor.active, true); await f.monitor.stop();
});
test("stop during startup ignores late ready and samples without resurrecting callbacks", async t => {
  const f = await fixture(t, "late"), started = f.monitor.start();
  const rejected = assert.rejects(started, /cancelled/);
  await f.listening;
  assert.equal(f.monitor.state.phase, "starting");
  assert.ok(f.states.every(state => state.phase !== "ready"), "the fixture barrier must not acknowledge monitor readiness");
  if (f.bootstrapMs >= 2000) t.diagnostic(`Cold fixture bootstrap took ${Math.round(f.bootstrapMs)}ms before the cancellation test began.`);
  await f.monitor.stop(); await rejected;
  assert.equal(f.monitor.active, false); assert.deepEqual(f.levels, []); assert.deepEqual(f.frames, []);
});
test("malformed helper output is fatal and the child remains owned through exit", async t => {
  const f = await fixture(t, "malformed"); await assert.rejects(f.monitor.start());
  await f.monitor.stop().catch(() => {}); assert.equal(f.monitor.active, false);
});
test("unacknowledged cleanup is reported even after process exit", async t => {
  const f = await fixture(t, "missing-ack"); await f.monitor.start();
  await assert.rejects(f.monitor.stop(), /acknowledge cleanup/); assert.equal(f.monitor.active, false);
});
test("fatal error after ready notifies the owner and ends the child", async t => {
  const f = await fixture(t, "fatal"); await f.monitor.start();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.errors.length, 1); assert.equal(f.errors[0].code, "input_failed");
  await f.monitor.stop().catch(() => {}); assert.equal(f.monitor.active, false);
});
test("failed shutdown retains the exact child for cleanup retry", async () => {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter(); child.stdout.setEncoding = () => {};
  let stops = 0; const signals = [];
  child.stdin.end = () => { if (++stops === 2) queueMicrotask(() => { child.stdout.emit("data", '{"type":"stopped","kind":"input-monitor"}\n'); child.emit("close", 0); }); };
  child.kill = signal => { signals.push(signal); return true; };
  const monitor = new InputMonitor({ helper: "owned fake child", spawnProcess: () => { queueMicrotask(() => child.stdout.emit("data", '{"type":"ready","kind":"input-monitor","microphoneDeviceIDs":[]}\n')); return child; }, stopTimeoutMs: 5, killTimeoutMs: 5, exitTimeoutMs: 5 });
  await monitor.start(); await assert.rejects(monitor.stop(), /retained for cleanup retry/);
  assert.equal(monitor.active, true); assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  await assert.rejects(monitor.start(), /already active/); await monitor.stop(); assert.equal(monitor.active, false);
});

test("cancellation during final cleanup waits for the owned child's actual close", async () => {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter(); child.stdout.setEncoding = () => {};
  let stops = 0; child.stdin.end = () => { stops++; child.stdout.emit("data", '{"type":"stopped","kind":"input-monitor"}\n'); }; child.kill = () => true;
  const monitor = new InputMonitor({ helper: "owned finalizing child", spawnProcess: () => { queueMicrotask(() => child.stdout.emit("data", '{"type":"ready","kind":"input-monitor","microphoneDeviceIDs":[]}\n')); return child; }, stopTimeoutMs: 1000 });
  await monitor.start();
  let completed = false;
  const first = monitor.stop().then(() => { completed = true; }), repeated = monitor.stop();
  await Promise.resolve(); assert.equal(completed, false); assert.equal(monitor.active, true); assert.equal(stops, 1);
  child.emit("close", 0); await Promise.all([first, repeated]);
  assert.equal(completed, true); assert.equal(monitor.active, false);
});

test("denied permission and empty readiness remain a persistent typed state, never measured silence", async t => {
  const f = await fixture(t, "permission-denied");
  await f.monitor.start({ microphones: "selected", microphoneDeviceID: "mic:one" });
  assert.deepEqual(f.levels, []);
  assert.equal(f.monitor.state.phase, "ready");
  assert.equal(f.monitor.state.microphonePermission, "denied");
  assert.deepEqual(f.monitor.state.microphoneDeviceIDs, []);
  assert.equal(f.monitor.state.errors[0].code, "microphone_permission_denied");
  assert.equal(f.monitor.state.errors[0].recoverable, true);
  assert.ok(f.states.some(state => state.microphonePermission === "not-determined"));
  const args = await f.calls(); assert.equal(args[args.indexOf("--microphone-device-id") + 1], "mic:one");
  await f.monitor.stop();
});
