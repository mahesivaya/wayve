// Modal picker for adding a mailbox. Three flows:
//
//   1. User clicks Gmail/Outlook  → onSelect fires immediately, parent
//      kicks off the existing OAuth redirect.
//   2. User clicks Yahoo          → disabled "Coming soon" row, no-op.
//   3. User clicks "Other"        → inline email form; on submit, asks the
//      backend [provider_lookup](../../../backend/src/email/provider_lookup.rs)
//      whether the domain has OAuth wired up. If yes, dispatches as that
//      provider; if no, surfaces the error and redirects to /home (per
//      product spec — clean reset rather than leaving the user stranded
//      with a dead-end form).

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { lookupEmailProvider } from "../api/email";
import {
  EMAIL_PROVIDERS,
  type ProviderConfig,
  type ProviderId,
} from "./providers";

type Props = {
  onSelect: (id: ProviderId) => void;
  onClose: () => void;
};

type Mode = "list" | "other";

// How long the error stays visible inside the modal before we redirect home.
// Long enough that a user can read it, short enough that they don't think
// the form is hung.
const ERROR_REDIRECT_DELAY_MS = 1800;

// The picker is mounted only while open (parent does `{open && <ProviderPicker />}`).
// That makes state reset on close automatic — no `open` prop, no reset effect.
export default function ProviderPicker({ onSelect, onClose }: Props) {
  const navigate = useNavigate();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<Mode>("list");
  const [otherEmail, setOtherEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ESC closes; first interactive control gets focus on mount / mode switch.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKey);
    const t = window.setTimeout(() => {
      const target = cardRef.current?.querySelector<HTMLElement>(
        mode === "other"
          ? "input[name='other-email']"
          : "button.provider-option:not([disabled])",
      );
      target?.focus();
    }, 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
    };
  }, [mode, submitting, onClose]);

  const handleListSelect = (provider: ProviderConfig) => {
    if (provider.status !== "available") return;
    onSelect(provider.id);
  };

  const handleOtherSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = otherEmail.trim();
    if (!email.includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const provider = (await lookupEmailProvider(email)) as ProviderId;
      // Hand off to the parent — same dispatch arm as a direct Gmail/Outlook
      // click. The OAuth redirect path is unchanged.
      onSelect(provider);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "We couldn't connect that mailbox.";
      // Per product spec: show the error briefly so the user knows what
      // happened, then redirect to /home for a clean reset. The backend has
      // already logged the unsupported domain.
      setError(message);
      setSubmitting(false);
      window.setTimeout(() => navigate("/home"), ERROR_REDIRECT_DELAY_MS);
    }
  };

  return (
    <div
      className="provider-picker-backdrop"
      role="presentation"
      onClick={() => {
        // Don't let a stray backdrop click cancel an in-flight request.
        if (!submitting) onClose();
      }}
    >
      <div
        ref={cardRef}
        className="provider-picker-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-picker-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="provider-picker-header">
          <h2 id="provider-picker-title">
            {mode === "other" ? "Add a mailbox" : "Add a mailbox"}
          </h2>
          <button
            type="button"
            className="provider-picker-close"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        {mode === "list" && (
          <>
            <p className="provider-picker-sub">
              Choose where to import mail from. We'll redirect you to the
              provider to authorize access.
            </p>

            <ul className="provider-picker-list">
              {EMAIL_PROVIDERS.map((provider) => {
                const disabled = provider.status !== "available";
                return (
                  <li key={provider.id}>
                    <button
                      type="button"
                      className="provider-option"
                      disabled={disabled}
                      onClick={() => handleListSelect(provider)}
                      aria-label={`Connect ${provider.name}${
                        disabled ? " (coming soon)" : ""
                      }`}
                    >
                      <span
                        className={`provider-badge provider-badge-${provider.id}`}
                        aria-hidden="true"
                      >
                        {provider.badge}
                      </span>
                      <span className="provider-option-text">
                        <span className="provider-option-name">
                          {provider.name}
                        </span>
                        <span className="provider-option-desc">
                          {provider.description}
                        </span>
                      </span>
                      {disabled && (
                        <span className="provider-option-tag">Coming soon</span>
                      )}
                    </button>
                  </li>
                );
              })}

              {/* "Other" — opens the inline email form. Visually a peer of
                  the named providers so users don't have to hunt for it. */}
              <li>
                <button
                  type="button"
                  className="provider-option"
                  onClick={() => setMode("other")}
                  aria-label="Connect another mailbox"
                >
                  <span
                    className="provider-badge provider-badge-other"
                    aria-hidden="true"
                  >
                    ＋
                  </span>
                  <span className="provider-option-text">
                    <span className="provider-option-name">Other</span>
                    <span className="provider-option-desc">
                      Enter your email address — we'll figure out the provider
                    </span>
                  </span>
                </button>
              </li>
            </ul>
          </>
        )}

        {mode === "other" && (
          <form className="provider-other-form" onSubmit={handleOtherSubmit}>
            <p className="provider-picker-sub">
              We'll detect the provider from your email's domain. If we don't
              support it yet, you'll be sent back to the home page.
            </p>

            <label
              className="provider-other-label"
              htmlFor="provider-other-email"
            >
              Email address
            </label>
            <input
              id="provider-other-email"
              name="other-email"
              type="email"
              className="provider-other-input"
              placeholder="you@example.com"
              value={otherEmail}
              onChange={(e) => setOtherEmail(e.target.value)}
              disabled={submitting}
              autoComplete="email"
              required
            />

            {error && (
              <div className="provider-other-error" role="alert">
                {error}
                <div className="provider-other-redirect-note">
                  Redirecting to home…
                </div>
              </div>
            )}

            <div className="provider-other-actions">
              <button
                type="button"
                className="provider-other-back"
                onClick={() => {
                  setMode("list");
                  setError(null);
                }}
                disabled={submitting}
              >
                Back
              </button>
              <button
                type="submit"
                className="provider-other-submit"
                disabled={submitting || !otherEmail.trim()}
              >
                {submitting ? "Checking…" : "Continue"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
