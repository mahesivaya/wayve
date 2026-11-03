import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CloseCommentIcon, LineCommentIcon, SendCommentIcon } from "../icons";
import {
  canExpandFile,
  type CommitDiffs,
  type CommitFile,
  type IssueComment,
} from "./commitDiffData";
import { DEFAULT_DIFF_PREFS, type DiffPrefs } from "./diffPrefs";
import type { DraftStore } from "./openRepoSession";
import { FileTypeIcon } from "./FileTypeIcon";
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

// A diff header's file: its type icon, then the name with its folder muted after
// it. A rename keeps both full paths, since the folder may be what changed.
export function DiffFileName({
  filename,
  previousFilename,
}: {
  filename: string;
  previousFilename?: string | null;
}) {
  const slash = filename.lastIndexOf("/");
  return (
    <>
      <FileTypeIcon path={filename} />
      <span className="github-commit-file-name">
        {previousFilename ? (
          `${previousFilename} → ${filename}`
        ) : (
          <>
            {filename.slice(slash + 1)}
            {slash !== -1 && (
              <span className="github-commit-file-dir">
                {filename.slice(0, slash + 1)}
              </span>
            )}
          </>
        )}
      </span>
    </>
  );
}

// Patch parsing. GitHub's `files[].patch` is pure hunk content (no
// `diff --git`/`---`/`+++` headers), so a leading `-`/`+` is always content.
// A patch becomes hunk headers, context lines, and change blocks (the run of
// removals and the additions that follow them); both layouts render from that.
// `position` is GitHub's index of the line within this file's diff, which a commit
// comment anchors to. Lines revealed from the full file have none, and GitHub
// refuses comments outside the diff, so they can't be commented on.
type DiffLine = { no: number; text: string; position?: number };
type HunkItem = {
  type: "hunk";
  text: string;
  oldStart: number;
  newStart: number;
};
// Unchanged lines the patch left out. `hidden` is null for the end of the file
// until its text has loaded, because the patch doesn't say how long a file is.
type GapItem = {
  type: "gap";
  id: number;
  hidden: number | null;
  hasAbove: boolean;
  hasBelow: boolean;
};
type PatchItem =
  | HunkItem
  | GapItem
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

  // Every line after the first hunk header counts, later headers included.
  let position = -1;

  for (const line of patch.split("\n")) {
    position++;
    if (line.startsWith("@@")) {
      flush();
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) {
        oldLn = Number(m[1]);
        newLn = Number(m[2]);
      }
      items.push({
        type: "hunk",
        text: line,
        oldStart: oldLn,
        newStart: newLn,
      });
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" is an annotation, not content.
      continue;
    } else if (line.startsWith("+")) {
      adds.push({ no: newLn++, text: line.slice(1), position });
    } else if (line.startsWith("-")) {
      dels.push({ no: oldLn++, text: line.slice(1), position });
    } else {
      // Context line: flush the pending change block first so removals and
      // additions stay grouped.
      flush();
      const text = line.startsWith(" ") ? line.slice(1) : line;
      items.push({
        type: "ctx",
        old: { no: oldLn++, text, position },
        new: { no: newLn++, text, position },
      });
    }
  }
  flush();
  return items;
}

// Lines revealed from each edge of a gap, keyed by gap id.
type GapReveals = Record<number, { top: number; bottom: number }>;

// GitHub's patches carry 3 lines of context, so a last hunk ending in fewer has
// reached the end of the file and nothing is left to reveal below it.
const PATCH_CONTEXT = 3;

function endsBeforeEof(items: PatchItem[]): boolean {
  let trailingCtx = 0;
  for (let i = items.length - 1; i >= 0 && items[i].type === "ctx"; i--) {
    trailingCtx++;
  }
  return trailingCtx >= PATCH_CONTEXT;
}

// Puts a gap row wherever the patch skipped lines, and the lines already revealed
// from `lines` (the file's new side) on either side of it. A fully revealed gap
// disappears along with its hunk header, leaving one continuous run of code.
function withGaps(
  items: PatchItem[],
  lines: string[] | null,
  reveals: GapReveals
): PatchItem[] {
  const out: PatchItem[] = [];
  let nextNew = 1;
  let oldOffset = 0;
  let nextGapId = 0;

  const pushLines = (from: number, count: number) => {
    for (let no = from; no < from + count; no++) {
      const text = lines?.[no - 1] ?? "";
      out.push({
        type: "ctx",
        old: { no: no + oldOffset, text },
        new: { no, text },
      });
    }
  };

  for (const item of items) {
    if (item.type === "hunk") {
      const id = nextGapId++;
      const total = item.newStart - nextNew;
      oldOffset = item.oldStart - item.newStart;
      if (total <= 0) {
        out.push(item);
      } else {
        const reveal = reveals[id] ?? { top: 0, bottom: 0 };
        const top = Math.min(reveal.top, total);
        const bottom = Math.min(reveal.bottom, total - top);
        const hidden = total - top - bottom;
        pushLines(nextNew, top);
        if (hidden > 0) {
          out.push({
            type: "gap",
            id,
            hidden,
            hasAbove: id > 0,
            hasBelow: true,
          });
        }
        pushLines(item.newStart - bottom, bottom);
      }
      nextNew = item.newStart;
    } else {
      out.push(item);
      if (item.type === "ctx") {
        nextNew = item.new.no + 1;
      } else if (item.type === "change") {
        nextNew += item.adds.length;
        oldOffset += item.dels.length - item.adds.length;
      }
    }
  }

  const gapEnd = {
    type: "gap",
    id: nextGapId,
    hasAbove: true,
    hasBelow: false,
  } as const;
  if (!lines) {
    if (endsBeforeEof(items)) out.push({ ...gapEnd, hidden: null });
  } else {
    const total = lines.length - nextNew + 1;
    const top = Math.min(reveals[nextGapId]?.top ?? 0, Math.max(total, 0));
    pushLines(nextNew, top);
    if (total - top > 0) out.push({ ...gapEnd, hidden: total - top });
  }
  return out;
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

// A line someone can comment on, in both of the forms GitHub takes: a commit
// comment anchors by `position`, a pull request comment by `side` and `line`.
export type LineAnchor = {
  side: "LEFT" | "RIGHT";
  line: number;
  position: number;
};

// What a diff needs to take comments: the caller owns the data and posting.
export type LineComments = {
  comments: IssueComment[];
  post: (anchor: LineAnchor, body: string) => Promise<void>;
  renderComment: (comment: IssueComment) => ReactNode;
  // Keeps a half-written comment when the page is left. One per file's diff, as
  // only one box is open in it at a time.
  draft?: DraftStore;
};

const anchorOf = (
  side: LineAnchor["side"],
  line: number | null,
  position: number | undefined
): LineAnchor | null =>
  line === null || position === undefined ? null : { side, line, position };

const anchorsOf = (...anchors: (LineAnchor | null)[]) =>
  anchors.filter((a): a is LineAnchor => a !== null);

const sameLine = (a: LineAnchor, b: LineAnchor) =>
  a.side === b.side && a.line === b.line;

const isCommentOn = (comment: IssueComment, anchor: LineAnchor) =>
  comment.side
    ? comment.side === anchor.side && comment.line === anchor.line
    : comment.position === anchor.position;

// Split (side-by-side): within a change block, removals pair row-for-row with
// the additions; overhang gets an empty cell opposite.
type SplitCell = {
  no: number | null;
  text: string;
  kind: "add" | "del" | "ctx" | "empty";
  position?: number;
};
type SplitRow =
  HunkItem | GapItem | { type: "pair"; left: SplitCell; right: SplitCell };

const EMPTY_CELL: SplitCell = { no: null, text: "", kind: "empty" };

function toSplitRows(items: PatchItem[]): SplitRow[] {
  const rows: SplitRow[] = [];
  for (const item of items) {
    if (item.type === "hunk" || item.type === "gap") rows.push(item);
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

// Unified: one column, removals then additions, numbered by the new file. A
// removal has no line there, so its gutter shows a minus instead.
type UnifiedRow =
  | HunkItem
  | GapItem
  | {
      type: "line";
      oldNo: number | null;
      newNo: number | null;
      text: string;
      kind: "add" | "del" | "ctx";
      anchors: LineAnchor[];
    };

function toUnifiedRows(items: PatchItem[]): UnifiedRow[] {
  const rows: UnifiedRow[] = [];
  for (const item of items) {
    if (item.type === "hunk" || item.type === "gap") rows.push(item);
    else if (item.type === "ctx")
      rows.push({
        type: "line",
        oldNo: item.old.no,
        newNo: item.new.no,
        text: item.new.text,
        kind: "ctx",
        anchors: anchorsOf(
          anchorOf("LEFT", item.old.no, item.old.position),
          anchorOf("RIGHT", item.new.no, item.new.position)
        ),
      });
    else {
      for (const del of item.dels)
        rows.push({
          type: "line",
          oldNo: del.no,
          newNo: null,
          text: del.text,
          kind: "del",
          anchors: anchorsOf(anchorOf("LEFT", del.no, del.position)),
        });
      for (const add of item.adds)
        rows.push({
          type: "line",
          oldNo: null,
          newNo: add.no,
          text: add.text,
          kind: "add",
          anchors: anchorsOf(anchorOf("RIGHT", add.no, add.position)),
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

const GAP_STEP = 20;

function GapArrowIcon({ direction }: { direction: "up" | "down" }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 2.5h10M8 13.5V6M4.5 9.5 8 6l3.5 3.5"
        transform={direction === "down" ? "rotate(180 8 8)" : undefined}
      />
    </svg>
  );
}

function GapAllIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8 2v12M5 5l3-3 3 3M5 11l3 3 3-3"
      />
    </svg>
  );
}

// The divider standing in for a gap: arrows in the gutter reveal GAP_STEP lines
// from either edge, and the centred count reveals all of them.
function GapRow({
  gap,
  busy,
  error,
  onReveal,
}: {
  gap: GapItem;
  busy: boolean;
  error: string;
  onReveal: (gap: GapItem, edge: "top" | "bottom", count: number) => void;
}) {
  const { hidden } = gap;
  const stepWouldFinish = hidden !== null && hidden <= GAP_STEP;
  const reveal = (
    edge: "top" | "bottom",
    count: number,
    label: string,
    icon: ReactNode
  ) => (
    <button
      type="button"
      className="github-diff-gap-btn"
      aria-label={label}
      title={label}
      disabled={busy}
      onClick={() => onReveal(gap, edge, count)}
    >
      {icon}
    </button>
  );

  return (
    <div className="github-split-hunk github-diff-gap">
      {!stepWouldFinish && (
        <span className="github-diff-gap-arrows">
          {gap.hasBelow &&
            reveal(
              "bottom",
              GAP_STEP,
              `Show ${GAP_STEP} lines above`,
              <GapArrowIcon direction="up" />
            )}
          {gap.hasAbove &&
            reveal(
              "top",
              GAP_STEP,
              `Show ${GAP_STEP} lines below`,
              <GapArrowIcon direction="down" />
            )}
        </span>
      )}
      <button
        type="button"
        className="github-diff-gap-all"
        title="Show these lines"
        disabled={busy}
        onClick={() => onReveal(gap, gap.hasBelow ? "bottom" : "top", Infinity)}
      >
        <GapAllIcon />
        {hidden === null
          ? "Show the rest of the file"
          : `${hidden.toLocaleString()} unchanged ${hidden === 1 ? "line" : "lines"}`}
      </button>
      {error && (
        <span className="github-diff-gap-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

// The box opened under a line, or over a comment being edited (`initial`). Enter
// posts and Shift+Enter starts a new line. The draft is kept if posting fails.
export function LineCommentComposer({
  initial = "",
  onDraft,
  onPost,
  onClose,
}: {
  initial?: string;
  // Called with the text as it's typed, so it can outlive the page.
  onDraft?: (body: string) => void;
  onPost: (body: string) => Promise<void>;
  onClose: () => void;
}) {
  const [body, setBody] = useState(initial);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    const text = body.trim();
    if (!text || posting) return;
    setPosting(true);
    setError("");
    try {
      await onPost(text);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't post the comment."
      );
      setPosting(false);
    }
  };

  return (
    <div className="github-line-composer">
      <textarea
        className="github-line-composer-input"
        placeholder="Leave a code comment…"
        aria-label="Leave a code comment"
        value={body}
        rows={2}
        autoFocus
        disabled={posting}
        onFocus={(e) =>
          e.currentTarget.setSelectionRange(
            e.currentTarget.value.length,
            e.currentTarget.value.length
          )
        }
        onChange={(e) => {
          setBody(e.target.value);
          onDraft?.(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          // isComposing: Enter there picks an IME candidate, it isn't a send.
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <button
        type="button"
        className="github-line-composer-close"
        aria-label="Close comment"
        title="Close"
        onClick={onClose}
      >
        <CloseCommentIcon size={16} />
      </button>
      <div className="github-line-composer-foot">
        {error ? (
          <span className="github-diff-gap-error" role="alert">
            {error}
          </span>
        ) : (
          <span className="github-commit-composer-note">
            Posts to GitHub as the connected account
          </span>
        )}
        <button
          type="button"
          className="github-line-composer-send"
          aria-label="Post comment"
          title="Post comment (Enter)"
          disabled={posting || !body.trim()}
          onClick={() => void submit()}
        >
          <SendCommentIcon size={16} />
        </button>
      </div>
    </div>
  );
}

export function CommitPatch({
  patch,
  prefs = DEFAULT_DIFF_PREFS,
  query = "",
  loadLines,
  lineComments,
}: {
  patch: string;
  prefs?: DiffPrefs;
  // Text to highlight in the code (the Commits "Search within code" box).
  query?: string;
  // Fetches the file's new side. Without it, hunks stay plain headers and there
  // is nothing to expand.
  loadLines?: () => Promise<string[]>;
  // Without it, lines have no comment button and show no threads.
  lineComments?: LineComments;
}) {
  const draft = lineComments?.draft;
  // A comment left half-written reopens on its line.
  const [commentingOn, setCommentingOn] = useState<LineAnchor | null>(
    () => draft?.read()?.anchor ?? null
  );
  const [lines, setLines] = useState<string[] | null>(null);
  const [reveals, setReveals] = useState<GapReveals>({});
  const [loadingLines, setLoadingLines] = useState(false);
  const [linesError, setLinesError] = useState("");

  const revealGap = async (
    gap: GapItem,
    edge: "top" | "bottom",
    count: number
  ) => {
    if (!loadLines) return;
    if (!lines) {
      setLoadingLines(true);
      setLinesError("");
      try {
        setLines(await loadLines());
      } catch (err) {
        setLinesError(
          err instanceof Error ? err.message : "Could not load this file"
        );
        return;
      } finally {
        setLoadingLines(false);
      }
    }
    setReveals((current) => {
      const reveal = current[gap.id] ?? { top: 0, bottom: 0 };
      return {
        ...current,
        [gap.id]: { ...reveal, [edge]: reveal[edge] + count },
      };
    });
  };

  const parsed = parsePatch(patch);
  const expanded = loadLines ? withGaps(parsed, lines, reveals) : parsed;
  const items = prefs.hideWhitespace ? ignoreWhitespace(expanded) : expanded;
  const compact = prefs.compact ? " is-compact" : "";

  const gapRow = (key: number, gap: GapItem) => (
    <GapRow
      key={key}
      gap={gap}
      busy={loadingLines}
      error={linesError}
      onReveal={(g, edge, count) => void revealGap(g, edge, count)}
    />
  );

  // A line number, with the comment button that shows when its side is hovered.
  const gutter = (no: ReactNode, anchor: LineAnchor | null | undefined) => (
    <span className="github-split-no">
      {no}
      {lineComments && anchor && (
        <button
          type="button"
          className="github-line-comment-btn"
          aria-label={`Comment on line ${anchor.line}`}
          title="Add a comment"
          onClick={() => {
            // The box moves here, leaving the text it held behind.
            if (commentingOn && !sameLine(commentingOn, anchor)) draft?.clear();
            setCommentingOn(anchor);
          }}
        >
          <LineCommentIcon size={13} />
        </button>
      )}
    </span>
  );

  // The comments on a row, and the composer if it was opened on this row.
  const rowComments = (anchors: LineAnchor[]) => {
    if (!lineComments) return null;
    const thread = lineComments.comments.filter((c) =>
      anchors.some((anchor) => isCommentOn(c, anchor))
    );
    const open = commentingOn;
    const composing =
      open !== null && anchors.some((anchor) => sameLine(anchor, open));
    if (thread.length === 0 && !composing) return null;
    return (
      <div className="github-line-thread">
        {thread.length > 0 && (
          <ul className="github-pr-thread">
            {thread.map((comment) => (
              <Fragment key={comment.id}>
                {lineComments.renderComment(comment)}
              </Fragment>
            ))}
          </ul>
        )}
        {composing && (
          <LineCommentComposer
            initial={draft?.read()?.body ?? ""}
            onDraft={(body) => draft?.save({ body, anchor: open })}
            onClose={() => {
              draft?.clear();
              setCommentingOn(null);
            }}
            onPost={async (body) => {
              await lineComments.post(open, body);
              draft?.clear();
              setCommentingOn(null);
            }}
          />
        )}
      </div>
    );
  };

  if (prefs.layout === "unified") {
    return (
      <div className={`github-unified${compact}`}>
        {toUnifiedRows(items).map((row, idx) =>
          row.type === "gap" ? (
            gapRow(idx, row)
          ) : row.type === "hunk" ? (
            <div key={idx} className="github-split-hunk">
              {row.text}
            </div>
          ) : (
            <Fragment key={idx}>
              <div className="github-diff-side">
                {gutter(row.newNo ?? "−", row.anchors[row.anchors.length - 1])}
                <span className={`github-split-code is-${row.kind}`}>
                  {MARK[row.kind]} {highlight(row.text, query)}
                </span>
              </div>
              {rowComments(row.anchors)}
            </Fragment>
          )
        )}
      </div>
    );
  }

  return (
    <div className={`github-split${compact}`}>
      {toSplitRows(items).map((row, idx) => {
        if (row.type === "gap") return gapRow(idx, row);
        if (row.type === "hunk") {
          return (
            <div key={idx} className="github-split-hunk">
              {row.text}
            </div>
          );
        }
        const left = anchorOf("LEFT", row.left.no, row.left.position);
        const right = anchorOf("RIGHT", row.right.no, row.right.position);
        return (
          <Fragment key={idx}>
            <div className="github-diff-side">
              {gutter(row.left.no ?? "", left)}
              <span className={`github-split-code is-${row.left.kind}`}>
                {row.left.text ? highlight(row.left.text, query) : " "}
              </span>
            </div>
            <div className="github-diff-side">
              {gutter(row.right.no ?? "", right)}
              <span className={`github-split-code is-${row.right.kind}`}>
                {row.right.text ? highlight(row.right.text, query) : " "}
              </span>
            </div>
            {rowComments(anchorsOf(left, right))}
          </Fragment>
        );
      })}
    </div>
  );
}

export function CommitSplitPatch({
  patch,
  loadLines,
  lineComments,
}: {
  patch: string;
  loadLines?: () => Promise<string[]>;
  lineComments?: LineComments;
}) {
  return (
    <CommitPatch
      patch={patch}
      loadLines={loadLines}
      lineComments={lineComments}
    />
  );
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
  lineComments,
}: {
  sha: string;
  diffs: CommitDiffs;
  prefs?: DiffPrefs;
  query?: string;
  lineComments?: (file: CommitFile) => LineComments;
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
                  <DiffFileName
                    filename={file.filename}
                    previousFilename={file.previous_filename}
                  />
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
                      key={fileKey}
                      patch={file.patch}
                      prefs={prefs}
                      query={query}
                      loadLines={
                        canExpandFile(file.status)
                          ? () => diffs.loadFileLines(sha, file.filename)
                          : undefined
                      }
                      lineComments={lineComments?.(file)}
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
