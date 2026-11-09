import { useLayoutEffect, useRef, useState } from "react";
import { updateTeamDescription } from "../api/workspace";

// The backend keeps at most this many characters (DESCRIPTION_MAX).
const MAX_LENGTH = 2000;

// A team's description on its Overview. Admins can click the text to edit it,
// and it saves when they click away; everyone else just reads it.
export default function TeamDescription({
  teamId,
  value,
  canEdit,
  onSaved,
}: {
  teamId: number;
  value: string;
  canEdit: boolean;
  onSaved: (description: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState("");

  // Follow a new saved value without losing what's being typed: the page keeps
  // this mounted across saves, and the value only changes after one.
  const [lastValue, setLastValue] = useState(value);
  if (lastValue !== value) {
    setLastValue(value);
    setDraft(value);
  }

  // It reads as text on the page, so it grows with its content, not a scrollbar.
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, [draft]);

  if (!canEdit) {
    return <p className="team-tab-text">{value || "No description yet."}</p>;
  }

  const save = async () => {
    const next = draft.trim();
    if (next === value.trim()) return;
    setError("");
    setStatus("saving");
    try {
      const saved = await updateTeamDescription(teamId, next);
      setStatus("saved");
      onSaved(saved.description ?? "");
    } catch (err) {
      setStatus("idle");
      // The text stays in the box so nothing typed is lost.
      setError(
        err instanceof Error ? err.message : "Failed to save description"
      );
    }
  };

  return (
    <div className="team-description">
      <textarea
        ref={inputRef}
        className="team-description-input"
        aria-label="Team description"
        placeholder="Add a description..."
        rows={1}
        maxLength={MAX_LENGTH}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setStatus("idle");
          setError("");
        }}
        onBlur={() => void save()}
      />
      {error && (
        <p className="team-delete-error" role="alert">
          {error}
        </p>
      )}
      {status !== "idle" && (
        <p className="team-description-status" role="status">
          {status === "saving" ? "Saving…" : "Saved"}
        </p>
      )}
    </div>
  );
}
