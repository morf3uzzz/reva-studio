import assert from "node:assert/strict";
import test from "node:test";
import { createProject } from "../src/core/model.ts";
import { duration, sourceRangeOutputSpans } from "../src/core/timeline.ts";
import {
  defaultCaptionSettings, parseCaptionSettings, parseTranscript, importSRT, importTranscriptJSON,
  cutTranscriptWords, restoreTranscriptWords, restoreTranscriptCuts, hideTranscriptWords, correctTranscriptWord,
  fillerWordIDs, transcriptPauses, tightenTranscriptPauses, transcriptCaptionCues, transcriptSRT,
  retainedTranscriptWordIDs, drawTranscriptCaptions,
  type TranscriptProject, type TranscriptDocument, type TranscriptWord,
} from "../src/core/transcript.ts";

const word = (id: string, start: number, end: number, text = id): TranscriptWord => ({ id, start, end, text, timing: "word" });
function example(words = [word("hello", 1, 1.3), word("um", 1.4, 1.6), word("world", 3, 3.5), word("again", 6, 7)]): TranscriptProject {
  return { ...createProject({ path: "/recording.mp4", name: "Recording", duration: 10, width: 1280, height: 720 }),
    transcript: { version: 1, generator: "apple-on-device", language: "en-US", source: { path: "/mic.m4a", sha256: "a".repeat(64), offset: 0, duration: 10, track: "microphone" }, words },
    captionSettings: defaultCaptionSettings(),
    slices: [{ id: "first", start: 0, end: 4, speed: 2, volume: 0.6, cursorHidden: true }, { id: "second", start: 5, end: 10, speed: 1, volume: 0.2, cursorSmooth: false }] };
}

test("shared persistence boundary rejects malformed timing, IDs, provenance and caption settings", () => {
  const valid = example();
  assert.deepEqual(parseTranscript(valid.transcript, valid.duration), valid.transcript);
  assert.deepEqual(parseCaptionSettings(defaultCaptionSettings()), defaultCaptionSettings());
  for (const words of [[word("a", 2, 1)], [word("a", 2, 3), word("a", 3, 4)], [word("a", 12, 13)], [word("a", 2, 3), word("b", 1, 2)]]) {
    assert.throws(() => parseTranscript({ ...valid.transcript, words }, 10));
  }
  assert.throws(() => parseTranscript({ ...valid.transcript, source: { ...valid.transcript!.source, sha256: "missing" } }, 10), /SHA/);
  assert.throws(() => parseCaptionSettings({ ...defaultCaptionSettings(), sizeRatio: 1 }), /size/);
  assert.throws(() => parseCaptionSettings({ ...defaultCaptionSettings(), color: "red" }), /hex/);
  const noIdentity = { ...valid.transcript, source: { ...valid.transcript!.source, sha256: null, path: null } };
  assert.equal(parseTranscript(noIdentity).source.sha256, null);
});

test("SRT import retains cue precision, source offset, multilingual text and overlapping cues", () => {
  const transcript = importSRT("\uFEFF1\r\n00:00:01,125 --> 00:00:03,500\r\nПривет, мир!\r\nSecond line\r\n\r\n2\r\n00:00:02.000 --> 00:00:02.500\r\nOverlap\r\n", 10, 1);
  assert.equal(transcript.words[0].timing, "segment");
  assert.equal(transcript.words[0].start, 2.125);
  assert.equal(transcript.words[0].text, "Привет, мир!\nSecond line");
  assert.equal(transcript.words[1].start, 3);
  assert.deepEqual(importTranscriptJSON(JSON.stringify(transcript), 10), transcript);
  assert.throws(() => importSRT("1\n00:61:00,000 --> 00:62:00,000\nBad", 10), /timestamp/);
  assert.throws(() => importSRT("1\n00:00:00,000 --> 00:00:11,000\nBeyond", 10), /end/);
  assert.throws(() => importSRT("1\n00:00:01,000 --> 00:00:01,000\nEmpty", 10), /positive/);
});

test("text cuts intersect retained clips exactly and preserve speed, gain and clip policy", () => {
  const project = example();
  const cut = cutTranscriptWords(project, new Set(["hello", "um"]));
  assert.deepEqual(cut.slices!.map(s => [s.start, s.end, s.speed, s.volume]), [[0, 1, 2, .6], [1.6, 4, 2, .6], [5, 10, 1, .2]]);
  assert.equal(cut.slices![1].cursorHidden, true);
  assert.equal(cut.slices![2].cursorSmooth, false);
  assert.equal(project.transcript!.videoCuts, undefined);
  assert.deepEqual([...retainedTranscriptWordIDs(cut)], ["world", "again"]);
  assert.equal(duration(cut), 6.7);
  assert.equal(parseTranscript(cut.transcript, 10).videoCuts!.length, 1);
  const restored = restoreTranscriptWords(cut, new Set(["hello"]));
  assert.equal(duration(restored), duration(project));
  assert.ok(Math.abs(sourceRangeOutputSpans(restored, 1, 1.6).reduce((n, s) => n + s.end - s.start, 0) - .3) < 1e-9);
  assert.equal(restored.transcript!.videoCuts!.length, 0);
  // Restore does not overwrite gain changes made after a transcript cut.
  const manuallyChanged = { ...cut, slices: cut.slices!.map((s, i) => i ? s : { ...s, volume: .1 }) };
  assert.equal(restoreTranscriptWords(manuallyChanged, new Set(["hello"])).slices![0].volume, .1);
  assert.throws(() => cutTranscriptWords({ ...project, slices: [{ id: "only", start: 1, end: 1.3, speed: 1, volume: 1 }] }, new Set(["hello"])), /keep part/);
});

test("hide and text correction preserve original timing, source evidence and manual overlays", () => {
  const project = example(); project.captions = [{ id: "manual", text: "Title", start: 0, end: 2, x: .5, y: .5, size: 40, color: "#fff" }];
  const hidden = hideTranscriptWords(project, new Set(["hello"]));
  const corrected = correctTranscriptWord(hidden, "hello", "Hello!");
  assert.equal(corrected.transcript!.words[0].sourceText, "hello");
  assert.equal(corrected.transcript!.words[0].start, 1);
  assert.equal(correctTranscriptWord(corrected, "hello", "HELLO").transcript!.words[0].sourceText, "hello");
  assert.deepEqual(corrected.captions, project.captions);
  assert.equal(transcriptSRT(corrected).includes("Hello!"), false);
  assert.equal(transcriptSRT(restoreTranscriptWords(corrected, new Set(["hello"]))).includes("Hello!"), true);
});

test("filler removal is conservative and gap tightening keeps hidden speech and existing cuts", () => {
  const project = example([word("um", 1, 1.2, "Um,"), word("like", 1.3, 1.6, "like"), { ...word("hidden", 2, 2.5, "hidden speech"), hidden: true }, word("again", 5, 6)]);
  assert.deepEqual(fillerWordIDs(project.transcript!), ["um"]);
  assert.deepEqual(fillerWordIDs({ ...project.transcript!, language: "de-DE" }), []);
  assert.deepEqual(fillerWordIDs({ ...project.transcript!, words: [{ ...project.transcript!.words[0], timing: "segment" }] }), []);
  assert.deepEqual(transcriptPauses(project.transcript!), [{ start: 2.5, end: 5 }]);
  const shortened = tightenTranscriptPauses(project, .8, .25);
  assert.equal(sourceRangeOutputSpans(shortened, 2, 2.5).length, 1);
  assert.deepEqual(shortened.slices!.map(s => [s.start, s.end]), [[0, 2.625], [5, 10]]);
  const restore = restoreTranscriptCuts(shortened, new Set(shortened.transcript!.videoCuts!.map(c => c.id)));
  assert.equal(duration(restore), duration(project));
});

test("caption plan and SRT map trimmed, split, repeated and accelerated words to edited output time", () => {
  const project = example([word("a", 1, 2, "One."), word("b", 3, 6, "Across"), word("c", 6, 7, "cuts.")]);
  const cues = transcriptCaptionCues(project);
  assert.deepEqual(cues.map(c => [c.start, c.end, c.text]), [[.5, 1, "One."], [1.5, 2, "Across"], [2, 4, "Across cuts."]]);
  assert.equal(transcriptSRT(project), "1\n00:00:00,500 --> 00:00:01,000\nOne.\n\n2\n00:00:01,500 --> 00:00:02,000\nAcross\n\n3\n00:00:02,000 --> 00:00:04,000\nAcross cuts.\n");
  const repeated = { ...project, slices: [{ id: "repeat1", start: 1, end: 2, speed: 1, volume: 1 }, { id: "repeat2", start: 1, end: 2, speed: 2, volume: 1 }] };
  assert.deepEqual(transcriptCaptionCues(repeated).map(c => [c.start, c.end]), [[0, 1], [1, 1.5]]);
  const overlapping = { ...project, slices: [{ id: "later", start: 5, end: 7, speed: 1, volume: 1 }], transcript: importSRT("1\n00:00:00,000 --> 00:00:06,000\nLong\n\n2\n00:00:01,000 --> 00:00:02,000\nShort", 10) };
  assert.equal(transcriptCaptionCues(overlapping)[0].text, "Long");
});

test("canvas captions consume the same cue plan and honor word reveal, hidden labels and disabling", () => {
  const project = example([word("one", 1, 1.3, "One"), word("two", 1.4, 1.8, "two")]);
  project.captionSettings = { ...defaultCaptionSettings(), wordsReveal: "word-by-word", wordEntrance: "fade-in" };
  const drawn: { text: string; alpha: number }[] = [];
  const drawing = { globalAlpha: 1, save() {}, restore() {}, fillRect() {}, measureText(value: string) { return { width: value.length * 10 }; }, fillText(value: string) { drawn.push({ text: value, alpha: drawing.globalAlpha }); } };
  const context = drawing as unknown as CanvasRenderingContext2D;
  drawTranscriptCaptions(context, project, 1.1, 1280, 720, .55);
  assert.deepEqual(drawn.map(d => d.text), ["One"]);
  assert.ok(drawn[0].alpha > 0 && drawn[0].alpha < 1);
  drawn.length = 0;
  drawTranscriptCaptions(context, project, 1.6, 1280, 720, .8);
  assert.deepEqual(drawn.map(d => d.text), ["One", "two"]);
  drawn.length = 0;
  drawTranscriptCaptions(context, { ...project, captionSettings: { ...project.captionSettings, enabled: false } }, 1.1, 1280, 720);
  assert.equal(drawn.length, 0);
});
