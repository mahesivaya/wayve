// Plan A Phase 3 — Secure-send magic-link reader page.
//
// Public route at /m/:token. Anyone with the link can land here; the
// passphrase is what actually unlocks the message. The page fetches
// the ciphertext bundle from /api/secure-messages/{token} (no auth
// required), prompts for the passphrase, derives the KEK via PBKDF2,
// unwraps the DEK, decrypts the body, and renders the plaintext.
//
// At no point does the passphrase leave the browser. Wrong passphrase
// surfaces as a clear "couldn't unlock" error from the AES-GCM auth
// tag failure path in openSecureMessage().

import { FormEvent, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchSecureMessage } from "../api/email";
import {
  openSecureMessage,
  type ServerSecureMessage,
} from "./secureSend";

type LoadState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "ready"; envelope: ServerSecureMessage }
  | { kind: "error"; message: string };

const fmtDate = (iso: string): string => {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
};

export default function SecureMessageView() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setState({ kind: "missing" });
      return;
    }
    let cancelled = false;
    fetchSecureMessage(token)
      .then((envelope) => {
        if (cancelled) return;
        if (!envelope) {
          setState({ kind: "missing" });
        } else {
          setState({ kind: "ready", envelope });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to load message",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (state.kind !== "ready") return;
    setError("");
    setBusy(true);
    try {
      const plaintext = await openSecureMessage(state.envelope, passphrase);
      setBody(plaintext);
      // Wipe the passphrase from state once decryption succeeded —
      // leaving it in React state would let any later XSS / dev-tool
      // session read it. Plaintext stays in state because the user is
      // actively reading it.
      setPassphrase("");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Couldn't unlock this message — check the passphrase.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page" style={{ minHeight: "100vh" }}>
      <div className="login-card" style={{ maxWidth: 560 }}>
        <h2>🔒 Secure message</h2>

        {state.kind === "loading" && (
          <p className="subtitle">Loading…</p>
        )}

        {state.kind === "missing" && (
          <p className="subtitle">
            This link is invalid or has expired. Ask the sender to
            re-send if you still need the message.
          </p>
        )}

        {state.kind === "error" && (
          <p className="subtitle" style={{ color: "#b91c1c" }}>
            {state.message}
          </p>
        )}

        {state.kind === "ready" && body === null && (
          <>
            <p className="subtitle">
              <strong>{state.envelope.sender_email}</strong> sent you a
              secure message on Fluxze.
              <br />
              Subject: <em>{state.envelope.subject}</em>
              <br />
              Expires: {fmtDate(state.envelope.expires_at)}
            </p>
            <p className="subtitle">
              Enter the passphrase the sender shared with you out-of-band
              (Signal, SMS, in person) to decrypt the message in your
              browser. Fluxze never sees the passphrase.
            </p>

            <form onSubmit={handleSubmit}>
              <input
                type="password"
                placeholder="Passphrase"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoComplete="off"
                autoFocus
                required
                style={{
                  padding: "10px",
                  borderRadius: 5,
                  border: "1px solid #ccc",
                  width: "100%",
                  marginBottom: 10,
                }}
              />
              {error && (
                <p
                  className="subtitle"
                  style={{ color: "#b91c1c", marginTop: 0 }}
                >
                  {error}
                </p>
              )}
              <button type="submit" disabled={busy}>
                {busy ? "Unlocking…" : "Unlock message"}
              </button>
            </form>
          </>
        )}

        {state.kind === "ready" && body !== null && (
          <>
            <p className="subtitle">
              From <strong>{state.envelope.sender_email}</strong> · Subject:{" "}
              <em>{state.envelope.subject}</em>
            </p>
            <div
              style={{
                background: "#f9fafb",
                border: "1px solid #e5e7eb",
                borderRadius: 6,
                padding: 16,
                whiteSpace: "pre-wrap",
                fontFamily: "inherit",
                lineHeight: 1.5,
                color: "#111827",
                maxHeight: 480,
                overflow: "auto",
              }}
            >
              {body}
            </div>
            <p
              className="subtitle"
              style={{ marginTop: 12, fontSize: 12, color: "#6b7280" }}
            >
              Decrypted in your browser. This message is not stored
              after you close this tab.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
