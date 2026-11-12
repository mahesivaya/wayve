import { useEffect, useRef, useState } from "react";
import type { MergeMethod } from "../api/github";
import "./prMergeButton.css";

/** The two merge styles offered; a plain merge commit is left out on purpose. */
export type HeaderMergeMethod = Extract<MergeMethod, "squash" | "rebase">;

const METHODS: {
  value: HeaderMergeMethod;
  label: string;
  short: string;
  hint: string;
}[] = [
  {
    value: "squash",
    label: "Squash and merge",
    short: "Squash & merge",
    hint: "Combine all commits into one on the base branch.",
  },
  {
    value: "rebase",
    label: "Rebase and merge",
    short: "Rebase & merge",
    hint: "Replay each commit onto the base branch.",
  },
];

type Props = {
  number: number;
  baseRef: string;
  /** GitHub's async mergeability: false = conflicts, null = still computing. */
  mergeable: boolean | null | undefined;
  merging: boolean;
  onMerge: (method: HeaderMergeMethod) => void;
};

// The PR header's merge control (next to the title): a pill naming the chosen
// method that opens a menu of Squash / Rebase, then a confirm step. When the
// branch conflicts it is replaced by a "Conflicts" pill.
export default function PrMergeButton({
  number,
  baseRef,
  mergeable,
  merging,
  onMerge,
}: Props) {
  const [method, setMethod] = useState<HeaderMergeMethod>("squash");
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<HeaderMergeMethod | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setConfirming(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setConfirming(null);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (mergeable === false) {
    return (
      <span
        className="pr-merge-pill is-conflicts"
        title="This branch has conflicts that must be resolved before it can be merged."
      >
        <span aria-hidden="true">✕</span> Conflicts
      </span>
    );
  }

  const current = METHODS.find((m) => m.value === method) ?? METHODS[0];
  const checking = mergeable == null;
  const pick = (m: HeaderMergeMethod) => {
    setMethod(m);
    setConfirming(m);
  };
  const confirmed = confirming
    ? (METHODS.find((m) => m.value === confirming) ?? current)
    : null;

  return (
    <div className="pr-merge-dropdown" ref={rootRef}>
      <button
        type="button"
        className="pr-merge-pill is-ready"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={merging || checking}
        title={checking ? "GitHub is still checking mergeability" : undefined}
        onClick={() => {
          setOpen((o) => !o);
          setConfirming(null);
        }}
      >
        <MergeIcon />
        {merging ? "Merging…" : checking ? "Checking…" : `${current.short}…`}
      </button>
      {open && (
        <div className="pr-merge-menu" role="menu" aria-label="Merge method">
          {confirmed ? (
            <div className="pr-merge-confirm">
              <div className="pr-merge-confirm-text">
                {confirmed.label} #{number} into <code>{baseRef}</code>?
              </div>
              <div className="pr-merge-confirm-actions">
                <button
                  type="button"
                  className="pr-merge-confirm-btn"
                  onClick={() => {
                    setOpen(false);
                    setConfirming(null);
                    onMerge(confirmed.value);
                  }}
                >
                  Confirm {confirmed.label.toLowerCase()}
                </button>
                <button
                  type="button"
                  className="pr-merge-cancel-btn"
                  onClick={() => setConfirming(null)}
                >
                  Back
                </button>
              </div>
            </div>
          ) : (
            METHODS.map((m) => (
              <button
                key={m.value}
                type="button"
                role="menuitemradio"
                aria-checked={m.value === method}
                className="pr-merge-option"
                onClick={() => pick(m.value)}
              >
                <span className="pr-merge-option-check" aria-hidden="true">
                  {m.value === method ? "✓" : ""}
                </span>
                <span>
                  <span className="pr-merge-option-label">{m.label}</span>
                  <span className="pr-merge-option-hint">{m.hint}</span>
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function MergeIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="pr-merge-pill-icon">
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="12.5" r="1.6" />
      <path d="M4 5.1v5.8M12 10.9V8a3 3 0 0 0-3-3H6.5" />
    </svg>
  );
}
