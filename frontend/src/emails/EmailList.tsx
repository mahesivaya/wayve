import React from "react";
import { EmailItem } from "./types";

interface EmailListProps {
  emails: EmailItem[];
  selectedEmailId: number | null;
  onOpenEmail: (email: EmailItem) => void;
  hasMore: boolean;
  loadMore: () => void;
  loadingMore: boolean;
}

export const EmailList: React.FC<EmailListProps> = ({
  emails,
  selectedEmailId,
  onOpenEmail,
  hasMore,
  loadMore,
  loadingMore,
}) => {
  return (
    <div className="email-list">
      {emails.map((email) => (
        <div
          key={email.id}
          className={[
            "email-item",
            email.is_read === false ? "unread" : "read",
            selectedEmailId === email.id ? "active" : "",
          ].filter(Boolean).join(" ")}
          onClick={() => onOpenEmail(email)}
        >
          <div className="email-top">
            <span className="email-primary">
              {/* Shared-inbox workflow chip. Only renders when the row
                  came from a shared account AND has been touched at
                  least once (no chip = no help-desk state yet, i.e.
                  implicit "open" — surfaced by the row's unread style
                  rather than a redundant green chip on every mail). */}
              {email.is_shared && email.inbox_status && (
                <span className={`inbox-status-chip ${email.inbox_status}`}>
                  {email.inbox_status}
                </span>
              )}
              <span className="email-list-subject">{email.subject || "(No Subject)"}</span>
            </span>
            <span className="email-row-meta">
              {email.has_attachments && <span className="email-attachment-pin" title="Has attachments">📎</span>}
              <span className="email-time">
                {new Date(email.created_at).toLocaleTimeString()}
              </span>
            </span>
          </div>
        </div>
      ))}

      {hasMore && (
        <div className="load-more-wrap">
          <button className="load-more-btn" onClick={loadMore} disabled={loadingMore}>{loadingMore ? "Loading..." : "Show more emails"}</button>
        </div>
      )}
    </div>
  );
};
