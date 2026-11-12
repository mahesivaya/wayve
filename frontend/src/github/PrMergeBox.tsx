import { useState } from "react";
import Modal from "../components/Modal";
import {
  approvalsLabel,
  checkDuration,
  checkOutcome,
  checksLabel,
  latestVerdicts,
  sortChecks,
  summarizeApprovals,
  summarizeChecks,
  type CheckRun,
} from "./prMergeSummary";
import "./prMergeBox.css";

type Review = {
  user: { login: string } | null;
  state: string;
  submitted_at: string | null;
  html_url?: string;
};

type Comment = {
  id: number;
  user: { login: string } | null;
  body: string | null;
  created_at: string;
  html_url?: string;
  path?: string | null;
};

type Props = {
  pr: { html_url: string };
  /** Null while the head commit's check runs are unavailable. */
  checkRuns: CheckRun[] | null;
  reviews: Review[];
  /** Conversation comments plus comments on lines of the diff. */
  comments: Comment[];
};

type Segment = { key: string; weight: number; cls: string };

/** One row of a cell's hover list. */
type ListItem = {
  key: string;
  icon: string;
  iconCls: string;
  primary: string;
  secondary?: string;
  meta?: string | null;
  url?: string | null;
};

/** What the redirect pop-up names, e.g. "the check 2 · Rust deps". */
type Target = { what: string; url: string };

function Bar({ segments, label }: { segments: Segment[]; label: string }) {
  const shown = segments.filter((s) => s.weight > 0);
  return (
    <div className="pr-merge-bar" role="img" aria-label={label}>
      {shown.length === 0 ? (
        <span className="pr-merge-bar-empty" />
      ) : (
        shown.map((s) => (
          <span
            key={s.key}
            className={`pr-merge-bar-seg ${s.cls}`}
            style={{ flexGrow: s.weight }}
          />
        ))
      )}
    </div>
  );
}

const OUTCOME_ICON = { pass: "✓", fail: "✕", pending: "●", skip: "⊘" };

function snippet(body: string | null): string {
  const text = (body ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "(no text)";
  return text.length > 90 ? `${text.slice(0, 90).trimEnd()}…` : text;
}

function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// GitHub's merge summary: Checks, Comments and Approvals bars. Hovering a cell
// lists what's behind it (nothing pops up when it's empty); clicking an entry
// asks Yes/No before opening it on GitHub.
export default function PrMergeBox({ checkRuns, reviews, comments }: Props) {
  const [target, setTarget] = useState<Target | null>(null);

  const checks = summarizeChecks(checkRuns ?? []);
  const approvals = summarizeApprovals(reviews);
  const checksText = checkRuns === null ? "Unavailable" : checksLabel(checks);
  const approvalsText = approvalsLabel(approvals);
  const commentsText =
    comments.length === 0
      ? "None"
      : `${comments.length} comment${comments.length === 1 ? "" : "s"}`;

  const checkItems: ListItem[] = sortChecks(checkRuns ?? []).map((run) => {
    const outcome = checkOutcome(run);
    return {
      key: `check-${run.id}`,
      icon: OUTCOME_ICON[outcome],
      iconCls: `is-${outcome}`,
      primary: run.name,
      meta: checkDuration(run),
      url: run.html_url,
    };
  });

  const commentItems: ListItem[] = [...comments]
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .map((c) => ({
      key: `comment-${c.id}`,
      icon: "“",
      iconCls: "is-comment",
      primary: c.user?.login ?? "unknown",
      secondary: c.path ? `${c.path}: ${snippet(c.body)}` : snippet(c.body),
      meta: shortDate(c.created_at),
      url: c.html_url,
    }));

  const approvalItems: ListItem[] = latestVerdicts(reviews).map((v) => ({
    key: `review-${v.login}`,
    icon: v.state === "APPROVED" ? "✓" : "✕",
    iconCls: v.state === "APPROVED" ? "is-pass" : "is-fail",
    primary: v.login,
    secondary: v.state === "APPROVED" ? "Approved" : "Requested changes",
    meta: shortDate(v.submitted_at),
    url: v.html_url,
  }));

  const pick = (what: string) => (item: ListItem) => {
    if (item.url) setTarget({ what, url: item.url });
  };

  const openTarget = () => {
    if (target) window.open(target.url, "_blank", "noopener");
    setTarget(null);
  };

  return (
    <section className="pr-merge-box" aria-label="Merge status">
      <div className="pr-merge-cells">
        <HoverListCell
          title="Checks"
          sub={checksText}
          items={checkItems}
          noun="check"
          onPick={(item) => pick(`the check ${item.primary}`)(item)}
          segments={[
            { key: "pass", weight: checks.passed, cls: "is-pass" },
            { key: "skip", weight: checks.skipped, cls: "is-skip" },
            { key: "pend", weight: checks.pending, cls: "is-pending" },
            { key: "fail", weight: checks.failing, cls: "is-fail" },
          ]}
        />
        <HoverListCell
          title="Comments"
          sub={commentsText}
          items={commentItems}
          noun="comment"
          onPick={(item) => pick(`${item.primary}'s comment`)(item)}
          segments={[{ key: "c", weight: comments.length, cls: "is-comment" }]}
        />
        <HoverListCell
          title="Approvals"
          sub={approvalsText}
          items={approvalItems}
          noun="review"
          onPick={(item) => pick(`${item.primary}'s review`)(item)}
          segments={[
            { key: "ok", weight: approvals.approved.length, cls: "is-pass" },
            {
              key: "chg",
              weight: approvals.changesRequested.length,
              cls: "is-fail",
            },
          ]}
        />
      </div>
      <Modal
        isOpen={target !== null}
        onClose={() => setTarget(null)}
        title="Open on GitHub?"
      >
        {target && (
          <div className="pr-checks-confirm">
            <p>
              Do you want to leave the app to view{" "}
              <strong>{target.what}</strong> on GitHub? It opens in a new tab.
            </p>
            <div className="pr-checks-confirm-actions">
              <button
                type="button"
                className="pr-checks-cancel"
                onClick={() => setTarget(null)}
              >
                No
              </button>
              <button
                type="button"
                className="pr-checks-open"
                onClick={openTarget}
                autoFocus
              >
                Yes
              </button>
            </div>
          </div>
        )}
      </Modal>
    </section>
  );
}

function HoverListCell({
  title,
  sub,
  items,
  noun,
  segments,
  onPick,
}: {
  title: string;
  sub: string;
  items: ListItem[];
  /** Singular label for the list header: "3 checks", "1 comment". */
  noun: string;
  segments: Segment[];
  onPick: (item: ListItem) => void;
}) {
  const hasItems = items.length > 0;
  return (
    <div
      className={`pr-merge-cell${hasItems ? " has-list" : ""}`}
      tabIndex={hasItems ? 0 : undefined}
    >
      <div className="pr-merge-cell-head">
        <span className="pr-merge-cell-title">{title}</span>
        <span className="pr-merge-cell-sub">{sub}</span>
      </div>
      <Bar label={`${title}: ${sub}`} segments={segments} />
      {hasItems && (
        <div className="pr-checks-pop" role="dialog" aria-label={title}>
          <div className="pr-checks-pop-head">
            {items.length} {noun}
            {items.length === 1 ? "" : "s"}
          </div>
          <ul className="pr-checks-list">
            {items.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  className="pr-checks-item"
                  disabled={!item.url}
                  onClick={() => onPick(item)}
                >
                  <span
                    className={`pr-checks-icon ${item.iconCls}`}
                    aria-hidden="true"
                  >
                    {item.icon}
                  </span>
                  <span className="pr-checks-text">
                    <span className="pr-checks-name">{item.primary}</span>
                    {item.secondary && (
                      <span className="pr-checks-secondary">
                        {item.secondary}
                      </span>
                    )}
                  </span>
                  {item.meta && (
                    <span className="pr-checks-time">{item.meta}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
