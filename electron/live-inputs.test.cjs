"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { InputMonitor } = require("./input-monitor.cjs");
const { LiveInputs } = require("./live-inputs.cjs");

const flush = () => new Promise(resolve => setImmediate(resolve));
const observe = promise => promise.then(value => ({ status: "fulfilled", value }), error => ({ status: "rejected", error }));
const camera = id => ({ camera: true, cameraDeviceID: id, microphones: "all" });

function fixture(t, deadlines = {}) {
  const children = [], errors = [], levels = [];
  function spawnProcess(_helper, args) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.args = args;
    child.stops = 0;
    child.signals = [];
    child.closed = false;
    child.stdin.end = value => { assert.equal(value, "stop\n"); child.stops++; };
    child.kill = signal => { child.signals.push(signal); return true; };
    child.emitLine = value => child.stdout.emit("data", `${JSON.stringify(value)}\n`);
    child.ready = (patch = {}) => child.emitLine({ type: "ready", kind: "input-monitor", cameraDeviceID: args[args.indexOf("--camera") + 1] === "true" ? args[args.indexOf("--camera-device-id") + 1] : null, microphoneDeviceIDs: args[args.indexOf("--microphones") + 1] !== "none" ? ["mic:one"] : [], ...patch });
    child.acknowledgeStop = () => child.emitLine({ type: "stopped", kind: "input-monitor" });
    child.close = () => { if (!child.closed) { child.closed = true; child.emit("close", 0); } };
    children.push(child);
    return child;
  }
  class ControlledInputMonitor extends InputMonitor {
    constructor(options) { super({ ...options, spawnProcess, readyTimeoutMs: 2000, stopTimeoutMs: 1000, killTimeoutMs: 100, exitTimeoutMs: 100, ...deadlines }); }
  }
  const live = new LiveInputs({ InputMonitor: ControlledInputMonitor, helper: "owned controlled input helper", onInputLevels: value => levels.push(value), onError: error => errors.push(error) });
  t.after(async () => {
    const stopping = live.stop().catch(() => {});
    for (const child of children) if (!child.closed) { child.acknowledgeStop(); child.close(); }
    await stopping;
    await live.dispose().catch(() => {});
  });
  return { live, children, errors, levels };
}

test("the latest configuration owns readiness and waits for its predecessor's actual close", async t => {
  const f = fixture(t), first = f.live.configure(camera("camera:A"));
  await flush();
  const old = f.children[0];
  const intermediate = f.live.configure(camera("camera:B"));
  const latest = f.live.configure(camera("camera:C"));
  old.ready();
  old.emitLine({ type: "levels", deviceID: "mic:one", rms: 0.8, peak: 0.9 });
  old.acknowledgeStop();
  await flush();
  assert.equal(f.children.length, 1, "a cleanup acknowledgement does not release the owned child");
  assert.equal(old.stops, 1);
  assert.deepEqual(f.levels, []);
  old.close();
  await flush();
  assert.equal(f.children.length, 2, "the superseded middle configuration never starts");
  const current = f.children[1];
  assert.equal(current.args[current.args.indexOf("--camera-device-id") + 1], "camera:C");
  current.ready();
  current.emitLine({ type: "levels", deviceID: "mic:one", rms: 0.2, peak: 0.3 });
  await Promise.all([first, intermediate, latest]);
  assert.deepEqual(f.levels, [{ deviceID: "mic:one", rms: 0.2, peak: 0.3 }]);
  assert.deepEqual(f.errors, []);
});

test("equivalent concurrent configurations share one helper and accepted options are snapshotted", async t => {
  const f = fixture(t), options = camera("selected opaque:/ camera");
  const first = f.live.configure(options);
  options.cameraDeviceID = "mutated after admission";
  await flush();
  assert.equal(f.children.length, 1);
  const child = f.children[0];
  assert.equal(child.args[child.args.indexOf("--camera-device-id") + 1], "selected opaque:/ camera");
  const second = f.live.configure({ microphones: "all", cameraDeviceID: "selected opaque:/ camera", camera: true });
  child.ready();
  await Promise.all([first, second]);
  assert.equal(child.stops, 0);
});

test("stop cancels pending readiness and waits through final cleanup without late input callbacks", async t => {
  const f = fixture(t), configured = f.live.configure(camera("camera:A"));
  await flush();
  const child = f.children[0];
  let stopped = false;
  const stopping = f.live.stop().then(() => { stopped = true; });
  child.ready();
  child.emitLine({ type: "levels", deviceID: "mic:one", rms: 0.8, peak: 0.9 });
  child.acknowledgeStop();
  await flush();
  assert.equal(stopped, false);
  child.close();
  await Promise.all([configured, stopping]);
  assert.equal(stopped, true);
  assert.deepEqual(f.levels, []);
  assert.deepEqual(f.errors, []);
  assert.equal(f.children.length, 1);
});

test("failed cleanup blocks a replacement and retry stops the same retained helper first", async t => {
  const f = fixture(t, { stopTimeoutMs: 5, killTimeoutMs: 5, exitTimeoutMs: 5 });
  const first = f.live.configure(camera("camera:A"));
  await flush();
  const old = f.children[0];
  old.ready();
  await first;
  await f.live.configure(camera("camera:B"));
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0].message, /retained for cleanup retry/);
  assert.equal(f.children.length, 1);
  assert.deepEqual(old.signals, ["SIGTERM", "SIGKILL"]);

  const retry = f.live.configure(camera("camera:B"));
  assert.equal(old.stops, 2, "retry retains the original ChildProcess handle");
  old.acknowledgeStop();
  old.close();
  await flush();
  assert.equal(f.children.length, 2);
  f.children[1].ready();
  await retry;
});

test("dispose closes admission before awaited cleanup and still permits cleanup retry", async t => {
  const f = fixture(t, { stopTimeoutMs: 5, killTimeoutMs: 5, exitTimeoutMs: 5 });
  const initial = f.live.configure(camera("camera:A"));
  await flush();
  const child = f.children[0];
  child.ready();
  await initial;
  const disposal = observe(f.live.dispose());
  let during;
  const attempted = observe(Promise.resolve().then(() => f.live.configure(camera("camera:B")))).then(value => { during = value; });
  await flush();
  assert.equal(during?.status, "rejected", "a disposed owner cannot admit a replacement while cleanup is pending");
  assert.match(during.error.message, /disposed/);
  const failed = await disposal;
  assert.equal(failed.status, "rejected");
  assert.match(failed.error.message, /retained for cleanup retry/);
  await assert.rejects(Promise.resolve().then(() => f.live.configure(camera("camera:B"))), /disposed/);
  const retry = f.live.dispose();
  assert.equal(child.stops, 2);
  child.acknowledgeStop();
  child.close();
  await Promise.all([attempted, retry]);
  assert.equal(f.children.length, 1);
});

test("a fatal monitor failure permits retry of unchanged options without losing its diagnostic", async t => {
  const f = fixture(t), initial = f.live.configure(camera("camera:A"));
  await flush();
  const old = f.children[0];
  old.ready();
  await initial;
  old.emitLine({ type: "error", code: "input_failed", message: "Camera disconnected", recoverable: false });
  old.acknowledgeStop();
  old.close();
  await flush();
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].code, "input_failed");
  const retry = f.live.configure(camera("camera:A"));
  await flush();
  assert.equal(f.children.length, 2, "the desired configuration cannot be cached as healthy after native failure");
  f.children[1].ready();
  await retry;
});

test("a recoverable device warning preserves other live inputs and their configuration", async t => {
  const f = fixture(t), initial = f.live.configure(camera("camera:A"));
  await flush();
  const child = f.children[0];
  child.emitLine({ type: "error", code: "input_unavailable", message: "One microphone unavailable", deviceID: "mic:failed", mediaType: "microphone", recoverable: true });
  child.ready();
  await initial;
  await f.live.configure(camera("camera:A"));
  assert.equal(f.children.length, 1);
  assert.equal(child.stops, 0);
  assert.equal(f.errors[0].deviceID, "mic:failed");
  assert.equal(f.errors[0].recoverable, true);
});

test("explicit retry of a denied selected microphone waits for close and replaces stale failure state", async t => {
  const f = fixture(t), options = { camera: false, microphones: "selected", microphoneDeviceID: "mic:one" };
  const first = f.live.configure(options); await flush();
  const old = f.children[0];
  old.emitLine({ type: "permission", mediaType: "microphone", status: "denied" });
  old.emitLine({ type: "error", code: "microphone_permission_denied", message: "Access denied", mediaType: "microphone", recoverable: true });
  old.ready({ microphoneDeviceIDs: [], microphonePermission: "denied" }); await first;
  assert.equal(f.live.monitor.state.microphonePermission, "denied");
  const retry = f.live.configure(options, { force: true }); await flush();
  assert.equal(f.children.length, 1); assert.equal(old.stops, 1);
  old.acknowledgeStop(); old.close(); await flush();
  const fresh = f.children[1];
  assert.equal(fresh.args[fresh.args.indexOf("--microphone-device-id") + 1], "mic:one");
  fresh.emitLine({ type: "permission", mediaType: "microphone", status: "granted" });
  fresh.ready({ microphonePermission: "granted" });
  fresh.emitLine({ type: "levels", deviceID: "mic:one", rms: .2, peak: .4 }); await retry;
  assert.equal(f.live.monitor.state.microphonePermission, "granted");
  assert.deepEqual(f.live.monitor.state.errors, []);
  assert.deepEqual(f.levels, [{ deviceID: "mic:one", rms: .2, peak: .4 }]);
  const changed = f.live.configure({ ...options, microphoneDeviceID: "mic:two" });
  fresh.acknowledgeStop(); fresh.close(); await flush();
  const second = f.children[2]; assert.equal(second.args[second.args.indexOf("--microphone-device-id") + 1], "mic:two");
  second.ready({ microphoneDeviceIDs: ["mic:two"], microphonePermission: "granted" }); await changed;
});
