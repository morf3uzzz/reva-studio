import type { Project, Slice } from "../types.ts";
import { getSlices, sourceRangeOutputSpans, timeToOutput } from "./timeline.ts";
import { defaultCaptionSettings } from "../../shared/transcript.mjs";
export { defaultCaptionSettings, parseCaptionSettings, parseTranscript, importSRT, importTranscriptJSON } from "../../shared/transcript.mjs";

export interface TranscriptWord {
  id: string; start: number; end: number; text: string; timing: "word" | "segment";
  sourceText?: string; hidden?: boolean; type?: "word" | "filler" | "sound-label"; confidence?: number;
}
export interface TranscriptCut { id: string; wordIds: string[]; removed: Slice[] }
export interface TranscriptDocument {
  version: 1; generator: "apple-on-device" | "srt-import" | "json-import" | "manual"; language: string | null;
  source: { path: string | null; sha256: string | null; duration: number; offset: number; track: "microphone" | "system" | "import" };
  words: TranscriptWord[]; videoCuts?: TranscriptCut[]; limitations?: string[];
}
export interface CaptionSettings {
  version: 1; enabled: boolean; showSoundLabels: boolean; font: "serif" | "sans-serif" | "mono"; sizeRatio: number;
  color: string; backgroundColor: string; backgroundOpacity: number; position: { x: number; y: number };
  wordsReveal: "line-by-line" | "word-by-word"; lineGrowth: "entire-line" | "left-anchored" | "centered";
  wordEntrance: "appear" | "fade-in" | "slide-in"; maxWords: number;
}
export interface TranscriptProject extends Project { transcript?: TranscriptDocument; captionSettings?: CaptionSettings }
export interface SpeechStatus {
  available: boolean; method: "apple-on-device"; permission: "granted" | "denied" | "restricted" | "not-determined" | "unknown";
  locale: string; locales: string[]; reason: string | null; engine: string;
}
export interface SpeechOptions { locale: string; track: "microphone" | "system"; offset: number; contextualStrings: string[] }
export interface TranscriptServices {
  status(locale: string): Promise<SpeechStatus>;
  generate(path: string, options: SpeechOptions): Promise<TranscriptDocument | null>;
  cancel(): Promise<void>;
  importFile(duration: number): Promise<TranscriptDocument | null>;
  exportSRT(content: string, name: string): Promise<boolean>;
}

function unionRanges(ranges: readonly { start: number; end: number }[]) {
  const merged: { start: number; end: number }[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start) continue;
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1e-9) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}
function uniqueID(ids: Set<string>, prefix: string) {
  let index = 1;
  while (ids.has(`${prefix}-${index}`)) index++;
  const id = `${prefix}-${index}`; ids.add(id); return id;
}

/** Remove exact source intervals; clip policy and all optional settings survive. */
export function removeTranscriptRanges(project: Project, ranges: readonly { start: number; end: number }[]): { slices: Slice[]; removed: Slice[] } {
  const cuts = unionRanges(ranges), original = getSlices(project), ids = new Set(original.map(s => s.id));
  const slices: Slice[] = [], removed: Slice[] = [];
  for (const slice of original) {
    let from = slice.start, emitted = false;
    const append = (start: number, end: number) => {
      if (end - start <= 1e-9) return;
      slices.push({ ...slice, id: emitted ? uniqueID(ids, `${slice.id}-transcript`) : slice.id, start, end }); emitted = true;
    };
    let low = 0, high = cuts.length;
    while (low < high) { const middle = (low + high) >>> 1; if (cuts[middle].end <= slice.start) low = middle + 1; else high = middle; }
    for (let index = low; index < cuts.length && cuts[index].start < slice.end; index++) {
      const cut = cuts[index];
      const start = Math.max(slice.start, cut.start), end = Math.min(slice.end, cut.end);
      if (end <= from || start >= slice.end) continue;
      append(from, start);
      removed.push({ ...slice, start, end }); from = end;
    }
    append(from, slice.end);
  }
  if (!slices.length && original.length) throw new Error("A transcript edit must keep part of the recording.");
  return { slices, removed };
}

/** Adjacent selected words include their intervening gap; distinct selections stay distinct. */
export function selectedWordRanges(transcript: TranscriptDocument, selected: ReadonlySet<string>) {
  const ranges: { start: number; end: number }[] = [];
  let contiguous = false;
  for (const word of transcript.words) {
    if (!selected.has(word.id)) { contiguous = false; continue; }
    if (contiguous) ranges[ranges.length - 1].end = Math.max(ranges.at(-1)!.end, word.end);
    else ranges.push({ start: word.start, end: word.end });
    contiguous = true;
  }
  return unionRanges(ranges);
}

export function cutTranscriptWords<T extends TranscriptProject>(project: T, selected: ReadonlySet<string>): T {
  if (!project.transcript || !selected.size) return project;
  const { slices, removed } = removeTranscriptRanges(project, selectedWordRanges(project.transcript, selected));
  if (!removed.length) return project;
  const history = project.transcript.videoCuts ?? [], ids = new Set(history.map(cut => cut.id));
  return { ...project, slices, transcript: { ...project.transcript, videoCuts: [...history,
    { id: uniqueID(ids, "transcript-cut"), wordIds: project.transcript.words.filter(w => selected.has(w.id)).map(w => w.id), removed }] } };
}

/** Restores the complete cut containing a selected word; later clip edits take priority. */
export function restoreTranscriptWords<T extends TranscriptProject>(project: T, selected: ReadonlySet<string>): T {
  if (!project.transcript || !selected.size) return project;
  const restored = restoreTranscriptCuts(project, new Set((project.transcript.videoCuts ?? []).filter(cut => cut.wordIds.some(id => selected.has(id))).map(cut => cut.id)));
  return hideTranscriptWords(restored, selected, false);
}

export function restoreTranscriptCuts<T extends TranscriptProject>(project: T, cutIDs: ReadonlySet<string>): T {
  if (!project.transcript) return project;
  const history = project.transcript.videoCuts ?? [], restore = history.filter(cut => cutIDs.has(cut.id));
  if (!restore.length) return project;
  const existing = getSlices(project), additions: Slice[] = [], ids = new Set(existing.map(slice => slice.id));
  for (const original of restore.flatMap(cut => cut.removed)) {
    let ranges = [{ start: original.start, end: original.end }];
    for (const present of [...existing, ...additions]) ranges = ranges.flatMap(range => [
      ...(present.start > range.start ? [{ start: range.start, end: Math.min(range.end, present.start) }] : []),
      ...(present.end < range.end ? [{ start: Math.max(range.start, present.end), end: range.end }] : []),
    ]).filter(range => range.end > range.start);
    for (const range of ranges) additions.push({ ...original, ...range, id: uniqueID(ids, "transcript-restore") });
  }
  return { ...project, slices: [...existing, ...additions].sort((a, b) => a.start - b.start),
    transcript: { ...project.transcript, videoCuts: history.filter(cut => !restore.includes(cut)) } };
}

export function hideTranscriptWords<T extends TranscriptProject>(project: T, selected: ReadonlySet<string>, hidden = true): T {
  if (!project.transcript || !project.transcript.words.some(w => selected.has(w.id) && Boolean(w.hidden) !== hidden)) return project;
  return { ...project, transcript: { ...project.transcript, words: project.transcript.words.map(w => selected.has(w.id) ? { ...w, hidden } : w) } };
}
export function correctTranscriptWord<T extends TranscriptProject>(project: T, id: string, text: string): T {
  if (!project.transcript || text.length > 16384 || text.includes("\0") || !project.transcript.words.some(w => w.id === id && w.text !== text)) return project;
  return { ...project, transcript: { ...project.transcript, words: project.transcript.words.map(w => w.id === id ? { ...w, sourceText: w.sourceText ?? w.text, text } : w) } };
}

/** Deliberately conservative, language-specific word-list detection, not a semantic AI claim. */
export function fillerWordIDs(transcript: TranscriptDocument): string[] {
  const english = !transcript.language || /^en(?:[-_]|$)/i.test(transcript.language);
  return transcript.words.filter(w => w.type === "filler" || (english && w.timing === "word" && /^(?:u+m+|u+h+|e+rm+|h+m+)[.!?,…]*$/i.test(w.text.trim()))).map(w => w.id);
}
export function transcriptPauses(transcript: TranscriptDocument, threshold = 0.8): { start: number; end: number }[] {
  const spoken = transcript.words.filter(w => w.type !== "sound-label"), pauses = [];
  let end = spoken[0]?.end ?? 0;
  for (const word of spoken.slice(1)) {
    if (word.start - end >= threshold) pauses.push({ start: end, end: word.start });
    end = Math.max(end, word.end);
  }
  return pauses;
}
export function tightenTranscriptPauses<T extends TranscriptProject>(project: T, threshold = 0.8, keep = 0.25, only?: { start: number; end: number }): T {
  if (!project.transcript || !Number.isFinite(keep) || keep < 0 || keep >= threshold) return project;
  const pauses = transcriptPauses(project.transcript, threshold).filter(p => !only || p.start === only.start && p.end === only.end);
  const ranges = pauses.map(p => ({ start: p.start + keep / 2, end: p.end - keep / 2 }));
  const { slices, removed } = removeTranscriptRanges(project, ranges);
  if (!removed.length) return project;
  const history = project.transcript.videoCuts ?? [], ids = new Set(history.map(cut => cut.id));
  return { ...project, slices, transcript: { ...project.transcript, videoCuts: [...history,
    { id: uniqueID(ids, "pause-cut"), wordIds: [], removed }] } };
}
export function wordIsRetained(project: Project, word: TranscriptWord): boolean {
  return sourceRangeOutputSpans(project, word.start, word.end).length > 0;
}

/** One batch avoids copying and rescanning all slices for each displayed word. */
type MappedTranscriptWord = TranscriptWord & { start: number; end: number; sliceId: string };
function mappedTranscriptWords(project: TranscriptProject): MappedTranscriptWord[] {
  const slices = getSlices(project), words = project.transcript?.words ?? [];
  const mapped: MappedTranscriptWord[] = [];
  let output = 0;
  // Each slice searches the canonical start-sorted word list. Earlier overlapping
  // SRT cues are included by retaining the maximum end in a prefix index.
  const ends: number[] = [];
  for (const [index, word] of words.entries()) ends.push(Math.max(ends[index - 1] ?? 0, word.end));
  for (const slice of slices) {
    let low = 0, high = words.length;
    while (low < high) { const middle = (low + high) >>> 1; if (ends[middle] <= slice.start) low = middle + 1; else high = middle; }
    for (let index = low; index < words.length && words[index].start < slice.end; index++) {
      const word = words[index], start = Math.max(word.start, slice.start), end = Math.min(word.end, slice.end);
      if (end > start) mapped.push({ ...word, start: output + (start - slice.start) / slice.speed, end: output + (end - slice.start) / slice.speed, sliceId: slice.id });
    }
    output += (slice.end - slice.start) / slice.speed;
  }
  return mapped;
}

interface TranscriptPlan {
  words: TranscriptWord[]; slices: Slice[] | undefined; legacyKey: string;
  mapped: MappedTranscriptWord[]; retained: ReadonlySet<string>; cues: Map<string, CaptionCue[]>;
}
// A bounded session LRU shares timing work across appearance-only edits and
// playback frames. Word/slice reference identity plus the legacy timing values
// cover every result-affecting input; undo can reuse the last three plans.
const transcriptPlans: TranscriptPlan[] = [];
const emptyIDs: ReadonlySet<string> = new Set();
function transcriptPlan(project: TranscriptProject): TranscriptPlan | null {
  const words = project.transcript?.words; if (!words) return null;
  const legacyKey = project.slices ? "" : `${project.duration}:${project.trimStart}:${project.trimEnd}:${project.speed}`;
  const index = transcriptPlans.findIndex(plan => plan.words === words && plan.slices === project.slices && plan.legacyKey === legacyKey);
  if (index >= 0) { const [plan] = transcriptPlans.splice(index, 1); transcriptPlans.unshift(plan); return plan; }
  const mapped = mappedTranscriptWords(project);
  const plan = { words, slices: project.slices, legacyKey, mapped, retained: new Set(mapped.map(word => word.id)), cues: new Map<string, CaptionCue[]>() };
  transcriptPlans.unshift(plan); if (transcriptPlans.length > 3) transcriptPlans.pop(); return plan;
}
export function retainedTranscriptWordIDs(project: TranscriptProject): ReadonlySet<string> {
  return transcriptPlan(project)?.retained ?? emptyIDs;
}

export interface CaptionToken { id: string; text: string; start: number; end: number }
export interface CaptionCue { start: number; end: number; sliceId: string; words: CaptionToken[]; text: string }
/** Caption grouping, SRT and render all consume this edited-output-clock plan. */
export function transcriptCaptionCues(project: TranscriptProject): CaptionCue[] {
  const settings = project.captionSettings ?? defaultCaptionSettings(), cues: CaptionCue[] = [];
  const plan = transcriptPlan(project); if (!plan) return cues;
  const key = `${settings.showSoundLabels}:${settings.maxWords}`, cached = plan.cues.get(key); if (cached) return cached;
  const tokens = plan.mapped.filter(word => !word.hidden && word.text.trim() && (settings.showSoundLabels || word.type !== "sound-label"))
    .sort((a, b) => a.start - b.start);
  for (const word of tokens) {
    const previous = cues.at(-1);
    if (previous && previous.sliceId === word.sliceId && word.start - previous.end < 0.8 && previous.words.length < settings.maxWords && !/[.!?…]$/.test(previous.words.at(-1)!.text)) {
      previous.words.push(word); previous.end = Math.max(previous.end, word.end); previous.text = previous.words.map(w => w.text).join(" ");
    } else cues.push({ start: word.start, end: word.end, sliceId: word.sliceId, words: [word], text: word.text });
  }
  if (plan.cues.size >= 3) plan.cues.delete(plan.cues.keys().next().value!);
  plan.cues.set(key, cues); return cues;
}
function srtTimestamp(time: number) {
  const ms = Math.max(0, Math.round(time * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}
export function transcriptSRT(project: TranscriptProject): string {
  return transcriptCaptionCues(project).map((cue, index) => `${index + 1}\n${srtTimestamp(cue.start)} --> ${srtTimestamp(Math.max(cue.end, cue.start + 0.001))}\n${cue.text}\n`).join("\n");
}

/** Called from the shared canvas compositor, after existing manual text overlays. */
export function drawTranscriptCaptions(context: CanvasRenderingContext2D, project: TranscriptProject, sourceTime: number, width: number, height: number, outputTime?: number): void {
  const settings = project.captionSettings ?? defaultCaptionSettings();
  if (!settings.enabled || !project.transcript) return;
  const time = outputTime ?? timeToOutput(project, sourceTime); if (time === null) return;
  const cues = transcriptCaptionCues(project);
  let low = 0, high = cues.length;
  while (low < high) { const mid = (low + high) >>> 1; if (cues[mid].start <= time) low = mid + 1; else high = mid; }
  const cue = cues[low - 1]; if (!cue || time >= cue.end) return;
  context.save();
  const size = Math.max(10, height * settings.sizeRatio), lineHeight = size * 1.25, padding = size * 0.25;
  context.font = `600 ${size}px ${settings.font === "mono" ? "ui-monospace, monospace" : settings.font === "serif" ? "Georgia, serif" : "-apple-system, BlinkMacSystemFont, sans-serif"}`;
  context.textBaseline = "middle";
  const space = context.measureText(" ").width, lines: CaptionToken[][] = [[]]; let lineWidth = 0;
  for (const word of cue.words) {
    const tokenWidth = context.measureText(word.text).width;
    if (lineWidth && lineWidth + space + tokenWidth > width * 0.88) { lines.push([]); lineWidth = 0; }
    lines.at(-1)!.push(word); lineWidth += (lineWidth ? space : 0) + tokenWidth;
  }
  const blockHeight = lines.length * lineHeight + padding * 2;
  const top = Math.min(height - blockHeight - height * 0.04, Math.max(height * 0.04, settings.position.y * height - blockHeight / 2));
  for (const [lineIndex, line] of lines.entries()) {
    const visible = settings.wordsReveal === "line-by-line" ? line : line.filter(word => word.start <= time);
    if (!visible.length) continue;
    const fullWidth = context.measureText(line.map(w => w.text).join(" ")).width;
    const visibleWidth = context.measureText(visible.map(w => w.text).join(" ")).width;
    const boxWidth = (settings.lineGrowth === "entire-line" ? fullWidth : visibleWidth) + padding * 2;
    const anchor = Math.max(padding, Math.min(width - fullWidth - padding, settings.position.x * width - fullWidth / 2));
    const x = settings.lineGrowth === "centered" ? anchor + (fullWidth - visibleWidth) / 2 : anchor;
    const y = top + lineIndex * lineHeight;
    context.globalAlpha = settings.backgroundOpacity; context.fillStyle = settings.backgroundColor;
    context.fillRect(x - padding, y, boxWidth, lineHeight);
    context.globalAlpha = 1; context.fillStyle = settings.color;
    let cursor = x;
    for (const word of visible) {
      const progress = Math.min(1, Math.max(0, (time - (settings.wordsReveal === "line-by-line" ? cue.start : word.start)) / 0.15));
      context.globalAlpha = settings.wordEntrance === "fade-in" ? progress : 1;
      context.fillText(word.text, cursor, y + lineHeight / 2 + (settings.wordEntrance === "slide-in" ? (1 - progress) * size * 0.25 : 0), width * 0.88);
      cursor += context.measureText(word.text).width + space;
    }
  }
  context.restore();
}
