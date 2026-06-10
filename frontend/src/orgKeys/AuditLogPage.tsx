// Owner / admin view of the org-key audit log. Every fetch of a member's
// escrow, every password reset, every bootstrap, and every key-holder
// promotion leaves a row here. Read-only — there's no edit/delete path
// on the audit log by design (otherwise the audit value is null).

import { useEffect, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { readAuditLog, type AuditEntry } from "./api";

type State =
  | { kind: "loading" }
  | { kind: "ok"; entries: AuditEntry[] }
  | { kind: "error"; message: string };

function formatAction(action: string): string {
  // Map snake_case → Title Case for the column.
  switch (action) {
    case "bootstrap":
      return "Bootstrap";
    case "add_key_holder":
      return "Add key-holder";
    case "fetch_member_escrow":
      return "Fetch member escrow";
    case "list_member_notes":
      return "List member notes";
    case "reset_password":
      return "Reset password";
    case "rotate":
      return "Rotate";
    default:
      return action;
  }
}

export default function AuditLogPage() {
  const { user } = useAuth();
  const orgId = user?.organization_id ?? null;
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    if (!orgId) {
      setState({ kind: "error", message: "Not in an organization." });
      return;
    }
    let cancelled = false;
    readAuditLog(orgId)
      .then((entries) => {
        if (!cancelled) setState({ kind: "ok", entries });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({
            kind: "error",
            message:
              err instanceof Error ? err.message : "Failed to load audit log.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  return (
    <div style={{ padding: 40, maxWidth: 960 }}>
      <h2>🔍 Org master key — access log</h2>
      <p style={{ color: "#6b7280" }}>
        Every use of the organization master key — bootstraps, escrow fetches,
        password resets, and key-holder additions — is recorded here. The log is
        append-only; rows cannot be edited or deleted from the application
        surface.
      </p>

      {state.kind === "loading" && <p>Loading audit log…</p>}

      {state.kind === "error" && (
        <p style={{ color: "#b91c1c" }}>{state.message}</p>
      )}

      {state.kind === "ok" && state.entries.length === 0 && (
        <p style={{ color: "#6b7280" }}>
          No audit entries yet. Bootstrap your org master key, or recover a
          member's data — entries will start appearing here.
        </p>
      )}

      {state.kind === "ok" && state.entries.length > 0 && (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            marginTop: 20,
            fontSize: 14,
          }}
        >
          <thead style={{ background: "#f9fafb" }}>
            <tr>
              <th style={cellStyle}>When</th>
              <th style={cellStyle}>Actor</th>
              <th style={cellStyle}>Role</th>
              <th style={cellStyle}>Action</th>
              <th style={cellStyle}>Target</th>
              <th style={cellStyle}>IP</th>
            </tr>
          </thead>
          <tbody>
            {state.entries.map((entry) => (
              <tr key={entry.id}>
                <td style={cellStyle}>
                  {new Date(entry.created_at).toLocaleString()}
                </td>
                <td style={cellStyle}>{entry.actor_user_id ?? "—"}</td>
                <td style={cellStyle}>{entry.actor_role ?? "—"}</td>
                <td style={{ ...cellStyle, fontWeight: 600 }}>
                  {formatAction(entry.action)}
                </td>
                <td style={cellStyle}>{entry.target_user_id ?? "—"}</td>
                <td
                  style={{
                    ...cellStyle,
                    fontFamily: "monospace",
                    fontSize: 12,
                    color: "#6b7280",
                  }}
                >
                  {entry.ip ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const cellStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderBottom: "1px solid #e5e7eb",
  textAlign: "left",
};
