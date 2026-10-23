"use strict";

const layout = require("../shared/crop-editor-layout.json");

function cropRectangle(value) {
  if (!value || typeof value !== "object" || ![value.x, value.y, value.width, value.height].every(Number.isFinite) || value.x < 0 || value.y < 0 || value.width <= 0 || value.height <= 0 || value.x + value.width > 1.000000001 || value.y + value.height > 1.000000001) throw new Error("The crop must fit inside the recording.");
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function windowBounds(data, area) {
  if (![data.width, data.height].every(value => Number.isFinite(value) && value >= 1)) throw new Error("The recording dimensions are invalid.");
  const maxWidth = Math.max(1, Math.min(layout.width, area.width - layout.screenMarginX * 2));
  const maxHeight = Math.max(1, Math.min(layout.maxHeight, area.height - layout.screenMarginY * 2));
  const chromeHeight = layout.toolbarHeight + layout.footerHeight;
  const scale = Math.min(Math.max(1, maxWidth - layout.frameInset * 2) / data.width, Math.max(1, maxHeight - chromeHeight) / data.height);
  const width = Math.min(maxWidth, Math.max(layout.minWidth, Math.ceil(data.width * scale) + layout.frameInset * 2));
  const height = Math.min(maxHeight, Math.max(layout.minHeight, Math.ceil(data.height * scale) + chromeHeight));
  return { width, height, x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2) };
}

class CropWindow {
  constructor({ BrowserWindow, screen, preload, url }) { Object.assign(this, { BrowserWindow, screen, preload, url }); this.window = null; this.request = null; }
  owns(event) { const w = this.window; return w && !w.isDestroyed() && event.sender === w.webContents && event.senderFrame === w.webContents.mainFrame && event.senderFrame.url === this.url; }
  async open(data, parent) {
    if (this.request) { this.window?.focus(); throw new Error("Finish the open crop editor first."); }
    if (this.window && !this.window.isDestroyed()) throw new Error("The previous crop editor has not closed.");
    const crop = cropRectangle(data.crop);
    const area = this.screen.getDisplayMatching(parent.getBounds()).workArea;
    const bounds = windowBounds(data, area);
    // A macOS sheet hides the native traffic lights. Keep this as an owned child
    // window so the close button uses the same cancellation path as Discard.
    const window = new this.BrowserWindow({ parent, modal: false, title: "REVA Studio — Crop", ...bounds, minWidth: Math.min(layout.minWidth, bounds.width), minHeight: Math.min(layout.minHeight, bounds.height), minimizable: false, maximizable: false, fullscreenable: false, show: false, backgroundColor: "#272727", frame: true, titleBarStyle: "hiddenInset", trafficLightPosition: { x: 23, y: 22 }, webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false } });
    this.window = window;
    let resolve, reject;
    const result = new Promise((done, fail) => { resolve = done; reject = fail; });
    const request = { data: { ...data, crop }, resolve, reject, window, parent, onParentClosed: () => { if (this.request === request) this.complete(null); } };
    this.request = request;
    parent.once("closed", request.onParentClosed);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => { if (url !== this.url) event.preventDefault(); });
    window.webContents.on("will-attach-webview", event => event.preventDefault());
    window.webContents.on("render-process-gone", (_event, details) => { if (details.reason !== "clean-exit" && this.request === request) { this.finishRequest(request, null, new Error("The crop editor closed unexpectedly.")); window.destroy(); } });
    window.on("closed", () => { if (this.window === window) this.window = null; this.finishRequest(request, null); });
    try {
      void window.loadURL(this.url).then(() => { if (this.window === window && this.request === request && !window.isDestroyed()) window.show(); }).catch(error => {
        this.finishRequest(request, null, error);
        if (!window.isDestroyed()) window.destroy();
      });
    } catch (error) { this.finishRequest(request, null, error); if (!window.isDestroyed()) window.destroy(); }
    return result;
  }
  finishRequest(request, value, error) {
    if (this.request !== request) return;
    request.parent.removeListener("closed", request.onParentClosed);
    this.request = null;
    if (error) request.reject(error); else request.resolve(value);
  }
  getData() { if (!this.request) throw new Error("The crop editor is not open."); return this.request.data; }
  complete(value) { if (!this.request) throw new Error("The crop editor is not open."); const crop = value === null ? null : cropRectangle(value); const pending = this.request; this.finishRequest(pending, crop); if (!pending.window.isDestroyed()) pending.window.destroy(); }
  dispose() { if (this.request) this.complete(null); else if (this.window && !this.window.isDestroyed()) this.window.destroy(); }
}

module.exports = { CropWindow, cropRectangle };
