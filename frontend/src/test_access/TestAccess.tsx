import { useEffect, useState } from "react";
import {
  createAccessRequest,
  getMyAccessStatus,
  type MyAccessStatus,
} from "../api/accessRequests";
import "./test_access.css";

const RESOURCE = "test_access";

// Sample page whose data is locked behind an access request. The button
// routes the request to the right support team (platform for personal
// users, the user's organization for org members); once approved the
// unlocked data is returned by the server.
// `embedded` = rendered as a tab of the Requests page, which supplies the
// page title; the panel drops its own header so the two don't stack.
export default function TestAccess({ embedded }: { embedded?: boolean } = {}) {
  const [state, setState] = useState<MyAccessStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    let alive = true;
    getMyAccessStatus(RESOURCE)
      .then((s) => {
        if (!alive) return;
        setState(s);
        setNote(s.request_note ?? "");
      })
      .catch((err) => {
        if (alive)
          setError(
            err instanceof Error ? err.message : "Failed to load status"
          );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const submit = async () => {
    setError("");
    setSuccess("");
    setBusy(true);
    try {
      await createAccessRequest(RESOURCE, note.trim());
      const next = await getMyAccessStatus(RESOURCE);
      setState(next);
      setNote(next.request_note ?? "");
      setSuccess(
        next.status === "pending"
          ? "Request sent to the support team."
          : "Request updated."
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit request");
    } finally {
      setBusy(false);
    }
  };

  const teamLabel =
    state?.target === "organization" ? "organization" : "platform";

  return (
    <main className="test-access-page">
      {!embedded && (
        <header className="test-access-header">
          <h1>Test Access</h1>
          <p>
            This page contains protected sample data that requires approval.
          </p>
        </header>
      )}

      {loading ? (
        <div className="test-access-muted">Loading…</div>
      ) : state?.status === "approved" ? (
        <section className="test-access-section">
          <div className="test-access-unlocked">
            <h2>🔓 Unlocked data</h2>
            <p>{state.data}</p>
          </div>
          {state.decision_note && (
            <p className="test-access-muted">
              Support note: {state.decision_note}
            </p>
          )}
        </section>
      ) : state?.status === "pending" ? (
        <section className="test-access-section">
          <div className="test-access-locked">
            <h2>🔒 Locked</h2>
            <p>
              Your request is pending with the <strong>{teamLabel}</strong>{" "}
              support team.
            </p>
          </div>
          <label className="test-access-label">
            <span>Your explanation</span>
            <textarea
              className="test-access-textarea"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why do you need access?"
            />
          </label>
          <button
            type="button"
            className="test-access-btn"
            onClick={() => void submit()}
            disabled={busy}
          >
            {busy ? "Saving…" : "Update explanation"}
          </button>
          {error && <div className="test-access-error">{error}</div>}
          {success && <div className="test-access-success">{success}</div>}
        </section>
      ) : (
        <section className="test-access-section">
          <div className="test-access-locked">
            <h2>🔒 Locked</h2>
            <p>Request access to view the protected data on this page.</p>
            {state?.status === "denied" && state.decision_note && (
              <p className="test-access-denied">
                Previously denied — support note: {state.decision_note}
              </p>
            )}
          </div>
          <label className="test-access-label">
            <span>Explanation</span>
            <textarea
              className="test-access-textarea"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why do you need access?"
            />
          </label>
          <button
            type="button"
            className="test-access-btn"
            onClick={() => void submit()}
            disabled={busy}
          >
            {busy ? "Sending…" : "Request access"}
          </button>
          {error && <div className="test-access-error">{error}</div>}
          {success && <div className="test-access-success">{success}</div>}
        </section>
      )}
    </main>
  );
}
