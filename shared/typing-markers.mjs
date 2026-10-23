/**
 * Source-derived typing suggestions. Inputs are validated, ordered activity
 * samples in source seconds; they contain counts, never characters or key IDs.
 * Original p_/f_: adjacent gap <500 ms, span >=1500 ms, >=2 events/second.
 */
export function deriveTypingRanges(samples) {
  const ranges = [];
  let start, end, count = 0;
  const finish = () => {
    const spanMs = end * 1000 - start * 1000;
    if (spanMs >= 1500 && count * 1000 >= spanMs * 2) ranges.push({ start, end, count });
  };
  for (const sample of samples) {
    if (start === undefined) {
      start = end = sample.time; count = sample.count;
    } else if (sample.time * 1000 - end * 1000 < 500) {
      end = sample.time; count += sample.count;
    } else {
      finish(); start = end = sample.time; count = sample.count;
    }
  }
  if (start !== undefined) finish();
  return ranges;
}
