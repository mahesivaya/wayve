// Type-to-confirm dialog for irreversible platform deletes. The Delete button
// stays disabled until the admin types the exact `confirmText` (e.g. the
// account's email), so a misclick can't wipe someone's data.
import { useEffect, useState, type ReactNode } from "react";
import "./confirmDeleteDialog.css";

type Props = {
  title: string;
  /** What will be destroyed; rendered above the input. */
  children: ReactNode;
  /** The string the admin must type to arm the Delete button. */
  confirmText: string;
  confirmLabel?: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
};

export default function ConfirmDeleteDialog({
  title,
  children,
  confirmText,
  confirmLabel = "Delete permanently",
  onConfirm,
  onCancel,
}: Props) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [busy, onCancel]);

  const armed = typed.trim() === confirmText.trim();

  const submit = async () => {
    if (!armed || busy) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
      setBusy(false);
    }
  };

  return (
    <div
      className="confirm-delete-backdrop"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        className="confirm-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-delete-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-delete-title">{title}</h2>
        <div className="confirm-delete-body">{children}</div>
        <label className="confirm-delete-label">
          <span>
            Type <strong>{confirmText}</strong> to confirm
          </span>
          <input
            type="text"
            value={typed}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
        </label>
        {error && (
          <div className="confirm-delete-error" role="alert">
            {error}
          </div>
        )}
        <div className="confirm-delete-actions">
          <button
            type="button"
            className="u-btn-secondary"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="confirm-delete-btn"
            onClick={() => void submit()}
            disabled={!armed || busy}
          >
            {busy ? "Deleting…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
