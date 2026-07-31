import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import {
  getOAuthConsent,
  decideOAuthConsent,
  type OAuthConsent,
} from "../api/oauth";
import "./connect.css";

// Human-readable labels for the scopes an app can request. Falls back to the
// raw scope string so a new backend scope still renders sensibly.
const SCOPE_LABELS: Record<string, string> = {
  "email:read": "Read your email",
  "email:send": "Send email on your behalf",
  "chat:read": "Read your chat messages",
  "chat:write": "Send chat messages",
  "call:access": "Start and join calls",
  "scheduler:read": "View your calendar",
  "scheduler:write": "Manage your calendar",
  "drive:read": "View your files",
  "drive:write": "Manage your files",
  "notes:read": "View your notes",
  "notes:write": "Manage your notes",
  "reminders:read": "View your reminders",
  "reminders:write": "Manage your reminders",
  "tasks:read": "View your tasks",
  "tasks:write": "Manage your tasks",
  "ai:use": "Use AI features as you",
  "profile:read": "View your basic profile",
};

export default function ConnectPage() {
  const [params] = useSearchParams();
  const requestId = params.get("request_id") ?? "";
  const { user } = useAuth();

  const [consent, setConsent] = useState<OAuthConsent | null>(null);
  // No request_id → nothing to load; start settled so the effect never needs to
  // setState synchronously (which cascades renders and the linter forbids).
  const [loading, setLoading] = useState(Boolean(requestId));
  const [error, setError] = useState("");
  const [deciding, setDeciding] = useState(false);

  useEffect(() => {
    if (!requestId) return;
    let alive = true;
    getOAuthConsent(requestId)
      .then((c) => {
        if (alive) setConsent(c);
      })
      .catch((err) => {
        if (alive)
          setError(
            err instanceof Error
              ? err.message
              : "This authorization request is invalid or has expired."
          );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [requestId]);

  const decide = async (approve: boolean) => {
    setDeciding(true);
    setError("");
    try {
      const { redirect_to } = await decideOAuthConsent(requestId, approve);
      window.location.href = redirect_to;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setDeciding(false);
    }
  };

  const shownError =
    error || (!requestId ? "Missing authorization request." : "");

  let host = "";
  try {
    host = consent ? new URL(consent.redirect_uri).host : "";
  } catch {
    host = "";
  }

  return (
    <div className="connect-page">
      <div className="connect-card">
        <div className="connect-brand">Fluxze</div>

        {loading ? (
          <p className="connect-muted">Loading…</p>
        ) : shownError ? (
          <p className="connect-error">{shownError}</p>
        ) : consent ? (
          <>
            <h1 className="connect-title">
              <strong>{consent.app_name}</strong> wants to access your account
            </h1>
            <p className="connect-muted">
              Signed in as {user?.email}. This will let{" "}
              <strong>{consent.app_name}</strong> access your Fluxze account
              until you revoke it.
            </p>

            <div className="connect-scopes">
              <div className="connect-scopes-head">
                This app will be able to:
              </div>
              {consent.scopes.length === 0 ? (
                <div className="connect-muted">
                  Read only your basic account info.
                </div>
              ) : (
                <ul>
                  {consent.scopes.map((s) => (
                    <li key={s}>{SCOPE_LABELS[s] ?? s}</li>
                  ))}
                </ul>
              )}
            </div>

            {host && (
              <p className="connect-redirect">
                You’ll be returned to <strong>{host}</strong>.
              </p>
            )}

            <div className="connect-actions">
              <button
                type="button"
                className="connect-deny"
                onClick={() => void decide(false)}
                disabled={deciding}
              >
                Deny
              </button>
              <button
                type="button"
                className="connect-allow"
                onClick={() => void decide(true)}
                disabled={deciding}
              >
                {deciding ? "…" : "Allow"}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
