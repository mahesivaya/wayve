// In-app support overlay. Two halves:
//   1. Static contact details — direct email, response SLA, link to the full
//      /support marketing page for self-serve docs.
//   2. A compact contact form (subject + message). Submit composes a mailto:
//      URI prefilled with the user's identity. Zero backend dependency, so
//      it works in any environment. When we wire a real /api/support endpoint
//      later, swap the handler — the props don't change.

import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import "./supportModal.css";

const SUPPORT_EMAIL = "support@rwayve.maheshg.me";

type Props = {
  onClose: () => void;
};

export default function SupportModal({ onClose }: Props) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const finalSubject = subject.trim() || "Support request";
    const body = [
      `From: ${user?.email ?? "(unknown user)"}`,
      `Account: ${user?.account_type ?? "personal"}`,
      "",
      message.trim(),
    ].join("\n");

    const url = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(finalSubject)}&body=${encodeURIComponent(body)}`;
    window.location.href = url;
    onClose();
  }

  return (
    <div className="support-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="support-modal" onClick={(e) => e.stopPropagation()}>
        <header className="support-modal-header">
          <h2>How can we help?</h2>
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
          <h3>Reach us directly</h3>
          <dl>
            <div>
              <dt>Email</dt>
              <dd>
                <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
              </dd>
            </div>
            <div>
              <dt>Response time</dt>
              <dd>Within 1 business day · 24×7 for paid plans</dd>
            </div>
            <div>
              <dt>Status & docs</dt>
              <dd>
                <button
                  type="button"
                  className="support-link-btn"
                  onClick={() => {
                    onClose();
                    void navigate("/support");
                  }}
                >
                  Open the support center →
                </button>
              </dd>
            </div>
          </dl>
        </section>

        <section className="support-form-section">
          <h3>Send us a message</h3>
          <p className="support-form-note">
            Opens in your mail client prefilled with your account details so we can find you quickly.
          </p>
          <form className="support-form" onSubmit={submit}>
            <label>
              <span>Subject</span>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="What do you need help with?"
                autoFocus
              />
            </label>
            <label>
              <span>Message</span>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={5}
                placeholder="Steps to reproduce, what you expected, what happened…"
              />
            </label>
            <div className="support-form-actions">
              <button type="button" className="support-secondary-btn" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="support-primary-btn" disabled={!message.trim()}>
                Compose email
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
