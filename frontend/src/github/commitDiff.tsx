import { Fragment } from "react";
import type { CommitDiffs } from "./commitDiffData";
import "./githubRepo.css";

// Commit-diff rendering, extracted from GitHubRepo.tsx so both the Code Repo
// viewer and the Projects → Recent activity list render identical diffs. The
// data layer (fetching, caching, expand/collapse) lives in `commitDiffData.ts`.

export function ChevronIcon() {
  return (
    <svg
      className="github-chevron"
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
    >
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M6 3l5 5-5 5"
      />
    </svg>
  );
}

// Split (side-by-side) diff rendering. Within a change block, consecutive
// removals pair row-for-row with the additions that follow; overhang gets an
// empty cell opposite. GitHub's `files[].patch` is pure hunk content (no
// `diff --git`/`---`/`+++` headers), so a leading `-`/`+` is always content.
type SplitCell = {
  no: number | null;
  text: string;
  kind: "add" | "del" | "ctx" | "empty";
};
type SplitRow =
  | { type: "hunk"; text: string }
  | { type: "pair"; left: SplitCell; right: SplitCell };

const EMPTY_CELL: SplitCell = { no: null, text: "", kind: "empty" };

function toSplitRows(patch: string): SplitRow[] {
  const rows: SplitRow[] = [];
  let oldLn = 0;
  let newLn = 0;
  let dels: SplitCell[] = [];
  let adds: SplitCell[] = [];

  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      rows.push({
        type: "pair",
        left: dels[i] ?? EMPTY_CELL,
        right: adds[i] ?? EMPTY_CELL,
      });
    }
    dels = [];
    adds = [];
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      flush();
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) {
        oldLn = Number(m[1]);
        newLn = Number(m[2]);
      }
      rows.push({ type: "hunk", text: line });
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" is an annotation, not content.
      continue;
    } else if (line.startsWith("+")) {
      adds.push({ no: newLn++, text: line.slice(1), kind: "add" });
    } else if (line.startsWith("-")) {
      dels.push({ no: oldLn++, text: line.slice(1), kind: "del" });
    } else {
      // Context line: flush the pending change block first so removals and
      // additions stay grouped.
      flush();
      const text = line.startsWith(" ") ? line.slice(1) : line;
      rows.push({
        type: "pair",
        left: { no: oldLn++, text, kind: "ctx" },
        right: { no: newLn++, text, kind: "ctx" },
      });
    }
  }
  flush();
  return rows;
}

export function CommitSplitPatch({ patch }: { patch: string }) {
  const rows = toSplitRows(patch);
  return (
    <div className="github-split">
      {rows.map((row, idx) =>
        row.type === "hunk" ? (
          <div key={idx} className="github-split-hunk">
            {row.text}
          </div>
        ) : (
          <Fragment key={idx}>
            <span className="github-split-no">{row.left.no ?? ""}</span>
            <span className={`github-split-code is-${row.left.kind}`}>
              {row.left.text || " "}
            </span>
            <span className="github-split-no">{row.right.no ?? ""}</span>
            <span className={`github-split-code is-${row.right.kind}`}>
              {row.right.text || " "}
            </span>
          </Fragment>
        )
      )}
    </div>
  );
}

// Renders the `?media=diff` fallback payload.
export function RawUnifiedDiff({ text }: { text: string }) {
  return (
    <pre className="github-commit-patch is-full">
      {text.split("\n").map((line, idx) => {
        let cls = "diff-ctx";
        if (line.startsWith("diff --git")) cls = "diff-file";
        else if (line.startsWith("@@")) cls = "diff-hunk";
        else if (line.startsWith("+++") || line.startsWith("---"))
          cls = "diff-file-marker";
        else if (line.startsWith("+")) cls = "diff-add";
        else if (line.startsWith("-")) cls = "diff-del";
        return (
          <span key={idx} className={`github-commit-patch-line ${cls}`}>
            {line || " "}
          </span>
        );
      })}
    </pre>
  );
}

// The expanded panel for one commit: per-file collapsible diffs plus the
// `?media=diff` full-diff fallback. Returns a fragment (no wrapper) so the
// caller can place it inside its own container and append extra content (the
// Code Repo viewer appends a comments thread below it).
export function CommitDiffBody({
  sha,
  diffs,
}: {
  sha: string;
  diffs: CommitDiffs;
}) {
  const isLoading = diffs.loadingShas.has(sha);
  const errorText = diffs.errorBySha[sha];
  const detail = diffs.detailBySha[sha];

  return (
    <>
      {isLoading && <div className="github-empty">Loading changes…</div>}
      {errorText && <div className="github-banner">{errorText}</div>}
      {!isLoading && !errorText && !detail && (
        <div className="github-empty">
          Couldn't load this commit's changes.{" "}
          <button
            type="button"
            className="github-link-btn"
            onClick={() => diffs.reload(sha)}
          >
            Refresh
          </button>
        </div>
      )}
      {!isLoading && !errorText && detail && (
        <>
          {(detail.files ?? []).map((file) => {
            const fileKey = `${sha}::${file.filename}`;
            const fileOpen = !diffs.collapsedFiles.has(fileKey);
            return (
              <article
                key={file.filename}
                className={`github-commit-file status-${file.status} ${fileOpen ? "is-open" : "is-collapsed"}`}
              >
                <button
                  type="button"
                  className="github-commit-file-head"
                  onClick={() => diffs.toggleFile(fileKey)}
                  aria-expanded={fileOpen}
                >
                  <span
                    className={`github-tree-toggle ${fileOpen ? "open" : ""}`}
                    aria-hidden="true"
                  >
                    <ChevronIcon />
                  </span>
                  <span className="github-commit-file-name">
                    {file.previous_filename
                      ? `${file.previous_filename} → ${file.filename}`
                      : file.filename}
                  </span>
                  <span className="github-commit-file-meta">
                    <em className={`github-commit-status status-${file.status}`}>
                      {file.status}
                    </em>
                    <span className="github-commit-stat is-add">
                      +{file.additions}
                    </span>
                    <span className="github-commit-stat is-del">
                      −{file.deletions}
                    </span>
                  </span>
                </button>
                {fileOpen &&
                  (file.patch ? (
                    <CommitSplitPatch patch={file.patch} />
                  ) : (
                    <div className="github-commit-nopatch">
                      Binary file or diff not available — open on GitHub to view.
                    </div>
                  ))}
              </article>
            );
          })}
          {(detail.files ?? []).length === 0 && (
            <div className="github-empty">
              This commit has no file changes recorded.
            </div>
          )}

          {/* Fallback: when ANY file in the JSON detail has no patch (GitHub
              omits patches over ~300 KB), surface a button that fetches the raw
              unified diff through the proxy's `?media=diff` branch. Hidden once
              we've already loaded the raw diff for this SHA. */}
          {(() => {
            const hasMissingPatch = (detail.files ?? []).some(
              (file) =>
                !file.patch &&
                file.status !== "added" &&
                file.status !== "removed"
            );
            const rawDiff = diffs.fullDiffBySha[sha];
            const fullLoading = diffs.loadingFullDiffShas.has(sha);
            const fullError = diffs.errorFullDiffBySha[sha];
            if (!hasMissingPatch && !rawDiff) return null;
            return (
              <div className="github-commit-fulldiff">
                {!rawDiff && (
                  <button
                    type="button"
                    className="github-commit-fulldiff-btn"
                    onClick={() => diffs.loadFullDiff(sha)}
                    disabled={fullLoading}
                  >
                    {fullLoading ? "Loading full diff…" : "Load full diff"}
                  </button>
                )}
                {fullError && <div className="github-banner">{fullError}</div>}
                {rawDiff && <RawUnifiedDiff text={rawDiff} />}
              </div>
            );
          })()}
        </>
      )}
    </>
  );
}
