import type { Appearance, Project, TextOverlay } from "../types.ts";
import { privacyRect, privacyRegionsAtTime } from "./privacy.ts";
import { getSlices } from "./timeline.ts";
import type { CameraMatte } from "./camera-matte.ts";
import { cameraCoverCrop, cameraSceneAt, cameraSourceTime } from "./camera-effects.ts";
import { FrameProcessor } from "./frame-processing.ts";
import { drawLoupe, drawManualMasks, drawShortcutOverlay } from "./annotations.ts";
import { drawTranscriptCaptions } from "./transcript.ts";
import { screenShadowGeometry, drawDeviceFrame, drawSocialSafeArea, type SocialSafeArea } from "./screen-effects.ts";
import { drawCursorFrame } from "./cursor-render.ts";
import { mediaTimelineEnd } from "./playback.ts";
import {
  BACKGROUNDS,
  clamp,
  getCameraRect,
  getFadeOpacity,
  getScreenGeometry,
  type ScreenAnimator,
  type Rect,
} from "./model.ts";

export interface DrawFrameOptions {
  width: number;
  height: number;
  screen?: CanvasImageSource;
  camera?: CanvasImageSource;
  cameraMask?: HTMLVideoElement;
  cameraMatte?: CameraMatte;
  cameraProcessor?: FrameProcessor;
  screenProcessor?: FrameProcessor;
  /** Preview-only composition guides. Export callers deliberately omit it. */
  socialSafeArea?: SocialSafeArea;
  outputTime?: number;
  background?: HTMLImageElement;
  fps?: number;
  screenAnimator?: ScreenAnimator;
  onCursorAssetReady?: () => void;
  placeholder?: { title: string; subtitle: string };
}

function roundedRect(
  context: CanvasRenderingContext2D,
  rectangle: Rect,
  radius: number,
): void {
  const { x, y, width, height } = rectangle;
  const r = clamp(radius, 0, Math.min(width, height) / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function sourceSize(
  source: CanvasImageSource,
  fallbackWidth = 1920,
  fallbackHeight = 1080,
): { width: number; height: number } {
  const dimensions = source as unknown as {
    videoWidth?: number;
    videoHeight?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    displayWidth?: number;
    displayHeight?: number;
    width?: number;
    height?: number;
  };
  const width =
    dimensions.videoWidth ||
    dimensions.naturalWidth ||
    dimensions.displayWidth ||
    dimensions.width;
  const height =
    dimensions.videoHeight ||
    dimensions.naturalHeight ||
    dimensions.displayHeight ||
    dimensions.height;
  return {
    width: typeof width === "number" && width > 0 ? width : fallbackWidth,
    height: typeof height === "number" && height > 0 ? height : fallbackHeight,
  };
}

export function isFrameSourceReady(
  source: CanvasImageSource | undefined,
): source is CanvasImageSource {
  if (!source) return false;
  const media = source as unknown as {
    readyState?: number;
    naturalWidth?: number;
  };
  return (
    (media.readyState === undefined || media.readyState >= 2) &&
    (media.naturalWidth === undefined || media.naturalWidth > 0)
  );
}

function paintWallpaper(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  colors: string[],
): void {
  const base = context.createLinearGradient(0, 0, width, height);
  colors.forEach((color, index) =>
    base.addColorStop(index / (colors.length - 1), color),
  );
  context.fillStyle = base;
  context.fillRect(0, 0, width, height);

  const shade = context.createRadialGradient(
    width * 0.88,
    height * 0.05,
    0,
    width * 0.65,
    height * 0.25,
    width * 0.95,
  );
  shade.addColorStop(0, "#080611c9");
  shade.addColorStop(1, "#08061100");
  context.fillStyle = shade;
  context.fillRect(0, 0, width, height);

  // Original vector ribbons: deterministic geometry at every preview/export size.
  for (let index = 0; index < 5; index++) {
    const shift = index * height * 0.073;
    const light = context.createLinearGradient(
      width * 0.15,
      height * 0.32 + shift,
      width * 0.8,
      height + shift,
    );
    light.addColorStop(0, colors[0]);
    light.addColorStop(0.42, colors[2]);
    light.addColorStop(0.58, colors[1]);
    light.addColorStop(1, colors[0]);
    context.fillStyle = light;
    context.globalAlpha = 0.36 + index * 0.075;
    context.beginPath();
    context.moveTo(-width * 0.18, height * 0.68 + shift);
    context.bezierCurveTo(
      width * 0.07,
      height * 0.07 + shift,
      width * 0.39,
      height * 0.45 + shift,
      width * 0.56,
      height * 0.65 + shift,
    );
    context.bezierCurveTo(
      width * 0.76,
      height * 0.92 + shift,
      width * 0.95,
      height * 0.22 + shift,
      width * 1.14,
      height * 0.27 + shift,
    );
    context.lineTo(width * 1.14, height * 1.4);
    context.lineTo(-width * 0.18, height * 1.4);
    context.closePath();
    context.fill();
  }
  context.globalAlpha = 1;
  const glow = context.createRadialGradient(
    width * 0.12,
    height * 0.97,
    0,
    width * 0.12,
    height * 0.97,
    width * 0.63,
  );
  glow.addColorStop(0, "#f1d9ff30");
  glow.addColorStop(1, "#f1d9ff00");
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);
}

function drawBackground(
  context: CanvasRenderingContext2D,
  appearance: Appearance,
  width: number,
  height: number,
  image?: HTMLImageElement,
): void {
  context.save();
  const blur = (clamp(appearance.blur, 0, 100) * Math.min(width, height)) / 1080;
  const overscan = blur * 2;
  if (blur > 0) context.filter = `blur(${blur}px)`;
  context.translate(-overscan, -overscan);
  const w = width + overscan * 2,
    h = height + overscan * 2;
  context.fillStyle = "#191622";
  context.fillRect(0, 0, w, h);
  if (appearance.backgroundKind === "color") {
    context.fillStyle = "#191622";
    context.fillStyle = appearance.background;
    context.fillRect(0, 0, w, h);
  } else if (
    (appearance.backgroundKind === "image" ||
      appearance.backgroundKind === "wallpaper") &&
    image &&
    image.naturalWidth > 0
  ) {
    const size = sourceSize(image);
    const scale = Math.max(w / size.width, h / size.height);
    context.drawImage(
      image,
      (w - size.width * scale) / 2,
      (h - size.height * scale) / 2,
      size.width * scale,
      size.height * scale,
    );
  } else {
    const selected =
      appearance.backgroundKind === "gradient"
        ? appearance.gradient
        : appearance.wallpaper;
    const colors =
      BACKGROUNDS[clamp(Math.floor(selected), 0, BACKGROUNDS.length - 1)]
        .colors;
    if (appearance.backgroundKind === "gradient") {
      const gradient = context.createLinearGradient(0, 0, w, h);
      colors.forEach((color, index) =>
        gradient.addColorStop(index / (colors.length - 1), color),
      );
      context.fillStyle = gradient;
      context.fillRect(0, 0, w, h);
    } else paintWallpaper(context, w, h, colors);
  }
  context.restore();
}

function drawPlaceholder(
  context: CanvasRenderingContext2D,
  screen: Rect,
  text: DrawFrameOptions["placeholder"],
): void {
  const { x, y, width, height } = screen;
  const scale = Math.min(width / 1280, height / 720);
  const background = context.createLinearGradient(x, y, x + width, y + height);
  background.addColorStop(0, "#22232b");
  background.addColorStop(1, "#13151c");
  context.fillStyle = background;
  context.fillRect(x, y, width, height);
  context.fillStyle = "#ffffff05";
  context.fillRect(x, y, width, 40 * scale);
  context.strokeStyle = "#ffffff0c";
  context.lineWidth = Math.max(0.5, scale);
  context.beginPath();
  context.moveTo(x, y + 40 * scale);
  context.lineTo(x + width, y + 40 * scale);
  context.stroke();
  ["#f07872", "#e1ba65", "#6dbb85"].forEach((color, index) => {
    context.fillStyle = color;
    context.beginPath();
    context.arc(
      x + (22 + index * 18) * scale,
      y + 20 * scale,
      5 * scale,
      0,
      Math.PI * 2,
    );
    context.fill();
  });
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `500 ${12 * scale}px -apple-system, BlinkMacSystemFont, sans-serif`;
  context.fillStyle = "#ffffff5c";
  context.fillText("REVA Studio", x + width / 2, y + 20 * scale);

  const centerX = x + width / 2,
    centerY = y + height / 2;
  context.strokeStyle = "#c5b3ea55";
  context.lineWidth = 1.4 * scale;
  roundedRect(
    context,
    {
      x: centerX - 28 * scale,
      y: centerY - 86 * scale,
      width: 56 * scale,
      height: 44 * scale,
    },
    11 * scale,
  );
  context.stroke();
  context.fillStyle = "#c5b3ea";
  context.beginPath();
  context.arc(centerX, centerY - 64 * scale, 7 * scale, 0, Math.PI * 2);
  context.fill();
  context.font = `500 ${34 * scale}px -apple-system, BlinkMacSystemFont, sans-serif`;
  context.fillStyle = "#f0edf6";
  context.fillText(text?.title ?? "Your next great recording", centerX, centerY + 8 * scale);
  context.font = `400 ${18 * scale}px -apple-system, BlinkMacSystemFont, sans-serif`;
  context.fillStyle = "#9994a6";
  context.fillText(
    text?.subtitle ?? "Record your screen or import a video",
    centerX,
    centerY + 47 * scale,
  );
}

function drawCamera(
  context: CanvasRenderingContext2D,
  project: Project,
  source: CanvasImageSource,
  width: number,
  height: number,
  pixelScale: number,
  layoutRectangle: Rect | null,
  layoutRadius: number,
  focus: { x: number; y: number },
  cutout: boolean,
): void {
  const appearance = project.appearance;
  const size = sourceSize(source, 1280, 720);
  const rectangle = layoutRectangle ?? getCameraRect(
    appearance,
    width,
    height,
    size.width / size.height,
  );
  const radius = layoutRectangle ? layoutRadius : clamp(appearance.cameraRadius, 0, 200) * pixelScale;
  context.save();
  if (!cutout) {
    context.shadowColor = "#00000070";
    context.shadowBlur = 24 * pixelScale;
    context.shadowOffsetY = 9 * pixelScale;
    roundedRect(context, rectangle, radius);
    context.fillStyle = "#212129";
    context.fill();
  }
  context.shadowColor = "transparent";
  context.shadowBlur = 0;
  context.shadowOffsetX = 0;
  context.shadowOffsetY = 0;
  roundedRect(context, rectangle, radius);
  context.clip();
  // Aspect selection crops the camera to cover the frame, never stretches it.
  const crop = cameraCoverCrop(size, rectangle, focus, appearance.cameraCrop);
  context.translate(rectangle.x + (appearance.cameraMirror ? rectangle.width : 0), rectangle.y);
  if (appearance.cameraMirror) context.scale(-1, 1);
  context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, rectangle.width, rectangle.height);
  context.restore();
}

function wrapText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = "";
      }
      if (context.measureText(word).width > maxWidth) {
        for (const character of word) {
          if (line && context.measureText(line + character).width > maxWidth) {
            lines.push(line);
            line = "";
          }
          line += character;
        }
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  return lines;
}

function drawCaption(
  context: CanvasRenderingContext2D,
  caption: TextOverlay,
  width: number,
  height: number,
  pixelScale: number,
): void {
  const fontSize = clamp(caption.size, 8, 240) * pixelScale;
  context.save();
  context.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  const lines = wrapText(context, caption.text, width * 0.84);
  const lineHeight = fontSize * 1.25,
    paddingX = fontSize * 0.45,
    paddingY = fontSize * 0.27;
  const textWidth = lines.reduce(
    (maximum, line) => Math.max(maximum, context.measureText(line).width),
    0,
  );
  const blockWidth = textWidth + paddingX * 2,
    blockHeight = lineHeight * lines.length + paddingY * 2;
  const centerX = clamp(
    caption.x * width,
    blockWidth / 2,
    width - blockWidth / 2,
  );
  const centerY = clamp(
    caption.y * height,
    blockHeight / 2,
    height - blockHeight / 2,
  );
  roundedRect(
    context,
    {
      x: centerX - blockWidth / 2,
      y: centerY - blockHeight / 2,
      width: blockWidth,
      height: blockHeight,
    },
    fontSize * 0.22,
  );
  context.fillStyle = "#0b0b12a8";
  context.fill();
  context.fillStyle = "#ffffff";
  context.fillStyle = caption.color;
  lines.forEach((line, index) =>
    context.fillText(
      line,
      centerX,
      centerY + (index - (lines.length - 1) / 2) * lineHeight,
    ),
  );
  context.restore();
}

/** Shared deterministic compositor. `time` is original media time, in seconds. */
const cameraProcessors = new WeakMap<CanvasRenderingContext2D, FrameProcessor>();
const screenProcessors = new WeakMap<CanvasRenderingContext2D, FrameProcessor>();
export function drawFrame(
  context: CanvasRenderingContext2D,
  project: Project,
  time: number,
  options: DrawFrameOptions,
): void {
  const { width, height, camera, background } = options;
  let screen = options.screen;
  if (!(width > 0 && height > 0)) return;
  const pixelScale = Math.min(width, height) / 1080;
  const appearance = project.appearance;
  const {
    rect: rectangle,
    crop,
    scale,
    camera: cameraRectangle,
    screenClip,
    screenRadius,
    cameraRadius,
    cameraOpacity,
    screenOpacity,
    cameraFocus,
  } = getScreenGeometry(
    project,
    time,
    width,
    height,
    options.fps ?? 60,
    options.screenAnimator,
  );
  const radius = screenRadius;
  if (screenOpacity > 0 && appearance.screenProcessing?.deband && isFrameSourceReady(screen)) {
    let processor = options.screenProcessor ?? screenProcessors.get(context);
    if (!processor) { processor = new FrameProcessor(); screenProcessors.set(context, processor); }
    const size = sourceSize(screen, project.width, project.height);
    screen = processor.frame(screen, size.width, size.height, appearance.screenProcessing, time);
  }
  const inset = clamp(appearance.inset, 0, 12) * pixelScale * scale;
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
  context.filter = "none";
  context.shadowColor = "transparent";
  context.shadowBlur = 0;
  context.shadowOffsetX = 0;
  context.shadowOffsetY = 0;
  context.setLineDash([]);
  context.clearRect(0, 0, width, height);
  context.beginPath();
  context.rect(0, 0, width, height);
  context.clip();
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  drawBackground(context, appearance, width, height, background);

  context.save();
  context.globalAlpha = screenOpacity;
  context.beginPath();
  context.rect(screenClip.x, screenClip.y, screenClip.width, screenClip.height);
  context.clip();
  const frame = {
    x: rectangle.x - inset,
    y: rectangle.y - inset,
    width: rectangle.width + 2 * inset,
    height: rectangle.height + 2 * inset,
  };
  const shadow = clamp(appearance.shadow);
  context.shadowColor = `rgba(0, 0, 0, ${shadow * 0.9})`;
  const shadowGeometry = screenShadowGeometry(shadow, appearance.screenShadow, pixelScale);
  context.shadowBlur = shadowGeometry.blur;
  context.shadowOffsetX = shadowGeometry.x;
  context.shadowOffsetY = shadowGeometry.y;
  roundedRect(context, frame, radius + inset);
  context.fillStyle = inset > 0 ? "#ffffffa8" : "#16171e";
  context.fill();
  context.shadowColor = "transparent";
  context.shadowBlur = 0;
  context.shadowOffsetX = 0;
  context.shadowOffsetY = 0;
  roundedRect(context, rectangle, radius);
  context.clip();
  if (isFrameSourceReady(screen)) {
    const size = sourceSize(screen, project.width, project.height);
    context.drawImage(
      screen,
      crop.x * size.width,
      crop.y * size.height,
      crop.width * size.width,
      crop.height * size.height,
      rectangle.x,
      rectangle.y,
      rectangle.width,
      rectangle.height,
    );
    const masks = privacyRegionsAtTime(project, time);
    for (const region of masks) {
      const box = privacyRect(region, crop, rectangle);
      if (!box) continue;
      context.save();
      if (region.kind === "face") {
        context.beginPath();
        context.rect(box.x, box.y, box.width, box.height);
        context.clip();
        context.filter = `blur(${Math.max(12 * pixelScale, Math.min(box.width, box.height) * 0.12)}px)`;
        context.drawImage(
          screen,
          crop.x * size.width,
          crop.y * size.height,
          crop.width * size.width,
          crop.height * size.height,
          rectangle.x,
          rectangle.y,
          rectangle.width,
          rectangle.height,
        );
      } else {
        context.fillStyle = "#181820";
        context.fillRect(box.x, box.y, box.width, box.height);
      }
      context.restore();
    }
    drawManualMasks(context, project, time, screen, crop, rectangle, pixelScale);
    drawCursorFrame(context, project, time, crop, rectangle, pixelScale, { fps: options.fps, outputTime: options.outputTime, onAssetReady: options.onCursorAssetReady });
  } else if (!project.mediaPath) drawPlaceholder(context, rectangle, options.placeholder);
  context.restore();

  if (screenOpacity > 0) { context.save(); context.globalAlpha = screenOpacity; drawDeviceFrame(context, rectangle, appearance.deviceFrame); context.restore(); }
  const cameraEnd = typeof HTMLMediaElement !== "undefined" && camera instanceof HTMLMediaElement ? mediaTimelineEnd(camera, project.cameraEndTime ?? project.duration) : project.cameraEndTime;
  const cameraTime = cameraSourceTime(project, time, cameraEnd);
  if (cameraOpacity > 0 && cameraTime >= (project.cameraStartTime ?? 0) && isFrameSourceReady(camera)) {
    let cameraFrame: CanvasImageSource | undefined = camera;
    const cameraLayout = cameraSceneAt(project, time)?.layout ?? appearance.cameraLayout;
    const cutout = cameraLayout?.type === "cutout-camera";
    if (cutout) {
      const mask = project.cameraMask;
      const ready = mask && mask.sourcePath === project.cameraPath && cameraTime >= mask.sourceTimeOrigin && cameraTime < mask.sourceTimeOrigin + mask.duration && isFrameSourceReady(options.cameraMask);
      cameraFrame = ready && options.cameraMatte && typeof HTMLVideoElement !== "undefined" && camera instanceof HTMLVideoElement
        ? options.cameraMatte.frame(camera, options.cameraMask!, cameraLayout.cutout.edgeSoftness, cameraLayout.cutout.inset)
        : undefined;
    }
    if (cameraFrame) {
      const processing = appearance.cameraProcessing;
      if (processing) {
        let processor = options.cameraProcessor ?? cameraProcessors.get(context);
        if (!processor) { processor = new FrameProcessor(); cameraProcessors.set(context, processor); }
        const size = sourceSize(cameraFrame, 1280, 720);
        cameraFrame = processor.frame(cameraFrame, size.width, size.height, processing, cameraTime);
      }
      context.save(); context.globalAlpha = cameraOpacity;
      drawCamera(context, project, cameraFrame, width, height, pixelScale, cameraRectangle, cameraRadius, cameraFocus, cutout);
      context.restore();
    }
  }
  if (screenOpacity > 0) {
    context.save(); context.globalAlpha = screenOpacity;
    drawLoupe(context, project, time, screen, crop, rectangle, pixelScale);
    context.restore();
  }
  drawShortcutOverlay(context, project, time, width, height);
  for (const caption of project.captions) {
    if (caption.text && time >= caption.start && time < caption.end)
      drawCaption(context, caption, width, height, pixelScale);
  }
  drawTranscriptCaptions(context, project, time, width, height, options.outputTime);
  const opacity = getFadeOpacity(project, time);
  if (opacity < 1) {
    context.fillStyle = `rgba(0, 0, 0, ${1 - opacity})`;
    context.fillRect(0, 0, width, height);
  }
  if (options.socialSafeArea) drawSocialSafeArea(context, options.socialSafeArea, width, height);
  context.restore();
}
