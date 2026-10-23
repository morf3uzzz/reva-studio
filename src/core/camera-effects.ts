import type { Project } from "../types.ts";
import type { CameraLayoutSettings, CameraPoint, CameraRect } from "./camera.ts";
import { cameraSourceOffsetSeconds } from "../../shared/camera-clock.mjs";

/** Editable ranges use original screen-media seconds, just like zooms/cuts. */
export type CameraSceneLayout = CameraLayoutSettings
  | { type: "fullscreen-camera"; enablePadding: boolean; cameraLayout?: CameraLayoutSettings }
  | { type: "screen-only"; cameraLayout?: CameraLayoutSettings };
export interface CameraScene {
  id: string;
  start: number;
  end: number;
  layout: CameraSceneLayout;
  disabled?: boolean;
}
export interface CameraAnalysisSource {
  path: string;
  sha256: string;
  duration: number;
  width?: number;
  height?: number;
}
export interface CameraFaceTrack {
  version: 1;
  source: CameraAnalysisSource;
  coordinateSpace: "oriented-top-left-normalized";
  sampleInterval: number;
  samples: { t: number; requestedTime?: number; face: (CameraRect & { confidence: number }) | null }[];
  coverage: { complete: boolean; intervals: { start: number; end: number }[]; limitations: string[] };
}
export interface CameraSilenceAnalysis {
  version: 1;
  source: CameraAnalysisSource;
  thresholdDB: number;
  minimumSeconds: number;
  windowSeconds: number;
  intervals: { start: number; end: number }[];
  coverage: { complete: boolean; intervals: { start: number; end: number }[]; limitations: string[] };
}
export interface CameraAnalysisResult { faceTrack?: CameraFaceTrack; silence?: CameraSilenceAnalysis }
export interface CameraLUT {
  title: string;
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  /** .cube ordering: red varies fastest, then green, then blue. */
  data: number[];
}
export const CAMERA_LOOKS = ["none", "warm", "cool", "mono", "cinematic", "studio", "film", "cream", "terra", "moody", "neon", "punch", "fade"] as const;
export type CameraLook = typeof CAMERA_LOOKS[number];
export interface CameraProcessingSettings {
  gradingEnabled?: boolean;
  look: CameraLook;
  lut: CameraLUT | null;
  lutIntensity: number;
  sharpen: number;
  grain: number;
}
export const defaultCameraProcessing = (): CameraProcessingSettings => ({ look: "none", lut: null, lutIntensity: 1, sharpen: 0, grain: 0 });

export function cameraSourceTime(project: Project, screenSeconds: number, mediaDuration?: number): number {
  const requested = Math.max(0, screenSeconds + cameraSourceOffsetSeconds(project));
  const knownDuration = mediaDuration ?? (project.cameraFaceTrack?.source.path === project.cameraPath ? project.cameraFaceTrack.source.duration : undefined);
  // A decoder endpoint can be the final real frame PTS. Seeking policy belongs
  // to playback; the camera clock must preserve that exact source endpoint.
  return Number.isFinite(knownDuration) && knownDuration! > 0 ? Math.min(requested, knownDuration!) : requested;
}

export function normalizedCameraCrop(crop: CameraRect | undefined): CameraRect {
  if (!crop) return { x: 0, y: 0, width: 1, height: 1 };
  const x = Math.min(1 - Number.EPSILON, Math.max(0, crop.x)), y = Math.min(1 - Number.EPSILON, Math.max(0, crop.y));
  return { x, y, width: Math.min(1 - x, Math.max(Number.EPSILON, crop.width)), height: Math.min(1 - y, Math.max(Number.EPSILON, crop.height)) };
}

export function cameraSceneAt(project: Project, sourceTime: number): CameraScene | null {
  // Last range wins an overlap; edits retain their explicit source ranges.
  const scenes = project.cameraScenes ?? [];
  for (let index = scenes.length - 1; index >= 0; index--) {
    const scene = scenes[index];
    if (!scene.disabled && Number.isFinite(scene.start) && Number.isFinite(scene.end) && scene.end > scene.start && sourceTime >= scene.start && sourceTime < scene.end) return scene;
  }
  return null;
}

export function cameraSilenceSource(project: Project): string | null {
  return project.microphonePath ?? project.mediaPath ?? project.cameraPath;
}

export function cameraIsHidden(project: Project, sourceTime: number): boolean {
  if (cameraSourceTime(project, sourceTime) < (project.cameraStartTime ?? 0)) return true;
  if (project.appearance.cameraHidden || cameraSceneAt(project, sourceTime)?.layout.type === "screen-only") return true;
  const silence = project.cameraSilence;
  if (!project.appearance.cameraHideDuringSilence || !silence || silence.source.path !== cameraSilenceSource(project)) return false;
  // Only measured, successfully covered intervals can hide the camera.
  const minimum = project.appearance.cameraSilenceMinimumSeconds ?? silence.minimumSeconds;
  return silence.coverage.intervals.some(range => sourceTime >= range.start && sourceTime < range.end)
    && silence.intervals.some(range => range.end - range.start + 1e-7 >= minimum && sourceTime >= range.start && sourceTime < range.end);
}

/** No detection is represented explicitly; missing observations never invent a face. */
export function cameraFaceFocus(project: Project, sourceTime: number): CameraPoint {
  const fallback = { x: 0.5, y: 0.5 };
  const track = project.cameraFaceTrack;
  if (!project.appearance.cameraFollowFace || !track || track.source.path !== project.cameraPath || track.coordinateSpace !== "oriented-top-left-normalized") return fallback;
  sourceTime = cameraSourceTime(project, sourceTime, track.source.duration);
  if (!track.coverage.intervals.some(range => sourceTime >= range.start && sourceTime < range.end)) return fallback;
  let low = 0, high = track.samples.length;
  while (low < high) { const middle = (low + high) >>> 1; if (track.samples[middle].t <= sourceTime) low = middle + 1; else high = middle; }
  const previous = track.samples[low - 1];
  if (!previous?.face || sourceTime - previous.t > Math.max(0.5, track.sampleInterval * 2)) return fallback;
  return { x: previous.face.x + previous.face.width / 2, y: previous.face.y + previous.face.height / 2 };
}

/** Cover crop around an independently animated, oriented source-space focal point. */
export function cameraCoverCrop(source: { width: number; height: number }, frame: { width: number; height: number }, focus: CameraPoint, sourceCrop?: CameraRect): CameraRect {
  const normalized = normalizedCameraCrop(sourceCrop), area = { x: normalized.x * source.width, y: normalized.y * source.height, width: normalized.width * source.width, height: normalized.height * source.height };
  const scale = Math.max(frame.width / area.width, frame.height / area.height);
  const width = frame.width / scale, height = frame.height / scale;
  return { x: Math.min(area.x + area.width - width, Math.max(area.x, focus.x * source.width - width / 2)), y: Math.min(area.y + area.height - height, Math.max(area.y, focus.y * source.height - height / 2)), width, height };
}

export type CameraLUTResult = { ok: true; value: CameraLUT } | { ok: false; error: { code: "invalid_camera_lut"; message: string } };
/** Strict 3D .cube parser. The 65³ bound caps the float GPU texture at 4.2 MiB. */
export function parseCameraLUT(source: string, name = "Custom LUT"): CameraLUTResult {
  const fail = (message: string): CameraLUTResult => ({ ok: false, error: { code: "invalid_camera_lut", message } });
  if (source.length > 32 * 1024 * 1024) return fail("The LUT exceeds the 32 MiB text budget.");
  let title = name, size: number | null = null;
  const domainMin: [number, number, number] = [0, 0, 0], domainMax: [number, number, number] = [1, 1, 1];
  const seen = new Set<string>(), data: number[] = [];
  for (const raw of source.split(/\r?\n/)) {
    if (/^\s*TITLE\b/.test(raw)) {
      const match = /^\s*TITLE\s+"([^"]*)"\s*(?:#.*)?$/.exec(raw);
      if (!match || seen.has("TITLE")) return fail("Invalid or duplicate TITLE.");
      title = match[1]; seen.add("TITLE"); continue;
    }
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [keyword, ...values] = line.split(/\s+/);
    if (keyword === "LUT_3D_SIZE") {
      if (seen.has(keyword) || data.length || values.length !== 1) return fail("Specify one LUT_3D_SIZE before the color rows.");
      size = Number(values[0]); if (!Number.isInteger(size) || size < 2 || size > 65) return fail("Supported 3D LUT sizes are 2 through 65."); seen.add(keyword); continue;
    }
    if (keyword === "DOMAIN_MIN" || keyword === "DOMAIN_MAX") {
      if (seen.has(keyword) || data.length || values.length !== 3 || values.some(value => !Number.isFinite(Number(value)))) return fail("Invalid or duplicate LUT domain.");
      const target = keyword === "DOMAIN_MIN" ? domainMin : domainMax; for (let index = 0; index < 3; index++) target[index] = Number(values[index]); seen.add(keyword); continue;
    }
    const channels = [keyword, ...values].map(Number);
    if (!size || channels.length !== 3 || [keyword, ...values].some(value => !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) || channels.some(value => !Number.isFinite(value) || Math.abs(value) > 65504)) return fail("Expected a 3D .cube header and RGB rows representable by the half-float GPU texture.");
    if (data.length + 3 > size ** 3 * 3) return fail("The LUT contains more color rows than its declared size.");
    data.push(...channels);
  }
  if (!size || data.length !== size ** 3 * 3) return fail("The LUT is incomplete for its declared size.");
  if (domainMin.some((value, index) => Math.fround(value) >= Math.fround(domainMax[index]) || !Number.isFinite(Math.fround(domainMax[index] - value)))) return fail("Every LUT domain must have a positive finite GPU-representable extent.");
  return { ok: true, value: { title, size, domainMin, domainMax, data } };
}

/** Reference trilinear sampler also used by pixel-level processing tests. */
export function sampleCameraLUT(lut: CameraLUT, rgb: readonly number[]): [number, number, number] {
  const p = rgb.map((value, index) => Math.min(1, Math.max(0, (value - lut.domainMin[index]) / (lut.domainMax[index] - lut.domainMin[index]))) * (lut.size - 1));
  const lower = p.map(Math.floor), fraction = p.map((value, index) => value - lower[index]);
  const output: [number, number, number] = [0, 0, 0];
  for (let z = 0; z <= 1; z++) for (let y = 0; y <= 1; y++) for (let x = 0; x <= 1; x++) {
    const corner = [x, y, z], point = lower.map((value, axis) => Math.min(lut.size - 1, value + corner[axis]));
    const weight = corner.reduce((total, side, axis) => total * (side ? fraction[axis] : 1 - fraction[axis]), 1);
    const offset = (point[0] + lut.size * (point[1] + lut.size * point[2])) * 3;
    for (let channel = 0; channel < 3; channel++) output[channel] += lut.data[offset + channel] * weight;
  }
  return output;
}
