// Org-admin page for shared inboxes. Lives under /settings/inboxes.
// Requires the `inbox:manage` permission.
//
// Two-pane layout:
//   - LEFT: list of current shared inboxes, each clickable to load members
//   - RIGHT: members panel for the selected inbox + a "Mark as shared" form
//            for one of the user's existing email accounts
//
// Adding a shared inbox = picking one of the admin's already-connected
// email accounts (Gmail / Outlook) and marking it shared. We don't create
// new OAuth connections here — that's done from the existing /emails
// "Connect mailbox" flow.

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import {
  addInboxMember,
  createSharedInbox,
  deleteSharedInbox,
  listInboxMembers,
  listSharedInboxes,
  removeInboxMember,
  updateSharedInbox,
  type InboxMember,
  type SharedInbox,
} from "../api/sharedInboxes";
import { getAccounts } from "../api/email";
import "./sharedInboxes.css";

interface AccountRow {
  id: number;
  email: string;
  display_name?: string | null;
  is_shared?: boolean;
  shared_label?: string | null;
  is_owner?: boolean;
}

export default function SharedInboxes() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const canManage = hasPermission(user, "inbox:manage");

  const [inboxes, setInboxes] = useState<SharedInbox[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [selected, setSelected] = useState<SharedInbox | null>(null);
  const [members, setMembers] = useState<InboxMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  // Share-an-account form
  const [pickAccount, setPickAccount] = useState<number | "">("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);

  // Add-member form
  const [memberEmail, setMemberEmail] = useState("");
  const [memberCanReply, setMemberCanReply] = useState(true);
  const [addingMember, setAddingMember] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [inboxList, accountList] = await Promise.all([
        listSharedInboxes(),
        getAccounts<AccountRow>(),
      ]);
      setInboxes(inboxList);
      setAccounts(accountList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load shared inboxes");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // Load members whenever the selected inbox changes.
  useEffect(() => {
    if (!selected) {
      const timer = window.setTimeout(() => setMembers([]), 0);
      return () => window.clearTimeout(timer);
    }
    let alive = true;
    listInboxMembers(selected.id)
      .then((rows) => {
        if (alive) setMembers(rows);
      })
      .catch((err) => {
        if (alive)
          setError(err instanceof Error ? err.message : "Failed to load members");
      });
    return () => {
      alive = false;
    };
  }, [selected]);

  if (!canManage) {
    return (
      <div className="shared-inboxes">
        <h1>Shared inboxes</h1>
        <p className="shared-inboxes-error">
          You need the <code>inbox:manage</code> permission to view this page.
        </p>
        <button onClick={() => navigate("/home")}>Back to Home</button>
      </div>
    );
  }

  // Candidate accounts: ones the user owns that aren't already shared.
  const candidates = accounts.filter(
    (a) => a.is_owner === true && a.is_shared !== true
  );

  async function onShare(event: React.FormEvent) {
    event.preventDefault();
    if (pickAccount === "") {
      setError("Pick an account to share.");
      return;
    }
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const newInbox = await createSharedInbox({
        account_id: Number(pickAccount),
        label: label.trim() || undefined,
        organization_id: user?.organization_id ?? null,
      });
      setInboxes((prev) => [newInbox, ...prev]);
      setSelected(newInbox);
      setStatus("Inbox shared.");
      setPickAccount("");
      setLabel("");
      // Refresh accounts so the newly-shared one disappears from the
      // candidates list.
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to share");
    } finally {
      setSaving(false);
    }
  }

  async function onRename(id: number, newLabel: string) {
    setError("");
    try {
      const updated = await updateSharedInbox(id, { label: newLabel });
      setInboxes((prev) => prev.map((row) => (row.id === id ? updated : row)));
      if (selected?.id === id) setSelected(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename");
    }
  }

  async function onUnshare(id: number) {
    if (!window.confirm("Un-share this inbox? Members will lose access.")) return;
    setError("");
    try {
      await deleteSharedInbox(id);
      setInboxes((prev) => prev.filter((row) => row.id !== id));
      if (selected?.id === id) setSelected(null);
      setStatus("Inbox un-shared.");
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to un-share");
    }
  }

  async function onAddMember(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    const email = memberEmail.trim();
    if (!email) {
      setError("Enter the user's email.");
      return;
    }
    setAddingMember(true);
    setError("");
    try {
      // The backend's add-member endpoint takes a `user_id`. Resolve the
      // email to an ID by hitting the existing user-lookup endpoint.
      const resp = await fetch(
        `/api/users/by-email?email=${encodeURIComponent(email)}`,
        { credentials: "include" }
      );
      if (!resp.ok) {
        setError("Could not find a user with that email.");
        return;
      }
      const user = (await resp.json()) as { id: number };
      await addInboxMember(selected.id, {
        user_id: user.id,
        can_reply: memberCanReply,
      });
      const refreshed = await listInboxMembers(selected.id);
      setMembers(refreshed);
      setMemberEmail("");
      setStatus("Member added.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add member");
    } finally {
      setAddingMember(false);
    }
  }

  async function onRemoveMember(userId: number) {
    if (!selected) return;
    setError("");
    try {
      await removeInboxMember(selected.id, userId);
      setMembers((prev) => prev.filter((row) => row.user_id !== userId));
      setStatus("Member removed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove member");
    }
  }

  return (
    <div className="shared-inboxes">
      <header className="shared-inboxes-header">
        <h1>Shared inboxes</h1>
        <p>
          Mark a connected mailbox as shared so other members of your
          organization can read and reply from it (e.g. <code>support@</code>,{" "}
          <code>sales@</code>). Status and assignment are tracked per message.
        </p>
      </header>

      {status && <p className="shared-inboxes-status">{status}</p>}
      {error && <p className="shared-inboxes-error">{error}</p>}

      {loading ? (
        <p>Loading…</p>
      ) : (
        <div className="shared-inboxes-grid">
          {/* LEFT: existing inboxes */}
          <aside className="shared-inboxes-list">
            <h2>Inboxes</h2>
            {inboxes.length === 0 ? (
              <p className="shared-inboxes-empty">
                No shared inboxes yet. Share an account from the panel on the right.
              </p>
            ) : (
              <ul>
                {inboxes.map((inbox) => (
                  <li
                    key={inbox.id}
                    className={`shared-inbox-row ${selected?.id === inbox.id ? "selected" : ""}`}
                    onClick={() => setSelected(inbox)}
                  >
                    <div className="shared-inbox-label">
                      <strong>{inbox.shared_label || inbox.email}</strong>
                      <span className="shared-inbox-email">{inbox.email}</span>
                    </div>
                    <button
                      type="button"
                      className="shared-inbox-unshare-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onUnshare(inbox.id);
                      }}
                    >
                      Un-share
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          {/* RIGHT: share form + (when selected) members panel */}
          <section className="shared-inboxes-detail">
            <div className="shared-inboxes-share-form">
              <h2>Share an existing account</h2>
              <form onSubmit={onShare}>
                <label>
                  <span>Account</span>
                  <select
                    value={pickAccount}
                    onChange={(e) =>
                      setPickAccount(
                        e.target.value === "" ? "" : Number(e.target.value)
                      )
                    }
                  >
                    <option value="">Pick a connected mailbox…</option>
                    {candidates.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.email}
                      </option>
                    ))}
                  </select>
                  <small>
                    Only mailboxes you connected via Gmail / Outlook OAuth can be
                    shared. Already-shared mailboxes are hidden.
                  </small>
                </label>
                <label>
                  <span>Label</span>
                  <input
                    type="text"
                    placeholder="Support, Sales, Billing…"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                </label>
                <button type="submit" disabled={saving || pickAccount === ""}>
                  {saving ? "Sharing…" : "Mark as shared"}
                </button>
              </form>
            </div>

            {selected && (
              <div className="shared-inboxes-members-panel">
                <h2>Members of {selected.shared_label || selected.email}</h2>
                <p className="shared-inboxes-rename">
                  <input
                    type="text"
                    defaultValue={selected.shared_label ?? ""}
                    placeholder={selected.email}
                    onBlur={(e) => {
                      const next = e.target.value.trim();
                      if (next !== (selected.shared_label ?? "")) {
                        void onRename(selected.id, next);
                      }
                    }}
                  />
                  <small>Rename — saved on blur.</small>
                </p>

                <ul className="shared-inboxes-members">
                  {members.length === 0 && <li className="muted">No members yet.</li>}
                  {members.map((m) => (
                    <li key={m.user_id}>
                      <div>
                        <strong>{m.first_name ?? m.email}</strong>
                        <span className="muted"> · {m.email}</span>
                      </div>
                      <div className="shared-inbox-member-tags">
                        {m.can_reply && <span className="tag">Can reply</span>}
                        {m.can_manage && <span className="tag">Manager</span>}
                        <button
                          type="button"
                          onClick={() => void onRemoveMember(m.user_id)}
                        >
                          Remove
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>

                <form onSubmit={onAddMember} className="shared-inboxes-add-member">
                  <input
                    type="email"
                    placeholder="teammate@your-org.com"
                    value={memberEmail}
                    onChange={(e) => setMemberEmail(e.target.value)}
                  />
                  <label className="inline">
                    <input
                      type="checkbox"
                      checked={memberCanReply}
                      onChange={(e) => setMemberCanReply(e.target.checked)}
                    />
                    Can reply
                  </label>
                  <button type="submit" disabled={addingMember}>
                    {addingMember ? "Adding…" : "Add member"}
                  </button>
                </form>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
