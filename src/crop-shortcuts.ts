import { movePixelCrop, resizePixelCrop, type CropRect, type CropSize } from "./crop-geometry.ts";

const actions = [
  { key: "ArrowLeft", symbol: "←", dx: -1, dy: 0, move: "moveLeft", resize: "reduceWidth" },
  { key: "ArrowRight", symbol: "→", dx: 1, dy: 0, move: "moveRight", resize: "increaseWidth" },
  { key: "ArrowUp", symbol: "↑", dx: 0, dy: -1, move: "moveUp", resize: "increaseHeight" },
  { key: "ArrowDown", symbol: "↓", dx: 0, dy: 1, move: "moveDown", resize: "reduceHeight" },
] as const;

/** The help rows and key handler share the same command definitions. */
export const CROP_SHORTCUTS = [false, true].flatMap(metaKey =>
  [1, 10].flatMap(step => actions.map(action => ({
    key: action.key,
    metaKey,
    shiftKey: step === 10,
    step,
    dx: action.dx * step,
    dy: action.dy * step,
    label: metaKey ? action.resize : action.move,
    chord: [metaKey ? "⌘" : "", step === 10 ? "⇧" : "", action.symbol].filter(Boolean).join(" "),
  }))),
);

export type CropShortcut = (typeof CROP_SHORTCUTS)[number];

export function cropShortcutForKey(event: {
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
}): CropShortcut | undefined {
  if (event.altKey || event.ctrlKey) return undefined;
  return CROP_SHORTCUTS.find(shortcut =>
    shortcut.key === event.key && shortcut.metaKey === event.metaKey && shortcut.shiftKey === event.shiftKey,
  );
}

export function applyCropShortcut(
  crop: CropRect,
  shortcut: CropShortcut,
  source: CropSize,
  ratio: number | null = null,
): CropRect {
  if (!shortcut.metaKey) return movePixelCrop(crop, shortcut.dx, shortcut.dy, source);
  // Command-Up increases height; unlike movement, its vertical delta is inverted.
  return resizePixelCrop(crop, shortcut.dx ? "e" : "s", shortcut.dx, -shortcut.dy, source, ratio);
}
