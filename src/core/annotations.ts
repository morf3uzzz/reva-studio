import type { Project } from "../types.ts";
import type { Rect } from "./model.ts";
import { clamp, getCursorAtTime, sourcePointToScreen } from "./model.ts";
import { privacyRegionsAtTime } from "./privacy.ts";
import { drawCursorFrame } from "./cursor-render.ts";
export interface ManualMask { id: string; start: number; end: number; type: "sensitive-data" | "highlight"; bounds: Rect[]; blur: number; opacity: number; disabled?: boolean }
export interface RecordedShortcut { id: string; time: number; keys: string[]; keyCode?: number; duration?: number; hidden?: boolean }
export interface ShortcutSettings { enabled: boolean; style: "mac" | "windows"; sizeRatio: number; position: { x: number; y: number }; duration: number; background: string; color: string }
export const defaultShortcutSettings = (): ShortcutSettings => ({ enabled: true, style: "mac", sizeRatio: .055, position: { x: .5, y: .9 }, duration: 1.5, background: "#17171f", color: "#ffffff" });
export function sourceRectToScreen(region: Rect, crop: Rect, screen: Rect): Rect | null {
  const x = Math.max(region.x, crop.x), y = Math.max(region.y, crop.y), right = Math.min(region.x + region.width, crop.x + crop.width), bottom = Math.min(region.y + region.height, crop.y + crop.height);
  return right > x && bottom > y ? { x: screen.x + (x - crop.x) / crop.width * screen.width, y: screen.y + (y - crop.y) / crop.height * screen.height, width: (right - x) / crop.width * screen.width, height: (bottom - y) / crop.height * screen.height } : null;
}
const highlightSurfaces = new WeakMap<CanvasRenderingContext2D, HTMLCanvasElement>();
export function drawManualMasks(context: CanvasRenderingContext2D, project: Project, time: number, source: CanvasImageSource, crop: Rect, screen: Rect, pixelScale: number): void {
  const active = (project.masks ?? []).filter(mask => !mask.disabled && time >= mask.start && time < mask.end);
  const highlights = active.filter(mask => mask.type === "highlight");
  if (highlights.length) {
    let layer = highlightSurfaces.get(context); if (!layer) { layer = document.createElement("canvas"); highlightSurfaces.set(context, layer); }
    if (layer.width !== context.canvas.width) layer.width = context.canvas.width; if (layer.height !== context.canvas.height) layer.height = context.canvas.height;
    const drawing = layer.getContext("2d")!; drawing.clearRect(0, 0, layer.width, layer.height); drawing.globalCompositeOperation = "source-over";
    drawing.fillStyle = `rgba(0,0,0,${Math.max(...highlights.map(mask => mask.opacity))})`; drawing.fillRect(0, 0, layer.width, layer.height); drawing.globalCompositeOperation = "destination-out";
    for (const mask of highlights) for (const rect of mask.bounds) { const box = sourceRectToScreen(rect, crop, screen); if (box) drawing.fillRect(box.x, box.y, box.width, box.height); }
    context.drawImage(layer, 0, 0); drawing.globalCompositeOperation = "source-over";
  }
  const input = source as HTMLVideoElement & HTMLImageElement, width = input.videoWidth || input.naturalWidth || input.width || project.width, height = input.videoHeight || input.naturalHeight || input.height || project.height;
  for (const mask of active.filter(mask => mask.type === "sensitive-data")) for (const region of mask.bounds) {
    const box = sourceRectToScreen(region, crop, screen); if (!box) continue;
    context.save(); context.beginPath(); context.rect(box.x, box.y, box.width, box.height); context.clip();
    if (mask.blur > 0) { context.filter = `blur(${mask.blur * pixelScale}px)`; context.drawImage(source, crop.x * width, crop.y * height, crop.width * width, crop.height * height, screen.x, screen.y, screen.width, screen.height); }
    else { context.fillStyle = "#15151b"; context.fillRect(box.x, box.y, box.width, box.height); }
    context.restore();
  }
}
export function loupeAt(project: Project, time: number) { return project.zooms.find(zoom => zoom.presentation === "loupe" && !zoom.disabled && time >= zoom.start && time < zoom.end) ?? null; }
export function drawLoupe(context: CanvasRenderingContext2D, project: Project, time: number, source: CanvasImageSource | undefined, crop: Rect, screen: Rect, pixelScale: number): void {
  const zoom = loupeAt(project, time); if (!zoom || !source) return;
  const cursor = zoom.mode === "auto" ? getCursorAtTime(project.cursor, time) : null, target = cursor ?? zoom;
  const focus = sourcePointToScreen(target, crop, screen), settings = zoom.loupeOptions ?? { radius01: .35, bevelRatio: .2, chromaticAberration: .5, hasGlassOptics: true };
  const radius = Math.max(8, Math.min(screen.width, screen.height) * settings.radius01 / 2), x = clamp(focus.x, radius, context.canvas.width - radius), y = clamp(focus.y, radius, context.canvas.height - radius);
  const video = source as HTMLVideoElement & HTMLImageElement, width = video.videoWidth || video.naturalWidth || video.width || project.width, height = video.videoHeight || video.naturalHeight || video.height || project.height;
  const sampleWidth = radius * 2 / screen.width * crop.width * width / zoom.scale, sampleHeight = radius * 2 / screen.height * crop.height * height / zoom.scale;
  const sx = clamp(target.x * width - sampleWidth / 2, 0, Math.max(0, width - sampleWidth)), sy = clamp(target.y * height - sampleHeight / 2, 0, Math.max(0, height - sampleHeight));
  context.save(); context.shadowColor = "#00000066"; context.shadowBlur = 14 * pixelScale; context.shadowOffsetY = 4 * pixelScale; context.fillStyle = "#fff"; context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill(); context.shadowColor = "transparent"; context.clip();
  context.drawImage(source, sx, sy, sampleWidth, sampleHeight, x - radius, y - radius, radius * 2, radius * 2);
  const lensCrop = { x: sx / width, y: sy / height, width: sampleWidth / width, height: sampleHeight / height }, lensScreen = { x: x - radius, y: y - radius, width: radius * 2, height: radius * 2 };
  drawManualMasks(context, project, time, source, lensCrop, lensScreen, pixelScale);
  for (const region of privacyRegionsAtTime(project, time)) {
    const box = sourceRectToScreen(region, lensCrop, lensScreen); if (!box) continue;
    context.save(); context.beginPath(); context.rect(box.x, box.y, box.width, box.height); context.clip();
    if (region.kind === "face") { context.filter = `blur(${Math.max(12 * pixelScale, Math.min(box.width, box.height) * .12)}px)`; context.drawImage(source, sx, sy, sampleWidth, sampleHeight, lensScreen.x, lensScreen.y, lensScreen.width, lensScreen.height); }
    else { context.fillStyle = "#181820"; context.fillRect(box.x, box.y, box.width, box.height); }
    context.restore();
  }
  drawCursorFrame(context, project, time, lensCrop, lensScreen, pixelScale);
  if (settings.hasGlassOptics) { const bevel = context.createRadialGradient(x, y, radius * (1 - settings.bevelRatio), x, y, radius); bevel.addColorStop(0, "#ffffff00"); bevel.addColorStop(.7, "#ffffff0a"); bevel.addColorStop(1, "#ffffff77"); context.fillStyle = bevel; context.fillRect(x - radius, y - radius, radius * 2, radius * 2); }
  if (settings.chromaticAberration > 0) { context.strokeStyle = `rgba(90,130,255,${settings.chromaticAberration * .35})`; context.lineWidth = Math.max(1, radius * .015 * settings.chromaticAberration); context.beginPath(); context.arc(x - settings.chromaticAberration * pixelScale, y, radius - context.lineWidth / 2, 0, Math.PI * 2); context.stroke(); }
  context.restore();
}
export function shortcutsAt(project: Project, time: number): RecordedShortcut[] {
  const settings = project.shortcutSettings ?? defaultShortcutSettings(); if (!settings.enabled) return [];
  return (project.shortcuts ?? []).filter(event => !event.hidden && time >= event.time && time < event.time + (event.duration ?? settings.duration)).slice(-1);
}
export function shortcutKeyLabels(keys: readonly string[], style: ShortcutSettings["style"]): string[] {
  const symbols: Record<string, string> = style === "mac" ? { command: "⌘", option: "⌥", control: "⌃", shift: "⇧", Enter: "↩", Backspace: "⌫", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Space: "Space", Escape: "esc" } : { command: "Win", option: "Alt", control: "Ctrl", shift: "Shift" };
  return keys.map(key => symbols[key] ?? key);
}
export function drawShortcutOverlay(context: CanvasRenderingContext2D, project: Project, time: number, width: number, height: number): void {
  const event = shortcutsAt(project, time).at(-1); if (!event) return;
  const settings = project.shortcutSettings ?? defaultShortcutSettings(), size = Math.min(width, height) * settings.sizeRatio;
  context.save(); context.font = `500 ${size}px -apple-system, BlinkMacSystemFont, sans-serif`; context.textAlign = "center"; context.textBaseline = "middle";
  const labels = shortcutKeyLabels(event.keys, settings.style), widths = labels.map(label => Math.max(size * 1.1, context.measureText(label).width + size * .65)), gap = size * .14, total = widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1), keyHeight = size * 1.5;
  let x = clamp(settings.position.x * width - total / 2, size * .2, width - total - size * .2), y = clamp(settings.position.y * height - keyHeight / 2, 0, height - keyHeight);
  const fade = Math.min(1, (time - event.time) / .08, (event.time + (event.duration ?? settings.duration) - time) / .16); context.globalAlpha *= Math.max(0, fade);
  labels.forEach((label, index) => { context.fillStyle = settings.background; context.beginPath(); context.roundRect(x, y, widths[index], keyHeight, size * .2); context.fill(); context.strokeStyle = "#ffffff30"; context.lineWidth = Math.max(1, size * .025); context.stroke(); context.fillStyle = settings.color; context.fillText(label, x + widths[index] / 2, y + keyHeight / 2); x += widths[index] + gap; });
  context.restore();
}
