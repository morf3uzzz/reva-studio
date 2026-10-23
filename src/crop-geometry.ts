export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface CropSize {
  width: number;
  height: number;
}
export type CropHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

const limit = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, Number.isFinite(value) ? value : low));

/** This editor owns source-pixel interaction geometry; persisted crops stay normalized. */
export function constrainPixelCrop(crop: CropRect, source: CropSize): CropRect {
  const width = limit(crop.width, 1, source.width);
  const height = limit(crop.height, 1, source.height);
  return {
    x: limit(crop.x, 0, source.width - width),
    y: limit(crop.y, 0, source.height - height),
    width,
    height,
  };
}

export function cropToPixels(crop: CropRect, source: CropSize): CropRect {
  return constrainPixelCrop(
    {
      x: crop.x * source.width,
      y: crop.y * source.height,
      width: crop.width * source.width,
      height: crop.height * source.height,
    },
    source,
  );
}

export function cropToNormalized(crop: CropRect, source: CropSize): CropRect {
  const bounded = constrainPixelCrop(crop, source);
  return {
    x: bounded.x / source.width,
    y: bounded.y / source.height,
    width: bounded.width / source.width,
    height: bounded.height / source.height,
  };
}

export function movePixelCrop(
  crop: CropRect,
  dx: number,
  dy: number,
  source: CropSize,
): CropRect {
  return constrainPixelCrop(
    { ...crop, x: crop.x + dx, y: crop.y + dy },
    source,
  );
}

/** Keep the center while fitting a preset inside the current crop. */
export function fitCropAspect(
  crop: CropRect,
  ratio: number,
  source: CropSize,
): CropRect {
  const bounded = constrainPixelCrop(crop, source);
  if (!Number.isFinite(ratio) || ratio <= 0) return bounded;
  const maxWidth = Math.min(source.width, source.height * ratio);
  const minWidth = Math.min(maxWidth, Math.max(1, ratio));
  const width = limit(
    Math.min(bounded.width, bounded.height * ratio),
    minWidth,
    maxWidth,
  );
  const height = width / ratio;
  return constrainPixelCrop(
    {
      x: bounded.x + (bounded.width - width) / 2,
      y: bounded.y + (bounded.height - height) / 2,
      width,
      height,
    },
    source,
  );
}

export function setCropDimension(
  crop: CropRect,
  axis: "width" | "height",
  value: number,
  source: CropSize,
  ratio: number | null = null,
): CropRect {
  const bounded = constrainPixelCrop(crop, source);
  if (!ratio || !Number.isFinite(ratio) || ratio <= 0)
    return constrainPixelCrop({ ...bounded, [axis]: value }, source);
  const maxWidth = Math.min(source.width, source.height * ratio);
  const minWidth = Math.min(maxWidth, Math.max(1, ratio));
  const width = limit(
    axis === "width" ? value : value * ratio,
    minWidth,
    maxWidth,
  );
  return constrainPixelCrop(
    { ...bounded, width, height: width / ratio },
    source,
  );
}

/** Opposite edge/corner stays fixed. Ratio-locked side handles preserve the cross-axis center. */
export function resizePixelCrop(
  crop: CropRect,
  handle: CropHandle,
  dx: number,
  dy: number,
  source: CropSize,
  ratio: number | null = null,
): CropRect {
  const initial = constrainPixelCrop(crop, source);
  const horizontal = handle.includes("w") ? -1 : handle.includes("e") ? 1 : 0;
  const vertical = handle.includes("n") ? -1 : handle.includes("s") ? 1 : 0;
  const left =
    horizontal < 0
      ? limit(initial.x + dx, 0, initial.x + initial.width - 1)
      : initial.x;
  const right =
    horizontal > 0
      ? limit(initial.x + initial.width + dx, initial.x + 1, source.width)
      : initial.x + initial.width;
  const top =
    vertical < 0
      ? limit(initial.y + dy, 0, initial.y + initial.height - 1)
      : initial.y;
  const bottom =
    vertical > 0
      ? limit(initial.y + initial.height + dy, initial.y + 1, source.height)
      : initial.y + initial.height;
  if (!ratio || !Number.isFinite(ratio) || ratio <= 0)
    return { x: left, y: top, width: right - left, height: bottom - top };

  const anchorX =
    horizontal < 0
      ? initial.x + initial.width
      : horizontal > 0
        ? initial.x
        : initial.x + initial.width / 2;
  const anchorY =
    vertical < 0
      ? initial.y + initial.height
      : vertical > 0
        ? initial.y
        : initial.y + initial.height / 2;
  const maxWidth =
    horizontal < 0
      ? anchorX
      : horizontal > 0
        ? source.width - anchorX
        : 2 * Math.min(anchorX, source.width - anchorX);
  const maxHeight =
    vertical < 0
      ? anchorY
      : vertical > 0
        ? source.height - anchorY
        : 2 * Math.min(anchorY, source.height - anchorY);
  const widthFromX = initial.width + horizontal * dx;
  const widthFromY = (initial.height + vertical * dy) * ratio;
  const widthDriven =
    vertical === 0 ||
    (horizontal !== 0 &&
      Math.abs(dx / initial.width) >= Math.abs(dy / initial.height));
  const maximum = Math.min(maxWidth, maxHeight * ratio);
  const minimum = Math.min(maximum, Math.max(1, ratio));
  const width = limit(widthDriven ? widthFromX : widthFromY, minimum, maximum);
  const height = width / ratio;
  return {
    x:
      horizontal < 0
        ? anchorX - width
        : horizontal > 0
          ? anchorX
          : anchorX - width / 2,
    y:
      vertical < 0
        ? anchorY - height
        : vertical > 0
          ? anchorY
          : anchorY - height / 2,
    width,
    height,
  };
}
