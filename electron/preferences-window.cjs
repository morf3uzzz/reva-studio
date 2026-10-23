"use strict";

const TABS = new Set(["general", "recording", "editing", "widget", "shortcuts", "advanced"]);
function preferencesTab(value) {
  if (!TABS.has(value)) throw new Error("Choose a valid settings tab.");
  return value;
}

/** Owns settings readiness independently from the current tab and its contents. */
class PreferencesWindow {
  constructor({ BrowserWindow, screen, preload, url, initialTab = "general", onError }) {
    Object.assign(this, { BrowserWindow, screen, preload, url, onError });
    this.tab = preferencesTab(initialTab);
    this.window = null;
    this.loading = null;
    this.failure = null;
  }
  owns(event) {
    const window = this.window;
    return !!window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === this.url;
  }
  getTab() { return this.tab; }
  send(channel, value) { if (this.window && !this.window.isDestroyed()) this.window.webContents.send(channel, value); }
  async open(tab = this.tab, parent) {
    this.tab = preferencesTab(tab);
    if (this.failure?.window === this.window) this.close();
    let window = this.window;
    if (!window || window.isDestroyed()) {
      const display = parent && !parent.isDestroyed() ? this.screen.getDisplayMatching(parent.getBounds()) : this.screen.getDisplayNearestPoint(this.screen.getCursorScreenPoint());
      const area = display.workArea, width = 840, height = Math.min(560, area.height - 24);
      window = new this.BrowserWindow({
        title: "Settings", width, height, x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2),
        show: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, acceptFirstMouse: true,
        titleBarStyle: "hiddenInset", trafficLightPosition: { x: 23, y: 22 }, vibrancy: "window", visualEffectState: "active", backgroundColor: "#00000000",
        webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
      });
      this.window = window;
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, url) => { if (url !== this.url) event.preventDefault(); });
      window.webContents.on("will-attach-webview", event => event.preventDefault());
      window.webContents.on("render-process-gone", (_event, details) => {
        if (details.reason === "clean-exit" || this.window !== window) return;
        const error = new Error("The settings window closed unexpectedly.");
        try { this.close(); this.onError?.(error); }
        catch (cleanup) { this.onError?.(new AggregateError([error, cleanup], "The settings window could not be closed.", { cause: error })); }
      });
      window.on("closed", () => { if (this.window === window) { this.window = null; this.failure = null; } });
      const entry = { window, ready: null };
      this.loading = entry;
      entry.ready = this.load(window);
    }
    const entry = this.loading;
    try {
      if (entry?.window === window) await entry.ready;
      if (window.isDestroyed() || this.window !== window) throw new Error("The settings window was closed.");
      this.send("reva:preferences-tab", this.tab);
      window.show(); window.focus();
    } finally { if (this.loading === entry) this.loading = null; }
  }
  async load(window) {
    try { await window.loadURL(this.url); }
    catch (error) {
      if (this.window === window) this.failure = { window, error };
      try {
        if (!window.isDestroyed()) window.destroy();
        if (this.window === window) { this.window = null; this.failure = null; }
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "The settings window failed to load and still needs cleanup.", { cause: error });
      }
      throw error;
    }
  }
  resize(height) {
    if (!Number.isFinite(height) || height <= 0) throw new Error("The settings height must be a positive number.");
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    const bounds = window.getBounds(), area = this.screen.getDisplayMatching(bounds).workArea;
    const maximum = Math.max(1, area.height - 24);
    const nextHeight = Math.min(maximum, Math.max(Math.min(200, maximum), Math.ceil(height)));
    window.setBounds({ x: bounds.x, y: Math.max(area.y + 12, Math.min(bounds.y, area.y + area.height - nextHeight - 12)), width: 840, height: nextHeight });
  }
  close() {
    const window = this.window;
    if (!window) return;
    if (!window.isDestroyed()) window.destroy();
    if (this.window === window) { this.window = null; this.failure = null; }
  }
  dispose() { this.close(); }
}

module.exports = { PreferencesWindow, preferencesTab };
