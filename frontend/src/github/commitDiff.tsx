import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { CommitDiffs } from "./commitDiffData";
import { DEFAULT_DIFF_PREFS, type DiffPrefs } from "./diffPrefs";
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

// Patch parsing. GitHub's `files[].patch` is pure hunk content (no
// `diff --git`/`---`/`+++` headers), so a leading `-`/`+` is always content.
// A patch becomes hunk headers, context lines, and change blocks (the run of
// removals and the additions that follow them); both layouts render from that.
type DiffLine = { no: number; text: string };
type PatchItem =
  | { type: "hunk"; text: string }
  | { type: "ctx"; old: DiffLine; new: DiffLine }
  | { type: "change"; dels: DiffLine[]; adds: DiffLine[] };

function parsePatch(patch: string): PatchItem[] {
  const items: PatchItem[] = [];
  let oldLn = 0;
  let newLn = 0;
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];

  const flush = () => {
    if (dels.length || adds.length) items.push({ type: "change", dels, adds });
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
      items.push({ type: "hunk", text: line });
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" is an annotation, not content.
      continue;
    } else if (line.startsWith("+")) {
      adds.push({ no: newLn++, text: line.slice(1) });
    } else if (line.startsWith("-")) {
      dels.push({ no: oldLn++, text: line.slice(1) });
    } else {
      // Context line: flush the pending change block first so removals and
      // additions stay grouped.
      flush();
      const text = line.startsWith(" ") ? line.slice(1) : line;
      items.push({
        type: "ctx",
        old: { no: oldLn++, text },
        new: { no: newLn++, text },
      });
    }
  }
  flush();
  return items;
}

const squash = (text: string) => text.replace(/\s+/g, "");

// Hide whitespace, like `git diff -w`: within a change block, a removal and the
// addition paired with it that differ only in whitespace become a context line
// (shown as the new text), splitting the block around it.
function ignoreWhitespace(items: PatchItem[]): PatchItem[] {
  const out: PatchItem[] = [];
  for (const item of items) {
    if (item.type !== "change") {
      out.push(item);
      continue;
    }
    const { dels, adds } = item;
    let curDels: DiffLine[] = [];
    let curAdds: DiffLine[] = [];
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const del = dels[i];
      const add = adds[i];
      if (del && add && squash(del.text) === squash(add.text)) {
        if (curDels.length || curAdds.length)
          out.push({ type: "change", dels: curDels, adds: curAdds });
        curDels = [];
        curAdds = [];
        out.push({ type: "ctx", old: del, new: add });
      } else {
        if (del) curDels.push(del);
        if (add) curAdds.push(add);
      }
    }
    if (curDels.length || curAdds.length)
      out.push({ type: "change", dels: curDels, adds: curAdds });
  }
  return out;
}

// Split (side-by-side): within a change block, removals pair row-for-row with
// the additions; overhang gets an empty cell opposite.
type SplitCell = {
  no: number | null;
  text: string;
  kind: "add" | "del" | "ctx" | "empty";
};
type SplitRow =
  | { type: "hunk"; text: string }
  | { type: "pair"; left: SplitCell; right: SplitCell };

const EMPTY_CELL: SplitCell = { no: null, text: "", kind: "empty" };

function toSplitRows(items: PatchItem[]): SplitRow[] {
  const rows: SplitRow[] = [];
  for (const item of items) {
    if (item.type === "hunk") rows.push(item);
    else if (item.type === "ctx")
      rows.push({
        type: "pair",
        left: { ...item.old, kind: "ctx" },
        right: { ...item.new, kind: "ctx" },
      });
    else
      for (let i = 0; i < Math.max(item.dels.length, item.adds.length); i++) {
        const del = item.dels[i];
        const add = item.adds[i];
        rows.push({
          type: "pair",
          left: del ? { ...del, kind: "del" } : EMPTY_CELL,
          right: add ? { ...add, kind: "add" } : EMPTY_CELL,
        });
      }
  }
  return rows;
}

// Unified: one column, removals then additions, with old and new line numbers.
type UnifiedRow =
  | { type: "hunk"; text: string }
  | {
      type: "line";
      oldNo: number | null;
      newNo: number | null;
      text: string;
      kind: "add" | "del" | "ctx";
    };

function toUnifiedRows(items: PatchItem[]): UnifiedRow[] {
  const rows: UnifiedRow[] = [];
  for (const item of items) {
    if (item.type === "hunk") rows.push(item);
    else if (item.type === "ctx")
      rows.push({
        type: "line",
        oldNo: item.old.no,
        newNo: item.new.no,
        text: item.new.text,
        kind: "ctx",
      });
    else {
      for (const del of item.dels)
        rows.push({
          type: "line",
          oldNo: del.no,
          newNo: null,
          text: del.text,
          kind: "del",
        });
      for (const add of item.adds)
        rows.push({
          type: "line",
          oldNo: null,
          newNo: add.no,
          text: add.text,
          kind: "add",
        });
    }
  }
  return rows;
}

const MARK = { add: "+", del: "-", ctx: " " } as const;

// Wraps each case-insensitive occurrence of `query` in a <mark>.
function highlight(text: string, query: string): ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  let at = lower.indexOf(needle);
  while (at !== -1) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(
      <mark key={at} className="github-code-match">
        {text.slice(at, at + needle.length)}
      </mark>
    );
    from = at + needle.length;
    at = lower.indexOf(needle, from);
  }
  if (from === 0) return text;
  parts.push(text.slice(from));
  return parts;
}

export function CommitPatch({
  patch,
  prefs = DEFAULT_DIFF_PREFS,
  query = "",
}: {
  patch: string;
  prefs?: DiffPrefs;
  // Text to highlight in the code (the Commits "Search within code" box).
  query?: string;
}) {
  const parsed = parsePatch(patch);
  const items = prefs.hideWhitespace ? ignoreWhitespace(parsed) : parsed;
  const compact = prefs.compact ? " is-compact" : "";

  if (prefs.layout === "unified") {
    return (
      <div className={`github-unified${compact}`}>
        {toUnifiedRows(items).map((row, idx) =>
          row.type === "hunk" ? (
            <div key={idx} className="github-split-hunk">
              {row.text}
            </div>
          ) : (
            <Fragment key={idx}>
              <span className="github-split-no">{row.oldNo ?? ""}</span>
              <span className="github-split-no">{row.newNo ?? ""}</span>
              <span className={`github-split-code is-${row.kind}`}>
                {MARK[row.kind]} {highlight(row.text, query)}
              </span>
            </Fragment>
          )
        )}
      </div>
    );
  }

  return (
    <div className={`github-split${compact}`}>
      {toSplitRows(items).map((row, idx) =>
        row.type === "hunk" ? (
          <div key={idx} className="github-split-hunk">
            {row.text}
          </div>
        ) : (
          <Fragment key={idx}>
            <span className="github-split-no">{row.left.no ?? ""}</span>
            <span className={`github-split-code is-${row.left.kind}`}>
              {row.left.text ? highlight(row.left.text, query) : " "}
            </span>
            <span className="github-split-no">{row.right.no ?? ""}</span>
            <span className={`github-split-code is-${row.right.kind}`}>
              {row.right.text ? highlight(row.right.text, query) : " "}
            </span>
          </Fragment>
        )
      )}
    </div>
  );
}

export function CommitSplitPatch({ patch }: { patch: string }) {
  return <CommitPatch patch={patch} />;
}

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073-.159.059-.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z"
      />
    </svg>
  );
}

// Gear button + menu: Layout (Unified / Split), Hide whitespace, Compact line
// height. Each choice applies at once and the menu stays open, like GitHub's.
export function DiffSettingsMenu({
  prefs,
  onChange,
}: {
  prefs: DiffPrefs;
  onChange: (next: DiffPrefs) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const item = (label: string, checked: boolean, next: DiffPrefs) => (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      className="github-diff-menu-item"
      onClick={() => onChange(next)}
    >
      <span className="github-diff-menu-check" aria-hidden="true">
        {checked ? "✓" : ""}
      </span>
      {label}
    </button>
  );

  return (
    <span className="github-diff-settings" ref={rootRef}>
      <button
        type="button"
        className="github-diff-gear"
        aria-label="Diff settings"
        aria-haspopup="menu"
        aria-expanded={open}
        data-tooltip="Diff settings"
        onClick={() => setOpen((o) => !o)}
      >
        <GearIcon />
      </button>
      {open && (
        <div className="github-diff-menu" role="menu">
          <div className="github-diff-menu-label">Layout</div>
          {item("Unified", prefs.layout === "unified", {
            ...prefs,
            layout: "unified",
          })}
          {item("Split", prefs.layout === "split", {
            ...prefs,
            layout: "split",
          })}
          <div className="github-diff-menu-sep" />
          {item("Hide whitespace", prefs.hideWhitespace, {
            ...prefs,
            hideWhitespace: !prefs.hideWhitespace,
          })}
          {item("Compact line height", prefs.compact, {
            ...prefs,
            compact: !prefs.compact,
          })}
        </div>
      )}
    </span>
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
  prefs,
  query,
}: {
  sha: string;
  diffs: CommitDiffs;
  prefs?: DiffPrefs;
  query?: string;
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
                    <em
                      className={`github-commit-status status-${file.status}`}
                    >
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
                    <CommitPatch
                      patch={file.patch}
                      prefs={prefs}
                      query={query}
                    />
                  ) : (
                    <div className="github-commit-nopatch">
                      Binary file or diff not available — open on GitHub to
                      view.
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
