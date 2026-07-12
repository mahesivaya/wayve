import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getAccounts, getGmailConnectUrl } from "../api/email";
import { type EmailAccount } from "../emails/types";

/**
 * Gmail connect (OAuth) shown inline on the Integrations page. Starts the same
 * per-user Gmail OAuth flow the emails page uses (`getGmailConnectUrl`); the
 * backend callback attaches the mailbox and returns to `/emails#connected=true`,
 * where the connected inbox reads and sends. Disconnect / rename live on the
 * emails surface, so this panel only offers Connect + a jump to the inbox.
 *
 * Note: `/api/accounts` doesn't expose the provider, so "connected" here means
 * the user has at least one connected mailbox — good enough for the badge.
 */
export default function GmailPanel({
  onChange,
}: {
  onChange?: (connected: boolean) => void;
}) {
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await getAccounts<EmailAccount>();
      // Only count mailboxes the user connected themselves — shared inboxes
      // they're merely a member of aren't "their" Gmail connection.
      const owned = list.filter((a) => a.is_owner !== false);
      setAccounts(owned);
      onChange?.(owned.length > 0);
    } catch {
      setAccounts([]);
    } finally {
      setLoading(false);
    }
  }, [onChange]);

  // Deferred to a microtask so the effect body doesn't synchronously setState
  // (matches JiraPanel / GitHubPanel).
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const connect = async () => {
    setError("");
    setBusy(true);
    try {
      window.location.href = await getGmailConnectUrl();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not start the Gmail connect."
      );
      setBusy(false);
    }
  };

  if (loading) return null;
  const connected = accounts.length > 0;

  return (
    <div className="github-panel">
      <p className="github-panel-status">
        {connected ? (
          <>
            Connected:{" "}
            <strong>{accounts.map((a) => a.email).join(", ")}</strong>
          </>
        ) : (
          "Not connected"
        )}
      </p>

      {error && <p className="integrations-error">{error}</p>}

      <div className="github-panel-actions">
        <button
          type="button"
          className="integrations-info-btn"
          onClick={() => void connect()}
          disabled={busy}
        >
          {busy ? "Connecting…" : "Connect Gmail account"}
        </button>
        {connected && (
          <Link className="integrations-info-btn" to="/emails">
            Open inbox
          </Link>
        )}
      </div>

      <p className="integrations-info-text">
        Connecting authorizes Fluxze to read, send, and manage your Gmail (and
        read your Google Calendar). After you grant access you'll land in the
        Fluxze inbox, where you can read and reply to all your mail.
      </p>
      <p className="integrations-info-text">
        On a Google Workspace account, if Google blocks the grant your Workspace
        administrator must first mark the Fluxze app as trusted for your domain.
      </p>
    </div>
  );
}
