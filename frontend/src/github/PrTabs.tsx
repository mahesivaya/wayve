// The row of tabs at the top of a merge request, so each part of it is one
// click away rather than somewhere down a long page.
import { PR_TABS, type PrTab } from "./prTabList";

const LABELS: Record<PrTab, string> = {
  overview: "Overview",
  commits: "Commits",
  pipelines: "Pipelines",
  changes: "Changes",
};

export function PrTabs({
  active,
  counts,
  onChange,
}: {
  active: PrTab;
  // Null where the number isn't known (checks GitHub didn't return).
  counts: Record<PrTab, number | null>;
  onChange: (tab: PrTab) => void;
}) {
  return (
    <div className="pr-tabs" role="tablist" aria-label="Merge request sections">
      {PR_TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          id={`pr-tab-${tab}`}
          aria-selected={tab === active}
          className={`pr-tab${tab === active ? " is-active" : ""}`}
          onClick={() => onChange(tab)}
        >
          {LABELS[tab]}
          <span className="pr-tab-count">{counts[tab] ?? "-"}</span>
        </button>
      ))}
    </div>
  );
}
