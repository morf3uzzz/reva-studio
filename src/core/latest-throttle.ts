export interface LatestValue<T> { value: T; revision: number }
/** Starts during continuous input and shares pending work with its latest target.
 * Disposal revokes scheduling; the caller owns asynchronous cancellation. */
export function createLatestThrottle<T>({ sample, onError, intervalMs = 35, now = () => performance.now(), schedule = (callback, delay) => setTimeout(callback, delay), unschedule = handle => clearTimeout(handle as ReturnType<typeof setTimeout>) }: {
  onError: (error: unknown) => void;
  sample: (latest: () => LatestValue<T> | null) => Promise<number | void>;
  intervalMs?: number; now?: () => number;
  schedule?: (callback: () => void, delay: number) => unknown;
  unschedule?: (handle: unknown) => void;
}) {
  let latest: LatestValue<T> | null = null, revision = 0, delivered = 0, timer: unknown = null, running = false, disposed = false, lastStarted = -Infinity;
  const read = () => disposed ? null : latest;
  const request = () => {
    if (disposed || running || timer !== null || !latest || latest.revision <= delivered) return;
    timer = schedule(() => {
      timer = null; if (disposed || !latest) return;
      running = true; lastStarted = now(); const requested = latest.revision;
      void Promise.resolve().then(() => sample(read)).then(consumed => { delivered = Math.max(delivered, consumed ?? requested); }, error => { delivered = Math.max(delivered, requested); onError(error); }).finally(() => { running = false; request(); });
    }, Math.max(0, intervalMs - (now() - lastStarted)));
  };
  return { offer(value: T) { if (disposed) return; latest = { value, revision: ++revision }; request(); }, dispose() { disposed = true; latest = null; if (timer !== null) unschedule(timer); timer = null; } };
}
