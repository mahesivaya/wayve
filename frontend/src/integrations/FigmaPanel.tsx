import { useEffect, useState } from "react";
import {
  disconnectFigma,
  getFigmaConnectUrl,
  getFigmaConnection,
  type FigmaConnectionStatus,
} from "../api/figma";
import "./figmaPanel.css";

const DISCONNECTED: FigmaConnectionStatus = { connected: false };

// The OAuth callback can't return a value the way a fetch does, so it reports
// through the URL hash it redirects to. Read once, at mount.
function hashOutcome(): { connected: boolean; error: string | null } {
  const hash = typeof window === "undefined" ? "" : window.location.hash;
  if (hash.includes("figma_connected=true")) {
    return { connected: true, error: null };
  }
  if (!hash.includes("figma_error=")) {
    return { connected: false, error: null };
  }
  const reason = hash.split("figma_error=")[1]?.split("&")[0] ?? "unknown";
  return {
    connected: false,
    error:
      reason === "denied"
        ? "Figma access was declined."
        : reason === "not_configured"
          ? "Figma OAuth isn't configured on this server."
          : `Could not connect Figma (${reason}).`,
  };
}

// Connect a Figma account so designs can be attached to tickets and user
// stories. The connection is per person, not per organization: the token only
// ever reads files that person can already open, so one member connecting never
// widens what another can attach.
export default function FigmaPanel() {
  const [status, setStatus] = useState<FigmaConnectionStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Seeded from the callback's hash during render, so the effect below never has
  // to set it synchronously.
  const [error, setError] = useState<string | null>(() => hashOutcome().error);

  useEffect(() => {
    let cancelled = false;
    void getFigmaConnection()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        if (!cancelled) setStatus(DISCONNECTED);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Clear the callback's hash from the URL so a reload doesn't replay it. The
  // message itself was already read into state above.
  useEffect(() => {
    const outcome = hashOutcome();
    if (!outcome.connected && !outcome.error) return;
    if (outcome.connected) {
      void getFigmaConnection()
        .then(setStatus)
        .catch(() => {});
    }
    history.replaceState(null, "", window.location.pathname);
  }, []);

  const connect = async () => {
    setBusy("connect");
    setError(null);
    try {
      window.location.href = await getFigmaConnectUrl();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not start the Figma connect flow."
      );
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy("disconnect");
    setError(null);
    try {
      await disconnectFigma();
      setStatus(DISCONNECTED);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not disconnect Figma.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="figma-panel">
      <p className="figma-muted">
        Attach Figma designs to tickets and user stories. Paste a Figma link on
        any board item and it shows as a titled, thumbnailed reference — the
        design itself stays in Figma.
      </p>

      {error && <p className="figma-error">{error}</p>}

      {!status ? (
        <p className="figma-muted">Loading…</p>
      ) : status.connected ? (
        <div className="figma-row figma-row--between">
          <span>
            Connected as <strong>{status.handle}</strong>
            {status.email ? ` (${status.email})` : ""}
          </span>
          <button
            type="button"
            className="figma-btn"
            onClick={() => void disconnect()}
            disabled={busy === "disconnect"}
          >
            {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
          </button>
        </div>
      ) : (
        <div className="figma-row">
          <button
            type="button"
            className="figma-btn figma-btn--primary"
            onClick={() => void connect()}
            disabled={busy === "connect"}
          >
            {busy === "connect" ? "Redirecting…" : "Connect Figma"}
          </button>
          <span className="figma-muted">
            Read-only — Wayve only ever reads file names and thumbnails.
          </span>
        </div>
      )}
    </div>
  );
}
