import type {
  Appearance,
  CursorPoint,
  MediaInfo,
  Project,
  Zoom,
} from "../types.ts";
import {
  duration as timelineDuration,
  nearestOutputTime,
  outputToSource,
} from "./timeline.ts";
import { DEFAULT_SPRING } from "./spring.ts";
import { SpringTimeline, snapFrameNumber } from "./spring-timeline.ts";
import { cameraFaceFocus, cameraIsHidden, cameraSceneAt, normalizedCameraCrop, type CameraSceneLayout } from "./camera-effects.ts";
import { deviceScreenRadius, deviceScreenRect } from "./screen-effects.ts";
import {
  cameraConfig,
  cameraFreeCenter,
  defaultCameraLayout,
  getCameraAutoAspectRatio,
  resolveCameraGeometry,
  type CameraGeometry,
} from "./camera.ts";

export const BACKGROUNDS: { name: string; colors: string[] }[] = [
  { name: "Amethyst", colors: ["#181322", "#49315f", "#b399d4"] },
  { name: "Midnight Tide", colors: ["#081b2b", "#1e5571", "#80bdc9"] },
  { name: "Apricot", colors: ["#6b3345", "#de8c72", "#f8d3a2"] },
  { name: "Evergreen", colors: ["#0b2522", "#37675b", "#a3bfa0"] },
  { name: "Glacier", colors: ["#34445d", "#819cb6", "#d9e9e6"] },
  { name: "Rose Quartz", colors: ["#452c48", "#a46d8a", "#ecc4cc"] },
  { name: "Electric", colors: ["#111b4c", "#3b52b5", "#a2b5fc"] },
  { name: "Graphite", colors: ["#121820", "#434b58", "#a1a8b5"] },
  { name: "Aurora", colors: ["#18353c", "#637b83", "#c9b2da"] },
  { name: "Saffron", colors: ["#4e3330", "#b27742", "#eec78c"] },
  { name: "Lagoon", colors: ["#133048", "#337c92", "#a0d3ce"] },
  { name: "Pearl", colors: ["#5d5668", "#b0a2b7", "#f1e4df"] },
];

export function clamp(value: number, minimum = 0, maximum = 1): number {
  return Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : minimum;
}

const positive = (value: number, fallback: number) =>
  Number.isFinite(value) && value > 0 ? value : fallback;
const finite = (value: number, fallback = 0) =>
  Number.isFinite(value) ? value : fallback;
const smoothstep = (value: number) => {
  const x = clamp(value);
  return x * x * (3 - 2 * x);
};

export function formatTime(seconds: number, precise = false): string {
  const value = Math.max(0, finite(seconds));
  const ticks = Math.floor(value * (precise ? 100 : 1) + 1e-7);
  const whole = precise ? Math.floor(ticks / 100) : ticks;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const remainder = String(whole % 60).padStart(2, "0");
  const clock =
    hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}`
      : `${minutes}:${remainder}`;
  return precise ? `${clock}.${String(ticks % 100).padStart(2, "0")}` : clock;
}

/** Nominal frame timecode; the suffix is a frame index, not hundredths. */
export function formatTimecode(seconds: number, fps = 60): string {
  const rate = Math.max(1, Math.round(positive(fps, 60)));
  const frames = Math.floor(Math.max(0, finite(seconds)) * rate + 1e-7);
  const whole = Math.floor(frames / rate);
  const digits = Math.max(2, String(rate - 1).length);
  return `${formatTime(whole).padStart(5, "0")}.${String(frames % rate).padStart(digits, "0")}`;
}

export function defaultAppearance(): Appearance {
  return {
    backgroundKind: "wallpaper",
    background: "#191622",
    gradient: 0,
    wallpaper: 0,
    image: null,
    blur: 0,
    padding: 0.1,
    radius: 16,
    shadow: 0.3,
    inset: 0,
    aspect: "auto",
    cursorSize: 48,
    cursorHidden: false,
    cursorSmooth: true,
    cursorHideIdle: false,
    clickEffect: "none",
    cameraSize: 0.22,
    cameraRadius: 24,
    cameraX: 0.85,
    cameraY: 0.8,
    cameraMirror: false,
    cameraHidden: false,
    cameraLayout: defaultCameraLayout(),
    cameraRadiusRatio: 0.15,
    volume: 1,
    microphoneVolume: 1,
    cameraVolume: 1,
    fadeIn: 0,
    fadeOut: 0,
    zoomDuration: 0.55,
    screenSpring: { ...DEFAULT_SPRING },
    zoomStartEarly: false,
    crop: { x: 0, y: 0, width: 1, height: 1 },
  };
}

export function createProject(media?: MediaInfo): Project {
  const duration = media ? Math.max(0, finite(media.duration)) : 0;
  return {
    version: 1,
    name: media?.name?.replace(/\.[^.]+$/, "") || "Untitled recording",
    mediaPath: media?.path ?? null,
    cameraPath: null,
    microphonePath: null,
    duration,
    width: positive(media?.width ?? 0, 1920),
    height: positive(media?.height ?? 0, 1080),
    trimStart: 0,
    trimEnd: duration,
    speed: 1,
    appearance: defaultAppearance(),
    zooms: [],
    cursor: [],
    captions: [],
  };
}

/** All editable ranges and cursor samples use original media seconds. */
export function getDuration(project: Project): number {
  return timelineDuration(project);
}

/** Last playable output frame, including a partial final frame, before EOF. */
export function getLastFrameTime(project: Project, fps = 60): number {
  const rate = positive(fps, 60);
  const count = Math.ceil(snapFrameNumber(getDuration(project) * rate));
  return Math.max(0, count - 1) / rate;
}

export function getMediaTime(project: Project, outputSeconds: number): number {
  return outputToSource(project, outputSeconds) ?? 0;
}

export function getOutputTime(project: Project, mediaSeconds: number): number {
  return nearestOutputTime(project, mediaSeconds) ?? 0;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}

/** A normalized crop with a positive area entirely inside the source frame. */
export function normalizeCrop(crop: Rect): Rect {
  const epsilon = Number.EPSILON;
  const x = clamp(crop.x, 0, 1 - epsilon);
  const y = clamp(crop.y, 0, 1 - epsilon);
  return {
    x,
    y,
    width: clamp(crop.width, epsilon, 1 - x),
    height: clamp(crop.height, epsilon, 1 - y),
  };
}

export function getSourceAspect(project: Project): number {
  const crop = normalizeCrop(project.appearance.crop);
  return (
    (positive(project.width, 1920) * crop.width) /
    (positive(project.height, 1080) * crop.height)
  );
}

/** Padding is a fraction of the shorter source edge, before canvas scaling. */
export function getOutputAspect(project: Project): number {
  const crop = normalizeCrop(project.appearance.crop);
  const width = positive(project.width, 1920) * crop.width;
  const height = positive(project.height, 1080) * crop.height;
  const padding =
    Math.min(width, height) * clamp(project.appearance.padding, 0, 0.45);
  let automatic = (width + 2 * padding) / (height + 2 * padding);
  if (project.appearance.cameraLayout && !project.appearance.cameraHidden) {
    const result = getCameraAutoAspectRatio(cameraConfig(project.appearance.cameraLayout), { width, height }, clamp(project.appearance.padding, 0, 0.45));
    if (!result.ok) throw new Error(result.error.message);
    automatic = result.value;
  }
  if (project.appearance.aspect === "auto") return automatic;
  const [w, h] = project.appearance.aspect.split(":").map(Number);
  return positive(w / h, automatic);
}

/** Edge is the longest output dimension; both dimensions suit 4:2:0 encoders. */
export function getOutputSize(
  project: Project,
  edge = 1920,
): { width: number; height: number } {
  const aspect = getOutputAspect(project);
  const length = Math.max(2, 2 * Math.round(positive(edge, 1920) / 2));
  const even = (value: number) => Math.max(2, 2 * Math.round(value / 2));
  return aspect >= 1
    ? { width: length, height: even(length / aspect) }
    : { width: even(length * aspect), height: length };
}

function floorEven(value: number): number {
  const nearest = Math.round(value);
  const integer =
    Math.abs(value - nearest) < 1e-6 ? nearest : Math.floor(value);
  return Math.max(2, integer - (integer % 2));
}

/** Export resolutions denote height and fit within the observed 3840 × 2160 cap. */
export function getOutputSizeForHeight(
  project: Project,
  desiredHeight = 1080,
): { width: number; height: number } {
  let height = floorEven(positive(desiredHeight, 1080));
  let width = floorEven(height * getOutputAspect(project));
  const scale = Math.min(1, 3840 / width, 2160 / height);
  if (scale < 1) {
    width = floorEven(width * scale);
    height = floorEven(height * scale);
  }
  return { width, height };
}

function getZoomArea(project: Project, width: number, height: number): Rect {
  const shortest = Math.max(1, Math.min(width, height));
  const paddingRatio = clamp(project.appearance.padding, 0, 0.45);
  const padding = (shortest * paddingRatio) / (1 + 2 * paddingRatio);
  return {
    x: padding,
    y: padding,
    width: Math.max(1, width - 2 * padding),
    height: Math.max(1, height - 2 * padding),
  };
}

export interface ProjectCameraGeometry extends Omit<CameraGeometry, "type"> { type: CameraGeometry["type"] | "fullscreen-camera" }

function getLayoutGeometry(project: Project, width: number, height: number, layout: CameraSceneLayout): ProjectCameraGeometry | null {
  if (layout.type === "screen-only") return null;
  if (layout.type === "fullscreen-camera") {
    const area = layout.enablePadding ? getZoomArea(project, width, height) : { x: 0, y: 0, width, height };
    const frame = { screen: getPlainScreenRect(project, width, height), camera: area, zoomArea: area, allowsScreenBorderRadius: false, allowsCameraBorderRadius: layout.enablePadding };
    return { type: "fullscreen-camera", resting: frame, zoomed: frame, screenSide: null, effectivePaddingRatio: layout.enablePadding ? project.appearance.padding : 0, requiresForegroundAlpha: false };
  }
  const crop = normalizeCrop(project.appearance.crop);
  const cameraCrop = normalizedCameraCrop(project.appearance.cameraCrop);
  const result = resolveCameraGeometry(cameraConfig(layout), {
    stage: { width, height },
    screenSource: { width: project.width * crop.width, height: project.height * crop.height },
    paddingRatio: clamp(project.appearance.padding, 0, 0.45),
    cameraSourceAspectRatio: project.cameraSource ? project.cameraSource.width * cameraCrop.width / (project.cameraSource.height * cameraCrop.height) : undefined,
    avoidEmptyZoomArea: project.appearance.avoidEmptyZoomArea,
  });
  if (!result.ok) throw new Error(result.error.message);
  const frame = (endpoint: CameraGeometry["resting"]) => ({ ...endpoint, screen: deviceScreenRect(endpoint.screen, project.appearance.deviceFrame) });
  return { ...result.value, resting: frame(result.value.resting), zoomed: frame(result.value.zoomed) };
}

export function getProjectCameraGeometry(project: Project, width: number, height: number, sourceTime?: number): ProjectCameraGeometry | null {
  if (project.appearance.cameraHidden) return null;
  const layout = (sourceTime === undefined ? null : cameraSceneAt(project, sourceTime)?.layout) ?? project.appearance.cameraLayout;
  return layout ? getLayoutGeometry(project, width, height, layout) : null;
}

function getPlainScreenRect(project: Project, width: number, height: number): Rect {
  const area = getZoomArea(project, width, height);
  const aspect = getSourceAspect(project);
  const screenWidth = project.appearance.avoidEmptyZoomArea ? Math.max(area.width, area.height * aspect) : Math.min(area.width, area.height * aspect);
  const screenHeight = screenWidth / aspect;
  return deviceScreenRect({ x: (width - screenWidth) / 2, y: (height - screenHeight) / 2, width: screenWidth, height: screenHeight }, project.appearance.deviceFrame);
}

/** Initial screen fit; the inset is an outline and does not shrink the video. */
export function getScreenRect(
  project: Project,
  width: number,
  height: number,
  sourceTime?: number,
): Rect {
  const layout = getProjectCameraGeometry(project, width, height, sourceTime);
  if (layout) return layout.resting.screen;
  return getPlainScreenRect(project, width, height);
}

export interface ZoomState {
  scale: number;
  x: number;
  y: number;
  instant: boolean;
}

/** A symmetric 400 ms tracking window removes abrupt cursor-driven camera pans. */
export function getAutoZoomFocus(
  cursor: readonly CursorPoint[],
  time: number,
  fallback: Point,
): Point {
  let x = 0,
    y = 0,
    total = 0;
  for (let offset = -4; offset <= 4; offset++) {
    const sample = getCursorAtTime(cursor, time + offset * 0.05, true);
    if (!sample?.visible) continue;
    const weight = 5 - Math.abs(offset);
    x += sample.x * weight;
    y += sample.y * weight;
    total += weight;
  }
  return total > 0
    ? { x: x / total, y: y / total }
    : { x: clamp(fallback.x), y: clamp(fallback.y) };
}

/** Source-time target selection; transition motion belongs to the output clock. */
export function getZoomTarget(
  zooms: readonly Zoom[],
  time: number,
  cursor: readonly CursorPoint[] = [],
  startEarly = false,
): ZoomState {
  const milliseconds = snapFrameNumber(finite(time) * 1000);
  const start = (zoom: Zoom) => snapFrameNumber(zoom.start * 1000);
  const end = (zoom: Zoom) => snapFrameNumber(zoom.end * 1000);
  const ranges = zooms.filter(
    (zoom) =>
      zoom.presentation !== "loupe" && zoom.disabled !== true &&
      Number.isFinite(zoom.start) &&
      Number.isFinite(zoom.end) &&
      zoom.end > zoom.start,
  );
  const instant = ranges.some(
    (zoom) =>
      zoom.instant &&
      milliseconds >= start(zoom) &&
      milliseconds <= end(zoom) + 50,
  );
  let active = ranges.find(
    (zoom) => milliseconds >= start(zoom) && milliseconds <= end(zoom),
  );
  if (!active && startEarly) {
    const next = ranges.reduce<Zoom | undefined>(
      (best, zoom) =>
        start(zoom) > milliseconds && (!best || start(zoom) < start(best))
          ? zoom
          : best,
      undefined,
    );
    if (next && !next.instant && milliseconds >= start(next) - 350)
      active = next;
  }
  if (!active) return { scale: 1, x: 0.5, y: 0.5, instant };
  const focus =
    active.mode === "auto" ? getAutoZoomFocus(cursor, time, active) : active;
  return {
    scale: clamp(active.scale, 1, 8),
    x: clamp(focus.x),
    y: clamp(focus.y),
    instant,
  };
}

/**
 * Zoom enlarges the complete cropped video, which can extend outside the stage.
 * The stage clips its final image; the source crop stays unchanged. Focus points
 * remain normalized to the full source for project and cursor compatibility.
 * Camera-aware focus uses the resting camera rectangle of the active resolver,
 * including the reference's default overlay resolver without a camera track.
 */
export function getScreenTarget(
  project: Project,
  time: number,
  width: number,
  height: number,
): { rect: Rect; crop: Rect; scale: number; instant: boolean; camera: Rect | null; screenClip: Rect; screenRadius: number; cameraRadius: number; screenOpacity: number; cameraOpacity: number; cameraHidden: boolean } {
  const crop = normalizeCrop(project.appearance.crop);
  const zoom = getZoomTarget(
    project.zooms,
    time,
    project.cursor,
    project.appearance.zoomStartEarly,
  );
  const geometry = getProjectCameraGeometry(project, width, height, time);
  const zooming = zoom.scale > 1;
  const endpoint = geometry ? (zooming ? geometry.zoomed : geometry.resting) : null;
  const initial = endpoint?.screen ?? getPlainScreenRect(project, width, height);
  const area = endpoint?.zoomArea ?? getZoomArea(project, width, height);
  const scaledWidth = initial.width * zoom.scale;
  const scaledHeight = initial.height * zoom.scale;
  // Legacy imported avoidEmptyZoomArea retains the documented cursor-following
  // crop behavior, without reintroducing its removed 4.x inspector control.
  const focus = project.appearance.avoidEmptyZoomArea && !zooming ? getAutoZoomFocus(project.cursor, time, zoom) : zoom;
  const focusX = clamp((focus.x - crop.x) / crop.width);
  const focusY = clamp((focus.y - crop.y) / crop.height);
  const preferred = zooming && geometry
    ? cameraFreeCenter(area, geometry.type === "split-screen" ? geometry.zoomed.camera : geometry.resting.camera)
    : { x: area.x + area.width / 2, y: area.y + area.height / 2 };
  const centerX = preferred.x;
  const centerY = preferred.y;
  const frameSettings = project.appearance.deviceFrame;
  const screenRadius = frameSettings && frameSettings.type !== "none" ? deviceScreenRadius({ x: 0, y: 0, width: scaledWidth, height: scaledHeight }, frameSettings)
    : project.appearance.padding > 0 && (!endpoint || endpoint.allowsScreenBorderRadius) ? clamp(project.appearance.radius, 0, 200) * scaledWidth / (project.width * crop.width) : 0;
  const hidden = cameraIsHidden(project, time);
  // A hidden frame retains a real endpoint so fades never grow from (0,0).
  const cameraEndpoint = endpoint ?? getLayoutGeometry(project, width, height, project.appearance.cameraLayout ?? defaultCameraLayout())?.resting;
  const cameraRadius = cameraEndpoint?.allowsCameraBorderRadius ? Math.min(cameraEndpoint.camera.width, cameraEndpoint.camera.height) * (project.appearance.cameraRadiusRatio ?? 0.15) : 0;
  let cameraRectangle = cameraEndpoint?.camera ?? null;
  if (cameraRectangle && hidden) {
    const pivot = { x: clamp(cameraRectangle.x + cameraRectangle.width / 2, initial.x, initial.x + initial.width), y: clamp(cameraRectangle.y + cameraRectangle.height / 2, initial.y, initial.y + initial.height) };
    cameraRectangle = { x: pivot.x + (cameraRectangle.x - pivot.x) * 0.9, y: pivot.y + (cameraRectangle.y - pivot.y) * 0.9, width: cameraRectangle.width * 0.9, height: cameraRectangle.height * 0.9 };
  }
  return {
    rect: {
      x:
        scaledWidth > area.width
          ? clamp(
              centerX - focusX * scaledWidth,
              area.x + area.width - scaledWidth,
              area.x,
            )
          : area.x + (area.width - scaledWidth) / 2,
      y:
        scaledHeight > area.height
          ? clamp(
              centerY - focusY * scaledHeight,
              area.y + area.height - scaledHeight,
              area.y,
            )
          : area.y + (area.height - scaledHeight) / 2,
      width: scaledWidth,
      height: scaledHeight,
    },
    crop,
    scale: zoom.scale,
    instant: zoom.instant,
    camera: cameraRectangle,
    screenClip: { x: 0, y: 0, width, height },
    screenRadius,
    cameraRadius,
    cameraHidden: hidden,
    cameraOpacity: hidden ? 0 : 1,
    screenOpacity: geometry?.type === "fullscreen-camera" && !hidden && project.cameraPath ? 0 : 1,
  };
}

/** One instance per preview/export renderer; project edits invalidate its cache. */
export class ScreenAnimator {
  readonly fps: number;
  private project: Project | null = null;
  private timeline: SpringTimeline | null = null;
  private cameraTimeline: SpringTimeline | null = null;
  private faceTimeline: SpringTimeline | null = null;
  private referenceWidth = 1920;

  constructor(fps = 60) {
    if (!Number.isFinite(fps) || fps <= 0)
      throw new RangeError("FPS must be positive");
    this.fps = fps;
  }

  reset(): void {
    this.project = null;
    this.timeline = null;
    this.cameraTimeline = null;
    this.faceTimeline = null;
  }

  get diagnostics(): {
    resets: number;
    advancedFrames: number;
    cachedFrames: number;
  } | null {
    return this.timeline?.diagnostics ?? null;
  }

  sampleFrame(project: Project, sourceSeconds: number) {
    if (this.project !== project || this.timeline === null) {
      this.project = project;
      // Original layout geometry uses a 1080px-high virtual stage. Integrating
      // there preserves absolute precision thresholds at every export size.
      this.referenceWidth = 1080 * getOutputAspect(project);
      this.timeline = new SpringTimeline(this.fps, (outputMs) => {
        const sourceTime = getMediaTime(project, outputMs / 1000);
        const { rect, instant, screenClip, screenRadius, screenOpacity } = getScreenTarget(
          project,
          sourceTime,
          this.referenceWidth,
          1080,
        );
        return {
          values: [rect.x, rect.y, rect.width, rect.height,
            screenClip.x, screenClip.y, screenClip.width, screenClip.height,
            screenRadius, screenOpacity],
          config: instant
            ? { ...DEFAULT_SPRING, stiffness: 1, damping: 1, mass: 0 }
            : (project.appearance.screenSpring ?? DEFAULT_SPRING),
        };
      });
      this.cameraTimeline = new SpringTimeline(this.fps, outputMs => {
        const sourceTime = getMediaTime(project, outputMs / 1000);
        const target = getScreenTarget(project, sourceTime, this.referenceWidth, 1080);
        const camera = target.camera;
        return {
          values: [camera?.x ?? 0, camera?.y ?? 0, camera?.width ?? 0, camera?.height ?? 0, target.cameraRadius, target.cameraOpacity],
          config: target.instant ? { ...DEFAULT_SPRING, mass: 0 }
            : target.cameraHidden || cameraIsHidden(project, sourceTime - 0.2)
              ? { ...DEFAULT_SPRING, stiffness: 530, damping: 40, mass: 1 }
              : (project.appearance.screenSpring ?? DEFAULT_SPRING),
        };
      });
      this.faceTimeline = new SpringTimeline(this.fps, outputMs => {
        const focus = cameraFaceFocus(project, getMediaTime(project, outputMs / 1000));
        // Independently chosen smoothing for sampled local Vision positions.
        return { values: [focus.x, focus.y], config: { ...DEFAULT_SPRING, stiffness: 170, damping: 50, mass: 3, precision: 0.0001 } };
      });
    }
    const outputMilliseconds = snapFrameNumber(getOutputTime(project, sourceSeconds) * 1000);
    const [x, y, width, height, sx, sy, sw, sh, screenRadius, screenOpacity] = this.timeline.at(outputMilliseconds);
    const [cx, cy, cw, ch, cameraRadius, cameraOpacity] = this.cameraTimeline!.at(outputMilliseconds);
    const [faceX, faceY] = this.faceTimeline!.at(outputMilliseconds);
    return {
      rect: { x, y, width, height },
      camera: cw > 0 && ch > 0 ? { x: cx, y: cy, width: cw, height: ch } : null,
      screenClip: { x: sx, y: sy, width: sw, height: sh },
      screenRadius, cameraRadius,
      cameraOpacity: clamp(cameraOpacity), screenOpacity: clamp(screenOpacity),
      cameraFocus: { x: clamp(faceX), y: clamp(faceY) },
    };
  }

  sample(project: Project, sourceSeconds: number): Rect {
    return this.sampleFrame(project, sourceSeconds).rect;
  }
}

export function createScreenAnimator(fps = 60): ScreenAnimator {
  return new ScreenAnimator(fps);
}

/**
 * With an animator, repeated frame reads share the original cache/seek rules.
 * Without one this is an isolated seek with the observed 1000ms warm-up.
 * FPS belongs to the supplied animator; fps selects the isolated helper's clock.
 */
export function getScreenGeometry(
  project: Project,
  time: number,
  width: number,
  height: number,
  fps = 60,
  animator?: ScreenAnimator,
){
  const reference = (animator ?? createScreenAnimator(fps)).sampleFrame(
    project,
    time,
  );
  const referenceWidth = 1080 * getOutputAspect(project);
  const xScale = width / referenceWidth;
  const yScale = height / 1080;
  const resize = (r: Rect): Rect => ({ x: r.x * xScale, y: r.y * yScale, width: r.width * xScale, height: r.height * yScale });
  const rect = resize(reference.rect);
  const initial = getScreenRect(project, referenceWidth, 1080);
  return {
    rect,
    crop: normalizeCrop(project.appearance.crop),
    scale: reference.rect.width / initial.width,
    camera: reference.camera ? resize(reference.camera) : null,
    screenClip: resize(reference.screenClip),
    screenRadius: reference.screenRadius * Math.min(xScale, yScale),
    cameraRadius: reference.cameraRadius * Math.min(xScale, yScale),
    cameraOpacity: reference.cameraOpacity,
    screenOpacity: reference.screenOpacity,
    cameraFocus: reference.cameraFocus,
  };
}

export function sourcePointToScreen(
  point: Point,
  crop: Rect,
  screen: Rect,
): Point & { inside: boolean } {
  return {
    x: screen.x + ((point.x - crop.x) / crop.width) * screen.width,
    y: screen.y + ((point.y - crop.y) / crop.height) * screen.height,
    inside:
      point.x >= crop.x &&
      point.x <= crop.x + crop.width &&
      point.y >= crop.y &&
      point.y <= crop.y + crop.height,
  };
}

export function getCameraRect(
  appearance: Appearance,
  width: number,
  height: number,
  sourceAspect = 16 / 9,
): Rect {
  const aspect = positive(sourceAspect, 16 / 9);
  const cameraWidth = Math.min(
    width * clamp(appearance.cameraSize, 0.05, 0.8),
    height * 0.8 * aspect,
  );
  const cameraHeight = cameraWidth / aspect;
  const centerX = clamp(
    appearance.cameraX * width,
    cameraWidth / 2,
    width - cameraWidth / 2,
  );
  const centerY = clamp(
    appearance.cameraY * height,
    cameraHeight / 2,
    height - cameraHeight / 2,
  );
  return {
    x: centerX - cameraWidth / 2,
    y: centerY - cameraHeight / 2,
    width: cameraWidth,
    height: cameraHeight,
  };
}

type VisibleCursorPoint = CursorPoint & { visible?: boolean };
export interface CursorState extends Point {
  visible: boolean;
  idleSeconds: number;
  lastClick: (Point & { t: number }) | null;
}

/** Input samples are chronological, as produced by capture. O(log n) lookup. */
export function getCursorAtTime(
  points: readonly VisibleCursorPoint[],
  time: number,
  smooth = true,
): CursorState | null {
  if (points.length === 0 || !Number.isFinite(time)) return null;
  let low = 0,
    high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle].t <= time) low = middle + 1;
    else high = middle;
  }
  const index = Math.max(0, low - 1);
  const current = points[index],
    next = points[Math.min(index + 1, points.length - 1)];
  const span = next.t - current.t;
  let amount = span > 0 ? clamp((time - current.t) / span) : 0;
  if (smooth) amount = smoothstep(amount);
  if (current.visible === false || next.visible === false) amount = 0;
  let lastClick: CursorState["lastClick"] = null;
  let lastMovement = Math.min(time, points[0].t);
  let movementFound = false;
  // Only the recent 2.5 seconds affect idle fade or the 650 ms click animation.
  for (let i = index; i >= 0 && time - points[i].t <= 2.5; i--) {
    const sample = points[i];
    if (
      !lastClick &&
      sample.click &&
      sample.visible !== false &&
      sample.t <= time &&
      time - sample.t <= 0.65
    ) {
      lastClick = { t: sample.t, x: clamp(sample.x), y: clamp(sample.y) };
    }
    const previous = points[Math.max(0, i - 1)];
    if (
      !movementFound &&
      sample.t <= time &&
      (sample.click ||
        Math.hypot(sample.x - previous.x, sample.y - previous.y) > 0.001)
    ) {
      lastMovement = sample.t;
      movementFound = true;
    }
    if (movementFound && (lastClick || time - sample.t > 0.65)) break;
  }
  // A moving interpolated segment is movement now, including sparsely sampled tracks.
  if (
    time > current.t &&
    time < next.t &&
    Math.hypot(current.x - next.x, current.y - next.y) > 0.001
  )
    lastMovement = time;
  return {
    x: clamp(current.x + (next.x - current.x) * amount),
    y: clamp(current.y + (next.y - current.y) * amount),
    visible: current.visible !== false && time >= points[0].t,
    idleSeconds: clamp(time - lastMovement, 0, 2.5),
    lastClick,
  };
}

export function getFadeOpacity(project: Project, time: number): number {
  const duration = getDuration(project);
  if (duration === 0) return 1;
  const elapsed = getOutputTime(project, time);
  const fadeIn = Math.max(0, finite(project.appearance.fadeIn));
  const fadeOut = Math.max(0, finite(project.appearance.fadeOut));
  return Math.min(
    fadeIn > 0 ? clamp(elapsed / fadeIn) : 1,
    fadeOut > 0 ? clamp((duration - elapsed) / fadeOut) : 1,
  );
}

/** Click clusters and deliberate cursor pauses become editable source-time zooms. */
export function generateAutoZooms(
  cursor: readonly VisibleCursorPoint[],
  duration: number,
): Zoom[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const points = cursor
    .filter(
      (point) =>
        Number.isFinite(point.t) &&
        Number.isFinite(point.x) &&
        Number.isFinite(point.y) &&
        point.t >= 0 &&
        point.t <= duration &&
        point.visible !== false,
    )
    .slice()
    .sort((a, b) => a.t - b.t);
  const events: { t: number; x: number; y: number }[] = [];
  for (const point of points) if (point.click) events.push(point);
  if (events.length === 0 && points.length > 1) {
    let anchor = points[0],
      previous = points[0],
      traveled = 0,
      emitted = false;
    for (const point of points.slice(1)) {
      traveled += Math.hypot(point.x - previous.x, point.y - previous.y);
      if (Math.hypot(point.x - anchor.x, point.y - anchor.y) > 0.035) {
        anchor = point;
        emitted = false;
      } else if (!emitted && traveled >= 0.12 && point.t - anchor.t >= 0.8) {
        events.push({ t: anchor.t, x: anchor.x, y: anchor.y });
        emitted = true;
        traveled = 0;
      }
      previous = point;
    }
  }
  const ranges: Zoom[] = [];
  for (const event of events) {
    const start = Math.max(0, event.t - 0.5),
      end = Math.min(duration, event.t + 1.8);
    if (end - start < 0.3) continue;
    const x = clamp(event.x),
      y = clamp(event.y),
      previous = ranges.at(-1);
    if (
      previous &&
      start <= previous.end + 0.4 &&
      Math.hypot(previous.x - x, previous.y - y) < 0.25
    ) {
      previous.end = Math.max(previous.end, end);
      previous.x = (previous.x + x) / 2;
      previous.y = (previous.y + y) / 2;
    } else {
      ranges.push({
        id: `auto-${ranges.length}-${Math.round(event.t * 1000)}`,
        start,
        end,
        scale: 1.75,
        x,
        y,
        mode: "auto",
      });
    }
  }
  return ranges;
}
