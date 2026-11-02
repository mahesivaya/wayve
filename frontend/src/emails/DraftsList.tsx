import type { EmailDraft } from "../api/emailDrafts";

const KIND_LABEL: Record<EmailDraft["kind"], string> = {
  compose: "New",
  reply: "Reply",
  forward: "Forward",
};

function savedAt(iso: string): string {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

// The drafts saved here, above the Drafts folder's rows synced from the mailbox
// (those are read-only copies; these can be picked up again).
export function DraftsList({
  drafts,
  onOpen,
  onDelete,
}: {
  drafts: EmailDraft[];
  onOpen: (draft: EmailDraft) => void;
  onDelete: (draft: EmailDraft) => void;
}) {
  if (drafts.length === 0) return null;
  return (
    <section className="email-drafts" aria-label="Saved drafts">
      <h3 className="email-drafts-title">Saved drafts</h3>
      <ul className="email-drafts-list">
        {drafts.map((draft) => (
          <li key={draft.id} className="email-draft-row">
            <button
              type="button"
              className="email-draft-open"
              onClick={() => onOpen(draft)}
            >
              <span className="email-draft-kind">{KIND_LABEL[draft.kind]}</span>
              <span className="email-draft-to">
                {draft.to || "(no recipient)"}
              </span>
              <span className="email-draft-text">
                <strong>{draft.subject || "(no subject)"}</strong>
                {draft.body && (
                  <span className="email-draft-snippet"> {draft.body}</span>
                )}
              </span>
              <span className="email-draft-time">
                {savedAt(draft.updated_at)}
              </span>
            </button>
            <button
              type="button"
              className="email-draft-delete"
              aria-label={`Discard draft: ${draft.subject || "no subject"}`}
              data-tooltip="Discard draft"
              onClick={() => onDelete(draft)}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
