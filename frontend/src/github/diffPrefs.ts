import { useState } from "react";

// How a diff is drawn, chosen from the gear beside the Commits header and
// remembered per browser.
export type DiffPrefs = {
  layout: "split" | "unified";
  hideWhitespace: boolean;
  compact: boolean;
};

export const DEFAULT_DIFF_PREFS: DiffPrefs = {
  layout: "split",
  hideWhitespace: false,
  compact: false,
};

const DIFF_PREFS_KEY = "rwayve.github.diffPrefs.v1";

export function useDiffPrefs(): [DiffPrefs, (next: DiffPrefs) => void] {
  const [prefs, setPrefs] = useState<DiffPrefs>(() => {
    try {
      const raw = localStorage.getItem(DIFF_PREFS_KEY);
      if (raw) return { ...DEFAULT_DIFF_PREFS, ...JSON.parse(raw) };
    } catch {
      // Unreadable storage: fall back to the defaults.
    }
    return DEFAULT_DIFF_PREFS;
  });
  const save = (next: DiffPrefs) => {
    setPrefs(next);
    try {
      localStorage.setItem(DIFF_PREFS_KEY, JSON.stringify(next));
    } catch {
      // Not persisted; the choice still holds for this visit.
    }
  };
  return [prefs, save];
}
