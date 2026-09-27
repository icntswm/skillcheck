export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, i: number) => Promise<R>,
  opts?: { shouldStart?: () => boolean },
): Promise<(R | undefined)[]> {
  const cap = Math.max(1, Math.floor(concurrency) || 1);
  const results: (R | undefined)[] = new Array(items.length).fill(undefined);
  const inflight = new Set<Promise<void>>();
  let next = 0;
  let failed = false;
  let firstError: unknown;

  const canStart = () =>
    !failed && next < items.length && (!opts?.shouldStart || opts.shouldStart());

  const start = () => {
    const i = next++;
    const task = (async () => {
      try {
        results[i] = await worker(items[i] as T, i);
      } catch (e) {
        if (!failed) {
          failed = true;
          firstError = e;
        }
      }
    })();
    const slot = task.then(() => { inflight.delete(slot); });
    inflight.add(slot);
  };

  while (canStart() && inflight.size < cap) start();
  while (inflight.size > 0) {
    await Promise.race(inflight);
    while (canStart() && inflight.size < cap) start();
  }
  if (failed) throw firstError;
  return results;
}
