/**
 * Projects are validated at the persistence boundary. This owns compatibility:
 * an absent slice list means legacy trim/speed, whereas an explicit [] is empty.
 * The array order is the output order; source positions do not reorder clips.
 */
export function getSlices(project) {
  if (project.slices !== undefined)
    return project.slices.map((slice) => ({ ...slice }));
  const sourceDuration = Math.max(
    0,
    Number.isFinite(project.duration) ? project.duration : 0,
  );
  const start = Math.max(
    0,
    Math.min(
      sourceDuration,
      Number.isFinite(project.trimStart) ? project.trimStart : 0,
    ),
  );
  const end = Math.max(
    start,
    Math.min(
      sourceDuration,
      Number.isFinite(project.trimEnd) ? project.trimEnd : 0,
    ),
  );
  if (end <= start) return [];
  return [
    {
      id: "legacy-slice",
      start,
      end,
      speed:
        Number.isFinite(project.speed) && project.speed > 0 ? project.speed : 1,
      volume: 1,
    },
  ];
}

function sliceDuration(slice) {
  return (slice.end - slice.start) / slice.speed;
}

export function duration(project) {
  return getSlices(project).reduce(
    (total, slice) => total + sliceDuration(slice),
    0,
  );
}

/** At a cut choose the following slice; the final output boundary uses last.end. */
export function selectSlice(
  project,
  outputSeconds,
) {
  const slices = getSlices(project);
  if (slices.length === 0) return null;
  const total = slices.reduce(
    (total, slice) => total + sliceDuration(slice),
    0,
  );
  const time = Math.max(
    0,
    Math.min(total, Number.isFinite(outputSeconds) ? outputSeconds : 0),
  );
  let outputStart = 0;
  for (let index = 0; index < slices.length; index++) {
    const slice = slices[index];
    const outputEnd = outputStart + sliceDuration(slice);
    if (time < outputEnd || index === slices.length - 1)
      return {
        slice,
        index,
        outputStart,
        outputEnd,
        outputTime: time,
        sourceTime: Math.min(
          slice.end,
          slice.start + (time - outputStart) * slice.speed,
        ),
      };
    outputStart = outputEnd;
  }
  return null;
}

export function outputToSource(
  project,
  outputSeconds,
) {
  return selectSlice(project, outputSeconds)?.sourceTime ?? null;
}

/**
 * A removed source gap has no output time. If the same source exists more than
 * once, callers can select an occurrence by id; otherwise the first one wins.
 */
export function timeToOutput(
  project,
  sourceSeconds,
  sliceId,
) {
  if (!Number.isFinite(sourceSeconds)) return null;
  let outputStart = 0;
  for (const slice of getSlices(project)) {
    if (
      (sliceId === undefined || slice.id === sliceId) &&
      sourceSeconds >= slice.start &&
      sourceSeconds <= slice.end
    ) {
      return outputStart + (sourceSeconds - slice.start) / slice.speed;
    }
    outputStart += sliceDuration(slice);
  }
  return null;
}


/** Intersect a source range with retained clips before mapping their speeds. */
export function sourceRangeOutputSpans(project, start, end) {
  const spans = [];
  let output = 0;
  for (const slice of getSlices(project)) {
    const from = Math.max(start, slice.start), to = Math.min(end, slice.end);
    if (to > from) spans.push({ start: output + (from - slice.start) / slice.speed, end: output + (to - slice.start) / slice.speed, sliceId: slice.id });
    output += sliceDuration(slice);
  }
  return spans;
}
