import { useEffect, useState } from "react";

// SessionStorage cache — paints each home card instantly on repeat visits
// while the fresh fetch runs in the background. One key per card so a fast
// card can render even when an older snapshot of a slow card is stale or
// missing. Shared by ActivityDashboard and PersonalDashboard so navigating
// back to /home doesn't refetch every card cold.
const CACHE_PREFIX = "rwayve.home.";

export function loadCached<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function saveCached<T>(key: string, value: T) {
  try {
    sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value));
  } catch {
    // ignore — private mode / quota
  }
}

/**
 * Drop every home snapshot. Called on logout and on session expiry.
 *
 * These snapshots hold real user content — `personal.emails` carries inbox
 * subjects and senders — and sessionStorage outlives a logout within the same
 * tab. Without this, signing in as a second user paints the first user's mail on
 * /home until their own fetch lands.
 *
 * Sweeps by prefix so it also catches keys written elsewhere under
 * `rwayve.home.` (PersonalDashboard's `recentlyRead`), and so a snapshot added
 * later is covered without anyone remembering to update this list.
 */
export function clearHomeCache(): void {
  try {
    // Enumerate via length/key(i) rather than Object.keys: that is the API every
    // Storage implementation honors, and removal shifts the indices, so collect
    // the matches first and delete afterwards.
    const stale: string[] = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(CACHE_PREFIX)) stale.push(key);
    }
    for (const key of stale) sessionStorage.removeItem(key);
  } catch {
    // ignore — private mode / quota
  }
}

/**
 * Generic per-card fetch hook: seeds state from sessionStorage for instant
 * paint, fires the fetch on mount, writes back on success. Each card uses one
 * of these so the slow cards never block the fast ones.
 */
export function useCardData<T>(
  cacheKey: string,
  fetcher: () => Promise<T>
): { data: T | null; loading: boolean } {
  const [data, setData] = useState<T | null>(() => loadCached<T>(cacheKey));
  const [loading, setLoading] = useState(data === null);

  useEffect(() => {
    let cancelled = false;
    fetcher()
      .then((fresh) => {
        if (cancelled) return;
        setData(fresh);
        saveCached(cacheKey, fresh);
      })
      .catch(() => {
        // Keep the cached value rendered if the refresh fails; if there
        // was no cache, fall through so the card shows its empty state.
        if (cancelled) return;
        setData((prev) => prev);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Stable for the lifetime of this hook call — re-fetching is the
    // parent's job (none of these endpoints poll).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { data, loading };
}
