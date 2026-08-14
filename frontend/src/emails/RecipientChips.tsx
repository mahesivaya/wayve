// A recipient field that turns each finished address into a removable chip, so
// where one address ends and the next begins is visible rather than inferred
// from commas in a run-on text box.
//
// An address is "finished" on Enter, Tab, comma, or blur — the four moments a
// user signals they've moved on. Backspace in an empty box reaches back and
// picks up the last chip for editing, which is the one interaction people miss
// when a field like this only supports the × button.

import { useState, type KeyboardEvent } from "react";

import "./recipientChips.css";

type Props = {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** Rendered to the right of the field — the Cc/Bcc toggles on the To row. */
  actions?: React.ReactNode;
};

/** Splits on commas and semicolons so a pasted list lands as separate chips. */
function tokenize(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function RecipientChips({
  label,
  value,
  onChange,
  placeholder,
  actions,
}: Props) {
  const [draft, setDraft] = useState("");

  // De-duped case-insensitively, matching what the backend does to cc/bcc, so
  // the field doesn't show two chips the server would collapse into one.
  const commit = (raw: string) => {
    const additions = tokenize(raw);
    if (additions.length === 0) return;
    const seen = new Set(value.map((v) => v.toLowerCase()));
    const next = [...value];
    for (const addr of additions) {
      if (seen.has(addr.toLowerCase())) continue;
      seen.add(addr.toLowerCase());
      next.push(addr);
    }
    onChange(next);
    setDraft("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "Tab" || e.key === ",") {
      // Tab still moves on when there's nothing to commit, so the field doesn't
      // trap focus.
      if (!draft.trim()) return;
      e.preventDefault();
      commit(draft);
      return;
    }
    if (e.key === "Backspace" && draft === "" && value.length > 0) {
      e.preventDefault();
      // Pull it back into the box rather than deleting outright — a typo in the
      // last address is the usual reason for reaching back here.
      setDraft(value[value.length - 1]);
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div className="recipient-row">
      <span className="recipient-label">{label}</span>
      <div className="recipient-field">
        {value.map((addr) => (
          <span className="recipient-chip" key={addr}>
            {addr}
            <button
              type="button"
              className="recipient-chip-remove"
              aria-label={`Remove ${addr}`}
              onClick={() => onChange(value.filter((a) => a !== addr))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          className="recipient-input"
          value={draft}
          onChange={(e) => {
            // A pasted list commits immediately instead of sitting as one
            // unusable blob of text.
            if (/[,;]/.test(e.target.value)) commit(e.target.value);
            else setDraft(e.target.value);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => commit(draft)}
          placeholder={value.length === 0 ? placeholder : ""}
          aria-label={label}
        />
      </div>
      {actions}
    </div>
  );
}
