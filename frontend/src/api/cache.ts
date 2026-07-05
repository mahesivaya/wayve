// Tiny TTL + in-flight de-dupe cache for page-level data loads.
//
// Several pages (Billing, Settings, Platform Billing) fire 3–7 requests via
// Promise.all on every mount, re-fetching everything each time the user
// navigates back. Wrapping the load in `cachedLoad` means:
//   - concurrent callers share ONE in-flight request (de-dupe), and
//   - a load that resolved within `ttlMs` is reused instead of re-fetched.
//
// The TTL is deliberately short so data can't stay stale for long after a
// mutation; call `invalidateCache(key)` after a write to force a fresh load.

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
