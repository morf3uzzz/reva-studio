import type { PrivacyAnalysis, PrivacyRegion, Project } from "../types.ts";
import type { Rect } from "./model.ts";

const indexes = new WeakMap<
  PrivacyAnalysis,
  { regions: PrivacyRegion[]; ends: number[] }
>();

/** Index once per immutable result; seeking never depends on the previous frame. */
export function privacyRegionsAtTime(
  project: Project,
  time: number,
): PrivacyRegion[] {
  const privacy = project.privacy;
  const analysis = privacy?.analysis;
  if (!privacy || !analysis || (!privacy.sensitive && !privacy.faces))
    return [];
  let index = indexes.get(analysis);
  if (!index) {
    const regions = [...analysis.regions].sort((a, b) => a.start - b.start);
    let last = 0;
    const ends = regions.map((r) => (last = Math.max(last, r.end)));
    index = { regions, ends };
    indexes.set(analysis, index);
  }
  let lo = 0,
    hi = index.ends.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (index.ends[mid] <= time) lo = mid + 1;
    else hi = mid;
  }
  const result = [];
  for (
    let i = lo;
    i < index.regions.length && index.regions[i].start <= time;
    i++
  ) {
    const r = index.regions[i];
    if (r.end > time && (r.kind === "face" ? privacy.faces : privacy.sensitive))
      result.push(r);
  }
  return result;
}

/** The same source crop transform as the video, clipped before zoom projection. */
export function privacyRect(
  region: PrivacyRegion,
  crop: Rect,
  screen: Rect,
): Rect | null {
  const left = Math.max(region.x, crop.x),
    top = Math.max(region.y, crop.y);
  const right = Math.min(region.x + region.width, crop.x + crop.width);
  const bottom = Math.min(region.y + region.height, crop.y + crop.height);
  if (right <= left || bottom <= top) return null;
  return {
    x: screen.x + ((left - crop.x) / crop.width) * screen.width,
    y: screen.y + ((top - crop.y) / crop.height) * screen.height,
    width: ((right - left) / crop.width) * screen.width,
    height: ((bottom - top) / crop.height) * screen.height,
  };
}
