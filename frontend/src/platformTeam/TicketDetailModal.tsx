// Ticket detail overlay for the Support Console.
import { useEffect, useState } from "react";
import {
  downloadTicketAttachment,
  listTicketAttachments,
  type SupportAttachment,
  type SupportTicket,
} from "../api/support";
import { fmtDateTime } from "../utils/datetime";

type Props = { ticket: SupportTicket; onClose: () => void };

type LoadedAttachment = SupportAttachment & { previewUrl?: string };

const isImage = (a: SupportAttachment) =>
  (a.file_type ?? "").startsWith("image/");

const fmtSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export default function TicketDetailModal({ ticket, onClose }: Props) {
  const [attachments, setAttachments] = useState<LoadedAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const list = await listTicketAttachments(ticket.id);
        if (cancelled) return;
        setAttachments(list);
        // Previews need an authenticated request, so a plain <img src> cannot
        // load them; each is fetched as a blob instead.
        await Promise.all(
          list.filter(isImage).map(async (a) => {
            try {
              const blob = await downloadTicketAttachment(a.id);
              if (cancelled) return;
              const url = URL.createObjectURL(blob);
              urls.push(url);
              setAttachments((prev) =>
                prev.map((p) => (p.id === a.id ? { ...p, previewUrl: url } : p))
              );
            } catch {
              /* leave as a download link if the preview fetch fails */
            }
          })
        );
      } catch (err) {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : "Failed to load attachments"
          );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [ticket.id]);

  const downloadFile = async (a: SupportAttachment) => {
    try {
      const blob = await downloadTicketAttachment(a.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = a.name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch {
      setError("Download failed");
    }
  };

  return (
    <div
      className="ticket-modal-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div className="ticket-modal" onClick={(e) => e.stopPropagation()}>
        <header className="ticket-modal-head">
          <div>
            <h2>{ticket.subject}</h2>
            <span className="ticket-modal-sub">Ticket #{ticket.id}</span>
          </div>
          <button
            type="button"
            className="ticket-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <dl className="ticket-modal-meta">
          <div>
            <dt>Reporter</dt>
            <dd>
              {ticket.user_email ?? `user #${ticket.user_id}`}
              {ticket.organization_name ? ` · ${ticket.organization_name}` : ""}
            </dd>
          </div>
          <div>
            <dt>Category</dt>
            <dd>
              <span className="pt-pill info">{ticket.category}</span>
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>
              <span className={`pt-pill ${ticket.status}`}>
                {ticket.status.replace("_", " ")}
              </span>
            </dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{fmtDateTime(ticket.created_at)}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{fmtDateTime(ticket.updated_at)}</dd>
          </div>
          {ticket.resolved_at && (
            <div>
              <dt>Resolved</dt>
              <dd>{fmtDateTime(ticket.resolved_at)}</dd>
            </div>
          )}
        </dl>

        <section className="ticket-modal-section">
          <h3>Description</h3>
          <p className="ticket-modal-desc">{ticket.description}</p>
        </section>

        <section className="ticket-modal-section">
          <h3>
            Attachments
            {ticket.attachment_count > 0 ? ` (${ticket.attachment_count})` : ""}
          </h3>
          {error && <div className="pt-banner">{error}</div>}
          {loading ? (
            <p className="ticket-modal-muted">Loading attachments…</p>
          ) : attachments.length === 0 ? (
            <p className="ticket-modal-muted">No attachments.</p>
          ) : (
            <div className="ticket-attach-grid">
              {attachments.map((a) => (
                <div key={a.id} className="ticket-attach">
                  {isImage(a) && a.previewUrl ? (
                    <a href={a.previewUrl} target="_blank" rel="noreferrer">
                      <img
                        src={a.previewUrl}
                        alt={a.name}
                        className="ticket-attach-img"
                      />
                    </a>
                  ) : (
                    <button
                      type="button"
                      className="ticket-attach-file"
                      onClick={() => void downloadFile(a)}
                    >
                      📎 {a.name}
                    </button>
                  )}
                  <span className="ticket-attach-meta">
                    {a.name} · {fmtSize(a.size)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
