import { useState } from "react";
import { updateTeamDescription } from "../api/workspace";

// The backend keeps at most this many characters (DESCRIPTION_MAX).
const MAX_LENGTH = 2000;

// A team's description on its Overview. People who can manage the team get a
// textbox that saves when they click away; everyone else reads it.
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
        className="team-description-input"
        aria-label="Team description"
        placeholder="Add a description..."
        rows={4}
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
