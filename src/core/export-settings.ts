import type { ExportOptions } from "../types.ts";

type Format = ExportOptions["format"];
export interface ExportModeSettings {
  height: number;
  fps: number;
  quality: ExportOptions["quality"];
  codec: NonNullable<ExportOptions["codec"]>;
  encoding: NonNullable<ExportOptions["encoding"]>;
  proresProfile: NonNullable<ExportOptions["proresProfile"]>;
  gifHighQuality: boolean;
  gifLoop: boolean;
}
export interface ExportPreferences {
  version: 1;
  format: Format;
  destination: NonNullable<ExportOptions["destination"]>;
  modes: Record<Format, ExportModeSettings>;
}
interface PreferenceStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const exportPreferenceKey = "reva-export-settings-v1";
export function defaultExportPreferences(): ExportPreferences {
  const mode = { height: 720, fps: 60, quality: "balanced", codec: "h264", encoding: "software", proresProfile: "422-hq", gifHighQuality: false, gifLoop: true } as const;
  return { version: 1, format: "mp4", destination: "file", modes: {
    mp4: { ...mode }, prores: { ...mode, height: 1080, quality: "high" }, gif: { ...mode, height: 480, fps: 15 },
  } };
}
type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected export preferences to be an object.");
  return value as Record<string, unknown>;
};
function choice<T>(value: unknown, values: readonly T[], field: string): T {
  if (!values.includes(value as T)) throw new Error(`Invalid saved export ${field}.`);
  return value as T;
}
function parseMode(input: unknown, format: Format): ExportModeSettings {
  const mode = object(input);
  return {
    height: choice(mode.height, format === "gif" ? [480, 720, 1080] : [720, 1080, 2160], "height"),
    fps: choice(mode.fps, format === "gif" ? [50, 30, 25, 20, 15, 10] : [60, 50, 30, 25, 24, 20, 10], "frame rate"),
    quality: choice(mode.quality, ["high", "balanced", "small", "tiny"] as const, "quality"),
    codec: choice(mode.codec, ["h264", "hevc", "both"] as const, "codec"),
    encoding: choice(mode.encoding, ["software", "hardware"] as const, "encoding"),
    proresProfile: choice(mode.proresProfile, ["422-lt", "422", "422-hq", "4444"] as const, "ProRes profile"),
    gifHighQuality: choice(mode.gifHighQuality, [true, false], "GIF quality"),
    gifLoop: choice(mode.gifLoop, [true, false], "GIF loop"),
  };
}
export function parseExportPreferences(input: unknown): Parsed<ExportPreferences> {
  try {
    const value = object(input), modes = object(value.modes);
    if (value.version !== 1) throw new Error("Unsupported saved export preferences version.");
    return { ok: true, value: {
      version: 1, format: choice(value.format, ["mp4", "prores", "gif"] as const, "format"),
      destination: choice(value.destination, ["file", "clipboard"] as const, "destination"),
      modes: { mp4: parseMode(modes.mp4, "mp4"), prores: parseMode(modes.prores, "prores"), gif: parseMode(modes.gif, "gif") },
    } };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}
export function readExportPreferences(storage?: PreferenceStorage): { value: ExportPreferences; issue?: string } {
  try {
    const raw = (storage ?? window.localStorage).getItem(exportPreferenceKey);
    if (raw === null) return { value: defaultExportPreferences() };
    if (raw.length > 16_384) throw new Error("Saved export preferences exceed their size limit.");
    const result = parseExportPreferences(JSON.parse(raw));
    if (!result.ok) return { value: defaultExportPreferences(), issue: result.error };
    return { value: result.value };
  } catch (error) { return { value: defaultExportPreferences(), issue: error instanceof Error ? error.message : String(error) }; }
}
export function writeExportPreferences(value: ExportPreferences, storage?: PreferenceStorage): Parsed<void> {
  const parsed = parseExportPreferences(value);
  if (!parsed.ok) return parsed;
  try {
    const destination = storage ?? window.localStorage, raw = JSON.stringify(parsed.value), previous = destination.getItem(exportPreferenceKey);
    if (previous !== raw) {
      if (previous !== null) destination.setItem(`${exportPreferenceKey}.backup`, previous);
      destination.setItem(exportPreferenceKey, raw);
    }
    return { ok: true, value: undefined };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}
