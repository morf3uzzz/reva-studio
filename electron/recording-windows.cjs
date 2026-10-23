"use strict";

/** Owns the recorder and its source picker, input menus and camera preview. */
class RecordingWindows {
  constructor({ BrowserWindow, screen, preload, url, onCancel, onError, onPopoverClosed, onPreviewClosed }) {
    Object.assign(this, { BrowserWindow, screen, preload, url, onCancel, onError, onPopoverClosed, onPreviewClosed });
    this.windows = new Map();
    this.loading = new Map();
    this.captureRequest = null;
    this.popoverRequest = null;
    this.state = { status: "idle", startedAt: null };
  }
  get toolbar() { return this.windows.get("recorder"); }
  owns(event, role) {
    const window = this.windows.get(role);
    return window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === this.url(role);
  }
  async create(role, options) {
    const window = new this.BrowserWindow({
      frame: false, show: false, transparent: true, backgroundColor: "#00000000",
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      alwaysOnTop: true, hasShadow: true, skipTaskbar: true,
      webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false, backgroundThrottling: false },
      ...options,
    });
    this.windows.set(role, window);
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.setAlwaysOnTop(true, "floating");
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => { if (url !== this.url(role)) event.preventDefault(); });
    window.webContents.on("will-attach-webview", event => event.preventDefault());
    window.webContents.on("render-process-gone", (_event, details) => {
      if (details.reason !== "clean-exit" && this.windows.get(role) === window) {
        if (role === "capture-picker") this.cancelCapture();
        if (role === "recorder-popover") this.closePopover();
        if (role === "camera-preview") window.destroy();
        if (role === "recorder") window.destroy();
        this.onError?.(new Error("The recording panel closed unexpectedly."), role);
      }
    });
    window.on("closed", () => {
      const owned = this.windows.get(role) === window;
      if (owned) this.windows.delete(role);
      if (role === "capture-picker" && owned) this.cancelCapture();
      if (role === "recorder-popover" && owned) this.closePopover();
      if (role === "camera-preview" && owned) this.onPreviewClosed?.();
      if (role === "recorder" && owned) { this.cancelCapture(); this.closePopover(); this.closePreview(); this.onCancel?.(); }
    });
    const ready = window.loadURL(this.url(role));
    this.loading.set(role, ready);
    try {
      await ready;
      if (window.isDestroyed() || this.windows.get(role) !== window) throw new Error("The recording panel was closed.");
      return window;
    } catch (error) {
      if (this.windows.get(role) === window) this.windows.delete(role);
      if (!window.isDestroyed()) window.destroy();
      throw error;
    } finally { if (this.loading.get(role) === ready) this.loading.delete(role); }
  }
  async open() {
    let window = this.toolbar;
    if (!window || window.isDestroyed()) {
      const display = this.screen.getDisplayNearestPoint(this.screen.getCursorScreenPoint());
      const area = display.workArea;
      const width = Math.min(920, area.width - 32);
      window = await this.create("recorder", { title: "REVA Studio — Recording", type: "panel", width, height: 64, x: Math.round(area.x + (area.width - width) / 2), y: area.y + area.height - 164, vibrancy: "hud", visualEffectState: "active", roundedCorners: true });
    }
    else if (this.loading.has("recorder")) await this.loading.get("recorder");
    if (window.isDestroyed() || this.toolbar !== window) throw new Error("The recording panel was closed.");
    window.show(); window.focus();
    if (this.state.status === "idle") this.publish(); else this.setState(this.state);
  }
  publish() { if (this.toolbar && !this.toolbar.isDestroyed()) this.toolbar.webContents.send("reva:recorder-state", this.state); }
  setState(state) {
    const wasVisible = this.toolbar?.isVisible?.() ?? true, enteringRecording = this.state.status === "idle";
    this.state = state; this.publish();
    if (state.status !== "idle") {
      const window = this.toolbar;
      if (window && !window.isDestroyed()) {
        const bounds = window.getBounds();
        window.setBounds({ x: bounds.x + Math.round((bounds.width - 296) / 2), y: bounds.y, width: 296, height: 64 });
        if (enteringRecording || wasVisible) window.showInactive();
      }
    }
  }
  close(restore = true) {
    this.closeAreaCover();
    this.cancelCapture();
    this.closePopover();
    this.closePreview();
    const window = this.toolbar;
    if (window && !window.isDestroyed()) { this.windows.delete("recorder"); window.destroy(); }
    this.state = { status: "idle", startedAt: null };
    if (restore) this.onCancel?.();
  }
  async selectSource(mode, sources, preferences, savedAreas, selectedDisplay) {
    if (this.captureRequest) throw new Error("Finish selecting the recording area first.");
    const toolbar = this.toolbar;
    this.closePopover();
    const display = selectedDisplay
      ? this.screen.getAllDisplays().find(item => item.id === Number(selectedDisplay.id.split(":")[1]))
      : toolbar ? this.screen.getDisplayMatching(toolbar.getBounds()) : this.screen.getDisplayNearestPoint(this.screen.getCursorScreenPoint());
    if (!display) throw new Error("That display is no longer available.");
    let resolve, reject;
    const result = new Promise((done, fail) => { resolve = done; reject = fail; });
    const request = { resolve, data: { mode, sources, display: display.bounds, fps: preferences.fps, autoZoom: preferences.autoZoom, afterRecording: preferences.afterRecording, quickExportSettings: preferences.quickExportSettings, savedAreas } };
    this.captureRequest = request;
    toolbar?.hide();
    void this.create("capture-picker", { title: "REVA Studio — Select recording source", ...display.bounds, hasShadow: false, movable: false }).then(window => {
      if (this.captureRequest === request) { window.show(); window.focus(); }
    }).catch(error => {
      if (this.captureRequest === request) { this.captureRequest = null; reject(error); }
    });
    return result.finally(() => { if (this.toolbar === toolbar && toolbar && !toolbar.isDestroyed() && !this.captureRequest) toolbar.show(); });
  }
  async showAreaCover(source, area) {
    this.closeAreaCover();
    if (!area || source.kind !== "display" || !source.bounds) return;
    const data = { x: area.x / source.width, y: area.y / source.height, width: area.width / source.width, height: area.height / source.height };
    this.areaCover = data;
    let window;
    try { window = await this.create("recording-area-cover", { title: "REVA Studio — Recording area", ...source.bounds, x: Math.round(source.bounds.x), y: Math.round(source.bounds.y), width: Math.round(source.bounds.width), height: Math.round(source.bounds.height), hasShadow: false, movable: false, focusable: false, roundedCorners: false }); }
    catch (error) { if (this.areaCover !== data) return; throw error; }
    if (this.areaCover !== data) return;
    window.setIgnoreMouseEvents(true, { forward: true }); window.showInactive();
  }
  closeAreaCover() { this.areaCover = null; const window = this.windows.get("recording-area-cover"); if (window && !window.isDestroyed()) window.destroy(); }
  captureInfo() { if (!this.captureRequest) throw new Error("No recording source is being selected."); return this.captureRequest.data; }
  captureArea(value, source) {
    if (!value || typeof value !== "object" || ![value.x, value.y, value.width, value.height].every(Number.isFinite) || value.x < 0 || value.y < 0 || value.width < 150 || value.height < 150 || value.x + value.width > source.width || value.y + value.height > source.height) throw new Error("The recording area must fit inside the display and be at least 150 × 150 pixels.");
    return { x: value.x, y: value.y, width: value.width, height: value.height };
  }
  prepareCapture(input) {
    const request = this.captureRequest;
    if (!request) throw new Error("No recording source is being selected.");
    if (input === null) return { request, selection: null };
    const source = request.data.sources.find(item => item.id === input?.sourceID);
    if (!source) throw new Error("That source is no longer available. Select a source again.");
    if (input.area && source.kind !== "display") throw new Error("An area must belong to a display.");
    return { request, selection: { source, ...(input.area ? { area: this.captureArea(input.area, source) } : {}) } };
  }
  finishCapture(prepared) {
    if (this.captureRequest !== prepared.request) return;
    this.captureRequest = null;
    this.windows.get("capture-picker")?.destroy();
    prepared.request.resolve(prepared.selection);
  }
  cancelCapture() { if (this.captureRequest) this.finishCapture({ request: this.captureRequest, selection: null }); }
  async showPopover(data, position) {
    this.closePopover();
    const toolbar = this.toolbar;
    if (!toolbar || toolbar.isDestroyed()) throw new Error("The recording panel is not open.");
    const parent = toolbar.getBounds(), display = this.screen.getDisplayMatching(parent).workArea;
    const width = data.kind === "screen-permission" ? 340 : 300, desiredHeight = data.kind === "screen-permission" ? 280 : data.kind === "settings" ? 410 : data.kind === "camera" ? 112 + data.devices.cameras.length * 26 : data.kind === "microphone" ? 160 + data.devices.microphones.length * 34 : Math.min(480, 105 + (data.applications?.length ?? 0) * 28);
    const height = Math.min(desiredHeight, display.height - 16);
    const left = Math.round(Math.max(display.x + 8, Math.min(display.x + display.width - width - 8, parent.x + (Number(position?.x) || 0))));
    const below = parent.y + parent.height + 3;
    const top = below + height < display.y + display.height ? below : Math.max(display.y + 8, parent.y - height - 3);
    let resolve, reject;
    const result = new Promise((done, fail) => { resolve = done; reject = fail; });
    const request = { data, resolve };
    this.popoverRequest = request;
    void this.create("recorder-popover", { title: "REVA Studio — Recording options", type: "panel", width, height, x: left, y: top, vibrancy: "hud", visualEffectState: "active" }).then(window => {
      if (this.popoverRequest === request) {
        window.show(); window.focus();
        window.on("blur", () => { if (this.popoverRequest === request) this.closePopover(); });
      }
    }).catch(error => {
      if (this.popoverRequest === request) { this.popoverRequest = null; reject(error); this.onPopoverClosed?.(); }
    });
    return result;
  }
  popoverInfo() { if (!this.popoverRequest) throw new Error("No recording menu is open."); return this.popoverRequest.data; }
  closePopover(result = null) {
    const request = this.popoverRequest;
    if (!request) return;
    this.popoverRequest = null;
    const window = this.windows.get("recorder-popover");
    if (window && !window.isDestroyed()) { this.windows.delete("recorder-popover"); window.destroy(); }
    request.resolve(result); this.onPopoverClosed?.();
  }
  async showPreview() {
    let window = this.windows.get("camera-preview");
    if (!window || window.isDestroyed()) {
      const toolbar = this.toolbar;
      const display = toolbar ? this.screen.getDisplayMatching(toolbar.getBounds()) : this.screen.getDisplayNearestPoint(this.screen.getCursorScreenPoint());
      const area = display.workArea;
      window = await this.create("camera-preview", { title: "REVA Studio — Camera preview", type: "panel", width: 240, height: 240, x: area.x + area.width - 266, y: area.y + area.height - 266 });
    } else if (this.loading.has("camera-preview")) await this.loading.get("camera-preview");
    if (window.isDestroyed() || this.windows.get("camera-preview") !== window) throw new Error("The camera preview was closed.");
    window.showInactive();
  }
  closePreview() { const window = this.windows.get("camera-preview"); if (window && !window.isDestroyed()) { this.windows.delete("camera-preview"); window.destroy(); } }
  broadcast(channel, value) { for (const role of ["recorder", "recorder-popover", "camera-preview"]) { const window = this.windows.get(role); if (window && !window.isDestroyed()) window.webContents.send(channel, value); } }
  dispose() { this.close(false); for (const [role, window] of [...this.windows]) if (window && !window.isDestroyed()) { window.destroy(); if (window.isDestroyed()) this.windows.delete(role); } }
}

module.exports = { RecordingWindows };
