import { useCallback, useEffect, useRef } from "react";
import type { Project } from "./types";
import { getDuration, getOutputTime } from "./core/model";

import { createAudioKeyCache } from "./core/audio-key";
import { createLatestThrottle } from "./core/latest-throttle";
type ScrubTarget = { project: Project; output: number };
type WindowBuffer = { key: string; start: number; duration: number; buffer: AudioBuffer; reversed?: AudioBuffer };
export function useMixedAudio({ project, time, playing, rate, scrubEnabled, onError }: { project: Project; time: number; playing: boolean; rate: number; scrubEnabled: boolean; onError: (message: string) => void }) {
  const keyFor = useRef(createAudioKeyCache()).current;
  const scrubSession = useRef<{ key: string; chunk: number; scheduler: ReturnType<typeof createLatestThrottle<ScrubTarget>> } | null>(null);
  const grainGains = useRef(new WeakMap<AudioBufferSourceNode, GainNode>());
  const state = useRef({ project, time, playing, rate, scrubEnabled, onError }); state.current = { project, time, playing, rate, scrubEnabled, onError };
  const context = useRef<AudioContext | null>(null), generation = useRef(0), nodes = useRef<AudioBufferSourceNode[]>([]), cache = useRef(new Map<string, WindowBuffer>()), requests = useRef(new Set<string>()), pending = useRef(new Map<string, Promise<WindowBuffer | null>>()), cancellation = useRef<Promise<unknown>>(Promise.resolve()), playingWindow = useRef<{ node: AudioBufferSourceNode; output: number; wall: number; rate: number; end: number } | null>(null);
  const stop = useCallback(() => { scrubSession.current?.scheduler.dispose(); scrubSession.current = null; generation.current++; for (const node of nodes.current) { try { node.stop(); } catch {} node.disconnect(); } nodes.current = []; playingWindow.current = null; const cancellations = [...requests.current].map(id => window.reva?.cancelAudioPreview(id)); cancellation.current = Promise.allSettled([cancellation.current, ...cancellations]); requests.current.clear(); pending.current.clear(); }, []);
  const audioContext = useCallback(() => { context.current ??= new AudioContext({ sampleRate: 48000, latencyHint: "interactive" }); void context.current.resume().catch(error => state.current.onError(error.message)); return context.current; }, []);
  const loadWindow = useCallback(async (p: Project, output: number): Promise<WindowBuffer | null> => {
    const api = window.reva; if (!api || !p.mediaPath) return null;
    const chunk = Math.floor(Math.max(0, output) / 10), start = Math.max(0, chunk * 10 - 2), duration = Math.min(14, getDuration(p) - start), requestKey = `${keyFor(p)}:${chunk}`;
    if (duration <= 0) return null;
    const decoded = cache.current.get(requestKey);
    if (decoded) { cache.current.delete(requestKey); cache.current.set(requestKey, decoded); return decoded; }
    const existing = pending.current.get(requestKey); if (existing) return existing;
    const owner = generation.current, id = crypto.randomUUID(); requests.current.add(id);
    const task = (async () => {
      await cancellation.current; if (owner !== generation.current) return null;
      const result = await api.renderAudioPreview(p, { id, start, duration }); if (!result || owner !== generation.current) return null;
      let entry = cache.current.get(requestKey);
      if (!entry) { const response = await fetch(api.mediaURL(result.path)); if (!response.ok) throw new Error("The mixed audio preview could not be read."); const bytes = await response.arrayBuffer(); if (owner !== generation.current) return null; const decoded = await audioContext().decodeAudioData(bytes); if (owner !== generation.current) return null; entry = { key: result.key, start: result.start, duration: result.duration, buffer: decoded }; }
      cache.current.delete(requestKey); cache.current.set(requestKey, entry); while (cache.current.size > 4) cache.current.delete(cache.current.keys().next().value!);
      return entry;
    })().finally(() => { requests.current.delete(id); if (pending.current.get(requestKey) === task) pending.current.delete(requestKey); });
    pending.current.set(requestKey, task); return task;
  }, [audioContext, keyFor]);
  const startBuffer = useCallback((entry: WindowBuffer, output: number, rate: number, duration?: number) => {
    const ctx = audioContext(), node = ctx.createBufferSource(), reverse = rate < 0;
    let buffer = entry.buffer;
    if (reverse) { if (!entry.reversed) { const copy = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate); for (let channel = 0; channel < buffer.numberOfChannels; channel++) { const original = buffer.getChannelData(channel), target = copy.getChannelData(channel); for (let index = 0; index < original.length; index++) target[index] = original[original.length - 1 - index]; } entry.reversed = copy; } buffer = entry.reversed; }
    const relative = Math.max(0, Math.min(entry.duration, output - entry.start)), offset = reverse ? Math.max(0, buffer.duration - relative) : relative, available = Math.max(0, buffer.duration - offset);
    if (available <= 0) return null;
    node.buffer = buffer; node.playbackRate.value = Math.max(.1, Math.min(16, Math.abs(rate))); if (duration !== undefined) {
      const gain = ctx.createGain(), wallDuration = Math.min(available, duration) / node.playbackRate.value, now = ctx.currentTime;
      gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(1, now + Math.min(.005, wallDuration / 3)); gain.gain.setValueAtTime(1, now + Math.max(wallDuration / 3, wallDuration - .008)); gain.gain.linearRampToValueAtTime(0, now + wallDuration);
      node.connect(gain); gain.connect(ctx.destination); grainGains.current.set(node, gain);
    } else node.connect(ctx.destination); nodes.current.push(node);
    node.onended = () => { grainGains.current.get(node)?.disconnect(); node.disconnect(); nodes.current = nodes.current.filter(item => item !== node); if (playingWindow.current?.node === node) playingWindow.current = null; };
    node.start(0, offset, Math.min(available, duration ?? available)); return node;
  }, [audioContext, keyFor]);
  const key = keyFor(project);
  useEffect(() => {
    if (!playing && scrubSession.current?.key === key) return;
    stop(); if (!playing || !project.mediaPath) return;
    const owner = generation.current; let busy = false, failed = false;
    const tick = async () => {
      if (busy || failed || owner !== generation.current) return;
      const current = state.current, output = getOutputTime(current.project, current.time), live = playingWindow.current, now = performance.now();
      if (live && live.rate === current.rate && Math.abs(live.output + (now - live.wall) / 1000 * live.rate - output) < .18 && (current.rate >= 0 ? output < live.end - .12 : output > live.end + .12)) return;
      busy = true;
      try {
        const entry = await loadWindow(current.project, output); if (!entry || owner !== generation.current) return;
        const latest = state.current, actual = getOutputTime(latest.project, latest.time);
        for (const old of nodes.current) { try { old.stop(); } catch {} }
        const node = startBuffer(entry, actual, latest.rate); if (node) playingWindow.current = { node, output: actual, wall: performance.now(), rate: latest.rate, end: latest.rate >= 0 ? entry.start + entry.duration : entry.start };
        const next = latest.rate >= 0 ? Math.min(getDuration(latest.project) - .001, (Math.floor(actual / 10) + 1) * 10 + .01) : Math.max(0, Math.floor(actual / 10) * 10 - .01);
        if (Math.floor(next / 10) !== Math.floor(actual / 10)) void loadWindow(latest.project, next).catch(() => {});
      } catch (error) { if (owner === generation.current) { failed = true; state.current.onError(error instanceof Error ? error.message : String(error)); } }
      finally { busy = false; }
    };
    void tick(); const timer = setInterval(() => void tick(), 75); return () => { clearInterval(timer); stop(); };
  }, [playing, rate, key, loadWindow, startBuffer, stop, project.mediaPath]);
  const audition = useCallback((sourceTime: number | null, override?: Project, force = false) => {
    const current = state.current;
    if (sourceTime === null || current.playing || (!current.scrubEnabled && !force)) { if (!current.playing) stop(); return; }
    const p = override ?? current.project, output = getOutputTime(p, sourceTime);
    // Audition short forward grains at their rendered pitch. Pointer velocity,
    // direction and timeline zoom choose the position, never the sample rate.
    audioContext();
    const audioKey = keyFor(p), chunk = Math.floor(Math.max(0, output) / 10);
    if (!scrubSession.current || scrubSession.current.key !== audioKey || scrubSession.current.chunk !== chunk) {
      stop(); const owner = generation.current;
      const scheduler = createLatestThrottle<ScrubTarget>({ onError: error => state.current.onError(error instanceof Error ? error.message : String(error)), sample: async read => {
        try {
          const requested = read(); if (!requested) return;
          const entry = await loadWindow(requested.value.project, requested.value.output); if (!entry || owner !== generation.current) return requested.revision;
          const latest = read(); if (!latest) return;
          const ctx = audioContext();
          for (const old of nodes.current) {
            const gain = grainGains.current.get(old);
            try { if (gain) { gain.gain.cancelScheduledValues(ctx.currentTime); gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime); gain.gain.linearRampToValueAtTime(0, ctx.currentTime + .008); old.stop(ctx.currentTime + .009); } else old.stop(); } catch {}
          }
          startBuffer(entry, latest.value.output, 1, .14); return latest.revision;
        } catch (error) { if (owner === generation.current) { scrubSession.current?.scheduler.dispose(); state.current.onError(error instanceof Error ? error.message : String(error)); } return read()?.revision; }
      } });
      scrubSession.current = { key: audioKey, chunk, scheduler };
    }
    scrubSession.current.scheduler.offer({ project: p, output });
  }, [stop, audioContext, loadWindow, startBuffer, keyFor]);
  useEffect(() => () => { stop(); cache.current.clear(); void context.current?.close(); }, [stop]);
  return { audition, stop };
}
