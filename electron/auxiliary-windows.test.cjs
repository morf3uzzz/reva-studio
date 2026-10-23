"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { RecordingWindows } = require("./recording-windows.cjs");
const { CropWindow } = require("./crop-window.cjs");

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  // A deliberately late load failure must remain observable without making
  // the fake native load itself an unhandled rejection.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function observe(promise) {
  return promise.then(
    value => ({ status: "fulfilled", value }),
    error => ({ status: "rejected", error }),
  );
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const url = role => `reva-app://app/index.html?surface=${role}`;
const cropData = { mediaPath: "/selected/recording.mov", width: 1920, height: 1080, time: 1, crop: { x: 0, y: 0, width: 1, height: 1 } };
const selectedArea = { x: 10, y: 20, width: 300, height: 200 };
const displaySource = { id: "display:1", kind: "display", name: "Display", width: 1920, height: 1080, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
const windowSource = { id: "window:42", kind: "window", name: "Chosen window", width: 900, height: 700, bounds: { x: -40, y: 40, width: 900, height: 700 } };
const preferences = { fps: 60, autoZoom: true, afterRecording: "editor", quickExportSettings: { format: "mp4" } };
const select = (owner, mode = "area") => owner.selectSource(mode, [displaySource, windowSource], preferences, []);
const complete = (owner, value) => owner.finishCapture(owner.prepareCapture(value));
const eventFor = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });

function fixture() {
  const windows = [];
  const restorations = [];
  const errors = [];
  const popoverCloses = [], previewCloses = [];
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.bounds = { x: 0, y: 0, width: 900, height: 64, ...options };
      this.destroyed = false;
      this.visible = false;
      this.showsAfterDestroy = 0;
      this.delayClosed = false;
      this.closedDelivered = false;
      this.load = deferred();
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: "" };
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = () => {};
      windows.push(this);
    }
    loadURL(value) { this.webContents.mainFrame.url = value; return this.load.promise; }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    setIgnoreMouseEvents(value) { this.ignoresMouseEvents = value; }
    isMinimized() { return false; }
    restore() { this.show(); }
    show() {
      if (this.destroyed) { this.showsAfterDestroy++; throw new Error("Object has been destroyed"); }
      this.visible = true;
    }
    showInactive() { this.show(); }
    hide() { this.visible = false; }
    focus() {}
    getBounds() { return this.bounds; }
    getContentBounds() { const { x, y, width, height } = this.bounds; return { x, y, width, height }; }
    setBounds(value) { Object.assign(this.bounds, value); }
    setVisibleOnAllWorkspaces() {}
    setAlwaysOnTop() {}
    setContentSize(width, height) { Object.assign(this.bounds, { width, height }); }
    setSize(width, height) { Object.assign(this.bounds, { width, height }); }
    close() { this.destroy(); }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.visible = false;
      if (!this.delayClosed) this.deliverClosed();
    }
    deliverClosed() {
      if (this.closedDelivered) return;
      this.closedDelivered = true;
      this.emit("closed");
    }
  }
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1050 } };
  const screen = {
    getDisplayNearestPoint: () => display,
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    getDisplayMatching: () => display,
    getAllDisplays: () => [display],
  };
  const dependencies = { BrowserWindow: FakeWindow, screen, preload: "/app/preload.cjs" };
  const parent = Object.assign(new EventEmitter(), { getBounds: () => display.bounds });
  return {
    windows, restorations, errors, popoverCloses, previewCloses, dependencies,
    recorder: () => new RecordingWindows({ ...dependencies, url, onCancel: () => restorations.push("restore"), onError: error => errors.push(error), onPopoverClosed: () => popoverCloses.push("closed"), onPreviewClosed: () => previewCloses.push("closed") }),
    crop: () => new CropWindow({ ...dependencies, url: url("crop") }),
    parent,
  };
}

async function openRecorder(owner, windows) {
  const opening = owner.open();
  const window = windows.at(-1);
  window.load.resolve();
  await opening;
  return window;
}

function mainFixture(t) {
  const f = fixture(), handlers = new Map(), configurations = [], menus = [], external = [], app = new EventEmitter();
  Object.assign(app, { setName() {}, setPath() {}, getPath: name => `/controlled-reva-test/${name}`, whenReady: () => new Promise(() => {}), isPackaged: true });
  const electron = { app, ...f.dependencies, shell: { openExternal: async value => external.push(value) }, protocol: { registerSchemesAsPrivileged() {} }, ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} }, Menu: { buildFromTemplate: template => ({ popup: options => menus.push({ template, options }) }) } };
  class ControlledLiveInputs {
    configure(options) { configurations.push(options); return Promise.resolve(); }
    stop() { return Promise.resolve(); }
    dispose() { return Promise.resolve(); }
  }
  const editor = new f.dependencies.BrowserWindow({});
  editor.webContents.mainFrame.url = "reva-app://app/index.html";
  const context = {
    require: name => name === "electron" ? electron : name === "./live-inputs.cjs" ? { LiveInputs: ControlledLiveInputs } : require(name.startsWith(".") ? path.join(__dirname, name) : name),
    __dirname, process: { platform: "darwin", env: {} }, console, Buffer, URL, setImmediate, setTimeout, clearTimeout, testEditor: editor,
  };
  // Load the actual registrations and trust boundary without Electron startup,
  // native capture, disk settings writes, or exposing new production hooks.
  vm.runInNewContext(`${readFileSync(path.join(__dirname, "main.cjs"), "utf8")}\nmainWindow = testEditor; settings.language = "en"; installIPC(); globalThis.testAPI = { recorder, cropEditor, settings, syncLiveInputs, setCapture: value => { capture = value; capturePromise = Promise.resolve(value); } };`, context, { filename: path.join(__dirname, "main.cjs") });
  const api = context.testAPI;
  t.after(() => { api.recorder.dispose(); api.cropEditor.dispose(); });
  return { ...f, ...api, setCapture: value => {
    value.permissions ??= async () => ({ screen: "granted", microphone: "granted", camera: "granted" });
    api.setCapture(value);
  }, editor, configurations, menus, external, invoke: (channel, event, ...args) => {
    assert.equal(handlers.has(channel), true, `IPC channel ${channel} is registered`);
    return handlers.get(channel)(event, ...args);
  } };
}

test("failed recorder load releases the failed window and permits a fresh open", async () => {
  const f = fixture(), owner = f.recorder();
  const failure = new Error("controlled initial load failure");
  const first = observe(owner.open());
  const failedWindow = f.windows[0];
  failedWindow.load.reject(failure);
  const failed = await first;
  assert.equal(failed.status, "rejected");
  assert.equal(failed.error, failure);
  assert.equal(failedWindow.isDestroyed(), true);

  const second = owner.open();
  const replacement = f.windows.at(-1);
  assert.notEqual(replacement, failedWindow);
  replacement.load.resolve();
  await second;
  assert.equal(replacement.visible, true);
  assert.equal(owner.owns({ sender: replacement.webContents, senderFrame: replacement.webContents.mainFrame }, "recorder"), true);
  owner.dispose();
});

test("parallel recorder opens share readiness and a canceled load cannot later hide the editor", async () => {
  const f = fixture(), owner = f.recorder();
  const first = observe(owner.open()), second = observe(owner.open());
  assert.equal(f.windows.length, 1);
  const loadingWindow = f.windows[0];
  assert.equal(loadingWindow.visible, false, "a second caller cannot show the window before its load finishes");
  owner.close();
  loadingWindow.load.resolve();
  const outcomes = await Promise.all([first, second]);
  assert.ok(outcomes.every(outcome => outcome.status === "rejected"), "callers must not report successful open after cancellation; main hides the editor only after success");
  assert.equal(loadingWindow.showsAfterDestroy, 0);
  assert.equal(f.restorations.length, 1);
});

test("recorder restoration belongs to one close path and renderer crashes restore once", async () => {
  const f = fixture(), owner = f.recorder();
  await openRecorder(owner, f.windows);
  owner.close(false);
  assert.equal(f.restorations.length, 0, "internal disposal must honor restore=false");
  owner.close(false);
  assert.equal(f.restorations.length, 0);
  await openRecorder(owner, f.windows);
  owner.close();
  assert.equal(f.restorations.length, 1, "explicit close and its closed event must not both restore");
  const crashed = await openRecorder(owner, f.windows);
  crashed.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(crashed.isDestroyed(), true);
  assert.equal(f.restorations.length, 2);
  assert.equal(f.errors.length, 1);
});

test("successful reopen after active toolbar loss always provides a usable control", async () => {
  const f = fixture(), owner = f.recorder();
  const first = await openRecorder(owner, f.windows);
  owner.setState({ status: "recording", startedAt: 1 });
  first.destroy();
  const attempt = observe(owner.open());
  const replacement = f.windows.at(-1);
  if (replacement !== first) replacement.load.resolve();
  const result = await attempt;
  if (result.status === "fulfilled") {
    assert.ok(owner.toolbar && !owner.toolbar.isDestroyed() && owner.toolbar.visible, "main must not hide the editor after an open that created no controls");
  }
  owner.dispose();
});

test("auxiliary capabilities require the current window, main frame, role and exact URL", async () => {
  const f = fixture(), recorder = f.recorder(), crop = f.crop();
  const toolbar = await openRecorder(recorder, f.windows);
  const event = { sender: toolbar.webContents, senderFrame: toolbar.webContents.mainFrame };
  assert.equal(recorder.owns(event, "recorder"), true);
  assert.equal(!!recorder.owns(event, "capture-picker"), false);
  assert.equal(!!recorder.owns({ sender: {}, senderFrame: event.senderFrame }, "recorder"), false);
  assert.equal(!!recorder.owns({ sender: event.sender, senderFrame: { url: event.senderFrame.url } }, "recorder"), false);
  toolbar.webContents.mainFrame.url = `${url("recorder")}#foreign`;
  assert.equal(!!recorder.owns(event, "recorder"), false);
  toolbar.webContents.mainFrame.url = url("recorder");

  const editing = observe(crop.open(cropData, f.parent));
  const modal = f.windows.at(-1);
  modal.load.resolve();
  await flush();
  const cropEvent = { sender: modal.webContents, senderFrame: modal.webContents.mainFrame };
  assert.equal(crop.owns(cropEvent), true);
  assert.equal(!!crop.owns(event), false);
  assert.equal(!!crop.owns({ sender: cropEvent.sender, senderFrame: { url: url("crop") } }), false);
  crop.complete(null);
  assert.deepEqual(await editing, { status: "fulfilled", value: null });
  assert.equal(!!crop.owns(cropEvent), false);
  recorder.dispose();
  assert.equal(!!recorder.owns(event, "recorder"), false);
});

test("registered main IPC handlers keep auxiliary roles out of editor and cross-role capabilities", async t => {
  const f = mainFixture(t), owner = f.recorder;
  const toolbar = await openRecorder(owner, f.windows);
  const verify = async (window, ownChannel) => {
    const event = eventFor(window);
    assert.equal(await f.invoke("reva:get-language", event), "en");
    await f.invoke(ownChannel, event);
    for (const channel of ["reva:import-video", "reva:save-project", "reva:export-start", "reva:sources", "reva:crop-info"]) {
      await assert.rejects(f.invoke(channel, event), /did not come from/);
    }
    await assert.rejects(f.invoke("reva:get-language", { ...event, senderFrame: { url: event.senderFrame.url } }), /did not come from/);
    const originalURL = window.webContents.mainFrame.url;
    window.webContents.mainFrame.url += "#foreign";
    await assert.rejects(f.invoke(ownChannel, event), /did not come from/);
    window.webContents.mainFrame.url = originalURL;
  };
  await verify(toolbar, "reva:recorder-state");

  const selecting = select(owner);
  const picker = f.windows.at(-1);
  picker.load.resolve();
  await flush();
  await verify(picker, "reva:capture-picker-info");
  await assert.rejects(f.invoke("reva:record-start", eventFor(picker)), /did not come from/);
  await assert.rejects(f.invoke("reva:capture-picker-info", eventFor(toolbar)), /did not come from/);
  owner.cancelCapture();
  await selecting;
  await assert.rejects(f.invoke("reva:capture-picker-info", eventFor(picker)), /did not come from/);

  const menuResult = owner.showPopover({ kind: "settings", preferences });
  const menu = f.windows.at(-1);
  menu.load.resolve();
  await flush();
  await verify(menu, "reva:recorder-popover-info");
  await assert.rejects(f.invoke("reva:record-start", eventFor(menu)), /did not come from/);
  const previewReady = owner.showPreview();
  const preview = f.windows.at(-1);
  preview.load.resolve();
  await previewReady;
  await verify(preview, "reva:camera-preview-info");
  await assert.rejects(f.invoke("reva:record-start", eventFor(preview)), /did not come from/);
  await assert.rejects(f.invoke("reva:recorder-popover-info", eventFor(preview)), /did not come from/);
  await assert.rejects(f.invoke("reva:camera-preview-info", eventFor(menu)), /did not come from/);
  owner.closePopover();
  await menuResult;
});

test("main input synchronization cannot reapply stale preferences after awaited preview readiness", async t => {
  const f = mainFixture(t);
  await openRecorder(f.recorder, f.windows);
  f.settings.recording = { ...f.settings.recording, camera: true, cameraPreview: true, microphone: false, cameraDeviceID: "camera:old" };
  const staleSync = f.syncLiveInputs();
  const stalePreview = f.windows.at(-1);
  f.settings.recording = { ...f.settings.recording, camera: false, cameraDeviceID: "camera:current" };
  await f.syncLiveInputs();
  stalePreview.load.resolve();
  await staleSync;
  assert.equal(stalePreview.isDestroyed(), true);
  assert.equal(stalePreview.showsAfterDestroy, 0);
  assert.equal(f.configurations.length, 1);
  assert.equal(f.configurations[0].camera, false);
  assert.equal(f.configurations[0].cameraDeviceID, "camera:current");
  assert.equal(f.configurations[0].microphones, "none");
});

test("a source query finishing after recorder replacement cannot open a stale picker", async t => {
  const f = mainFixture(t), queried = deferred();
  let queries = 0;
  f.setCapture({ active: false, sources: () => { queries++; return queried.promise; } });
  const toolbar = await openRecorder(f.recorder, f.windows);
  const choice = observe(f.invoke("reva:recorder-source", eventFor(toolbar), "area"));
  await flush();
  assert.equal(queries, 1);
  await f.invoke("reva:recorder-close", eventFor(toolbar));
  const replacement = await openRecorder(f.recorder, f.windows);
  const count = f.windows.length;
  queried.resolve([displaySource, windowSource]);
  await flush();
  assert.equal(f.windows.length, count, "source enumeration retains the initiating toolbar's identity");
  assert.equal(replacement.visible, true);
  const outcome = await choice;
  assert.equal(outcome.status, "fulfilled");
  assert.equal(outcome.value, null);
});

test("screen help distinguishes unconfirmed access from empty windows and retries through the actual IPC owner", async t => {
  const f = mainFixture(t), toolbar = await openRecorder(f.recorder, f.windows), event = eventFor(toolbar);
  let permission = "not-granted", sources = [displaySource], checks = 0;
  f.setCapture({ active: false, permissions: async () => { checks++; return { screen: permission, camera: "granted", microphone: "granted" }; }, sources: async () => sources });
  const blocked = await f.invoke("reva:recorder-source", event, "window");
  assert.equal(blocked.issue.reason, "access-unconfirmed");
  assert.equal(blocked.issue.permission, "not-granted");
  assert.equal(f.recorder.captureRequest, null);
  const helping = f.invoke("reva:recorder-menu", event, "screen-permission", { x: 100, y: 50 });
  const help = f.windows.at(-1); help.load.resolve(); await flush();
  assert.equal(help.options.height, 280);
  const info = await f.invoke("reva:recorder-popover-info", eventFor(help));
  assert.equal(info.screenIssue.reason, "access-unconfirmed");
  await f.invoke("reva:capture-privacy-settings", eventFor(help), "screen");
  assert.equal(f.external[0], "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  await f.invoke("reva:screen-source-retry", eventFor(help));
  assert.equal((await helping).retrySource, true);
  assert.equal(help.isDestroyed(), true);

  permission = "granted";
  const empty = await f.invoke("reva:recorder-source", event, "window");
  assert.equal(empty.issue.reason, "no-windows");
  assert.equal(checks, 2, "retry reads permission again instead of retaining the earlier failure");
  sources = [displaySource, windowSource];
  const selecting = f.invoke("reva:recorder-source", event, "window");
  await flush();
  assert.equal(f.recorder.captureRequest.data.mode, "window");
  const picker = f.windows.at(-1); picker.load.resolve();
  assert.equal((await f.invoke("reva:recorder-state", event)).screenIssue, null);
  f.recorder.cancelCapture();
  assert.equal(await selecting, null);
  assert.equal(checks, 3);
});

test("permission refresh clears only the typed screen issue and stale refresh cannot erase a newer failure", async t => {
  const f = mainFixture(t), toolbar = await openRecorder(f.recorder, f.windows), event = eventFor(toolbar), sent = [];
  toolbar.webContents.send = (channel, value) => sent.push({ channel, value });
  f.setCapture({ active: false, permissions: async () => ({ screen: "not-granted" }), sources: async () => [displaySource] });
  await f.invoke("reva:recorder-source", event, "window");
  const pending = deferred();
  f.setCapture({ active: false, permissions: () => pending.promise, sources: async () => [displaySource] });
  const olderRefresh = f.invoke("reva:permissions", event); await flush();
  f.setCapture({ active: false, permissions: async () => ({ screen: "not-granted" }), sources: async () => [displaySource] });
  await f.invoke("reva:recorder-source", event, "window");
  pending.resolve({ screen: "granted" }); await olderRefresh;
  assert.equal((await f.invoke("reva:recorder-state", event)).screenIssue.reason, "access-unconfirmed");
  f.setCapture({ active: false, permissions: async () => ({ screen: "granted" }) });
  await f.invoke("reva:permissions", event);
  assert.equal((await f.invoke("reva:recorder-state", event)).screenIssue, null);
  assert.ok(sent.some(item => item.channel === "reva:screen-capture-issue" && item.value === null));
  assert.ok(sent.every(item => item.channel !== "reva:error" && item.channel !== "reva:input-error"), "permission refresh must not replace or clear unrelated recorder errors");
});

test("permission-query cancellation and ordinary source failures never open stale pickers or invent a permission diagnosis", async t => {
  const f = mainFixture(t), toolbar = await openRecorder(f.recorder, f.windows), permission = deferred();
  let queries = 0;
  f.setCapture({ active: false, permissions: () => permission.promise, sources: async () => { queries++; return [displaySource]; } });
  const choice = f.invoke("reva:recorder-source", eventFor(toolbar), "area");
  await flush(); await f.invoke("reva:recorder-close", eventFor(toolbar));
  permission.reject(new Error("late permission helper failure"));
  assert.equal(await choice, null);
  assert.equal(queries, 0);
  assert.equal(f.recorder.captureRequest, null);
  const replacement = await openRecorder(f.recorder, f.windows), event = eventFor(replacement);
  f.setCapture({ active: false, sources: async () => { throw new Error("Source helper failed to launch"); } });
  await assert.rejects(f.invoke("reva:recorder-source", event, "window"), /Source helper failed to launch/);
  assert.equal((await f.invoke("reva:recorder-state", event)).screenIssue, null);
  f.setCapture({ active: false, permissions: async () => ({ screen: "not-granted" }), sources: async () => [] });
  assert.equal((await f.invoke("reva:recorder-source", event, "display")).issue.reason, "no-displays", "display geometry does not depend on Screen Recording access");
});

test("permission reads admit only editor, recorder, popover and picker; retry belongs only to the owned screen-help menu", async t => {
  const f = mainFixture(t), toolbar = await openRecorder(f.recorder, f.windows);
  f.setCapture({ active: false });
  for (const window of [f.editor, toolbar]) assert.equal((await f.invoke("reva:permissions", eventFor(window))).screen, "granted");
  const selecting = select(f.recorder), picker = f.windows.at(-1); picker.load.resolve(); await flush();
  assert.equal((await f.invoke("reva:permissions", eventFor(picker))).screen, "granted");
  f.recorder.cancelCapture(); await selecting;
  const menuResult = f.recorder.showPopover({ kind: "settings", preferences }), menu = f.windows.at(-1); menu.load.resolve(); await flush();
  assert.equal((await f.invoke("reva:permissions", eventFor(menu))).screen, "granted");
  await assert.rejects(f.invoke("reva:screen-source-retry", eventFor(menu)), /No Screen Recording help/);
  await assert.rejects(f.invoke("reva:screen-source-retry", eventFor(toolbar)), /did not come from/);
  const opening = f.recorder.showPreview(), preview = f.windows.at(-1); preview.load.resolve(); await opening;
  await assert.rejects(f.invoke("reva:permissions", eventFor(preview)), /did not come from/);
  await assert.rejects(f.invoke("reva:permissions", { ...eventFor(toolbar), senderFrame: { url: url("recorder") } }), /did not come from/);
  f.recorder.closePopover(); await menuResult;
});

test("recording startup preserves non-screen failures and returns actionable help only for a native screen-access failure", async t => {
  const f = mainFixture(t), toolbar = await openRecorder(f.recorder, f.windows), event = eventFor(toolbar);
  const failure = new Error("native localized screen diagnostic"); failure.code = "screen_permission_denied";
  let permissionChecks = 0;
  f.setCapture({ active: false, start: async () => { throw failure; }, permissions: async () => { permissionChecks++; return { screen: "not-granted" }; } });
  const result = await f.invoke("reva:record-start", event, { source: displaySource, area: selectedArea });
  assert.equal(result.issue.reason, "access-unconfirmed");
  assert.equal(result.issue.sourceKind, "area");
  assert.equal(permissionChecks, 1);
  const cameraFailure = new Error("Camera device unavailable"); cameraFailure.code = "camera_unavailable";
  f.setCapture({ active: false, start: async () => { throw cameraFailure; }, permissions: async () => { permissionChecks++; return { screen: "granted" }; } });
  await assert.rejects(f.invoke("reva:record-start", event, { source: displaySource }), /Camera device unavailable/);
  assert.equal(permissionChecks, 1, "a camera failure is not reinterpreted as screen permission trouble");
  await flush();
});

test("screen startup help waits through final cleanup and does not hide a retained recorder cleanup failure", async t => {
  const f = mainFixture(t), toolbar = await openRecorder(f.recorder, f.windows), event = eventFor(toolbar), closing = deferred();
  const denied = new Error("Native screen access not confirmed"); denied.code = "screen_permission_denied";
  const capture = { active: false, start: async () => { capture.active = true; throw denied; }, stop: async () => { await closing.promise; capture.active = false; throw denied; }, permissions: async () => ({ screen: "not-granted" }) };
  f.setCapture(capture);
  let settled = false;
  const starting = f.invoke("reva:record-start", event, { source: displaySource }).then(value => { settled = true; return value; });
  await flush();
  assert.equal(settled, false);
  assert.equal((await f.invoke("reva:recorder-state", event)).screenIssue, null);
  closing.resolve();
  assert.equal((await starting).issue.reason, "access-unconfirmed");
  assert.equal(capture.active, false);

  let retained = false;
  const failure = { get active() { return retained; }, start: async () => { retained = true; throw denied; }, stop: async () => { throw new Error("Owned recording cleanup did not finish"); } };
  f.setCapture(failure);
  await assert.rejects(f.invoke("reva:record-start", event, { source: displaySource }), /Owned recording cleanup did not finish/);
  retained = false;
  await flush();
});

test("a native display menu completing after toolbar loss cannot attach its choice to a new toolbar", async t => {
  const f = mainFixture(t);
  const secondDisplay = { ...displaySource, id: "display:2", name: "Other display" };
  f.setCapture({ active: false, sources: async () => [displaySource, secondDisplay] });
  const toolbar = await openRecorder(f.recorder, f.windows);
  const choice = observe(f.invoke("reva:recorder-source", eventFor(toolbar), "display"));
  await flush();
  assert.equal(f.menus.length, 1);
  toolbar.destroy();
  const replacement = await openRecorder(f.recorder, f.windows);
  const count = f.windows.length;
  f.menus[0].template[0].click();
  f.menus[0].options.callback();
  await flush();
  assert.equal(f.windows.length, count, "native menu completion is still bound to its original toolbar");
  assert.equal(replacement.visible, true);
  const outcome = await choice;
  assert.equal(outcome.status, "fulfilled");
  assert.equal(outcome.value, null);
});

test("capture selection survives late failure and close events from its canceled predecessor", async () => {
  const f = fixture(), owner = f.recorder();
  const first = observe(select(owner));
  const stale = f.windows.at(-1);
  stale.delayClosed = true;
  complete(owner, null);
  const second = observe(select(owner));
  const current = f.windows.at(-1);
  assert.notEqual(current, stale);
  stale.load.reject(new Error("old window load aborted"));
  stale.deliverClosed();
  await flush();
  assert.equal(current.isDestroyed(), false, "a predecessor cannot cancel the accepted replacement");
  current.load.resolve();
  await flush();
  complete(owner, { sourceID: displaySource.id, area: selectedArea });
  assert.deepEqual(await first, { status: "fulfilled", value: null });
  assert.deepEqual(await second, { status: "fulfilled", value: { source: displaySource, area: selectedArea } });
  assert.equal(stale.showsAfterDestroy, 0);
  owner.dispose();
});

test("canceling a loading capture picker settles before its late native load finishes", async () => {
  const f = fixture(), owner = f.recorder();
  let outcome;
  const result = observe(select(owner)).then(value => { outcome = value; });
  const selector = f.windows.at(-1);
  owner.close(false);
  await flush();
  assert.deepEqual(outcome, { status: "fulfilled", value: null });
  selector.load.resolve();
  await result;
  await flush();
  assert.equal(selector.isDestroyed(), true);
  assert.equal(selector.showsAfterDestroy, 0);
});

test("external toolbar closure cancels its pending capture selector", async () => {
  const f = fixture(), owner = f.recorder();
  const toolbar = await openRecorder(owner, f.windows);
  const result = observe(select(owner));
  const selector = f.windows.at(-1);
  selector.load.resolve();
  await flush();
  toolbar.destroy();
  assert.equal(selector.isDestroyed(), true, "the hidden toolbar owns its full-display selector");
  assert.deepEqual(await result, { status: "fulfilled", value: null });
  assert.equal(f.restorations.length, 1);
  owner.dispose();
});

test("late capture finalization cannot show a replacement toolbar before readiness", async () => {
  const f = fixture(), owner = f.recorder();
  await openRecorder(owner, f.windows);
  const selection = observe(select(owner));
  const staleSelector = f.windows.at(-1);
  owner.close(false);
  const reopening = owner.open();
  const replacementToolbar = f.windows.at(-1);
  assert.equal(replacementToolbar.visible, false);
  staleSelector.load.reject(new Error("canceled selector load ended late"));
  await flush();
  assert.equal(replacementToolbar.visible, false, "only the replacement's own readiness may reveal its controls");
  replacementToolbar.load.resolve();
  await reopening;
  assert.deepEqual(await selection, { status: "fulfilled", value: null });
  owner.dispose();
});

test("capture preparation validates current source identity and geometry without losing the pending choice", async () => {
  const f = fixture(), owner = f.recorder(), result = select(owner, "window");
  const picker = f.windows.at(-1);
  picker.load.resolve();
  await flush();
  assert.equal(owner.owns(eventFor(picker), "capture-picker"), true);
  assert.equal(!!owner.owns(eventFor(picker), "recorder"), false);
  assert.equal(owner.captureInfo().mode, "window");
  await assert.rejects(select(owner), /Finish selecting/);
  assert.throws(() => owner.prepareCapture({ sourceID: "window:foreign" }), /no longer available/);
  assert.throws(() => owner.prepareCapture({ sourceID: windowSource.id, area: selectedArea }), /belong to a display/);
  for (const area of [{ ...selectedArea, width: 149 }, { ...selectedArea, x: -1 }, { ...selectedArea, y: Infinity }, { ...selectedArea, width: 1920 }]) {
    assert.throws(() => owner.prepareCapture({ sourceID: displaySource.id, area }), /must fit/);
  }
  assert.equal(picker.visible, true);
  complete(owner, { sourceID: windowSource.id });
  assert.deepEqual(await result, { source: windowSource }, "a partially offscreen window preserves its original bounds and opaque identity");
  assert.equal(!!owner.owns(eventFor(picker), "capture-picker"), false);
  owner.dispose();
});

test("a prepared selection cannot commit into a replacement request after awaited preference persistence", async () => {
  const f = fixture(), owner = f.recorder(), oldResult = select(owner);
  const stale = f.windows.at(-1);
  stale.load.resolve();
  await flush();
  const prepared = owner.prepareCapture({ sourceID: displaySource.id, area: selectedArea });
  owner.cancelCapture();
  const currentResult = select(owner, "display");
  const current = f.windows.at(-1);
  current.load.resolve();
  await flush();
  owner.finishCapture(prepared);
  assert.equal(current.visible, true);
  assert.equal(owner.captureInfo().mode, "display");
  complete(owner, { sourceID: displaySource.id });
  assert.equal(await oldResult, null);
  assert.deepEqual(await currentResult, { source: displaySource });
  owner.dispose();
});

test("capture load failure reports the original error, restores controls, and permits retry", async () => {
  const f = fixture(), owner = f.recorder(), toolbar = await openRecorder(owner, f.windows);
  const failure = new Error("controlled capture load failure"), first = observe(select(owner));
  const failed = f.windows.at(-1);
  failed.load.reject(failure);
  assert.deepEqual(await first, { status: "rejected", error: failure });
  assert.equal(failed.isDestroyed(), true);
  assert.equal(toolbar.visible, true);
  const second = select(owner);
  f.windows.at(-1).load.resolve();
  await flush();
  owner.cancelCapture();
  assert.equal(await second, null);
  owner.dispose();
});

test("a canceled loading popover settles immediately and its late load cannot dismiss a replacement", async () => {
  const f = fixture(), owner = f.recorder();
  await openRecorder(owner, f.windows);
  let outcome;
  const first = observe(owner.showPopover({ kind: "settings", preferences })).then(value => { outcome = value; });
  const stale = f.windows.at(-1);
  stale.delayClosed = true;
  owner.closePopover();
  await flush();
  assert.deepEqual(outcome, { status: "fulfilled", value: null });
  const second = owner.showPopover({ kind: "camera", devices: { cameras: [{ id: "camera:A" }] }, preferences });
  const current = f.windows.at(-1);
  stale.load.reject(new Error("canceled popover load failed late"));
  stale.deliverClosed();
  await flush();
  assert.equal(current.isDestroyed(), false);
  current.load.resolve();
  await flush();
  assert.equal(current.visible, true);
  assert.equal(owner.popoverInfo().kind, "camera");
  current.emit("blur");
  await Promise.all([first, second]);
  assert.equal(current.isDestroyed(), true);
  assert.equal(stale.showsAfterDestroy, 0);
  assert.equal(f.popoverCloses.length, 2);
  owner.dispose();
});

test("replaced popover blur and close events cannot dismiss its current successor", async () => {
  const f = fixture(), owner = f.recorder();
  await openRecorder(owner, f.windows);
  const first = owner.showPopover({ kind: "settings", preferences });
  const stale = f.windows.at(-1);
  stale.load.resolve();
  await flush();
  stale.delayClosed = true;
  const second = owner.showPopover({ kind: "system-audio", preferences });
  const current = f.windows.at(-1);
  current.load.resolve();
  await flush();
  stale.emit("blur");
  stale.deliverClosed();
  assert.equal(current.visible, true);
  assert.equal(owner.popoverInfo().kind, "system-audio");
  assert.equal(f.popoverCloses.length, 1);
  owner.closePopover();
  await Promise.all([first, second]);
  assert.equal(f.popoverCloses.length, 2);
  owner.dispose();
});

test("failed popover load permits retry and renderer failure settles the owned menu once", async () => {
  const f = fixture(), owner = f.recorder();
  await openRecorder(owner, f.windows);
  const failure = new Error("controlled popover load failure");
  const first = observe(owner.showPopover({ kind: "settings", preferences }));
  const failed = f.windows.at(-1);
  failed.load.reject(failure);
  assert.deepEqual(await first, { status: "rejected", error: failure });
  assert.equal(failed.isDestroyed(), true);
  const second = owner.showPopover({ kind: "settings", preferences });
  const crashed = f.windows.at(-1);
  crashed.load.resolve();
  await flush();
  crashed.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(await second, null);
  assert.equal(crashed.isDestroyed(), true);
  assert.equal(f.errors.length, 1);
  assert.equal(f.popoverCloses.length, 2);
  owner.dispose();
});

test("toolbar loss releases its menu and preview, revokes their capabilities, and restores once", async () => {
  const f = fixture(), owner = f.recorder(), toolbar = await openRecorder(owner, f.windows);
  const menuResult = owner.showPopover({ kind: "settings", preferences });
  const menu = f.windows.at(-1);
  const previewReady = owner.showPreview();
  const preview = f.windows.at(-1);
  menu.load.resolve();
  preview.load.resolve();
  await previewReady;
  await flush();
  for (const [window, role] of [[menu, "recorder-popover"], [preview, "camera-preview"]]) {
    const event = eventFor(window);
    assert.equal(owner.owns(event, role), true);
    assert.equal(!!owner.owns(event, "recorder"), false);
    assert.equal(!!owner.owns({ ...event, senderFrame: { url: url(role) } }, role), false);
    window.webContents.mainFrame.url = `${url(role)}#foreign`;
    assert.equal(!!owner.owns(event, role), false);
    window.webContents.mainFrame.url = url(role);
  }
  toolbar.destroy();
  assert.equal(await menuResult, null);
  assert.equal(menu.isDestroyed(), true);
  assert.equal(preview.isDestroyed(), true);
  assert.equal(!!owner.owns(eventFor(menu), "recorder-popover"), false);
  assert.equal(!!owner.owns(eventFor(preview), "camera-preview"), false);
  assert.equal(f.restorations.length, 1);
  assert.equal(f.popoverCloses.length, 1);
  assert.equal(f.previewCloses.length, 0, "owner teardown must not overwrite the user's preview preference");
  owner.dispose();
});

test("parallel preview opens share readiness and a canceled predecessor cannot affect its replacement", async () => {
  const f = fixture(), owner = f.recorder();
  const first = observe(owner.showPreview()), second = observe(owner.showPreview());
  assert.equal(f.windows.length, 1);
  const stale = f.windows[0];
  assert.equal(stale.visible, false);
  stale.delayClosed = true;
  owner.closePreview();
  const replacementReady = owner.showPreview();
  const current = f.windows.at(-1);
  stale.load.resolve();
  stale.deliverClosed();
  const outcomes = await Promise.all([first, second]);
  assert.ok(outcomes.every(outcome => outcome.status === "rejected"), "success requires the caller's exact preview to remain owned and ready");
  assert.equal(current.isDestroyed(), false);
  assert.equal(current.visible, false);
  assert.equal(f.previewCloses.length, 0);
  assert.equal(stale.showsAfterDestroy, 0);
  current.load.resolve();
  await replacementReady;
  assert.equal(current.visible, true);
  owner.dispose();
});

test("preview load failure can retry, and only external closure changes the preview preference", async () => {
  const f = fixture(), owner = f.recorder();
  const failure = new Error("controlled preview load failure"), failedReady = observe(owner.showPreview());
  const failed = f.windows.at(-1);
  failed.load.reject(failure);
  assert.deepEqual(await failedReady, { status: "rejected", error: failure });
  assert.equal(failed.isDestroyed(), true);
  assert.equal(f.previewCloses.length, 0);
  const secondReady = owner.showPreview();
  const external = f.windows.at(-1);
  external.load.resolve();
  await secondReady;
  external.destroy();
  assert.equal(f.previewCloses.length, 1);
  const thirdReady = owner.showPreview();
  const intentional = f.windows.at(-1);
  intentional.load.resolve();
  await thirdReady;
  owner.closePreview();
  assert.equal(f.previewCloses.length, 1);
  owner.dispose();
});

test("crop cancellation preserves a replacement through late predecessor load and close", async () => {
  const f = fixture(), owner = f.crop();
  const first = observe(owner.open(cropData, f.parent));
  const stale = f.windows.at(-1);
  stale.delayClosed = true;
  owner.complete(null);
  const second = observe(owner.open({ ...cropData, time: 2 }, f.parent));
  assert.equal(f.parent.listenerCount("closed"), 1, "only the current request owns parent termination");
  const current = f.windows.at(-1);
  stale.load.reject(new Error("old crop load aborted"));
  stale.deliverClosed();
  await flush();
  assert.equal(current.isDestroyed(), false);
  assert.equal(f.parent.listenerCount("closed"), 1, "late predecessor events preserve the current parent's listener");
  assert.equal(owner.owns({ sender: current.webContents, senderFrame: current.webContents.mainFrame }), true);
  current.load.resolve();
  await flush();
  assert.equal(owner.getData().time, 2);
  const crop = { x: 0.1, y: 0.2, width: 0.5, height: 0.4 };
  owner.complete(crop);
  assert.deepEqual(await first, { status: "fulfilled", value: null });
  assert.deepEqual(await second, { status: "fulfilled", value: crop });
  assert.equal(stale.showsAfterDestroy, 0);
  assert.equal(f.parent.listenerCount("closed"), 0);
});

test("crop window fits the recording aspect instead of opening a large fixed sheet", async () => {
  for (const [width, height, expectedHeight] of [[1512, 982, 720], [1440, 900, 698], [1920, 1080, 642]]) {
    const f = fixture(), owner = f.crop();
    const result = owner.open({ ...cropData, width, height }, f.parent);
    const window = f.windows.at(-1), options = window.options;
    assert.equal(options.width, 960);
    assert.equal(options.height, expectedHeight);
    assert.equal(options.parent, f.parent);
    assert.equal(options.modal, false, "a normal owned child window retains native macOS traffic lights");
    assert.equal(options.titleBarStyle, "hiddenInset");
    assert.deepEqual(options.trafficLightPosition, { x: 23, y: 22 });
    assert.equal(options.minimizable, false);
    assert.equal(options.maximizable, false);
    window.load.resolve();
    await flush();
    window.close();
    assert.equal(await result, null, "native close remains cancellation, never an implicit crop confirmation");
  }
});

test("crop window bounds fit a small offset display and reject invalid recording dimensions", async () => {
  const f = fixture(), owner = f.crop();
  const workArea = { x: -800, y: 80, width: 720, height: 560 };
  f.dependencies.screen.getDisplayMatching = () => ({ workArea });
  const result = owner.open({ ...cropData, width: 900, height: 1600 }, f.parent);
  const options = f.windows.at(-1).options;
  assert.ok(options.x >= workArea.x && options.y >= workArea.y);
  assert.ok(options.x + options.width <= workArea.x + workArea.width);
  assert.ok(options.y + options.height <= workArea.y + workArea.height);
  assert.ok(options.minWidth <= options.width && options.minHeight <= options.height);
  owner.dispose();
  assert.equal(await result, null);
  for (const width of [0, -1, NaN, Infinity]) {
    await assert.rejects(owner.open({ ...cropData, width }, f.parent), /dimensions are invalid/);
  }
  assert.equal(f.windows.length, 1, "invalid source geometry never constructs a native window");
});

test("closing the crop parent cancels and destroys its child before or after readiness", async () => {
  for (const ready of [false, true]) {
    const f = fixture(), owner = f.crop();
    const result = observe(owner.open(cropData, f.parent));
    const child = f.windows.at(-1);
    if (ready) { child.load.resolve(); await flush(); }
    f.parent.emit("closed");
    assert.deepEqual(await result, { status: "fulfilled", value: null });
    assert.equal(child.isDestroyed(), true);
    assert.equal(owner.window, null);
    assert.equal(f.parent.listenerCount("closed"), 0);
    if (!ready) child.load.reject(new Error("parent closed before crop load completed"));
    await flush();
    assert.equal(child.showsAfterDestroy, 0);
  }
});

test("failed crop load and renderer crash release the child and allow another edit", async () => {
  const f = fixture(), owner = f.crop();
  const failure = new Error("controlled crop load failure");
  const first = observe(owner.open(cropData, f.parent));
  const failedWindow = f.windows.at(-1);
  failedWindow.load.reject(failure);
  assert.deepEqual(await first, { status: "rejected", error: failure });
  assert.equal(failedWindow.isDestroyed(), true);
  assert.equal(f.parent.listenerCount("closed"), 0);

  const second = observe(owner.open(cropData, f.parent));
  const crashed = f.windows.at(-1);
  crashed.load.resolve();
  await flush();
  crashed.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  const crashResult = await second;
  assert.equal(crashResult.status, "rejected");
  assert.match(crashResult.error.message, /closed unexpectedly/);
  assert.equal(crashed.isDestroyed(), true);
  assert.equal(f.parent.listenerCount("closed"), 0);
  const third = observe(owner.open(cropData, f.parent));
  const replacement = f.windows.at(-1);
  replacement.load.resolve();
  await flush();
  owner.complete(null);
  assert.deepEqual(await third, { status: "fulfilled", value: null });
});

test("disposing a loading crop returns cancellation without showing a destroyed child", async () => {
  const f = fixture(), owner = f.crop();
  const result = observe(owner.open(cropData, f.parent));
  const loadingWindow = f.windows.at(-1);
  owner.dispose();
  loadingWindow.load.resolve();
  assert.deepEqual(await result, { status: "fulfilled", value: null });
  assert.equal(loadingWindow.isDestroyed(), true);
  assert.equal(loadingWindow.showsAfterDestroy, 0);
});

test("crop renderer failure during load is observed while native load rejection is late", async () => {
  const f = fixture(), owner = f.crop();
  const result = observe(owner.open(cropData, f.parent));
  const loadingWindow = f.windows.at(-1);
  loadingWindow.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  // The request already has a terminal error; observing the caller's public
  // promise must cover it even before native load failure arrives next turn.
  await flush();
  loadingWindow.load.reject(new Error("renderer stopped before load completed"));
  const outcome = await result;
  assert.equal(outcome.status, "rejected");
  assert.match(outcome.error.message, /closed unexpectedly/);
  assert.equal(loadingWindow.isDestroyed(), true);
});
test("area cover owns a click-through logical-display window and cancellation cannot revive it", async () => {
  const f = fixture(), owner = f.recorder(), source = { ...displaySource, bounds: { ...displaySource.bounds, x: -1920 } };
  const opening = owner.showAreaCover(source, selectedArea), window = f.windows.at(-1); window.load.resolve(); await opening;
  assert.equal(window.ignoresMouseEvents, true); assert.equal(window.options.focusable, false); assert.equal(window.getBounds().x, -1920); assert.deepEqual(owner.areaCover, { x: 10 / 1920, y: 20 / 1080, width: 300 / 1920, height: 200 / 1080 });
  owner.close(false); assert.equal(window.isDestroyed(), true); assert.equal(owner.areaCover, null);
  const late = owner.showAreaCover(source, selectedArea), pending = f.windows.at(-1); owner.closeAreaCover(); pending.load.resolve(); await late; assert.equal(pending.showsAfterDestroy, 0);
});
test("recording state updates retain a deliberately hidden status widget", async () => {
  const f = fixture(), owner = f.recorder(); await openRecorder(owner, f.windows); owner.setState({ status: "recording", startedAt: 1 }); owner.toolbar.hide();
  owner.setState({ status: "recording", startedAt: 1, paused: true }); assert.equal(owner.toolbar.isVisible(), false);
});

test("capture overlays publish the actual client frame after macOS repositions them", async () => {
  const f = fixture(), owner = f.recorder(), choice = select(owner, "window"), picker = f.windows.at(-1), sent = [];
  picker.webContents.send = (channel, value) => sent.push({ channel, value });
  picker.load.resolve(); await flush();
  picker.setBounds({ y: 33 }); picker.emit("move");
  assert.deepEqual(owner.captureInfo().viewport, { x: 0, y: 33, width: 1920, height: 1080 });
  assert.deepEqual(sent.at(-1), { channel: "reva:capture-picker-viewport", value: owner.captureInfo().viewport });
  owner.cancelCapture(); await choice;
  const covering = owner.showAreaCover(displaySource, selectedArea), cover = f.windows.at(-1);
  cover.load.resolve(); await covering;
  cover.setBounds({ y: 33 }); cover.emit("move");
  assert.equal(owner.areaCoverInfo().y, (20 - 33) / 1080, "Area overlay must not add the menu-bar offset to source coordinates");
  owner.dispose();
});

test("compact recording widget retains its center and dimensions through pause state updates", async () => {
  const f = fixture(), owner = f.recorder(), toolbar = await openRecorder(owner, f.windows);
  const center = toolbar.getBounds().x + toolbar.getBounds().width / 2;
  owner.setState({ status: "recording", startedAt: 1 });
  assert.equal(toolbar.getBounds().width, 160); assert.equal(toolbar.getBounds().height, 36);
  assert.equal(toolbar.getBounds().x + 80, center);
  owner.setState({ status: "recording", startedAt: 1, paused: true });
  assert.equal(toolbar.getBounds().x + 80, center); assert.equal(toolbar.getBounds().height, 36);
  owner.dispose();
});
