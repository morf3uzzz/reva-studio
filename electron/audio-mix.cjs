"use strict";
const { auxiliaryAudioFilter, atempoFilters } = require("../shared/audio.mjs");
const { projectSlices, MEDIA_FORMATS } = require("./core.cjs");
const SAMPLE_RATE = 48000;
function fadeFilters(project, duration, start = 0, windowDuration = duration) {
  const fadeIn = Math.min(project.appearance.fadeIn, duration), fadeOut = Math.min(project.appearance.fadeOut, duration), filters = [];
  if (!start && windowDuration === duration) {
    if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${fadeIn}`);
    if (fadeOut > 0) filters.push(`afade=t=out:st=${Math.max(0, duration - fadeOut)}:d=${fadeOut}`);
  } else if (fadeIn > 0 || fadeOut > 0) {
    const expressions = []; if (fadeIn > 0) expressions.push(`min(1,max(0,(t+${start})/${fadeIn}))`); if (fadeOut > 0) expressions.push(`min(1,max(0,(${duration}-t-${start})/${fadeOut}))`);
    filters.push(`volume='${expressions.join("*")}':eval=frame`);
  }
  return filters;
}
/** One filter graph owns the full output clock. Preview crops after stateful
 * processing and the final limiter, so seeking cannot restart a compressor,
 * denoiser, time stretch or loop phase in the middle of its input. FFmpeg streams
 * the required prefix; memory stays bounded. A late uncached seek costs that
 * prefix decode time, rather than returning a different mix. */
function buildAudioGraph(project, duration, tracks, { firstInputIndex = 1, start = 0, end = duration } = {}) {
  const inputArgs = [], filters = [], labels = [], slices = projectSlices(project);
  const windowDuration = Math.max(0, Math.min(duration, end) - start), range = start !== 0 || end !== duration;
  for (const track of tracks) {
    if (track.volume <= 0) continue;
    const index = firstInputIndex + labels.length, label = `a${index}`, source = `[${index}:a:0]`, out = `[${label}]`;
    if (track.clip) {
      inputArgs.push("-protocol_whitelist", "file,pipe", "-format_whitelist", MEDIA_FORMATS, "-i", track.path);
      filters.push(auxiliaryAudioFilter(track.clip, `${index}:a:0`, `aux${index}`, duration));
      filters.push(`[aux${index}]${[...fadeFilters(project, duration), `apad=whole_dur=${duration}`, `atrim=duration=${duration}`].join(",")}${out}`);
      labels.push(out); continue;
    }
    inputArgs.push("-protocol_whitelist", "file,pipe", "-format_whitelist", MEDIA_FORMATS, "-i", track.path);
    if (track.timeline === "output" || track.clock === "output") {
      filters.push(`${source}${["asetpts=PTS-STARTPTS", `volume=${track.volume}`, ...(track.filters ?? []), ...fadeFilters(project, duration), `apad=whole_dur=${duration}`, `atrim=duration=${duration}`].join(",")}${out}`); labels.push(out); continue;
    }
    const delay = track.sourceDelay ?? 0;
    let sourceLabel = source, chain;
    const sliceChain = slice => {
      const requestedStart = slice.start - delay, requestedEnd = slice.end - delay, audioStart = Math.max(0, requestedStart), audioEnd = Math.max(audioStart, requestedEnd);
      const sliceGain = track.role === "system" ? slice.systemVolume ?? slice.volume : track.role === "camera" ? slice.cameraVolume ?? slice.volume : slice.volume;
      const part = [`atrim=start=${audioStart}:end=${audioEnd}`, "asetpts=PTS-STARTPTS", ...atempoFilters(slice.speed), `volume=${track.volume * sliceGain}`, ...(track.filters ?? [])];
      if (requestedStart < 0) part.push(`adelay=${Math.round(-requestedStart / slice.speed * SAMPLE_RATE)}S:all=1`, "asetpts=N/SR/TB");
      return part;
    };
    if (slices.length === 1) chain = sliceChain(slices[0]);
    else {
      const parts = slices.map((_, n) => `[split${index}_${n}]`); filters.push(`${sourceLabel}asplit=${slices.length}${parts.join("")}`);
      const joined = slices.map((slice, n) => { const partDuration = (slice.end - slice.start) / slice.speed, target = `[slice${index}_${n}]`; filters.push(`${parts[n]}${[...sliceChain(slice), `apad=whole_dur=${partDuration}`, `atrim=duration=${partDuration}`].join(",")}${target}`); return target; });
      sourceLabel = `[joined${index}]`; filters.push(`${joined.join("")}concat=n=${slices.length}:v=0:a=1${sourceLabel}`); chain = [];
    }
    chain.push(...(track.outputFilters ?? []), ...fadeFilters(project, duration), `apad=whole_dur=${duration}`, `atrim=duration=${duration}`);
    filters.push(`${sourceLabel}${chain.join(",")}${out}`); labels.push(out);
  }
  if (labels.length) {
    filters.push(`${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0,alimiter=limit=0.95:level=0:latency=1${range ? "[fullmix]" : "[aout]"}`);
    if (range) filters.push(`[fullmix]atrim=start=${start}:end=${Math.min(end, duration)},asetpts=PTS-STARTPTS[aout]`);
  }
  return { inputArgs, filters, label: labels.length ? "[aout]" : null, duration: windowDuration };
}
module.exports = { buildAudioGraph };
