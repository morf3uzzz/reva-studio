import { useEffect, useRef, useState } from "react";
import { FolderOpen, Mic, Music2, Pause, Play, Plus, Square, Trash2, Upload, X } from "lucide-react";
import { NumberInput, Range, Select, Toggle } from "./components";
import { t, useLanguage } from "./i18n";
import type { Appearance, Project } from "./types";
import { duration } from "./core/timeline";
import { audioClipOutputEnd, createAudioClip, parseAudioSettings, resolveAudioSettings, resolveVoiceovers, updateAudioClip,
  type AudioAsset, type AudioClip, type AudioProject, type AudioServices, type AudioSettings, type MicrophonePreset } from "./core/audio";
import "./audio-panel.css";

export interface AudioPanelProps {
  project: AudioProject;
  update: (value: Project | ((project: Project) => Project), group?: string) => void;
  notify: (message: string) => void;
  outputTime: number;
  services?: AudioServices;
}
type RecordingSession = { recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; bytes: number; discard: boolean; start: number; projectPath: string | null };
const MAX_VOICEOVER_BYTES = 64 * 1024 * 1024;

export default function AudioPanel({ project, update, notify, outputTime, services }: AudioPanelProps) {
  useLanguage();
  const settings = resolveAudioSettings(project), outputDuration = duration(project), resolvedVoiceovers = resolveVoiceovers(project);
  const [library, setLibrary] = useState<AudioAsset[]>([]), [loadingLibrary, setLoadingLibrary] = useState(false);
  const [phase, setPhase] = useState<"idle" | "requesting" | "recording" | "saving">("idle");
  const [elapsed, setElapsed] = useState(0), [auditioning, setAuditioning] = useState<string | null>(null);
  const session = useRef<RecordingSession | null>(null), requesting = useRef(false), cancelRequest = useRef(false);
  const preview = useRef<HTMLAudioElement | null>(null), alive = useRef(true), latest = useRef(project); latest.current = project;
  useEffect(() => { alive.current = true; return () => {
    alive.current = false; cancelRequest.current = true;
    const current = session.current;
    if (current) { current.discard = true; if (current.recorder.state !== "inactive") current.recorder.stop(); current.stream.getTracks().forEach(track => track.stop()); }
    if (preview.current) { preview.current.pause(); preview.current.removeAttribute("src"); preview.current.load(); preview.current = null; }
  }; }, []);
  useEffect(() => {
    if (phase !== "recording") return;
    const began = performance.now();
    const timer = window.setInterval(() => setElapsed((performance.now() - began) / 1000), 100);
    return () => window.clearInterval(timer);
  }, [phase]);
  const safe = (action: () => void) => { try { action(); } catch (error) { notify(error instanceof Error ? error.message : String(error)); } };
  const edit = (fn: (current: AudioSettings) => AudioSettings, group?: string) => update(p => ({ ...p, audio: parseAudioSettings(fn(resolveAudioSettings(p))) }), group);
  const set = (patch: Partial<AudioSettings>, group?: string) => edit(current => ({ ...current, ...patch }), group);
  const appearance = <K extends keyof Appearance>(key: K, value: Appearance[K]) => update(p => ({ ...p, appearance: { ...p.appearance, [key]: value } }), `audio-${key}`);
  const newID = (kind: AudioClip["kind"], current: AudioSettings) => {
    const ids = new Set([...(current.background ? [current.background.id] : []), ...current.voiceovers.map(clip => clip.id)]);
    let number = 1; while (ids.has(`${kind}-${number}`)) number++; return `${kind}-${number}`;
  };
  const addAsset = (asset: AudioAsset, kind: AudioClip["kind"], start = kind === "music" ? 0 : outputTime) => safe(() => {
    edit(current => {
      const clip = createAudioClip(asset, kind, start, outputDuration, newID(kind, current));
      return kind === "music" ? { ...current, background: clip } : { ...current, voiceovers: [...current.voiceovers, clip] };
    });
    setLibrary(previous => previous.some(item => item.path === asset.path) ? previous : [...previous, asset]);
  });
  const importAsset = async (kind: AudioClip["kind"]) => {
    try { const asset = await services?.importFile(); if (asset) addAsset(asset, kind); }
    catch (error) { notify(error instanceof Error ? error.message : String(error)); }
  };
  const refreshLibrary = async () => {
    if (!services?.listLibrary) return;
    setLoadingLibrary(true);
    try { const assets = await services.listLibrary(); if (alive.current) setLibrary(assets); }
    catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { if (alive.current) setLoadingLibrary(false); }
  };
  const stopAudition = () => {
    if (preview.current) { preview.current.pause(); preview.current.removeAttribute("src"); preview.current.load(); preview.current = null; }
    setAuditioning(null);
  };
  const audition = async (asset: AudioAsset, clip?: AudioClip) => {
    if (!services) return;
    if (auditioning === (clip?.id ?? asset.path)) { stopAudition(); return; }
    stopAudition();
    const audio = new Audio(services.mediaURL(asset.path)); preview.current = audio;
    audio.volume = clip?.volume ?? .5; audio.playbackRate = clip?.rate ?? 1; audio.preservesPitch = true;
    audio.currentTime = clip?.trimStart ?? 0;
    audio.onended = stopAudition;
    audio.ontimeupdate = () => { if (clip && audio.currentTime >= clip.trimEnd) { if (clip.loop) audio.currentTime = clip.trimStart; else stopAudition(); } };
    audio.onerror = () => { notify(t("Cannot play this local audio file.")); stopAudition(); };
    setAuditioning(clip?.id ?? asset.path);
    try { await audio.play(); } catch (error) { notify(error instanceof Error ? error.message : String(error)); stopAudition(); }
  };
  const stopRecording = (discard = false) => {
    cancelRequest.current = discard;
    const current = session.current;
    if (!current) return;
    current.discard ||= discard;
    if (current.recorder.state !== "inactive") current.recorder.stop();
    current.stream.getTracks().forEach(track => track.stop());
  };
  const record = async () => {
    if (!services || requesting.current || session.current || phase !== "idle") return;
    requesting.current = true; cancelRequest.current = false; setPhase("requesting");
    let stream: MediaStream | null = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error(t("Microphone narration recording is unavailable in this session. Import a local recording instead."));
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
      if (!alive.current || cancelRequest.current) { stream.getTracks().forEach(track => track.stop()); if (alive.current) setPhase("idle"); return; }
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(value => MediaRecorder.isTypeSupported(value));
      if (!mime) throw new Error(t("No supported local narration recording format is available."));
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      const current: RecordingSession = { recorder, stream, chunks: [], bytes: 0, discard: false, start: outputTime, projectPath: project.mediaPath };
      session.current = current;
      recorder.ondataavailable = event => {
        if (!event.data.size || current.discard) return;
        current.bytes += event.data.size;
        if (current.bytes > MAX_VOICEOVER_BYTES) { current.discard = true; notify(t("Narration exceeded the 64 MiB recording bound and was discarded. Record shorter sections.")); stopRecording(true); }
        else current.chunks.push(event.data);
      };
      recorder.onerror = event => { notify(t("Microphone narration recording failed.")); current.discard = true; stopRecording(true); };
      recorder.onstop = async () => {
        current.stream.getTracks().forEach(track => track.stop());
        if (session.current === current) session.current = null;
        if (!alive.current) return;
        if (current.discard || !current.chunks.length) { setPhase("idle"); return; }
        setPhase("saving");
        try {
          const bytes = new Uint8Array(await new Blob(current.chunks, { type: recorder.mimeType }).arrayBuffer());
          current.chunks = [];
          const asset = await services.saveVoiceover(bytes, recorder.mimeType);
          if (alive.current && latest.current.mediaPath === current.projectPath) addAsset(asset, "voiceover", current.start);
        } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
        finally { if (alive.current) setPhase("idle"); }
      };
      setElapsed(0); recorder.start(1000); setPhase("recording");
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      if (alive.current) { setPhase("idle"); notify(error instanceof Error ? error.message : String(error)); }
    } finally { requesting.current = false; }
  };
  const changeClip = (clip: AudioClip, patch: Partial<AudioClip>, group?: string) => safe(() => edit(current => clip.kind === "music"
    ? { ...current, background: current.background?.id === clip.id ? updateAudioClip(current.background, patch) : current.background }
    : { ...current, voiceovers: current.voiceovers.map(value => value.id === clip.id ? updateAudioClip(value, patch) : value) }, group));
  const remove = (clip: AudioClip) => { if (auditioning === clip.id) stopAudition(); edit(current => clip.kind === "music" ? { ...current, background: null } : { ...current, voiceovers: current.voiceovers.filter(value => value.id !== clip.id) }); };
  const clipEditor = (clip: AudioClip) => <details className="audio-clip" key={clip.id} open>
    <summary><span>{clip.kind === "music" ? <Music2 size={13} /> : <Mic size={13} />}{clip.name}</span><button type="button" className="icon-button" aria-label={t("Remove {name}", { name: clip.name })} onClick={event => { event.preventDefault(); remove(clip); }}><Trash2 size={12} /></button></summary>
    <div className="audio-clip-description">{t("Edited timeline")} {t("{start}–{end}s", { start: clip.start.toFixed(2), end: audioClipOutputEnd(clip, outputDuration).toFixed(2) })}</div>
    {resolvedVoiceovers.issues.find(issue => issue.id === clip.id) && <p role="alert" className="panel-note">{resolvedVoiceovers.issues.find(issue => issue.id === clip.id)!.message}</p>}
    {clip.sourceAnchor && <><p className="panel-note">{t("Timing follows the original recording. Convert to edited-timeline timing to change placement.")}</p><button className="outline-button" onClick={() => changeClip(clip, { ...clip, sourceAnchor: undefined })}>{t("Convert to edited-timeline timing")}</button></>}
    <div className="audio-clip-actions"><button className="outline-button" disabled={!services} onClick={() => { void audition({ path: clip.path, name: clip.name, duration: clip.sourceDuration }, clip); }}>{auditioning === clip.id ? <Pause size={12} /> : <Play size={12} />}{t("Audition source")}</button><Toggle label="Mute" value={clip.muted} onChange={muted => changeClip(clip, { muted })} /></div>
    <Range label="Clip volume" value={clip.volume} max={1} step={.01} display={`${Math.round(clip.volume * 100)}%`} onChange={volume => changeClip(clip, { volume }, `audio-volume-${clip.id}`)} />
    {clip.kind === "voiceover" && <Toggle label="Mute microphone underneath" value={clip.hideRecording ?? false} onChange={hideRecording => changeClip(clip, { hideRecording })} />}
    <fieldset className="audio-anchor-timing" disabled={Boolean(clip.sourceAnchor)}>
    <div className="audio-time-fields"><label>{t("Output start")}<NumberInput label="Audio output start" value={clip.start} min={0} max={clip.end - .01} step={.01} onCommit={start => changeClip(clip, { start })} /></label><label>{t("Output end")}<NumberInput label="Audio output end" value={clip.end} min={clip.start + .01} max={Math.max(outputDuration, clip.end)} step={.01} onCommit={end => changeClip(clip, { end })} /></label></div>
    <div className="audio-time-fields"><label>{t("Source in")}<NumberInput label="Audio source trim start" value={clip.trimStart} min={0} max={clip.trimEnd - .001} step={.01} onCommit={trimStart => changeClip(clip, { trimStart })} /></label><label>{t("Source out")}<NumberInput label="Audio source trim end" value={clip.trimEnd} min={clip.trimStart + .001} max={clip.sourceDuration} step={.01} onCommit={trimEnd => changeClip(clip, { trimEnd })} /></label></div>
    <Range label="Audio playback speed" value={clip.rate} min={.25} max={4} step={.05} display={`${clip.rate.toFixed(2)}×`} onChange={rate => changeClip(clip, { rate }, `audio-rate-${clip.id}`)} />
    </fieldset>
    {clip.kind === "music" && <Toggle label="Loop trimmed music" value={clip.loop} onChange={loop => changeClip(clip, { loop })} />}
    <Range label="Audio fade in" value={clip.fadeIn} max={10} step={.05} display={t("{value}s", { value: clip.fadeIn.toFixed(2) })} onChange={fadeIn => changeClip(clip, { fadeIn }, `audio-fade-in-${clip.id}`)} />
    <Range label="Audio fade out" value={clip.fadeOut} max={10} step={.05} display={t("{value}s", { value: clip.fadeOut.toFixed(2) })} onChange={fadeOut => changeClip(clip, { fadeOut }, `audio-fade-out-${clip.id}`)} />
  </details>;
  return <div className="audio-panel">
    <h3>{t("Recorded audio")}</h3>
    <Toggle label="Mute system audio" value={settings.systemMuted} disabled={!project.mediaPath} onChange={systemMuted => set({ systemMuted })} />
    <Range label="System audio volume" value={project.appearance.volume} max={1} step={.01} display={`${Math.round(project.appearance.volume * 100)}%`} onChange={value => appearance("volume", value)} disabled={!project.mediaPath} />
    <Toggle label="Mute microphone" value={settings.microphoneMuted} disabled={!project.microphonePath} onChange={microphoneMuted => set({ microphoneMuted })} />
    <Range label="Microphone volume" value={project.appearance.microphoneVolume} max={1} step={.01} display={`${Math.round(project.appearance.microphoneVolume * 100)}%`} onChange={value => appearance("microphoneVolume", value)} disabled={!project.microphonePath} />
    {project.microphonePath && <><label className="audio-preset-field">{t("Microphone processing")}<Select label="Microphone processing preset" value={settings.microphonePreset} onChange={microphonePreset => set({ microphonePreset: microphonePreset as MicrophonePreset })}><option value="off">{t("Off")}</option><option value="standard">{t("Standard")}</option><option value="loud">{t("Loud")}</option><option value="noise-reduction">{t("Noise reduction")}</option></Select></label><p className="panel-note">{t("Off keeps the microphone recording unprocessed. Muting is separate.")}</p></>}
    <Toggle label="Mute camera audio" value={settings.cameraMuted} disabled={!project.cameraPath} onChange={cameraMuted => set({ cameraMuted })} />
    <Range label="Camera audio volume" value={project.appearance.cameraVolume} max={1} step={.01} display={`${Math.round(project.appearance.cameraVolume * 100)}%`} onChange={value => appearance("cameraVolume", value)} disabled={!project.cameraPath} />
    <hr /><h3>{t("Background audio")}</h3>
    <button className="outline-button full" disabled={!services || !outputDuration} onClick={() => { void importAsset("music"); }}><Upload size={14} />{t(settings.background ? "Replace background audio" : "Add background audio")}</button>
    {settings.background && clipEditor(settings.background)}
    <details className="audio-library" onToggle={event => { if (event.currentTarget.open && !library.length && !loadingLibrary) void refreshLibrary(); }}><summary>{t("User library")}</summary><p className="panel-note">{t("Use your own local music and narration files.")}</p>
      <div className="audio-library-actions">{services?.listLibrary && <button className="outline-button" disabled={loadingLibrary} onClick={() => { void refreshLibrary(); }}>{t(loadingLibrary ? "Loading…" : "Refresh library")}</button>}{services?.openLibrary && <button className="outline-button" onClick={() => { void services.openLibrary?.().catch(error => notify(String(error))); }}><FolderOpen size={12} />{t("Open library folder")}</button>}</div>
      {library.map(asset => <div className="audio-library-track" key={asset.path}><button className="icon-button" aria-label={t("Preview {name}", { name: asset.name })} onClick={() => { void audition(asset); }}>{auditioning === asset.path ? <Square size={12} /> : <Play size={12} />}</button><span title={asset.path}>{asset.name}</span><button className="icon-button" aria-label={t("Use {name} as background audio", { name: asset.name })} disabled={!outputDuration} onClick={() => addAsset(asset, "music")}><Plus size={12} /></button></div>)}
    </details>
    <hr /><h3>{t("Voiceover")}</h3><p className="panel-note">{t("New narration uses the edited timeline and stays fixed when video cuts change. Imported source anchors follow the original recording.")}</p>
    <div className="voiceover-actions">{phase === "recording" ? <><span className="voiceover-recording" role="status">● {t("{value}s", { value: elapsed.toFixed(1) })}</span><button className="outline-button" onClick={() => stopRecording()}><Square size={12} />{t("Save narration")}</button><button className="icon-button" aria-label={t("Discard narration")} onClick={() => stopRecording(true)}><X size={14} /></button></> : phase === "requesting" ? <><span role="status">{t("Waiting for microphone permission…")}</span><button className="outline-button" onClick={() => { cancelRequest.current = true; }}>{t("Cancel")}</button></> : phase === "saving" ? <span role="status">{t("Saving local narration…")}</span> : <><button className="outline-button" disabled={!services || !outputDuration || settings.voiceovers.length >= 64} onClick={() => { void record(); }}><Mic size={13} />{t("Record narration")}</button><button className="outline-button" disabled={!services || !outputDuration || settings.voiceovers.length >= 64} onClick={() => { void importAsset("voiceover"); }}><Upload size={13} />{t("Import narration")}</button></>}</div>
    {resolvedVoiceovers.clips.map(clipEditor)}
    {!services && <p className="panel-note">{t("The local audio file bridge is unavailable in this session.")}</p>}
  </div>;
}
