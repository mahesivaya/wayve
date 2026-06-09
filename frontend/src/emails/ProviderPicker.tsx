// Modal picker for adding a mailbox. Flows:
//
//   1. User clicks Gmail/Outlook  → onSelect fires immediately, parent
//      kicks off the existing OAuth redirect.
//   2. User clicks "Other"        → inline email form; on submit we
//      autodiscover the domain. If it's on Google/Microsoft we dispatch the
//      OAuth flow; otherwise we open the IMAP form pre-filled with the
//      guessed host/port for the user to test + connect.
//   3. IMAP form                  → password + (editable) server settings,
//      a "Test connection" check, then "Connect" (any custom-domain mailbox).

import { useEffect, useRef, useState } from "react";
import {
  connectImap,
  imapAutodiscover,
  imapTestLogin,
  type ImapSettings,
} from "../api/email";
import {
  EMAIL_PROVIDERS,
  type ProviderConfig,
  type ProviderId,
} from "./providers";

type Props = {
  onSelect: (id: ProviderId) => void;
  onConnected: () => void;
  onClose: () => void;
};

type Mode = "list" | "other" | "imap";

const DEFAULT_IMAP: ImapSettings = {
  imap_host: "",
  imap_port: 993,
  smtp_host: "",
  smtp_port: 465,
  security: "ssl",
};

export default function ProviderPicker({ onSelect, onConnected, onClose }: Props) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<Mode>("list");
  const [otherEmail, setOtherEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // IMAP form state.
  const [imapEmail, setImapEmail] = useState("");
  const [cfg, setCfg] = useState<ImapSettings>(DEFAULT_IMAP);
  const [password, setPassword] = useState("");
  const [testState, setTestState] = useState<"idle" | "ok">("idle");
  const [imapError, setImapError] = useState<string | null>(null);

  // ESC closes; first interactive control gets focus on mount / mode switch.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKey);
    const t = window.setTimeout(() => {
      const target = cardRef.current?.querySelector<HTMLElement>(
        mode === "list"
          ? "button.provider-option:not([disabled])"
          : "input",
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
      const res = await imapAutodiscover(email);
      if (res.use_oauth) {
        // Domain is on Google/Microsoft — use the existing OAuth connector.
        onSelect(res.use_oauth === "microsoft" ? "outlook" : "gmail");
        return;
      }
      // Otherwise open the IMAP form, pre-filled with the guessed settings.
      setImapEmail(email);
      setCfg({
        imap_host: res.imap_host ?? "",
        imap_port: res.imap_port ?? 993,
        smtp_host: res.smtp_host ?? "",
        smtp_port: res.smtp_port ?? 465,
        security: res.security ?? "ssl",
      });
      setPassword("");
      setTestState("idle");
      setImapError(null);
      setMode("imap");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "We couldn't look up that domain.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const setField = <K extends keyof ImapSettings>(key: K, value: ImapSettings[K]) => {
    setCfg((prev) => ({ ...prev, [key]: value }));
    setTestState("idle");
  };

  const handleTest = async () => {
    setImapError(null);
    setSubmitting(true);
    try {
      await imapTestLogin({
        email: imapEmail,
        imap_host: cfg.imap_host,
        imap_port: cfg.imap_port,
        password,
      });
      setTestState("ok");
    } catch (err) {
      setTestState("idle");
      setImapError(
        err instanceof Error ? err.message : "Connection test failed.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setImapError(null);
    setSubmitting(true);
    try {
      await connectImap({ email: imapEmail, password, ...cfg });
      onConnected();
    } catch (err) {
      setImapError(
        err instanceof Error ? err.message : "Could not connect the mailbox.",
      );
      setSubmitting(false);
    }
  };

  const canSubmitImap =
    !submitting && password.trim().length > 0 && cfg.imap_host.trim().length > 0;

  return (
    <div
      className="provider-picker-backdrop"
      role="presentation"
      onClick={() => {
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
          <h2 id="provider-picker-title">Add a mailbox</h2>
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
                      Any custom domain — enter your email and we'll set it up
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
              Enter your email address. If it's on Google or Microsoft we'll use
              secure sign-in; otherwise we'll set up IMAP.
            </p>

            <label className="provider-other-label" htmlFor="provider-other-email">
              Email address
            </label>
            <input
              id="provider-other-email"
              name="other-email"
              type="email"
              className="provider-other-input"
              placeholder="you@yourcompany.com"
              value={otherEmail}
              onChange={(e) => setOtherEmail(e.target.value)}
              disabled={submitting}
              autoComplete="email"
              required
            />

            {error && (
              <div className="provider-other-error" role="alert">
                {error}
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

        {mode === "imap" && (
          <form className="provider-other-form" onSubmit={handleConnect}>
            <p className="provider-picker-sub">
              Connecting <strong>{imapEmail}</strong> over IMAP. Use an
              app password if your provider requires one.
            </p>

            <label className="provider-other-label" htmlFor="imap-password">
              Password
            </label>
            <input
              id="imap-password"
              type="password"
              className="provider-other-input"
              placeholder="app password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setTestState("idle");
              }}
              disabled={submitting}
              autoComplete="off"
              required
            />

            <details className="provider-imap-advanced">
              <summary>Server settings</summary>
              <div className="provider-imap-grid">
                <label>
                  IMAP host
                  <input
                    type="text"
                    value={cfg.imap_host}
                    onChange={(e) => setField("imap_host", e.target.value)}
                    disabled={submitting}
                  />
                </label>
                <label>
                  IMAP port
                  <input
                    type="number"
                    value={cfg.imap_port}
                    onChange={(e) =>
                      setField("imap_port", Number(e.target.value) || 0)
                    }
                    disabled={submitting}
                  />
                </label>
                <label>
                  SMTP host
                  <input
                    type="text"
                    value={cfg.smtp_host}
                    onChange={(e) => setField("smtp_host", e.target.value)}
                    disabled={submitting}
                  />
                </label>
                <label>
                  SMTP port
                  <input
                    type="number"
                    value={cfg.smtp_port}
                    onChange={(e) =>
                      setField("smtp_port", Number(e.target.value) || 0)
                    }
                    disabled={submitting}
                  />
                </label>
                <label>
                  Security
                  <select
                    value={cfg.security}
                    onChange={(e) => setField("security", e.target.value)}
                    disabled={submitting}
                  >
                    <option value="ssl">SSL/TLS</option>
                    <option value="starttls">STARTTLS</option>
                  </select>
                </label>
              </div>
            </details>

            {testState === "ok" && (
              <div className="provider-imap-ok" role="status">
                Connected ✓ — you're good to go.
              </div>
            )}
            {imapError && (
              <div className="provider-other-error" role="alert">
                {imapError}
              </div>
            )}

            <div className="provider-other-actions">
              <button
                type="button"
                className="provider-other-back"
                onClick={() => {
                  setMode("other");
                  setImapError(null);
                }}
                disabled={submitting}
              >
                Back
              </button>
              <button
                type="button"
                className="provider-other-back"
                onClick={handleTest}
                disabled={!canSubmitImap}
              >
                {submitting ? "Testing…" : "Test connection"}
              </button>
              <button
                type="submit"
                className="provider-other-submit"
                disabled={!canSubmitImap}
              >
                {submitting ? "Connecting…" : "Connect"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
