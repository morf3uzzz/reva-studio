/** Source-clock transcript data and caption settings. Both adapters use this boundary. */
const MAX_WORDS = 200000;
const object = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
};
const text = (value, label, max = 16384) => {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new Error(`${label} is invalid.`);
  return value;
};
const number = (value, min, max, label) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} is out of range.`);
  return value;
};
const choice = (value, choices, label) => {
  if (!choices.includes(value)) throw new Error(`${label} is invalid.`);
  return value;
};
const bool = (value, label) => {
  if (typeof value !== "boolean") throw new Error(`${label} must be true or false.`);
  return value;
};

export function defaultCaptionSettings() {
  return { version: 1, enabled: true, showSoundLabels: false, font: "sans-serif", sizeRatio: 0.05,
    color: "#ffffff", backgroundColor: "#000000", backgroundOpacity: 0.85,
    position: { x: 0.5, y: 1 }, wordsReveal: "line-by-line", lineGrowth: "left-anchored",
    wordEntrance: "appear", maxWords: 8 };
}

export function parseCaptionSettings(input) {
  const v = object(input, "Caption settings");
  const p = object(v.position, "Caption position");
  const color = (value) => {
    if (!/^#[\da-f]{6}$/i.test(value)) throw new Error("Caption color must be a six-digit hex color.");
    return value;
  };
  choice(v.version, [1], "Caption settings version");
  const maxWords = number(v.maxWords, 1, 20, "Caption group size");
  if (!Number.isInteger(maxWords)) throw new Error("Caption group size must be a whole number.");
  return { version: 1, enabled: bool(v.enabled, "Caption visibility"), showSoundLabels: bool(v.showSoundLabels, "Sound label visibility"),
    font: choice(v.font, ["serif", "sans-serif", "mono"], "Caption font"), sizeRatio: number(v.sizeRatio, 0.015, 0.15, "Caption size"),
    color: color(v.color), backgroundColor: color(v.backgroundColor), backgroundOpacity: number(v.backgroundOpacity, 0, 1, "Caption background opacity"),
    position: { x: number(p.x, 0, 1, "Caption horizontal position"), y: number(p.y, 0, 1, "Caption vertical position") },
    wordsReveal: choice(v.wordsReveal, ["line-by-line", "word-by-word"], "Caption reveal"),
    lineGrowth: choice(v.lineGrowth, ["entire-line", "left-anchored", "centered"], "Caption line growth"),
    wordEntrance: choice(v.wordEntrance, ["appear", "fade-in", "slide-in"], "Caption entrance"), maxWords };
}

function parseSlice(input, duration) {
  const v = object(input, "Removed transcript clip");
  const start = number(v.start, 0, duration, "Removed clip start");
  const end = number(v.end, start, duration + 1e-6, "Removed clip end");
  if (end <= start) throw new Error("Removed clip must have a positive duration.");
  return { id: text(v.id, "Removed clip ID", 256), start, end, speed: number(v.speed, 0.1, 24, "Removed clip speed"), volume: number(v.volume, 0, 1, "Removed clip volume"),
    ...(v.cursorHidden === undefined ? {} : { cursorHidden: bool(v.cursorHidden, "Removed clip cursor visibility") }),
    ...(v.cursorSmooth === undefined ? {} : { cursorSmooth: bool(v.cursorSmooth, "Removed clip cursor smoothing") }) };
}

export function parseTranscript(input, projectDuration = Infinity) {
  const v = object(input, "Transcript");
  choice(v.version, [1], "Transcript version");
  const source = object(v.source, "Transcript source");
  const duration = number(source.duration, 0, 604800, "Transcript source duration");
  const offset = number(source.offset, 0, 604800, "Transcript source offset");
  if (offset + duration > projectDuration + 0.05) throw new Error("Transcript source extends beyond this recording.");
  const hash = source.sha256 === null ? null : text(source.sha256, "Transcript source SHA-256", 64);
  if (hash !== null && !/^[\da-f]{64}$/i.test(hash)) throw new Error("Transcript source SHA-256 is invalid.");
  if (!Array.isArray(v.words) || v.words.length > MAX_WORDS) throw new Error("Transcript word list is invalid or too large.");
  const ids = new Set(); let previous = 0;
  const words = v.words.map((input) => {
    const w = object(input, "Transcript word");
    const id = text(w.id, "Transcript word ID", 256);
    if (!id || ids.has(id)) throw new Error("Transcript word IDs must be unique and nonempty.");
    ids.add(id);
    const start = number(w.start, Math.max(offset, previous), offset + duration + 0.05, "Transcript word start");
    const end = number(w.end, start, offset + duration + 0.05, "Transcript word end");
    if (end <= start) throw new Error("Transcript words must have positive duration.");
    previous = start;
    return { id, start, end, text: text(w.text, "Transcript word text"), timing: choice(w.timing, ["word", "segment"], "Transcript timing precision"),
      ...(w.sourceText === undefined ? {} : { sourceText: text(w.sourceText, "Original transcript word") }),
      ...(w.hidden === undefined ? {} : { hidden: bool(w.hidden, "Hidden transcript word") }),
      ...(w.type === undefined ? {} : { type: choice(w.type, ["word", "filler", "sound-label"], "Transcript word kind") }),
      ...(w.confidence === undefined ? {} : { confidence: number(w.confidence, 0, 1, "Transcript confidence") }) };
  });
  let videoCuts;
  if (v.videoCuts !== undefined) {
    if (!Array.isArray(v.videoCuts) || v.videoCuts.length > MAX_WORDS) throw new Error("Transcript video cuts are invalid.");
    const cutIDs = new Set();
    videoCuts = v.videoCuts.map(input => {
      const cut = object(input, "Transcript cut"), id = text(cut.id, "Transcript cut ID", 256);
      if (!id || cutIDs.has(id)) throw new Error("Transcript cut IDs must be unique and nonempty.");
      cutIDs.add(id);
      if (!Array.isArray(cut.wordIds) || cut.wordIds.length > MAX_WORDS || cut.wordIds.some(id => !ids.has(id))) throw new Error("Transcript cut refers to an unknown word.");
      if (!Array.isArray(cut.removed) || cut.removed.length > MAX_WORDS) throw new Error("Transcript cut clips are invalid.");
      return { id, wordIds: [...new Set(cut.wordIds)], removed: cut.removed.map(s => parseSlice(s, projectDuration)) };
    });
  }
  return { version: 1, generator: choice(v.generator, ["apple-on-device", "srt-import", "json-import", "manual"], "Transcript generator"),
    language: v.language === null ? null : text(v.language, "Transcript language", 128),
    source: { path: source.path === null ? null : text(source.path, "Transcript source path", 32768), sha256: hash, duration, offset,
      track: choice(source.track, ["microphone", "system", "import"], "Transcript source track") }, words,
    ...(videoCuts === undefined ? {} : { videoCuts }),
    ...(v.limitations === undefined ? {} : { limitations: (() => {
      if (!Array.isArray(v.limitations) || v.limitations.length > 100) throw new Error("Transcript limitations are invalid.");
      return v.limitations.map(s => text(s, "Transcript limitation", 4096));
    })() }) };
}

function timestamp(value) {
  const match = /^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(value.trim());
  if (!match || +match[2] > 59 || +match[3] > 59) throw new Error("Invalid SRT timestamp.");
  return +match[1] * 3600 + +match[2] * 60 + +match[3] + +match[4] / 1000;
}

/** SRT has cue timing, never fabricated word alignment. */
export function importSRT(input, projectDuration, offset = 0) {
  text(input, "SRT file", 8 * 1024 * 1024);
  const blocks = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim().split(/\n[\t ]*\n/);
  const words = blocks.filter(b => b.trim()).map((block, index) => {
    const lines = block.split("\n");
    if (/^\d+$/.test(lines[0].trim())) lines.shift();
    const match = /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines.shift() ?? "");
    if (!match || !lines.length) throw new Error(`Invalid SRT cue ${index + 1}.`);
    const start = timestamp(match[1]) + offset, end = timestamp(match[2]) + offset;
    return { id: `srt-${index + 1}`, start, end, text: lines.join("\n"), timing: "segment" };
  }).sort((a, b) => a.start - b.start);
  if (!words.length) throw new Error("This SRT file has no captions.");
  return parseTranscript({ version: 1, generator: "srt-import", language: null,
    source: { path: null, sha256: null, duration: projectDuration - offset, offset, track: "import" }, words,
    limitations: ["SRT imports have cue timing. Individual words are not aligned to audio."] }, projectDuration);
}

export function importTranscriptJSON(input, projectDuration) {
  text(input, "Transcript JSON", 32 * 1024 * 1024);
  const raw = JSON.parse(input);
  // Our exported document retains provenance. Do not erase its generator.
  return parseTranscript(raw, projectDuration);
}
