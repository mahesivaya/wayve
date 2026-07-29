// The AI-fix review surface, shared by the Tickets board, the ticket detail page
// and the story detail page. It owns the whole post-dispatch flow: poll for CI's
// diff, show it, let the developer edit the proposed file contents, then drive
// Commit → Push → Create PR.
//
// Everything here is parameterised by an `AiFixApi`, so a board only has to say
// *which* collection it is; tickets and stories share this one implementation.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AiFixApi, AiFixFile, AiFixState } from "../api/aiFix";
import { decodeContent, diffLineClass, encodeContent } from "./diff";
import "./aiFix.css";

// Statuses where a reviewable change exists (as opposed to running/failed).
const REVIEWABLE = ["ready", "committed", "pushed", "pr_opened"] as const;

type Props = {
  itemId: number;
  api: AiFixApi;
  /// Whether this item's priority allows an AI fix. The button is hidden when
  /// false; the backend enforces the same rule.
  canFix: boolean;
  /// "ticket" | "story" — only used for wording.
  kind?: string;
  /// Notified after a step changes state, so a parent list can refresh.
  onChanged?: () => void;
};

export default function AiFixPanel({
  itemId,
  api,
  canFix,
  kind = "ticket",
  onChanged,
}: Props) {
  const [state, setState] = useState<AiFixState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [stepBusy, setStepBusy] = useState<"commit" | "push" | "pr" | null>(
    null
  );

  // Per-path edits the developer has made but not yet saved.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [savingEdits, setSavingEdits] = useState(false);
  const [loadError, setLoadError] = useState("");
  // The last status we rendered, so `load` can tell a fresh run from a poll.
  const seenStatus = useRef<AiFixState["status"]>(null);

  // The GET is manager-only, so for anyone who can't run the fixer it resolves
  // to null and no AI UI renders at all.
  const load = useCallback(async () => {
    if (!Number.isFinite(itemId)) return;
    try {
      const next = await api.getState(itemId);
      setLoadError("");
      // A new run replaces the change under review, so any half-typed edits
      // against the old one are stale. Tracked on a ref rather than inside the
      // setState updater, which must stay pure.
      if (seenStatus.current !== null && seenStatus.current !== next.status) {
        setEdits({});
        setOpenPath(null);
      }
      seenStatus.current = next.status;
      setState(next);
    } catch (err) {
      setState(null);
      // A failed read used to render as "no fix yet", which is
      // indistinguishable from a real empty state — the reviewed diff simply
      // never appeared and nothing said why.
      setLoadError(
        err instanceof Error ? err.message : "Couldn't load the AI fix state."
      );
    }
  }, [api, itemId]);

  // The load is deferred to a timeout so the effect body doesn't synchronously
  // call setState, which React 19 flags as a cascading-render risk.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // While CI is running, poll for the diff to land.
  useEffect(() => {
    if (state?.status !== "running") return;
    const timer = window.setInterval(() => void load(), 8000);
    return () => window.clearInterval(timer);
  }, [state?.status, load]);

  const start = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await api.start(itemId);
      setMsg(
        r.reused_fix_from
          ? `Fix started in CI (reusing the fix from #${r.reused_fix_from}). The diff will appear here to review.`
          : "Fix started in CI. The diff will appear here to review."
      );
      setState({
        status: "running",
        diff: null,
        files: [],
        commit_sha: null,
        branch: null,
        pr_url: null,
      });
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Couldn't start the AI fix.");
    } finally {
      setBusy(false);
    }
  };

  // Each GitHub step is gated on the prior one's status; this folds the returned
  // field + new status into local state so the row advances without a refetch.
  const runStep = async (
    step: "commit" | "push" | "pr",
    fn: () => Promise<Partial<AiFixState>>,
    nextStatus: AiFixState["status"],
    failMsg: string
  ) => {
    setStepBusy(step);
    setMsg("");
    try {
      const patch = await fn();
      setState((prev) =>
        prev ? { ...prev, ...patch, status: nextStatus } : prev
      );
      onChanged?.();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : failMsg);
    } finally {
      setStepBusy(null);
    }
  };

  const dirtyPaths = useMemo(
    () =>
      (state?.files ?? [])
        .filter((f) => !f.deleted && edits[f.path] !== undefined)
        .filter((f) => edits[f.path] !== decodeContent(f.content))
        .map((f) => f.path),
    [state?.files, edits]
  );

  const saveEdits = async () => {
    if (!state || dirtyPaths.length === 0) return;
    setSavingEdits(true);
    setMsg("");
    try {
      const files: AiFixFile[] = state.files.map((f) =>
        !f.deleted && edits[f.path] !== undefined
          ? { ...f, content: encodeContent(edits[f.path]) }
          : f
      );
      await api.saveEdits(itemId, files);
      setState((prev) => (prev ? { ...prev, files } : prev));
      setEdits({});
      setMsg("Edits saved — Commit will use your version.");
      onChanged?.();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Couldn't save your edits.");
    } finally {
      setSavingEdits(false);
    }
  };

  const status = state?.status ?? null;
  const showStart =
    canFix && (!status || status === "no_change" || status === "error");

  // Nothing to say: no run has ever happened, this item can't start one, and
  // the read didn't fail in a way worth reporting.
  if (!status && !showStart && !loadError) return null;

  const reviewable = REVIEWABLE.includes(
    status as (typeof REVIEWABLE)[number]
  );
  const order = reviewable
    ? { ready: 0, committed: 1, pushed: 2, pr_opened: 3 }[
        status as "ready" | "committed" | "pushed" | "pr_opened"
      ]
    : -1;
  // Once a commit object exists its content is fixed on GitHub, so editing is
  // only offered while the fix is still awaiting review.
  const editable = status === "ready";

  return (
    <section className="aifix" aria-label="AI fix">
      <div className="aifix-head">
        <h3 className="aifix-title">AI fix</h3>
        {showStart && (
          <button
            type="button"
            className="aifix-start"
            onClick={() => void start()}
            disabled={busy}
            data-tooltip={`Have Claude propose a fix in CI, then review the diff here`}
          >
            {busy
              ? "Starting…"
              : status === "no_change" || status === "error"
                ? "Retry AI fix"
                : "Fix with AI"}
          </button>
        )}
      </div>

      {loadError && (
        <p className="aifix-msg" role="status">
          Couldn’t load the AI fix for this item: {loadError}
        </p>
      )}

      {status === "running" && (
        <p className="aifix-muted">
          🤖 Claude is implementing and verifying a fix in CI. The diff will
          appear here for review when it’s ready — this can take a few minutes.
        </p>
      )}

      {status === "no_change" && (
        <p className="aifix-muted">
          🤖 Claude ran but proposed no code change — it couldn’t find a concrete
          fix for this {kind} in the codebase. Refine the description with the
          affected feature or file, the expected vs. actual behaviour, and steps
          to reproduce, then retry.
        </p>
      )}

      {status === "error" && (
        <p className="aifix-muted">
          The AI fix run didn’t complete — Claude may have run out of steps
          before finding a fix. Refine the description with the affected feature
          or file and steps to reproduce, then retry.
        </p>
      )}

      {reviewable && (
        <>
          <p className="aifix-muted">
            Review Claude’s proposed change — edit any file if you want to adjust
            it — then commit → push → create the pull request.
          </p>

          <pre className="aifix-diff">
            <code>
              {(state?.diff ?? "").split("\n").map((line, i) => (
                <span key={i} className={`aifix-line ${diffLineClass(line)}`}>
                  {line || " "}
                  {"\n"}
                </span>
              ))}
            </code>
          </pre>

          {(state?.files.length ?? 0) > 0 && (
            <div className="aifix-files">
              <div className="aifix-files-head">
                <span>
                  {state!.files.length} changed file
                  {state!.files.length === 1 ? "" : "s"}
                </span>
                {editable && dirtyPaths.length > 0 && (
                  <button
                    type="button"
                    className="aifix-save-edits"
                    onClick={() => void saveEdits()}
                    disabled={savingEdits}
                  >
                    {savingEdits
                      ? "Saving…"
                      : `Save ${dirtyPaths.length} edited file${
                          dirtyPaths.length === 1 ? "" : "s"
                        }`}
                  </button>
                )}
              </div>

              {state!.files.map((f) => {
                const open = openPath === f.path;
                const value = edits[f.path] ?? decodeContent(f.content);
                return (
                  <div className="aifix-file" key={f.path}>
                    <button
                      type="button"
                      className="aifix-file-toggle"
                      onClick={() => setOpenPath(open ? null : f.path)}
                      aria-expanded={open}
                    >
                      <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                      <code>{f.path}</code>
                      {f.deleted && (
                        <span className="aifix-file-tag">deleted</span>
                      )}
                      {dirtyPaths.includes(f.path) && (
                        <span className="aifix-file-tag is-edited">edited</span>
                      )}
                    </button>
                    {open && !f.deleted && (
                      <textarea
                        className="aifix-editor"
                        value={value}
                        readOnly={!editable}
                        spellCheck={false}
                        aria-label={`Contents of ${f.path}`}
                        onChange={(e) =>
                          setEdits((prev) => ({
                            ...prev,
                            [f.path]: e.target.value,
                          }))
                        }
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="aifix-steps">
            <button
              type="button"
              className="primary"
              onClick={() =>
                void runStep(
                  "commit",
                  async () => ({
                    commit_sha: (await api.commit(itemId)).commit_sha,
                  }),
                  "committed",
                  "Couldn't create the commit."
                )
              }
              disabled={stepBusy !== null || order >= 1}
            >
              {stepBusy === "commit"
                ? "Committing…"
                : order >= 1
                  ? "✓ Committed"
                  : "Commit"}
            </button>
            <span className="aifix-arrow" aria-hidden="true">
              →
            </span>
            <button
              type="button"
              className="primary"
              onClick={() =>
                void runStep(
                  "push",
                  async () => ({ branch: (await api.push(itemId)).branch }),
                  "pushed",
                  "Couldn't push the branch."
                )
              }
              disabled={stepBusy !== null || order < 1 || order >= 2}
            >
              {stepBusy === "push"
                ? "Pushing…"
                : order >= 2
                  ? "✓ Pushed"
                  : "Push"}
            </button>
            <span className="aifix-arrow" aria-hidden="true">
              →
            </span>
            <button
              type="button"
              className="primary"
              onClick={() =>
                void runStep(
                  "pr",
                  async () => ({ pr_url: (await api.openPr(itemId)).pr_url }),
                  "pr_opened",
                  "Couldn't open the pull request."
                )
              }
              disabled={stepBusy !== null || order < 2 || order >= 3}
            >
              {stepBusy === "pr"
                ? "Opening PR…"
                : order >= 3
                  ? "✓ PR opened"
                  : "Create PR"}
            </button>
          </div>

          {order >= 2 && state?.branch && (
            <p className="aifix-muted">
              Branch <code>{state.branch}</code>
              {state.commit_sha && <> at <code>{state.commit_sha.slice(0, 7)}</code></>}
            </p>
          )}
          {state?.pr_url && (
            <p className="aifix-muted">
              <a href={state.pr_url} target="_blank" rel="noreferrer">
                View pull request →
              </a>
            </p>
          )}
        </>
      )}

      {msg && (
        <p className="aifix-msg" role="status">
          {msg}
        </p>
      )}
    </section>
  );
}
