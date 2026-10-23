export function defaultCaptionSettings(): import("../src/core/transcript.ts").CaptionSettings;
export function parseCaptionSettings(input: unknown): import("../src/core/transcript.ts").CaptionSettings;
export function parseTranscript(input: unknown, projectDuration?: number): import("../src/core/transcript.ts").TranscriptDocument;
export function importSRT(input: string, projectDuration: number, offset?: number): import("../src/core/transcript.ts").TranscriptDocument;
export function importTranscriptJSON(input: string, projectDuration: number): import("../src/core/transcript.ts").TranscriptDocument;
