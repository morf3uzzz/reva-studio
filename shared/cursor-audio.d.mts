export type CursorSound = "none" | "apple-magic-mouse" | "logitech-mx-master";
export interface CursorAudioCue { sourceTime: number; outputTime: number; type: "click" | "down" | "up" }
export const CURSOR_SOUNDS: readonly CursorSound[];
export const CURSOR_SOUND_ROOT: string;
export function cursorSoundURL(sound: Exclude<CursorSound, "none">, type?: CursorAudioCue["type"]): string;
export function iterateCursorAudioCues(points: readonly { t: number; click: boolean; event?: string; visible?: boolean }[], slices: readonly { start: number; end: number; speed: number }[]): Generator<CursorAudioCue>;
