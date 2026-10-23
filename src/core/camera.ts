/**
 * Independent layout implementation from Screen Studio 4.1.0-5005 evidence.
 * One geometry owner is shared by editor preview and export.
 * Coordinates use the oriented, cropped source and an origin-zero output stage.
 */
export interface CameraSize {
  readonly width: number;
  readonly height: number;
}

export interface CameraPoint {
  readonly x: number;
  readonly y: number;
}

export interface CameraRect extends CameraSize, CameraPoint {}

/** All three layouts retain their own settings when the selected mode changes. */
export interface CameraLayoutSettings {
  type: CameraConfig["type"];
  overlay: Omit<Extract<CameraConfig, { type: "camera-overlay" }>, "type"> & { shrinkDuringZoom?: boolean };
  split: Omit<Extract<CameraConfig, { type: "split-screen" }>, "type">;
  cutout: Omit<Extract<CameraConfig, { type: "cutout-camera" }>, "type"> & {
    edgeSoftness: number;
    inset: number;
    shrinkDuringZoom?: boolean;
  };
}

export function defaultCameraLayout(): CameraLayoutSettings {
  return {
    type: "camera-overlay",
    overlay: { position: { x: 1, y: 1 }, sizeRatio: 0.5, paddingRatio: 0.5, aspectRatio: 1, zoomScale: 0.8 },
    split: { direction: "auto", flip: false, screenRatio: null, enablePadding: false },
    cutout: { positionX: 1, sizeRatio: 0.5, aspectRatio: null, zoomScale: 0.8, edgeSoftness: 0.2, inset: 0 },
  };
}

export function cameraConfig(settings: CameraLayoutSettings): CameraConfig {
  if (settings.type === "camera-overlay") return { type: settings.type, ...settings.overlay, zoomScale: settings.overlay.shrinkDuringZoom === false ? 1 : settings.overlay.zoomScale };
  if (settings.type === "split-screen") return { type: settings.type, ...settings.split };
  return { type: settings.type, ...settings.cutout, zoomScale: settings.cutout.shrinkDuringZoom === false ? 1 : settings.cutout.zoomScale };
}

/** Pa/Fa: the focus point with most clearance from both camera and stage edges. */
export function cameraFreeCenter(area: CameraRect, camera: CameraRect): CameraPoint {
  const center = { x: area.x + area.width / 2, y: area.y + area.height / 2 };
  const right = area.x + area.width, bottom = area.y + area.height;
  const leftC = Math.max(area.x, camera.x), topC = Math.max(area.y, camera.y);
  const rightC = Math.min(right, camera.x + camera.width), bottomC = Math.min(bottom, camera.y + camera.height);
  if (rightC <= leftC || bottomC <= topC || (leftC === area.x && rightC === right && topC === area.y && bottomC === bottom)) return center;
  const candidates = [center,
    { x: center.x, y: (area.y + topC) / 2 },
    { x: center.x, y: (bottomC + bottom) / 2 },
    { x: (area.x + leftC) / 2, y: center.y },
    { x: (rightC + right) / 2, y: center.y },
  ].filter(p => p.x >= area.x && p.x <= right && p.y >= area.y && p.y <= bottom && !(p.x >= leftC && p.x <= rightC && p.y >= topC && p.y <= bottomC));
  const score = (p: CameraPoint) => {
    let dx = Math.min(p.x - area.x, right - p.x);
    let dy = Math.min(p.y - area.y, bottom - p.y);
    if (p.y > topC && p.y < bottomC) dx = Math.min(dx, p.x < leftC ? leftC - p.x : p.x - rightC);
    if (p.x > leftC && p.x < rightC) dy = Math.min(dy, p.y < topC ? topC - p.y : p.y - bottomC);
    return Math.min(dx, dy);
  };
  candidates.sort((a, b) => {
    const difference = score(b) - score(a);
    return Math.abs(difference) > 1e-9 ? difference : Math.hypot(a.x - center.x, a.y - center.y) - Math.hypot(b.x - center.x, b.y - center.y);
  });
  return candidates[0] ?? center;
}

export type CameraConfig =
  | {
      readonly type: "camera-overlay";
      readonly position: CameraPoint;
      readonly sizeRatio: number;
      readonly paddingRatio: number;
      readonly aspectRatio: number;
      readonly zoomScale: number;
    }
  | {
      readonly type: "cutout-camera";
      readonly positionX: number;
      readonly sizeRatio: number;
      readonly aspectRatio: number | null;
      readonly zoomScale: number;
    }
  | {
      readonly type: "split-screen";
      readonly direction: "auto" | "horizontal" | "vertical";
      readonly flip: boolean;
      readonly screenRatio: number | null;
      readonly enablePadding: boolean;
    };

export interface CameraGeometryInput {
  readonly stage: CameraSize;
  /** Dimensions after orientation and source crop; this module does neither. */
  readonly screenSource: CameraSize;
  readonly paddingRatio: number;
  readonly cameraSourceAspectRatio?: number;
  readonly avoidEmptyZoomArea?: boolean;
}

export type CameraScreenSide = "left" | "right" | "top" | "bottom";

export interface CameraLayoutFrame {
  readonly screen: CameraRect;
  readonly camera: CameraRect;
  readonly zoomArea: CameraRect;
  readonly allowsScreenBorderRadius: boolean;
  readonly allowsCameraBorderRadius: boolean;
}

export interface CameraGeometry {
  readonly type: CameraConfig["type"];
  readonly resting: CameraLayoutFrame;
  /** Layout endpoint before applying screen zoom/focus or animation. */
  readonly zoomed: CameraLayoutFrame;
  readonly screenSide: CameraScreenSide | null;
  readonly effectivePaddingRatio: number;
  /** A cutout cannot be rendered faithfully without a separate foreground mask. */
  readonly requiresForegroundAlpha: boolean;
}

export interface CameraGeometryError {
  readonly code: "invalid_camera_geometry" | "camera_layout_unavailable";
  readonly field: string;
  readonly message: string;
}

export type CameraGeometryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CameraGeometryError };

type Failure = Extract<CameraGeometryResult<never>, { ok: false }>;
const fail = (
  field: string,
  message: string,
  code: CameraGeometryError["code"] = "invalid_camera_geometry",
): Failure => ({ ok: false, error: { code, field, message } });
const positive = (value: number) => Number.isFinite(value) && value > 0;
const ratio = (value: number) =>
  Number.isFinite(value) && value >= 0 && value <= 1;
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
const center = { x: 0.5, y: 0.5 };
const anchors: Record<CameraScreenSide, CameraPoint> = {
  left: { x: 0, y: 0.5 },
  right: { x: 1, y: 0.5 },
  top: { x: 0.5, y: 0 },
  bottom: { x: 0.5, y: 1 },
};

function validateConfig(config: CameraConfig): Failure | null {
  if (config.type === "split-screen") {
    if (!["auto", "horizontal", "vertical"].includes(config.direction))
      return fail("direction", "Expected auto, horizontal or vertical.");
    if (
      typeof config.flip !== "boolean" ||
      typeof config.enablePadding !== "boolean"
    )
      return fail("split-screen", "Flip and enablePadding must be booleans.");
    if (
      config.screenRatio !== null &&
      (!ratio(config.screenRatio) ||
        config.screenRatio === 0 ||
        config.screenRatio === 1)
    )
      return fail(
        "screenRatio",
        "A split needs a ratio strictly between zero and one, or null for Auto.",
      );
    return null;
  }
  if (config.type !== "camera-overlay" && config.type !== "cutout-camera")
    return fail("type", "Unsupported camera layout.");
  if (!ratio(config.sizeRatio) || config.sizeRatio === 0)
    return fail(
      "sizeRatio",
      "Camera size must be greater than zero and at most one.",
    );
  if (!ratio(config.zoomScale) || config.zoomScale === 0)
    return fail(
      "zoomScale",
      "Camera zoom scale must be greater than zero and at most one.",
    );
  if (config.aspectRatio !== null && !positive(config.aspectRatio))
    return fail(
      "aspectRatio",
      "Camera aspect ratio must be finite and positive.",
    );
  if (config.type === "camera-overlay") {
    if (!positive(config.aspectRatio))
      return fail("aspectRatio", "Overlay requires a camera aspect ratio.");
    if (!ratio(config.paddingRatio))
      return fail(
        "camera.paddingRatio",
        "Camera padding slider must be between zero and one.",
      );
    if (!ratio(config.position?.x) || !ratio(config.position?.y))
      return fail(
        "position",
        "Camera position must be normalized to the stage.",
      );
  } else if (!ratio(config.positionX)) {
    return fail(
      "positionX",
      "Cutout horizontal position must be between zero and one.",
    );
  }
  return null;
}

function validateSource(
  source: CameraSize,
  paddingRatio: number,
): Failure | null {
  if (
    !positive(source.width) ||
    !positive(source.height) ||
    !positive(source.width / source.height)
  )
    return fail(
      "screenSource",
      "Oriented source dimensions and their ratio must be finite and positive.",
    );
  if (!Number.isFinite(paddingRatio) || paddingRatio < 0)
    return fail(
      "paddingRatio",
      "Stage padding must be finite and nonnegative.",
    );
  return null;
}

function align(size: CameraSize, area: CameraRect, point = center): CameraRect {
  return {
    x: area.x + point.x * (area.width - size.width),
    y: area.y + point.y * (area.height - size.height),
    width: size.width,
    height: size.height,
  };
}

/** Inverse of expanding the shortest source dimension by padding on both sides. */
function inset(stage: CameraSize, padding: number): CameraRect {
  const amount =
    Math.min(stage.width, stage.height) * (padding / (1 + 2 * padding));
  return {
    x: amount,
    y: amount,
    width: stage.width - 2 * amount,
    height: stage.height - 2 * amount,
  };
}

function fitSource(
  source: CameraSize,
  area: CameraRect,
  cover: boolean,
): CameraRect {
  const scale = (cover ? Math.max : Math.min)(
    area.width / source.width,
    area.height / source.height,
  );
  return align(
    { width: source.width * scale, height: source.height * scale },
    area,
  );
}

function cameraSize(
  stage: CameraSize,
  sizeRatio: number,
  aspect: number,
): CameraSize {
  const side = Math.min(stage.width, stage.height) * sizeRatio;
  return aspect >= 1
    ? { width: side, height: side / aspect }
    : { width: side * aspect, height: side };
}

function screenFrame(input: CameraGeometryInput, padding: number) {
  const zoomArea = inset(input.stage, padding);
  return {
    zoomArea,
    screen: fitSource(
      input.screenSource,
      zoomArea,
      input.avoidEmptyZoomArea === true,
    ),
  };
}

function overlayCamera(
  config: Extract<CameraConfig, { type: "camera-overlay" }>,
  input: CameraGeometryInput,
  scale = 1,
  paddingScale = 1,
): CameraRect {
  const padding =
    0.025 + config.paddingRatio * (Math.max(0.1, input.paddingRatio) - 0.025);
  return align(
    cameraSize(input.stage, config.sizeRatio * scale, config.aspectRatio),
    inset(input.stage, padding * paddingScale),
    config.position,
  );
}

function splitFrame(
  config: Extract<CameraConfig, { type: "split-screen" }>,
  input: CameraGeometryInput,
  padding: number,
): CameraGeometryResult<{ frame: CameraLayoutFrame; side: CameraScreenSide }> {
  const area = inset(input.stage, padding);
  const horizontal =
    config.direction === "horizontal" ||
    (config.direction === "auto" && input.stage.width >= input.stage.height);
  const side: CameraScreenSide = horizontal
    ? config.flip
      ? "right"
      : "left"
    : config.flip
      ? "bottom"
      : "top";
  const cameraSide: CameraScreenSide = horizontal
    ? config.flip
      ? "left"
      : "right"
    : config.flip
      ? "top"
      : "bottom";
  const available = (horizontal ? area.width : area.height) - area.x;
  const sourceAspect = input.screenSource.width / input.screenSource.height;
  const requested =
    config.screenRatio === null && horizontal
      ? available - area.height * sourceAspect
      : available * (1 - (config.screenRatio ?? 0.5));
  const camera = align(
    horizontal
      ? {
          width:
            requested >= 0 && requested / area.height > 0.4
              ? requested
              : area.height * 0.5,
          height: area.height,
        }
      : {
          width: area.width,
          height:
            requested >= 0 && area.width / requested < 2.5
              ? requested
              : area.width / 2.5,
        },
    area,
    anchors[cameraSide],
  );
  const remaining = available - (horizontal ? camera.width : camera.height);
  if (!positive(remaining))
    return fail(
      "stage",
      "This split direction, padding and camera size leave no space for the screen.",
      "camera_layout_unavailable",
    );
  const zoomArea = align(
    horizontal
      ? { width: remaining, height: area.height }
      : { width: area.width, height: remaining },
    area,
    anchors[side],
  );
  let screen = fitSource(input.screenSource, zoomArea, true);
  const overflow = horizontal
    ? screen.width - zoomArea.width
    : screen.height - zoomArea.height;
  // The reference resolves geometry on a 1080-high stage before output scaling.
  if (overflow > (0.5 * input.stage.height) / 1080) {
    const reduction = padding > 0 ? 0.9 : 1;
    const dimension = horizontal
      ? Math.max(zoomArea.width / sourceAspect, zoomArea.height * reduction)
      : Math.max(zoomArea.height * sourceAspect, zoomArea.width * reduction);
    screen = align(
      horizontal
        ? { width: dimension * sourceAspect, height: dimension }
        : { width: dimension, height: dimension / sourceAspect },
      zoomArea,
    );
  }
  return {
    ok: true,
    value: {
      side,
      frame: {
        screen,
        camera,
        zoomArea,
        allowsScreenBorderRadius: padding > 0,
        allowsCameraBorderRadius: padding > 0,
      },
    },
  };
}

/** Static endpoints only: the caller owns screen zoom, cursor focus and springs. */
export function resolveCameraGeometry(
  config: CameraConfig,
  input: CameraGeometryInput,
): CameraGeometryResult<CameraGeometry> {
  const invalid =
    validateConfig(config) ??
    validateSource(input.screenSource, input.paddingRatio);
  if (invalid) return invalid;
  if (!positive(input.stage.width) || !positive(input.stage.height))
    return fail("stage", "Output dimensions must be finite and positive.");
  if (
    input.cameraSourceAspectRatio !== undefined &&
    !positive(input.cameraSourceAspectRatio)
  )
    return fail(
      "cameraSourceAspectRatio",
      "Camera source aspect ratio must be finite and positive when present.",
    );
  if (
    input.avoidEmptyZoomArea !== undefined &&
    typeof input.avoidEmptyZoomArea !== "boolean"
  )
    return fail("avoidEmptyZoomArea", "Expected a boolean when present.");

  const padding =
    config.type === "split-screen" && !config.enablePadding
      ? 0
      : input.paddingRatio;
  let resting: CameraLayoutFrame;
  let zoomed: CameraLayoutFrame;
  let screenSide: CameraScreenSide | null = null;
  if (config.type === "split-screen") {
    const split = splitFrame(config, input, padding);
    if (!split.ok) return split;
    resting = split.value.frame;
    screenSide = split.value.side;
    const overlay: Extract<CameraConfig, { type: "camera-overlay" }> = {
      type: "camera-overlay",
      position: {
        x: screenSide === "right" ? 0 : 1,
        y: screenSide === "bottom" ? 0 : 1,
      },
      sizeRatio: 0.5,
      paddingRatio: 0.5,
      aspectRatio: clamp(
        resting.camera.width / resting.camera.height,
        9 / 16,
        16 / 9,
      ),
      zoomScale: 1,
    };
    zoomed = {
      ...screenFrame(input, padding),
      camera: overlayCamera(overlay, { ...input, paddingRatio: padding }),
      allowsScreenBorderRadius: true,
      allowsCameraBorderRadius: true,
    };
  } else {
    const screen = screenFrame(input, padding);
    const frame = (camera: CameraRect): CameraLayoutFrame => ({
      ...screen,
      camera,
      allowsScreenBorderRadius: true,
      allowsCameraBorderRadius: config.type !== "cutout-camera",
    });
    if (config.type === "camera-overlay") {
      resting = frame(overlayCamera(config, input));
      zoomed = frame(overlayCamera(config, input, config.zoomScale, 0.5));
    } else {
      const area = {
        ...inset(input.stage, padding),
        y: 0,
        height: input.stage.height,
      };
      const aspect = config.aspectRatio ?? input.cameraSourceAspectRatio ?? 1;
      const camera = (scale: number) =>
        align(cameraSize(input.stage, config.sizeRatio * scale, aspect), area, {
          x: config.positionX,
          y: 1,
        });
      resting = frame(camera(1));
      zoomed = frame(camera(config.zoomScale));
    }
  }
  for (const [phase, frame] of [
    ["resting", resting],
    ["zoomed", zoomed],
  ] as const) {
    for (const [part, rect] of [
      ["screen", frame.screen],
      ["camera", frame.camera],
      ["zoomArea", frame.zoomArea],
    ] as const) {
      if (
        !Number.isFinite(rect.x) ||
        !Number.isFinite(rect.y) ||
        !positive(rect.width) ||
        !positive(rect.height)
      )
        return fail(
          `${phase}.${part}`,
          "Dimensions cannot be represented as a finite, nonempty rectangle.",
          "camera_layout_unavailable",
        );
    }
  }
  return {
    ok: true,
    value: {
      type: config.type,
      resting,
      zoomed,
      screenSide,
      effectivePaddingRatio: padding,
      requiresForegroundAlpha: config.type === "cutout-camera",
    },
  };
}

/** Canvas Auto aspect, before choosing actual export dimensions or orientation. */
export function getCameraAutoAspectRatio(
  config: CameraConfig,
  screenSource: CameraSize,
  paddingRatio: number,
): CameraGeometryResult<number> {
  const invalid =
    validateConfig(config) ?? validateSource(screenSource, paddingRatio);
  if (invalid) return invalid;
  let aspect: number;
  if (config.type === "split-screen") {
    const padding = config.enablePadding ? paddingRatio : 0;
    const sourceAspect = screenSource.width / screenSource.height;
    const insideHeight = 1080 - 2 * padding * 1080;
    const cameraAspect =
      (1920 - 3 * padding * 1080 - sourceAspect * insideHeight) / insideHeight;
    aspect =
      cameraAspect >= 0.4 && cameraAspect <= 16 / 9
        ? 16 / 9
        : clamp(
            (sourceAspect + 9 / 16 + 3 * padding) / (1 + 2 * padding),
            1,
            2.4,
          );
  } else {
    const expansion =
      2 * Math.min(screenSource.width, screenSource.height) * paddingRatio;
    aspect =
      (screenSource.width + expansion) / (screenSource.height + expansion);
  }
  return positive(aspect)
    ? { ok: true, value: aspect }
    : fail(
        "aspectRatio",
        "Auto aspect cannot be represented as a finite positive number.",
        "camera_layout_unavailable",
      );
}

/** Resting Split pans away from the camera when the cursor would approach it. */
export function getSplitRestingScreenSide(
  geometry: CameraGeometry,
  cursorBounds: CameraRect,
): CameraGeometryResult<CameraScreenSide> {
  if (geometry.screenSide === null)
    return fail("type", "Resting screen side applies only to Split layout.");
  if (
    !ratio(cursorBounds.x) ||
    !ratio(cursorBounds.y) ||
    !ratio(cursorBounds.width) ||
    !ratio(cursorBounds.height) ||
    cursorBounds.x + cursorBounds.width > 1 ||
    cursorBounds.y + cursorBounds.height > 1
  )
    return fail(
      "cursorBounds",
      "Cursor bounds must fit within normalized source coordinates.",
    );
  const side = geometry.screenSide;
  const opposite: Record<CameraScreenSide, CameraScreenSide> = {
    left: "right",
    right: "left",
    top: "bottom",
    bottom: "top",
  };
  const { camera, zoomArea } = geometry.resting;
  const screen = align(geometry.resting.screen, zoomArea, anchors[side]);
  const horizontal = side === "left" || side === "right";
  const x =
    screen.x +
    screen.width *
      (cursorBounds.x + (side === "left" ? cursorBounds.width : 0));
  const y =
    screen.y +
    screen.height *
      (cursorBounds.y + (side === "top" ? cursorBounds.height : 0));
  const distance =
    side === "left"
      ? camera.x - x
      : side === "right"
        ? x - camera.x - camera.width
        : side === "top"
          ? camera.y - y
          : y - camera.y - camera.height;
  return {
    ok: true,
    value:
      distance < 0.125 * (horizontal ? screen.width : screen.height)
        ? opposite[side]
        : side,
  };
}
