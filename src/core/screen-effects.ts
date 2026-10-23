import type { Rect } from "./model.ts";

export interface DeviceFrameSettings { type: "none" | "phone" | "tablet"; color: string; bezelRatio: number }
export interface ScreenProcessingSettings { deband: number }
export interface ScreenShadowSettings { style: "classic" | "directional"; distance: number; angle: number; blur: number }
export const defaultScreenShadow = (): ScreenShadowSettings => ({ style: "classic", distance: 25, angle: 90, blur: 20 });
/** One composition path owns preview and export. Older documents retain their existing shadow. */
export function screenShadowGeometry(intensity: number, settings: ScreenShadowSettings | undefined, scale: number) {
  if (!settings) return { blur: (12 + 60 * intensity) * scale, x: 0, y: 12 * intensity * scale };
  const radians = settings.angle * Math.PI / 180;
  const distance = settings.distance * scale;
  return { blur: settings.blur * (settings.style === "classic" ? 3 : 1) * scale, x: Math.cos(radians) * distance, y: Math.sin(radians) * distance };
}

export interface ScreenEnhancement {
  path: string; sourcePath: string; sourceSHA256: string;
  modelSHA256: string; modelName: string;
  width: number; height: number; duration: number; sourceStartTime: number;
  scale: number; enabled: boolean; attribution?: string;
}
export type SocialSafeArea = "off" | "tiktok" | "instagram";
export const defaultDeviceFrame = (): DeviceFrameSettings => ({ type: "none", color: "#34343a", bezelRatio: .035 });
export const defaultScreenProcessing = (): ScreenProcessingSettings => ({ deband: 0 });

/** Fit the complete independent bezel inside the resting content bounds. */
export function deviceScreenRect(bounds: Rect, settings: DeviceFrameSettings | undefined): Rect {
  if (!settings || settings.type === "none") return bounds;
  const aspect = bounds.width / bounds.height, margin = Math.min(bounds.width, bounds.height) * settings.bezelRatio;
  const width = Math.min(bounds.width - margin * 2, (bounds.height - margin * 2) * aspect), height = width / aspect;
  return { x: bounds.x + (bounds.width - width) / 2, y: bounds.y + (bounds.height - height) / 2, width, height };
}
export function deviceFrameRect(screen: Rect, settings: DeviceFrameSettings): Rect {
  const margin = Math.min(screen.width, screen.height) * settings.bezelRatio;
  return { x: screen.x - margin, y: screen.y - margin, width: screen.width + margin * 2, height: screen.height + margin * 2 };
}
export function deviceScreenRadius(screen: Rect, settings: DeviceFrameSettings): number { return Math.min(screen.width, screen.height) * (settings.type === "phone" ? .11 : .045); }

/** Original generic bezels; no vendor device artwork or model identity is inferred. */
export function drawDeviceFrame(context: CanvasRenderingContext2D, screen: Rect, settings: DeviceFrameSettings | undefined): void {
  if (!settings || settings.type === "none") return;
  const outside = deviceFrameRect(screen, settings), margin = (outside.width - screen.width) / 2, radius = deviceScreenRadius(screen, settings);
  context.save();
  context.shadowColor = "#00000066"; context.shadowBlur = margin * 2; context.shadowOffsetY = margin * .7;
  context.beginPath(); context.roundRect(outside.x, outside.y, outside.width, outside.height, radius + margin);
  context.roundRect(screen.x, screen.y, screen.width, screen.height, radius);
  context.fillStyle = settings.color; context.fill("evenodd");
  context.shadowColor = "transparent"; context.lineWidth = Math.max(.5, margin * .11);
  context.strokeStyle = "#ffffff66"; context.beginPath(); context.roundRect(outside.x + context.lineWidth, outside.y + context.lineWidth, outside.width - context.lineWidth * 2, outside.height - context.lineWidth * 2, radius + margin); context.stroke();
  context.strokeStyle = "#000000cc"; context.lineWidth = margin * .3;
  context.beginPath(); context.roundRect(screen.x, screen.y, screen.width, screen.height, radius); context.stroke();
  const portrait = screen.height >= screen.width;
  context.fillStyle = "#08080a";
  if (settings.type === "phone") {
    const pillWidth = Math.min(screen.width, screen.height) * .27, pillHeight = Math.min(screen.width, screen.height) * .065;
    context.beginPath();
    if (portrait) context.roundRect(screen.x + (screen.width - pillWidth) / 2, screen.y + pillHeight * .3, pillWidth, pillHeight, pillHeight / 2);
    else context.roundRect(screen.x + pillHeight * .3, screen.y + (screen.height - pillWidth) / 2, pillHeight, pillWidth, pillHeight / 2);
    context.fill();
  } else {
    context.beginPath(); context.arc(screen.x + screen.width / 2, outside.y + margin / 2, Math.max(.7, margin * .13), 0, Math.PI * 2); context.fill();
  }
  context.restore();
}

/** Approximate composition guides, deliberately separate from platform UI specifications. */
export function socialSafeRect(mode: SocialSafeArea, width: number, height: number): Rect | null {
  if (mode === "off") return null;
  const rect = mode === "tiktok" ? { x: .065, y: .12, width: .74, height: .66 } : { x: .05, y: .12, width: .80, height: .68 };
  return { x: rect.x * width, y: rect.y * height, width: rect.width * width, height: rect.height * height };
}
export function drawSocialSafeArea(context: CanvasRenderingContext2D, mode: SocialSafeArea, width: number, height: number): void {
  const safe = socialSafeRect(mode, width, height); if (!safe) return;
  const unit = Math.min(width, height);
  context.save(); context.globalAlpha = 1;
  context.fillStyle = "#11111966"; context.beginPath(); context.rect(0, 0, width, height); context.rect(safe.x, safe.y, safe.width, safe.height); context.fill("evenodd");
  context.strokeStyle = "#ffffffaa"; context.lineWidth = Math.max(1, unit / 540); context.setLineDash([unit * .009, unit * .006]); context.strokeRect(safe.x, safe.y, safe.width, safe.height); context.setLineDash([]);
  context.font = `600 ${unit * .026}px -apple-system, sans-serif`; context.fillStyle = "#fff"; context.textAlign = "left"; context.textBaseline = "middle";
  context.fillText(mode === "tiktok" ? "TikTok" : "Instagram Reels", width * .055, height * .055);
  context.globalAlpha = .8;
  for (const [index, label] of ["♡", "○", "↗"].entries()) {
    const x = width * .925, y = height * (.53 + index * .09);
    context.font = `400 ${unit * .055}px -apple-system, sans-serif`; context.textAlign = "center"; context.fillText(label, x, y);
  }
  context.fillStyle = "#ffffffaa"; context.fillRect(width * .06, height * .85, width * .58, height * .008); context.fillRect(width * .06, height * .88, width * .4, height * .006);
  context.restore();
}
