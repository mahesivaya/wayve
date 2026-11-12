import {
  approvalsLabel,
  checksLabel,
  mergeHeadline,
  summarizeApprovals,
  summarizeChecks,
  type CheckRun,
} from "./prMergeSummary";
import "./prMergeBox.css";

type Props = {
  pr: {
    state: string;
    merged?: boolean;
    mergeable?: boolean | null;
    mergeable_state?: string;
    html_url: string;
  };
  /** Null while the head commit's check runs are unavailable. */
  checkRuns: CheckRun[] | null;
  reviews: {
    user: { login: string } | null;
    state: string;
    submitted_at: string | null;
  }[];
  /** Conversation comments plus comments on lines of the diff. */
  commentCount: number;
};

type Segment = { key: string; weight: number; cls: string };

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

// GitHub's merge box: the headline (conflicts / ready / blocked …) and the
// Checks, Comments and Approvals bars, each linking to the PR on GitHub.
export default function PrMergeBox({
  pr,
  checkRuns,
  reviews,
  commentCount,
}: Props) {
  const checks = summarizeChecks(checkRuns ?? []);
  const approvals = summarizeApprovals(reviews);
  const headline = mergeHeadline(pr, checks);
  const checksText = checkRuns === null ? "Unavailable" : checksLabel(checks);
  const approvalsText = approvalsLabel(approvals);
  const commentsText =
    commentCount === 0
      ? "None"
      : `${commentCount} comment${commentCount === 1 ? "" : "s"}`;

  return (
    <section className="pr-merge-box" aria-label="Merge status">
      <div className={`pr-merge-head is-${headline.tone}`}>
        <span className="pr-merge-head-icon" aria-hidden="true">
          {headline.tone === "bad"
            ? "✕"
            : headline.tone === "ok" || headline.tone === "merged"
              ? "✓"
              : "•"}
        </span>
        <div>
          <div className="pr-merge-head-title">{headline.title}</div>
          <div className="pr-merge-head-detail">{headline.detail}</div>
        </div>
      </div>
      <div className="pr-merge-cells">
        <a
          className="pr-merge-cell"
          href={`${pr.html_url}/checks`}
          target="_blank"
          rel="noreferrer"
        >
          <div className="pr-merge-cell-head">
            <span className="pr-merge-cell-title">Checks</span>
            <span className="pr-merge-cell-sub">{checksText}</span>
          </div>
          <Bar
            label={`Checks: ${checksText}`}
            segments={[
              { key: "pass", weight: checks.passed, cls: "is-pass" },
              { key: "skip", weight: checks.skipped, cls: "is-skip" },
              { key: "pend", weight: checks.pending, cls: "is-pending" },
              { key: "fail", weight: checks.failing, cls: "is-fail" },
            ]}
          />
        </a>
        <a
          className="pr-merge-cell"
          href={pr.html_url}
          target="_blank"
          rel="noreferrer"
        >
          <div className="pr-merge-cell-head">
            <span className="pr-merge-cell-title">Comments</span>
            <span className="pr-merge-cell-sub">{commentsText}</span>
          </div>
          <Bar
            label={`Comments: ${commentsText}`}
            segments={[{ key: "c", weight: commentCount, cls: "is-comment" }]}
          />
        </a>
        <a
          className="pr-merge-cell"
          href={`${pr.html_url}/files`}
          target="_blank"
          rel="noreferrer"
        >
          <div className="pr-merge-cell-head">
            <span className="pr-merge-cell-title">Approvals</span>
            <span className="pr-merge-cell-sub">{approvalsText}</span>
          </div>
          <Bar
            label={`Approvals: ${approvalsText}`}
            segments={[
              {
                key: "ok",
                weight: approvals.approved.length,
                cls: "is-pass",
              },
              {
                key: "chg",
                weight: approvals.changesRequested.length,
                cls: "is-fail",
              },
            ]}
          />
        </a>
      </div>
    </section>
  );
}
