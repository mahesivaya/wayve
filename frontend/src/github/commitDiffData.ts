import { useCallback, useEffect, useState } from "react";
import { getAuthToken } from "../auth/token";

// Data layer for commit diffs, shared by the Code Repo viewer and the Projects
// → Recent activity list. The rendering components live in `commitDiff.tsx`.

// `patch` is a unified-diff string rendered line-by-line with +/- coloring.
export type CommitFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string | null;
  previous_filename?: string | null;
};

export type CommitDetail = {
  sha: string;
  files?: CommitFile[];
  stats?: {
    total: number;
    additions: number;
    deletions: number;
  };
  parents?: Array<{ sha: string; html_url: string }>;
};

export type IssueComment = {
  id: number;
  user: { login: string } | null;
  body: string | null;
  created_at: string;
};

// Authed fetch through the GitHub proxy. Bearer token, not the cookie alone,
// which is unreliable in token-only sessions. The proxy adds the Accept and
// X-GitHub-Api-Version headers.
export async function githubJson<T>(url: string): Promise<T> {
  const token = getAuthToken();
  const response = await fetch(url, {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!response.ok) {
    // A 403 means the repo isn't linked to one of this account's projects.
    if (response.status === 403) {
      throw new Error("You don't have access to this repository.");
    }
    throw new Error(`GitHub request failed (${response.status})`);
  }

  // Some proxy errors resolve with a 200 and an HTML/empty body, so guard and
  // show a banner rather than resolving to a falsy value that renders blank.
  const data = (await response.json()) as unknown;
  if (data === null || typeof data !== "object") {
    throw new Error("GitHub returned an unexpected response.");
  }
  return data as T;
}

// Per-commit diff state, keyed by SHA and shared across every expanded row.
// Detail is cached so toggling a row closed and open again doesn't re-hit
// GitHub; `collapsedFiles` holds only the file diffs the user has folded away
// (files default to expanded), with keys namespaced (`<sha>::<filename>` for
// commits, `pr-<n>::<filename>` for PR files) so one Set serves both views.
export type CommitDiffs = {
  expandedShas: Set<string>;
  detailBySha: Record<string, CommitDetail>;
  loadingShas: Set<string>;
  errorBySha: Record<string, string>;
  fullDiffBySha: Record<string, string>;
  loadingFullDiffShas: Set<string>;
  errorFullDiffBySha: Record<string, string>;
  collapsedFiles: Set<string>;
  toggle: (sha: string) => void;
  reload: (sha: string) => void;
  toggleFile: (key: string) => void;
  collapseFiles: (keys: string[]) => void;
  loadFullDiff: (sha: string) => void;
};

export function useCommitDiffs(owner: string, repo: string): CommitDiffs {
  const API_BASE = `/api/github/repos/${owner}/${repo}`;

  const [expandedShas, setExpandedShas] = useState<Set<string>>(new Set());
  const [detailBySha, setDetailBySha] = useState<Record<string, CommitDetail>>(
    {}
  );
  const [loadingShas, setLoadingShas] = useState<Set<string>>(new Set());
  const [errorBySha, setErrorBySha] = useState<Record<string, string>>({});
  // Fallback for commits whose JSON `files[].patch` is missing: GitHub truncates
  // patches over roughly 300 KB and for binary-adjacent files.
  const [fullDiffBySha, setFullDiffBySha] = useState<Record<string, string>>(
    {}
  );
  const [loadingFullDiffShas, setLoadingFullDiffShas] = useState<Set<string>>(
    new Set()
  );
  const [errorFullDiffBySha, setErrorFullDiffBySha] = useState<
    Record<string, string>
  >({});
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());

  const toggleFile = useCallback((key: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const collapseFiles = useCallback((keys: string[]) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      for (const key of keys) next.add(key);
      return next;
    });
  }, []);

  // Skips the network when the SHA is already cached, unless `force` is set (the
  // Retry affordance after a failed or empty load).
  const loadCommitDetail = useCallback(
    async (sha: string, force = false) => {
      if (!force && detailBySha[sha]) return;

      setLoadingShas((current) => new Set(current).add(sha));
      setErrorBySha((current) => {
        const next = { ...current };
        delete next[sha];
        return next;
      });
      try {
        const data = await githubJson<CommitDetail>(
          `${API_BASE}/commits/${encodeURIComponent(sha)}`
        );
        setDetailBySha((current) => ({ ...current, [sha]: data }));
      } catch (err) {
        setErrorBySha((current) => ({
          ...current,
          [sha]:
            err instanceof Error ? err.message : "Could not load commit diff",
        }));
      } finally {
        setLoadingShas((current) => {
          const next = new Set(current);
          next.delete(sha);
          return next;
        });
      }
    },
    [API_BASE, detailBySha]
  );

  // First open kicks off the detail fetch; later toggles read the cache.
  const toggle = useCallback(
    (sha: string) => {
      let opened = false;
      setExpandedShas((current) => {
        const next = new Set(current);
        if (next.has(sha)) {
          next.delete(sha);
        } else {
          next.add(sha);
          opened = true;
        }
        return next;
      });
      if (opened) void loadCommitDetail(sha);
    },
    [loadCommitDetail]
  );

  const reload = useCallback(
    (sha: string) => void loadCommitDetail(sha, true),
    [loadCommitDetail]
  );

  // Self-heal: a commit that is expanded with no detail, no error, and no fetch
  // in flight got there without the click path (the commit list reloaded and
  // cleared the cache, or state reset), so fetch its diff automatically.
  useEffect(() => {
    for (const sha of expandedShas) {
      if (!detailBySha[sha] && !errorBySha[sha] && !loadingShas.has(sha)) {
        void loadCommitDetail(sha);
      }
    }
  }, [expandedShas, detailBySha, errorBySha, loadingShas, loadCommitDetail]);

  // Used when the JSON detail returned `files[]` without a `patch` (text files
  // over roughly 300 KB).
  const loadFullDiff = useCallback(
    async (sha: string) => {
      if (fullDiffBySha[sha]) return;
      setLoadingFullDiffShas((current) => new Set(current).add(sha));
      setErrorFullDiffBySha((current) => {
        const next = { ...current };
        delete next[sha];
        return next;
      });
      try {
        const token = getAuthToken();
        const response = await fetch(
          `${API_BASE}/commits/${encodeURIComponent(sha)}?media=diff`,
          {
            credentials: "include",
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          }
        );
        if (!response.ok) {
          throw new Error(`GitHub diff failed (${response.status})`);
        }
        const text = await response.text();
        // Cap at ~2 MB so a runaway commit can't blow up the browser tab.
        const capped =
          text.length > 2_000_000
            ? `${text.slice(0, 2_000_000)}\n\n…diff truncated; open on GitHub for the full patch`
            : text;
        setFullDiffBySha((current) => ({ ...current, [sha]: capped }));
      } catch (err) {
        setErrorFullDiffBySha((current) => ({
          ...current,
          [sha]:
            err instanceof Error ? err.message : "Could not load full diff",
        }));
      } finally {
        setLoadingFullDiffShas((current) => {
          const next = new Set(current);
          next.delete(sha);
          return next;
        });
      }
    },
    [API_BASE, fullDiffBySha]
  );

  return {
    expandedShas,
    detailBySha,
    loadingShas,
    errorBySha,
    fullDiffBySha,
    loadingFullDiffShas,
    errorFullDiffBySha,
    collapsedFiles,
    toggle,
    reload,
    toggleFile,
    collapseFiles,
    loadFullDiff,
  };
}
