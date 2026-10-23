import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Download, FileText, Play, RefreshCw, Scissors, Upload, X } from "lucide-react";
import { Range, Select, Toggle } from "./components";
import { t, useLanguage } from "./i18n";
import type { Project } from "./types";
import { sourceRangeOutputSpans } from "./core/timeline";
import {
  correctTranscriptWord, cutTranscriptWords, defaultCaptionSettings, fillerWordIDs, hideTranscriptWords,
  restoreTranscriptWords, restoreTranscriptCuts, selectedWordRanges, tightenTranscriptPauses, transcriptPauses,
  transcriptSRT, retainedTranscriptWordIDs,
  type CaptionSettings, type SpeechStatus, type TranscriptProject, type TranscriptServices,
} from "./core/transcript";
import "./transcript.css";

export interface TranscriptPlaybackRange { sourceStart: number; sourceEnd: number; outputStart: number; outputEnd: number }
export interface TranscriptPanelProps {
  project: TranscriptProject;
  update: (value: Project | ((project: Project) => Project), group?: string) => void;
  time: number;
  notify: (message: string) => void;
  services?: TranscriptServices;
  progress?: number | null;
  onSeek?: (sourceTime: number) => void;
  onPlaySelection?: (range: TranscriptPlaybackRange) => void;
  editor?: boolean;
  onOpenGeneration?: () => void;
}

export default function TranscriptPanel({ project, update, time, notify, services, progress, onSeek, onPlaySelection, editor = false, onOpenGeneration }: TranscriptPanelProps) {
  const [language] = useLanguage();
  const [locale, setLocale] = useState("en-US"), [status, setStatus] = useState<SpeechStatus | null>(null);
  const [track, setTrack] = useState<"microphone" | "system">(project.microphonePath ? "microphone" : "system");
  const [keyTerms, setKeyTerms] = useState(""), [busy, setBusy] = useState(false), [statusBusy, setStatusBusy] = useState(false);
  const [selected, setSelected] = useState(new Set<string>()), [anchor, setAnchor] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null), [draft, setDraft] = useState("");
  const [showDeleted, setShowDeleted] = useState(false), [showHidden, setShowHidden] = useState(true);
  const [page, setPage] = useState(0);
  const [generationRequested, setGenerationRequested] = useState(false);
  const [pauseThreshold, setPauseThreshold] = useState(0.8), [pauseKeep, setPauseKeep] = useState(0.25);
  const latest = useRef(project); latest.current = project;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setSelected(new Set()); setEditing(null); }, [project.mediaPath, project.transcript?.source.sha256]);
  useEffect(() => {
    let active = true;
    if (!services) return;
    setStatusBusy(true);
    services.status(locale).then(value => { if (active) setStatus(value); }).catch(error => {
      if (active) setStatus({ available: false, method: "apple-on-device", permission: "unknown", locale, locales: [], engine: "Apple on-device", reason: error instanceof Error ? error.message : String(error) });
    }).finally(() => { if (active) setStatusBusy(false); });
    return () => { active = false; };
  }, [services, locale]);
  const document = project.transcript, settings = project.captionSettings ?? defaultCaptionSettings();
  const safe = (action: () => void) => { try { action(); } catch (error) { notify(error instanceof Error ? error.message : String(error)); } };
  const edit = (fn: (value: TranscriptProject) => TranscriptProject, group?: string) => update(p => fn(p), group);
  const setSettings = (patch: Partial<CaptionSettings>, group?: string) => edit(p => ({ ...p, captionSettings: { ...(p.captionSettings ?? defaultCaptionSettings()), ...patch } }), group);
  const source = track === "microphone" ? project.microphonePath : project.mediaPath;
  const generate = async () => {
    if (!services || !source || busy) return;
    const originalPath = project.mediaPath, originalDuration = project.duration;
    setBusy(true);
    try {
      const transcript = await services.generate(source, { locale, track, offset: 0, contextualStrings: keyTerms.split(/[,\n]/).map(s => s.trim()).filter(Boolean) });
      if (transcript && latest.current.mediaPath === originalPath && latest.current.duration === originalDuration) {
        update(p => ({ ...p, transcript, captionSettings: (p as TranscriptProject).captionSettings ?? defaultCaptionSettings() }));
        notify(transcript.words.length ? t("Transcript generated locally.") : t("The speech recognizer found no words in this audio."));
      }
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const importFile = async () => {
    try {
      const transcript = await services?.importFile(project.duration);
      if (transcript) update(p => ({ ...p, transcript, captionSettings: (p as TranscriptProject).captionSettings ?? defaultCaptionSettings() }));
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
  };
  const exportSRT = async () => {
    try { await services?.exportSRT(transcriptSRT(project), project.name); }
    catch (error) { notify(error instanceof Error ? error.message : String(error)); }
  };
  const choose = (id: string, shift: boolean, additive: boolean) => {
    if (shift && anchor && document) {
      const from = document.words.findIndex(w => w.id === anchor), to = document.words.findIndex(w => w.id === id);
      setSelected(new Set(document.words.slice(Math.min(from, to), Math.max(from, to) + 1).map(w => w.id)));
    } else {
      setSelected(previous => {
        if (!additive) return new Set([id]);
        const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next;
      });
      setAnchor(id);
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("input,textarea,select")) return;
    if ((event.key === "Backspace" || event.key === "Delete") && selected.size) {
      event.preventDefault(); event.stopPropagation(); safe(() => edit(p => event.metaKey || event.ctrlKey ? hideTranscriptWords(p, selected) : cutTranscriptWords(p, selected)));
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a" && document) {
      event.preventDefault(); setSelected(new Set(document.words.map(w => w.id)));
    }
  };
  const selectedRanges = document ? selectedWordRanges(document, selected) : [];
  const selectionStart = selectedRanges[0]?.start, selectionEnd = selectedRanges.at(-1)?.end;
  const playSpans = selectionStart !== undefined && selectionEnd !== undefined ? sourceRangeOutputSpans(project, selectionStart, selectionEnd) : [];
  const retainedIDs = retainedTranscriptWordIDs(project);
  const fillers = document ? fillerWordIDs(document).filter(id => retainedIDs.has(id)) : [];
  const pauses = document ? transcriptPauses(document, pauseThreshold) : [];
  const pauseByEnd = new Map(pauses.map(pause => [pause.end, pause]));
  const visibleWords = document?.words.filter(word => (showDeleted || retainedIDs.has(word.id)) && (showHidden || !word.hidden)) ?? [];
  const pageCount = Math.max(1, Math.ceil(visibleWords.length / 250)), displayedPage = Math.min(page, pageCount - 1);
  const retainedPauses = pauses.filter(pause => sourceRangeOutputSpans(project, pause.start + pauseKeep / 2, pause.end - pauseKeep / 2).length);
  const pauseCuts = document?.videoCuts?.filter(cut => cut.wordIds.length === 0) ?? [];
  const editorEmpty = editor && !document && !generationRequested;
  const generationControl = busy ? <div className="transcript-progress" role="status"><span>{t("Transcribing locally…")}{progress != null ? ` ${Math.round(progress * 100)}%` : ""}</span><progress value={progress ?? undefined} max={1} /><button className="outline-button" onClick={() => { void services?.cancel().catch(error => notify(String(error))); }}>{t("Cancel")}</button></div> : <button className="outline-button full" disabled={!services || !source || statusBusy || status?.available !== true} onClick={() => { void generate(); }}><RefreshCw size={14} />{t("Generate transcript")}</button>;
  const importExportControls = <div className="transcript-file-actions"><button className="outline-button" disabled={!services || busy} onClick={() => { void importFile(); }}><Upload size={14} />{t("Import SRT / JSON")}</button><button className="outline-button" disabled={!services || !document?.words.length} onClick={() => { void exportSRT(); }}><Download size={14} />SRT</button></div>;
  return <div className={`transcript-panel${editor ? " transcript-editor" : ""}`}>
    {editorEmpty && <div className="transcript-empty">
      <p className="transcript-kicker">{t("Edit by transcript")}</p>
      <p>{t("Edit your video by editing its text: delete words to cut them out, remove filler words and long pauses in one click.")}</p>
      <p className="transcript-empty-prompt">{t("Generate a transcript first to get started.")}</p>
      <button className="primary-button full" onClick={() => onOpenGeneration ? onOpenGeneration() : setGenerationRequested(true)}>{t("Generate transcript")}</button>
    </div>}

    {!editorEmpty && <details className="transcript-generation" open={!document}>
      <summary><FileText size={15} />{t(editorEmpty ? "Transcription options" : document ? "Regenerate transcript" : "Local transcript")}</summary>
      <p className="panel-note">{t("Apple on-device speech. No cloud fallback or model download. Availability depends on language, installed system assets, and Speech Recognition permission.")}</p>
      <label className="transcript-field">{t("Audio source")}<Select label="Transcription audio source" value={track} onChange={value => setTrack(value as typeof track)}><option value="microphone" disabled={!project.microphonePath}>{t("Microphone")}</option><option value="system" disabled={!project.mediaPath}>{t("System audio")}</option></Select></label>
      <label className="transcript-field">{t("Language")}<Select label="Transcription language" value={locale} onChange={setLocale}>
        {[...new Set([locale, ...(status?.locales ?? [])])].sort().map(value => <option key={value} value={value}>{(() => { try { return new Intl.DisplayNames([language], { type: "language" }).of(value.replace(/_/g, "-")) ?? value; } catch { return value; } })()}</option>)}
      </Select></label>
      <label className="transcript-field">{t("Key terms")}<textarea aria-label={t("Speech key terms")} value={keyTerms} onChange={e => setKeyTerms(e.target.value)} placeholder={t("Names and phrases, separated by commas")} rows={2} /></label>
      {status?.engine && <p className="transcript-method">{status.engine}</p>}
      {status?.reason && <p className="transcript-status" role="status">{status.reason}</p>}
      {!services && <p className="transcript-status">{t("The local speech bridge is unavailable in this session.")}</p>}
      {!editorEmpty && generationControl}
    </details>}
    {!editorEmpty && importExportControls}
    {document && <>
      {document.limitations?.map(message => <p className="transcript-method" key={message}>{message}</p>)}
      <div className="transcript-toolbar"><h3>{t("Edit by transcript")}</h3><span>{t("Transcript tokens: {count}", { count: document.words.length })}</span><button className="icon-button" aria-label={t("Clear transcript")} onClick={() => update(p => ({ ...p, transcript: undefined }))}><X size={13} /></button></div>
      <div className="transcript-filters"><label><input type="checkbox" checked={showDeleted} onChange={e => setShowDeleted(e.target.checked)} />{t("Show deleted text")}</label><label><input type="checkbox" checked={showHidden} onChange={e => setShowHidden(e.target.checked)} />{t("Show hidden words")}</label></div>
      <div className="transcript-text" tabIndex={0} role="group" aria-label={t("Timed transcript editor")} onKeyDown={keyDown} onCopy={event => {
        const words = document.words.filter(word => selected.has(word.id));
        if (words.length) { event.preventDefault(); event.clipboardData.setData("text/plain", words.map(w => w.text).join(" ")); }
      }}>
        {visibleWords.slice(displayedPage * 250, (displayedPage + 1) * 250).map((word) => {
          const retained = retainedIDs.has(word.id), pause = pauseByEnd.get(word.start);
          return <span key={word.id}>
            {pause && sourceRangeOutputSpans(project, pause.start + pauseKeep / 2, pause.end - pauseKeep / 2).length > 0 && <button className="transcript-pause" title={t("Shorten this gap to {value}s", { value: pauseKeep })} onClick={() => safe(() => edit(p => tightenTranscriptPauses(p, pauseThreshold, pauseKeep, pause)))}>{t("{value}s", { value: (pause.end - pause.start).toFixed(1) })}</button>}
            {editing === word.id ? <input className="transcript-word-edit" autoFocus aria-label={t("Correct transcript word")} value={draft} onChange={e => setDraft(e.target.value)} onBlur={() => { edit(p => correctTranscriptWord(p, word.id, draft), `transcript-word-${word.id}`); setEditing(null); }} onKeyDown={event => {
              if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(null); }
            }} /> : <button className={`transcript-word ${selected.has(word.id) ? "selected" : ""} ${time >= word.start && time < word.end ? "current" : ""} ${word.hidden ? "hidden-word" : ""} ${!retained ? "deleted-word" : ""}`} aria-pressed={selected.has(word.id)} title={`${t("{start}–{end}s", { start: word.start.toFixed(2), end: word.end.toFixed(2) })} · ${word.timing === "word" ? t("word timing") : t("cue timing")}`} onClick={event => { choose(word.id, event.shiftKey, event.metaKey || event.ctrlKey); if (retained) onSeek?.(word.start); }} onDoubleClick={() => { setEditing(word.id); setDraft(word.text); }}>{word.text || "∅"}</button>}{" "}
          </span>;
        })}
      </div>
      {pageCount > 1 && <div className="transcript-pagination"><button className="text-button" disabled={displayedPage === 0} onClick={() => setPage(displayedPage - 1)}>{t("Previous")}</button><span>{displayedPage + 1} / {pageCount}</span><button className="text-button" disabled={displayedPage + 1 >= pageCount} onClick={() => setPage(displayedPage + 1)}>{t("Next")}</button></div>}
      <p className="panel-note">{t("Click to seek; Shift-click to select a range. Double-click to correct text. Delete cuts video; ⌘Delete hides captions. Undo restores the previous edit.")}</p>
      <div className="transcript-selection-actions">
        <button className="outline-button" disabled={!selected.size} onClick={() => safe(() => edit(p => cutTranscriptWords(p, selected)))}><Scissors size={13} />{t("Cut video")}</button>
        <button className="outline-button" disabled={!selected.size} onClick={() => edit(p => hideTranscriptWords(p, selected))}>{t("Hide captions")}</button>
        <button className="outline-button" disabled={!selected.size} onClick={() => safe(() => edit(p => restoreTranscriptWords(p, selected)))} title={t("Restore caption text and the complete transcript cut containing a selected word.")}>{t("Restore")}</button>
        {onPlaySelection && <button className="outline-button" disabled={!playSpans.length || selectionStart === undefined || selectionEnd === undefined} onClick={() => { if (playSpans.length && selectionStart !== undefined && selectionEnd !== undefined) onPlaySelection({ sourceStart: selectionStart, sourceEnd: selectionEnd, outputStart: playSpans[0].start, outputEnd: playSpans.at(-1)!.end }); }}><Play size={13} />{t("Play selection")}</button>}
      </div>
      <details><summary>{t("Filler words and pauses")}</summary><p className="panel-note">{t("Filler detection uses a conservative English word list (um, uh, erm, hmm) or imported filler labels. Pauses are gaps between transcript tokens, not acoustic silence measurements.")}</p>
        <button className="outline-button full" disabled={!fillers.length} onClick={() => safe(() => edit(p => cutTranscriptWords(p, new Set(fillers))))}>{t("Remove detected filler words")} ({fillers.length})</button>
        <Range label="Long pause threshold" value={pauseThreshold} min={0.5} max={3} step={0.1} display={t("{value}s", { value: pauseThreshold.toFixed(1) })} onChange={value => { setPauseThreshold(value); setPauseKeep(Math.min(pauseKeep, value - 0.1)); }} />
        <Range label="Retain pause duration" value={pauseKeep} min={0.05} max={Math.min(0.75, pauseThreshold - 0.1)} step={0.05} display={t("{value}s", { value: pauseKeep.toFixed(2) })} onChange={setPauseKeep} />
        <button className="outline-button full" disabled={!retainedPauses.length} onClick={() => safe(() => edit(p => tightenTranscriptPauses(p, pauseThreshold, pauseKeep)))}>{t("Shorten every long pause")} ({retainedPauses.length})</button>
        {!!pauseCuts.length && <button className="text-button" onClick={() => safe(() => edit(p => restoreTranscriptCuts(p, new Set(pauseCuts.map(cut => cut.id)))))}>{t("Restore removed pauses")}</button>}
      </details>
    </>}
    {!editor && document && <details className="caption-style-controls" open><summary>{t("Caption style")}</summary>
      <Toggle label="Show transcript captions" value={settings.enabled} onChange={enabled => setSettings({ enabled })} />
      <Toggle label="Show sound labels" value={settings.showSoundLabels} onChange={showSoundLabels => setSettings({ showSoundLabels })} />
      <label className="transcript-field">{t("Font")}<Select label="Caption font" value={settings.font} onChange={font => setSettings({ font: font as CaptionSettings["font"] })}><option value="sans-serif">{t("Sans Serif")}</option><option value="serif">{t("Serif")}</option><option value="mono">{t("Monospace")}</option></Select></label>
      <Range label="Caption size" value={settings.sizeRatio} min={0.015} max={0.15} step={0.0025} display={`${Math.round(settings.sizeRatio * 100)}%`} onChange={sizeRatio => setSettings({ sizeRatio }, "caption-size")} />
      <div className="caption-colors"><label>{t("Text color")}<input type="color" value={settings.color} onChange={e => setSettings({ color: e.target.value }, "caption-color")} /></label><label>{t("Background color")}<input type="color" value={settings.backgroundColor} onChange={e => setSettings({ backgroundColor: e.target.value }, "caption-background")} /></label></div>
      <Range label="Caption background opacity" value={settings.backgroundOpacity} max={1} step={0.01} display={`${Math.round(settings.backgroundOpacity * 100)}%`} onChange={backgroundOpacity => setSettings({ backgroundOpacity }, "caption-opacity")} />
      <Range label="Caption horizontal position" value={settings.position.x} max={1} step={0.01} onChange={x => setSettings({ position: { ...settings.position, x } }, "caption-x")} />
      <Range label="Caption vertical position" value={settings.position.y} max={1} step={0.01} onChange={y => setSettings({ position: { ...settings.position, y } }, "caption-y")} />
      <Range label="Words per caption" value={settings.maxWords} min={1} max={20} step={1} onChange={maxWords => setSettings({ maxWords }, "caption-words")} />
      {([ ["wordsReveal", "Words reveal", [["line-by-line", "Line by line"], ["word-by-word", "Word by word"]]], ["lineGrowth", "Line growth", [["entire-line", "Entire line"], ["left-anchored", "Left anchored"], ["centered", "Centered"]]], ["wordEntrance", "Word entrance", [["appear", "Appear"], ["fade-in", "Fade in"], ["slide-in", "Slide in"]]] ] as const).map(([key, label, values]) => <label className="transcript-field" key={key}>{t(label)}<Select label={label} value={settings[key]} onChange={value => setSettings({ [key]: value })}>{values.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</Select></label>)}
    </details>}
  </div>;
}
