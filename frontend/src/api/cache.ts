// A TTL and in-flight de-dupe cache for page-level data loads: concurrent
// callers share one request, and a load that resolved within `ttlMs` is reused
// rather than re-fetched. Pages like Billing and Settings otherwise re-fire
// every request on each mount.
//
// Keep TTLs short so data cannot stay stale for long, and call
// `invalidateCache(key)` after a write to force a fresh load.

type Entry = { at: number; value: Promise<unknown> };

const store = new Map<string, Entry>();

export function cachedLoad<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>
): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) {
    return hit.value as Promise<T>;
  }
  const p = loader();
  store.set(key, { at: Date.now(), value: p });
  // Never cache a rejected load — evict so the next mount retries.
  p.catch(() => {
    if (store.get(key)?.value === p) store.delete(key);
  });
  return p;
}

export function invalidateCache(key: string): void {
  store.delete(key);
}
