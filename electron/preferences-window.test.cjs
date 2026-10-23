"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { PreferencesWindow } = require("./preferences-window.cjs");
const flush = () => new Promise(resolve => setImmediate(resolve));
const observe = promise => promise.then(value => ({ status: "fulfilled", value }), error => ({ status: "rejected", error }));

function fixture() {
  const windows = [], errors = [], url = "reva-app://app/index.html?surface=preferences";
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.bounds = { ...options }; this.destroyed = false; this.visible = false; this.messages = [];
      this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: "" };
      this.webContents.send = (channel, value) => this.messages.push({ channel, value });
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
      this.load = new Promise((resolve, reject) => { this.ready = resolve; this.fail = reject; });
      windows.push(this);
    }
    loadURL(url) { this.webContents.mainFrame.url = url; return this.load; }
    isDestroyed() { return this.destroyed; }
    getBounds() { return this.bounds; }
    setBounds(value) { this.bounds = value; }
    show() { assert.equal(this.destroyed, false); this.visible = true; }
    focus() {}
    destroy() {
      if (this.failDestroy) { this.failDestroy = false; throw new Error("controlled native close failure"); }
      this.destroyed = true; this.visible = false;
      if (!this.delayClose) this.emit("closed");
    }
  }
  const display = { workArea: { x: 0, y: 24, width: 1440, height: 876 } };
  const owner = new PreferencesWindow({ BrowserWindow: FakeWindow, screen: { getDisplayMatching: () => display, getDisplayNearestPoint: () => display, getCursorScreenPoint: () => ({ x: 0, y: 0 }) }, preload: "/controlled/preload.cjs", url, onError: error => errors.push(error) });
  return { owner, windows, errors, url, event: window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame }) };
}

test("settings opens share readiness and keep the latest requested tab on reuse", async () => {
  const f = fixture(), first = f.owner.open("general"), second = f.owner.open("shortcuts");
  const window = f.windows[0];
  assert.equal(f.windows.length, 1);
  assert.equal(window.visible, false);
  assert.equal(window.options.width, 840);
  assert.deepEqual(window.options.trafficLightPosition, { x: 23, y: 22 });
  assert.equal(window.options.titleBarStyle, "hiddenInset");
  window.ready();
  await Promise.all([first, second]);
  assert.equal(window.visible, true);
  assert.equal(f.owner.getTab(), "shortcuts");
  assert.ok(window.messages.every(message => message.channel === "reva:preferences-tab" && message.value === "shortcuts"));
  await f.owner.open("editing");
  assert.equal(f.windows.length, 1);
  assert.equal(window.messages.at(-1).value, "editing");
  f.owner.dispose();
});

test("closed settings readiness and late native closure cannot affect a replacement", async () => {
  const f = fixture(), first = observe(f.owner.open()), second = observe(f.owner.open("recording"));
  const stale = f.windows[0];
  stale.delayClose = true;
  f.owner.close();
  const currentReady = f.owner.open("widget"), current = f.windows.at(-1);
  stale.ready(); stale.emit("closed");
  assert.ok((await Promise.all([first, second])).every(result => result.status === "rejected"));
  assert.equal(current.destroyed, false);
  assert.equal(current.visible, false);
  current.ready(); await currentReady;
  assert.equal(current.visible, true);
  assert.equal(f.owner.getTab(), "widget");
  f.owner.dispose();
});

test("failed settings loading retains failed cleanup until the same window can be released", async () => {
  const f = fixture(), first = observe(f.owner.open());
  const failed = f.windows[0], failure = new Error("controlled settings load failure");
  failed.failDestroy = true; failed.fail(failure);
  const outcome = await first;
  assert.equal(outcome.status, "rejected");
  assert.ok(outcome.error instanceof AggregateError);
  assert.equal(outcome.error.cause, failure);
  assert.equal(f.owner.window, failed);
  assert.equal(failed.isDestroyed(), false);
  const retry = f.owner.open("recording"), current = f.windows.at(-1);
  assert.equal(failed.isDestroyed(), true);
  assert.notEqual(current, failed);
  current.ready(); await retry;
  assert.equal(current.visible, true);
  f.owner.dispose();
});

test("settings renderer failure releases only its owner and permits a fresh open", async () => {
  const f = fixture(), ready = f.owner.open(), old = f.windows[0];
  old.ready(); await ready;
  old.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(old.isDestroyed(), true);
  assert.equal(f.errors.length, 1);
  const replacementReady = f.owner.open(), current = f.windows.at(-1);
  old.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(current.isDestroyed(), false);
  current.ready(); await replacementReady;
  assert.equal(f.errors.length, 1);
  f.owner.dispose();
});

test("settings capability requires its exact live window, main frame, and URL", async () => {
  const f = fixture(), opening = f.owner.open(), window = f.windows[0];
  window.ready(); await opening;
  const event = f.event(window);
  assert.equal(f.owner.owns(event), true);
  assert.equal(f.owner.owns({ ...event, sender: {} }), false);
  assert.equal(f.owner.owns({ ...event, senderFrame: { url: f.url } }), false);
  window.webContents.mainFrame.url += "#foreign";
  assert.equal(f.owner.owns(event), false);
  window.webContents.mainFrame.url = f.url;
  let prevented = 0;
  window.webContents.emit("will-navigate", { preventDefault: () => prevented++ }, "https://foreign.invalid/");
  window.webContents.emit("will-attach-webview", { preventDefault: () => prevented++ });
  assert.equal(prevented, 2);
  assert.deepEqual(window.openHandler(), { action: "deny" });
  f.owner.close();
  assert.equal(f.owner.owns(event), false);
});

test("measured settings height is rounded and bounded by its current display", async () => {
  const f = fixture(), opening = f.owner.open(), window = f.windows[0];
  window.ready(); await opening;
  f.owner.resize(610.2);
  assert.equal(window.bounds.width, 840);
  assert.equal(window.bounds.height, 611);
  f.owner.resize(100000);
  assert.equal(window.bounds.height, 852);
  assert.equal(window.bounds.y, 36);
  for (const invalid of [NaN, Infinity, -1, 0, "610"]) assert.throws(() => f.owner.resize(invalid), /positive number/);
  await assert.rejects(f.owner.open("foreign"), /valid settings tab/);
  assert.equal(f.windows.length, 1);
  f.owner.dispose();
  await flush();
});
