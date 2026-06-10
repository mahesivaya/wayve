import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";

import "./profile.css";

import { deleteAccount, getAccounts } from "../api/email";
import {
  getSubscription,
  listInvoices,
  type SubscriptionResponse,
  type Invoice,
} from "../api/billing";
import { getProfile, type ProfileData } from "../api/profile";
import { deleteMyAccount, deleteMyOrganization } from "../api/admin";
import { useAuth } from "../auth/useAuth";
import { listMyTickets, type SupportTicket } from "../api/support";
import SupportModal from "../support/SupportModal";
import { fmtDate, fmtShortDate } from "../utils/datetime";

type Account = {
  id: number;
  email: string;
};

const BYTES_IN_KB = 1024;
const BYTES_IN_MB = 1024 ** 2;
const BYTES_IN_GB = 1024 ** 3;
const DEFAULT_MEMORY_LIMIT = 10 * BYTES_IN_GB;

// Picks a human-friendly unit for a byte count. Plain `(b/GB).toFixed(1)`
// hides everything under ~50 MB as "0.0 GB", which made the Memory Used
// row look stuck at zero while email storage was already in the MB range.
function formatBytes(bytes: number): string {
  if (bytes < BYTES_IN_KB) return `${bytes} B`;
  if (bytes < BYTES_IN_MB) return `${(bytes / BYTES_IN_KB).toFixed(1)} KB`;
  if (bytes < BYTES_IN_GB) return `${(bytes / BYTES_IN_MB).toFixed(1)} MB`;
  return `${(bytes / BYTES_IN_GB).toFixed(2)} GB`;
}

function formatMoney(cents: number, currency: string): string {
  return (cents / 100).toLocaleString(undefined, {
    style: "currency",
    currency: (currency || "usd").toUpperCase(),
  });
}

export default function Settings() {
  const navigate = useNavigate();
  const { user, refresh, logout } = useAuth();
  const [profile, setProfile] = useState<
    | (ProfileData & {
        total_emails?: number;
        email_storage_bytes?: number;
        drive_storage_bytes?: number;
        other_storage_bytes?: number;
        memory_used_bytes?: number;
        memory_limit_bytes?: number;
      })
    | null
  >(null);
  const [subscription, setSubscription] = useState<SubscriptionResponse | null>(
    null
  );
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [ticketsLoaded, setTicketsLoaded] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [invoicesLoaded, setInvoicesLoaded] = useState(false);
  const [invoicesError, setInvoicesError] = useState(false);

  // Only the org owner can tear the org back down. Mirrors the backend
  // gate so the danger-zone card simply doesn't render for admins,
  // members, personal accounts, or platform users.
  const isOrgOwner =
    user?.scope === "organization" && user?.effective_role === "owner";
  const isPlatformUser = user?.scope === "platform";
  const isOrgUser = user?.scope === "organization";
  const hideBilling = isPlatformUser || isOrgUser;
  // Self-service account deletion is for personal accounts only — business
  // (organization) and platform team members can't delete their own account.
  const isPersonal = user?.scope === "personal";
  const [deletingOrg, setDeletingOrg] = useState(false);
  const [deleteOrgError, setDeleteOrgError] = useState("");
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteAccountError, setDeleteAccountError] = useState("");

  const onDeleteAccount = async () => {
    // Two-step confirmation — this is irreversible. The second prompt asks
    // the user to type their email so a stray click can't wipe an account.
    if (
      !window.confirm(
        "Permanently delete your account? This removes your emails, chats, " +
          "files, notes and all connected mailboxes. This cannot be undone."
      )
    ) {
      return;
    }
    const typed = window.prompt(
      `To confirm, type your email address (${user?.email ?? ""}):`
    );
    if (typed === null) return;
    if (typed.trim().toLowerCase() !== (user?.email ?? "").toLowerCase()) {
      setDeleteAccountError(
        "That didn't match your email — account not deleted."
      );
      return;
    }
    setDeleteAccountError("");
    setDeletingAccount(true);
    try {
      await deleteMyAccount();
      // Account is gone — clear the session and land on /login.
      logout();
    } catch (err) {
      setDeleteAccountError(
        err instanceof Error ? err.message : "Failed to delete account"
      );
      setDeletingAccount(false);
    }
  };

  const onDeleteOrg = async () => {
    const orgName = user?.organization_name ?? "this organization";
    if (
      !window.confirm(
        `Delete ${orgName}? Every member account you added will be removed and your own account will revert to a personal plan.`
      )
    ) {
      return;
    }
    setDeleteOrgError("");
    setDeletingOrg(true);
    try {
      await deleteMyOrganization();
      await refresh();
      navigate("/home", { replace: true });
    } catch (err) {
      setDeleteOrgError(
        err instanceof Error ? err.message : "Failed to delete organization"
      );
    } finally {
      setDeletingOrg(false);
    }
  };

  const loadData = useCallback(async () => {
    try {
      const [accs, prof, sub] = await Promise.all([
        getAccounts<Account>(),
        getProfile(),
        getSubscription(),
      ]);
      setAccounts(accs);
      setProfile(prof);
      setSubscription(sub);
    } finally {
      setLoaded(true);
    }
  }, []);

  const loadTickets = useCallback(async () => {
    try {
      const rows = await listMyTickets();
      setTickets(rows);
    } catch {
      // Best effort — Support card just shows "Failed to load".
    } finally {
      setTicketsLoaded(true);
    }
  }, []);

  const loadInvoices = useCallback(async () => {
    try {
      const rows = await listInvoices();
      setInvoices(rows);
      setInvoicesError(false);
    } catch {
      // Best effort — the card surfaces a small "couldn't load" note.
      setInvoicesError(true);
    } finally {
      setInvoicesLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadData();
    void loadTickets();
    void loadInvoices();
  }, [loadData, loadTickets, loadInvoices]);

  const remove = async (id: number, email: string) => {
    if (!confirm(`Disconnect ${email}? Synced messages will be removed.`)) {
      return;
    }
    try {
      await deleteAccount(id);
      setAccounts((prev) => prev.filter((a) => a.id !== id));
    } catch {
      alert("Failed to remove account");
    }
  };

  return (
    <div className="settings-page">
      <div className="settings-stack">
        <h1 className="settings-page-title">Settings &amp; Privacy</h1>

        <section className="settings-card">
          <h2 className="settings-card-title">Storage &amp; Usage</h2>
          <div className="settings-rows">
            <div className="settings-usage-row">
              <span>Memory Used</span>
              <strong className={!loaded ? "settings-loading-text" : ""}>
                {profile?.memory_used_bytes === undefined
                  ? "Loading…"
                  : (profile.memory_limit_bytes ?? DEFAULT_MEMORY_LIMIT) < 0
                    ? // A negative limit is the "unlimited" sentinel
                      // (org/enterprise plans store storage_limit_bytes = -1).
                      `${formatBytes(profile.memory_used_bytes)} / Unlimited`
                    : `${formatBytes(profile.memory_used_bytes)} / ${(
                        (profile.memory_limit_bytes ?? DEFAULT_MEMORY_LIMIT) /
                        BYTES_IN_GB
                      ).toFixed(0)} GB`}
              </strong>
            </div>
            <div className="settings-usage-row">
              <span title="Number of emails synced to your local rwayve mailbox. Your Gmail/Outlook account may hold many more — sync pulls the most recent batch and grows over time.">
                Synced Emails
              </span>
              <strong>
                {profile?.total_emails !== undefined
                  ? `${profile.total_emails.toLocaleString()} emails`
                  : "Loading…"}
              </strong>
            </div>
            <div className="settings-usage-row">
              <span>Email Storage</span>
              <strong>
                {profile?.email_storage_bytes !== undefined
                  ? formatBytes(profile.email_storage_bytes)
                  : "Loading…"}
              </strong>
            </div>
            <div className="settings-usage-row">
              <span>Drive Storage</span>
              <strong>
                {profile?.drive_storage_bytes !== undefined
                  ? formatBytes(profile.drive_storage_bytes)
                  : "Loading…"}
              </strong>
            </div>
            <div className="settings-usage-row">
              <span>Other Apps (Chat, Notes)</span>
              <strong>
                {profile?.other_storage_bytes !== undefined
                  ? formatBytes(profile.other_storage_bytes)
                  : "Loading…"}
              </strong>
            </div>
            <div className="settings-usage-row">
              <span>Connected Accounts</span>
              <strong>
                {loaded
                  ? `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}`
                  : "Loading…"}
              </strong>
            </div>
            {loaded && accounts.length > 0 && (
              <div className="settings-accounts-inline">
                {accounts.map((acc) => (
                  <div key={acc.id} className="settings-account">
                    <span className="settings-account-icon">📧</span>
                    <span className="settings-account-email" title={acc.email}>
                      {acc.email}
                    </span>
                    <button
                      className="settings-account-delete"
                      onClick={() => void remove(acc.id, acc.email)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {(!hideBilling || isOrgOwner) && (
          <section className="settings-card">
            <h2 className="settings-card-title">Billing &amp; Plans</h2>
            <div className="settings-rows">
              <div className="settings-usage-row">
                <span>Current Plan</span>
                <strong>
                  {subscription?.subscription?.plan_name ?? "Basic User Free"}
                </strong>
              </div>
              <div className="settings-usage-row">
                <span>Status</span>
                <strong>{subscription?.subscription?.status ?? "free"}</strong>
              </div>
              <div className="settings-usage-row">
                <span>Renewal</span>
                <strong>
                  {subscription?.subscription?.current_period_end
                    ? fmtShortDate(subscription.subscription.current_period_end)
                    : "No paid renewal"}
                </strong>
              </div>
              <div className="settings-usage-row">
                <span>Upgrade plans</span>
                <button
                  className="settings-billing-link"
                  onClick={() => navigate("/billing")}
                >
                  Manage billing &amp; upgrade
                </button>
              </div>
            </div>
          </section>
        )}

        <section className="settings-card">
          <h2 className="settings-card-title">Transaction history</h2>
          {!invoicesLoaded ? (
            <p className="settings-loading-text">Loading transactions…</p>
          ) : invoicesError ? (
            <p className="settings-support-empty">
              Couldn't load your transactions. Try again later.
            </p>
          ) : invoices.length === 0 ? (
            <p className="settings-support-empty">
              No transactions yet. Charges and invoices will appear here once
              you upgrade to a paid plan.
            </p>
          ) : (
            <ul className="settings-txn-list">
              {invoices.map((inv) => {
                const link = inv.hosted_invoice_url ?? inv.invoice_pdf;
                return (
                  <li key={inv.id} className="settings-txn-row">
                    <div className="settings-txn-main">
                      <span className="settings-txn-amount">
                        {formatMoney(inv.amount_due_cents, inv.currency)}
                      </span>
                      <span className="settings-txn-meta">
                        {fmtDate(inv.created_at)}
                        {link && (
                          <>
                            {" · "}
                            <a
                              href={link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="settings-link-button"
                            >
                              View invoice
                            </a>
                          </>
                        )}
                      </span>
                    </div>
                    <span
                      className={`settings-txn-status status-${inv.status}`}
                    >
                      {inv.status}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="settings-card">
          <div className="settings-support-head">
            <h2 className="settings-card-title">Support</h2>
            <button
              type="button"
              className="settings-billing-link"
              onClick={() => setSupportOpen(true)}
            >
              Report an issue
            </button>
          </div>
          {!ticketsLoaded ? (
            <p className="settings-loading-text">Loading tickets…</p>
          ) : tickets.length === 0 ? (
            <p className="settings-support-empty">
              No tickets yet. If something isn't working, use{" "}
              <button
                type="button"
                className="settings-link-button"
                onClick={() => setSupportOpen(true)}
              >
                Report an issue
              </button>{" "}
              and we'll reply by email.
            </p>
          ) : (
            <ul className="settings-ticket-list">
              {tickets.map((t) => (
                <li key={t.id} className="settings-ticket-row">
                  <div className="settings-ticket-main">
                    <span className="settings-ticket-subject" title={t.subject}>
                      #{t.id} · {t.subject}
                    </span>
                    <span className="settings-ticket-meta">
                      {t.category} · {fmtDate(t.created_at)}
                      {t.attachment_count > 0 &&
                        ` · ${t.attachment_count} attachment${t.attachment_count === 1 ? "" : "s"}`}
                    </span>
                  </div>
                  <span className={`settings-ticket-status status-${t.status}`}>
                    {t.status.replace("_", " ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {isOrgOwner && (
          <section className="settings-card settings-danger">
            <h2 className="settings-card-title settings-danger-title">
              Danger zone
            </h2>
            <p className="settings-danger-text">
              Delete the organization and revert your own account to a personal
              account. Every member account you provisioned will be removed.
              Your own emails, chats, and files stay on your account.
            </p>
            {deleteOrgError && (
              <p className="settings-danger-error">{deleteOrgError}</p>
            )}
            <button
              type="button"
              className="settings-danger-btn"
              onClick={() => void onDeleteOrg()}
              disabled={deletingOrg}
            >
              {deletingOrg
                ? "Deleting…"
                : "Delete organization & revert to personal"}
            </button>
          </section>
        )}

        {/* Self-service account deletion is personal-accounts only. Business
            (organization) and platform team members can't delete their own
            account here — org owners tear down the whole org above instead. */}
        {isPersonal && (
          <section className="settings-card settings-danger settings-danger-compact">
            <div className="settings-danger-row">
              <span className="settings-danger-line">
                Permanently delete your account and all of your data.
              </span>
              <button
                type="button"
                className="settings-danger-btn"
                onClick={() => void onDeleteAccount()}
                disabled={deletingAccount}
              >
                {deletingAccount ? "Deleting…" : "Delete account"}
              </button>
            </div>
            {deleteAccountError && (
              <p className="settings-danger-error">{deleteAccountError}</p>
            )}
          </section>
        )}
      </div>

      {supportOpen && (
        <SupportModal
          onClose={() => setSupportOpen(false)}
          onSubmitted={() => void loadTickets()}
        />
      )}
    </div>
  );
}
