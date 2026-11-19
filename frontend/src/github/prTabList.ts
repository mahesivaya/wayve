// The tabs of a merge request, in the order they show (see PrTabs).
export const PR_TABS = ["overview", "commits", "pipelines", "changes"] as const;
export type PrTab = (typeof PR_TABS)[number];

export const isPrTab = (value: unknown): value is PrTab =>
  PR_TABS.includes(value as PrTab);
