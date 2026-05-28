// In-app "Report an issue" overlay.
//
// Triggered from the header profile menu and from /settings → Support.
// Submits to POST /api/support/tickets, then uploads any selected files
// to /api/support/tickets/{id}/attachments. Staff with `tickets:manage`
// see and resolve tickets via /platform/support. Replies are sent
// off-band by email to the ticket owner.

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  createTicket,
  uploadTicketAttachments,
  type TicketCategory,
} from "../api/support";
import "./supportModal.css";

const SUPPORT_EMAIL = "support@rwayve.maheshg.me";
const MAX_ATTACHMENT_MB = 10;

const CATEGORY_OPTIONS: { value: TicketCategory; label: string }[] = [
  { value: "bug", label: "Bug" },
  { value: "feature", label: "Feature request" },
  { value: "billing", label: "Billing" },
  { value: "account", label: "Account" },
  { value: "other", label: "Other" },
];

type Props = {
  onClose: () => void;
  onSubmitted?: () => void;
};

export default function SupportModal({ onClose, onSubmitted }: Props) {
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<TicketCategory>("bug");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [createdId, setCreatedId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const addFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    if (picked.length === 0) return;
    const oversized = picked.filter((f) => f.size > MAX_ATTACHMENT_MB * 1024 * 1024);
    if (oversized.length > 0) {
      setError(
        `These files exceed ${MAX_ATTACHMENT_MB} MB and were skipped: ${oversized
          .map((f) => f.name)
          .join(", ")}`,
      );
    }
    const accepted = picked.filter((f) => f.size <= MAX_ATTACHMENT_MB * 1024 * 1024);
    setFiles((prev) => [...prev, ...accepted]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    const trimmedSubject = subject.trim();
    const trimmedDescription = description.trim();
    if (!trimmedSubject || !trimmedDescription) {
      setError("Subject and description are required.");
      return;
    }
    setSubmitting(true);
    try {
      const { id } = await createTicket({
        subject: trimmedSubject,
        description: trimmedDescription,
        category,
      });
      if (files.length > 0) {
        await uploadTicketAttachments(id, files);
      }
      setCreatedId(id);
      onSubmitted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit ticket");
    } finally {
      setSubmitting(false);
    }
  };

  if (createdId !== null) {
    return (
      <div className="support-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
        <div className="support-modal" onClick={(e) => e.stopPropagation()}>
          <header className="support-modal-header">
            <h2>Ticket submitted</h2>
            <button
              type="button"
              className="support-close-btn"
              onClick={onClose}
              aria-label="Close"
            >
              ×
            </button>
          </header>
          <section className="support-form-section">
            <p>
              Thanks — your ticket <strong>#{createdId}</strong> is in our queue.
              Our support team will reply by email. You can track its status
              under <strong>Settings → Support</strong>.
            </p>
            <div className="support-form-actions">
              <button type="button" className="support-primary-btn" onClick={onClose}>
                Done
              </button>
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="support-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="support-modal" onClick={(e) => e.stopPropagation()}>
        <header className="support-modal-header">
          <h2>Report an issue</h2>
          <button
            type="button"
            className="support-close-btn"
            onClick={onClose}
            aria-label="Close support"
          >
            ×
          </button>
        </header>

        <section className="support-contact">
          <h3>Need a faster reply?</h3>
          <dl>
            <div>
              <dt>Email</dt>
              <dd>
                <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
              </dd>
            </div>
          </dl>
        </section>

        <section className="support-form-section">
          <h3>Describe the issue</h3>
          <form className="support-form" onSubmit={(e) => void submit(e)}>
            <label>
              <span>Category</span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as TicketCategory)}
              >
                {CATEGORY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Subject</span>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Short summary of the issue"
                autoFocus
                maxLength={200}
              />
            </label>
            <label>
              <span>Description</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={5}
                placeholder="Steps to reproduce, what you expected, what happened…"
              />
            </label>

            <label className="support-attach-label">
              <span>
                Attachments <span className="support-attach-hint">(screenshots / files, ≤ {MAX_ATTACHMENT_MB} MB each)</span>
              </span>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,application/pdf,text/plain,.log,.txt"
                onChange={addFiles}
              />
            </label>

            {files.length > 0 && (
              <ul className="support-file-list">
                {files.map((file, idx) => (
                  <li key={`${file.name}-${idx}`}>
                    <span className="support-file-name" title={file.name}>
                      {file.name}
                    </span>
                    <span className="support-file-size">
                      {(file.size / 1024).toFixed(1)} KB
                    </span>
                    <button
                      type="button"
                      className="support-file-remove"
                      onClick={() => removeFile(idx)}
                      aria-label={`Remove ${file.name}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {error && <p className="support-error">{error}</p>}

            <div className="support-form-actions">
              <button
                type="button"
                className="support-secondary-btn"
                onClick={onClose}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="support-primary-btn"
                disabled={submitting || !subject.trim() || !description.trim()}
              >
                {submitting ? "Submitting…" : "Submit ticket"}
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
