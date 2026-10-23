import { useCallback, useRef, useState } from "react";
import type { Project } from "./types";
import { mediaSeekTarget, mediaTimelineEnd } from "./core/playback";

export function useProject(initial: Project) {
  const [project, setProject] = useState(initial);
  const current = useRef(project);
  const history = useRef<{
    past: Project[];
    future: Project[];
    key?: string;
    at: number;
  }>({ past: [], future: [], at: 0 });
  const [, refresh] = useState(0);
  const update = useCallback(
    (next: Project | ((p: Project) => Project), group?: string) => {
      const value = typeof next === "function" ? next(current.current) : next;
      if (value === current.current) return;
      const h = history.current;
      if (!group || h.key !== group || (!group.startsWith("gesture:") && Date.now() - h.at > 700))
        h.past = [...h.past.slice(-99), current.current];
      h.key = group;
      h.at = Date.now();
      h.future = [];
      current.current = value;
      setProject(value);
    },
    [],
  );
  const reset = useCallback((p: Project) => {
    history.current = { past: [], future: [], at: 0 };
    current.current = p;
    setProject(p);
    refresh((x) => x + 1);
  }, []);
  const undo = useCallback(() => {
    const h = history.current,
      value = h.past.pop();
    if (!value) return;
    h.future.push(current.current);
    h.key = undefined;
    current.current = value;
    setProject(value);
  }, []);
  const redo = useCallback(() => {
    const h = history.current,
      value = h.future.pop();
    if (!value) return;
    h.past.push(current.current);
    h.key = undefined;
    current.current = value;
    setProject(value);
  }, []);
  return {
    project,
    update,
    reset,
    undo,
    redo,
    canUndo: history.current.past.length > 0,
    canRedo: history.current.future.length > 0,
  };
}

export function seekVideo(
  video: HTMLVideoElement,
  time: number,
  knownEnd?: number,
): Promise<void> {
  const target = mediaSeekTarget(video, time, knownEnd);
  if (Math.abs(video.currentTime - target) < 0.00001 && video.readyState >= 2)
    return Promise.resolve();
  return new Promise((resolve, reject) => {
    const initialDecoderEnd = mediaTimelineEnd(video);
    let initializedDecoder = false;
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Video seeking timed out. Try reimporting the source."));
    }, 10000);
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener("seeked", done);
      video.removeEventListener("error", failed);
    };
    const done = () => {
      // A first seek can initialize an empty-edit movie's full index. Chromium
      // clamps that first assignment to its stale media-only duration, then
      // publishes the genuine extended seekable clock at seeked. Retry once
      // only when those newly observed facts now cover our original target.
      const actualEnd = mediaTimelineEnd(video);
      if (!initializedDecoder && video.currentTime < target - .00001 && actualEnd > initialDecoderEnd + .00001 && actualEnd >= target) {
        initializedDecoder = true; video.currentTime = target; return;
      }
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error("Could not decode a video frame."));
    };
    video.addEventListener("seeked", done);
    video.addEventListener("error", failed, { once: true });
    video.currentTime = target;
  });
}

export function loadVideo(src: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.crossOrigin = "anonymous";
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener("loadeddata", done);
      video.removeEventListener("error", failed);
    };
    const done = () => {
      cleanup();
      resolve(video);
    };
    const failed = () => {
      cleanup();
      video.removeAttribute("src");
      video.load();
      reject(
        new Error(
          "Unable to decode source video. Try an H.264 MP4 or MOV file.",
        ),
      );
    };
    const timeout = window.setTimeout(failed, 15000);
    video.addEventListener("loadeddata", done, { once: true });
    video.addEventListener("error", failed, { once: true });
    video.src = src;
  });
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    const cleanup = () => {
      clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
    };
    const failed = () => {
      cleanup();
      image.src = "";
      reject(new Error("Unable to load the background image."));
    };
    const timeout = window.setTimeout(failed, 15000);
    image.onload = () => {
      cleanup();
      resolve(image);
    };
    image.onerror = failed;
    image.src = src;
  });
}
