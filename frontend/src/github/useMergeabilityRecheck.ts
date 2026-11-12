import { useEffect } from "react";
import { githubJson } from "./commitDiffData";

/** Waits between re-checks; one attempt per entry (~30s in all). */
export const RECHECK_DELAYS_MS = [2000, 3000, 5000, 8000, 12000];

type Mergeability = {
  mergeable?: boolean | null;
  mergeable_state?: string;
};

/**
 * GitHub works out a PR's mergeability in the background: right after its base
 * branch moves, the PR reads `mergeable: null` until that job finishes, and the
 * backend proxy caches that null for 60s. While the open PR is in that state,
 * re-read it a few times — with a throwaway `fresh` query param, since the
 * proxy keys its cache on the query string — and hand back GitHub's answer.
 */
export function useMergeabilityRecheck(
  pullUrl: string | null,
  awaiting: boolean,
  onResolved: (
    m: Required<Pick<Mergeability, "mergeable">> & Mergeability
  ) => void
): void {
  useEffect(() => {
    if (!pullUrl || !awaiting) return;
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout>;

    const check = async () => {
      try {
        const fresh = await githubJson<Mergeability>(
          `${pullUrl}?fresh=${Date.now()}`
        );
        if (cancelled) return;
        if (fresh.mergeable != null) {
          onResolved({
            mergeable: fresh.mergeable,
            mergeable_state: fresh.mergeable_state,
          });
          return;
        }
      } catch {
        // A failed re-check just waits for the next one.
      }
      attempt += 1;
      if (!cancelled && attempt < RECHECK_DELAYS_MS.length) {
        timer = setTimeout(() => void check(), RECHECK_DELAYS_MS[attempt]);
      }
    };

    timer = setTimeout(() => void check(), RECHECK_DELAYS_MS[0]);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // onResolved is a fresh closure each render; re-arming on it would restart
    // the countdown, so the effect keys only on what to re-check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pullUrl, awaiting]);
}
