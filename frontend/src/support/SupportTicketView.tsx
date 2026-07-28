import { useEffect, useState } from "react";
import Modal from "../components/Modal";
import {
  downloadTicketAttachment,
  getTicket,
  listTicketAttachments,
  type SupportAttachment,
  type SupportTicket,
} from "../api/support";
import "./supportModal.css";

// A submitted support ticket, read-only.
//
// Nothing here is editable on purpose: once a ticket is filed, its subject,
// description and category are the record support replies against, and only
// support moves its status. Reopening the report form would invite edits that
// silently diverge from the email already sent.

const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  closed: "Closed",
};

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

const fmtSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export default function SupportTicketView({
  ticketId,
  onClose,
}: {
  ticketId: number | null;
  onClose: () => void;
}) {
  return (
    <Modal
      isOpen={ticketId !== null}
      onClose={onClose}
      title={ticketId === null ? "Ticket" : `Ticket #${ticketId}`}
    >
      {/* Keyed on the id so switching tickets remounts with empty state —
          clearing it inside an effect would flash the previous ticket's
          contents under the new one's heading. */}
      {ticketId !== null && <TicketBody key={ticketId} ticketId={ticketId} />}
    </Modal>
  );
}

function TicketBody({ ticketId }: { ticketId: number }) {
  const [ticket, setTicket] = useState<SupportTicket | null>(null);
  const [attachments, setAttachments] = useState<SupportAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void getTicket(ticketId)
      .then((t) => {
        if (!cancelled) setTicket(t);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load that ticket.");
      });

    // Attachments are secondary: a failure here leaves the ticket readable
    // rather than blanking the whole view.
    void listTicketAttachments(ticketId)
      .then((rows) => {
        if (!cancelled) setAttachments(rows);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [ticketId]);

  // The blob is fetched with the session's auth header, so it can't be a plain
  // href; hand it to the browser as an object URL and revoke it straight after.
  const download = async (attachment: SupportAttachment) => {
    try {
      const blob = await downloadTicketAttachment(attachment.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = attachment.name;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("Couldn't download that attachment.");
    }
  };

  return (
    <>
      {error && <p className="support-view-error">{error}</p>}

      {!ticket && !error ? (
        <p className="support-view-muted">Loading…</p>
      ) : ticket ? (
        <div className="support-view">
          <h3 className="support-view-subject">{ticket.subject}</h3>

          <dl className="support-view-meta">
            <div>
              <dt>Status</dt>
              <dd>
                <span
                  className={`settings-ticket-status status-${ticket.status}`}
                >
                  {STATUS_LABEL[ticket.status] ?? ticket.status}
                </span>
              </dd>
            </div>
            <div>
              <dt>Category</dt>
              <dd>{ticket.category}</dd>
            </div>
            <div>
              <dt>Reported</dt>
              <dd>{fmtDateTime(ticket.created_at)}</dd>
            </div>
            {ticket.resolved_at && (
              <div>
                <dt>Resolved</dt>
                <dd>{fmtDateTime(ticket.resolved_at)}</dd>
              </div>
            )}
          </dl>

          <div className="support-view-section">
            <h3 className="support-view-label">Description</h3>
            {/* pre-wrap: the description was typed in a textarea, so its own
                line breaks are the formatting it has. */}
            <p className="support-view-description">{ticket.description}</p>
          </div>

          {attachments.length > 0 && (
            <div className="support-view-section">
              <h3 className="support-view-label">
                Attachments ({attachments.length})
              </h3>
              <ul className="support-view-attachments">
                {attachments.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      className="support-view-attachment"
                      onClick={() => void download(a)}
                    >
                      <span className="support-view-attachment-name">
                        {a.name}
                      </span>
                      <span className="support-view-attachment-size">
                        {fmtSize(a.size)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="support-view-muted">
            Support replies by email. To add anything to this report, reply to
            that thread.
          </p>
        </div>
      ) : null}
    </>
  );
}
