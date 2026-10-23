import catalog from "../../wallpapers.json";

export interface ReferenceWallpaper {
  name: string;
  category: string;
  /** Stable path within the original REVA artwork catalog. */
  file: string;
}

export const WALLPAPERS: readonly ReferenceWallpaper[] = catalog.entries.map(
  ({ name, category, file }) => ({ name, category, file }),
);

/** Stable catalog identity; category filtering does not change persisted indexes. */
export function wallpapersInCategory(category: string) {
  return WALLPAPERS.map((wallpaper, index) => ({wallpaper,index})).filter(entry => entry.wallpaper.category === category);
}

export function wallpaperURL(index: number): string {
  const wallpaper = WALLPAPERS[index] ?? WALLPAPERS[0];
  return `${import.meta.env.BASE_URL}wallpapers/${wallpaper.file
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

/** Returns -1 when the original wallpaper is not present in the verified catalog. */
export function referenceWallpaperIndex(systemName: string): number {
  return WALLPAPERS.findIndex((wallpaper) => wallpaper.file === systemName);
}
