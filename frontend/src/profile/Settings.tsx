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
import {
  getProfile,
  putChatEncryptFiles,
  type ProfileData,
} from "../api/profile";
import {
  deleteMyAccount,
  deleteMyOrganization,
  updateMyOrganization,
} from "../api/admin";
import { useAuth } from "../auth/useAuth";
import { homePathForUser } from "../auth/accountHome";
import { canViewIntegrations, hasPermission } from "../auth/permissions";
import { cachedLoad } from "../api/cache";
import { listMyTickets, type SupportTicket } from "../api/support";
import SupportModal from "../support/SupportModal";
import { fmtDate, fmtShortDate } from "../utils/datetime";
import { isDesktopApp } from "../utils/desktop";
import ThemeCustomizer from "../theme/ThemeCustomizer";

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
  const { user, refresh, logout, switchMode } = useAuth();
  // Desktop shell only: the header ProfileMenu dropdown is gone there, so its
  // account links (My Profile / Integrations / Appearance / Log out) are
  // surfaced as an Account card on this page instead.
  const desktop = isDesktopApp();
  const [appearanceOpen, setAppearanceOpen] = useState(false);

  // The admin-mode toggle also lives only in the header ProfileMenu on the web,
  // so the desktop shell would otherwise strand an owner in normal mode with no
  // way to elevate. Mirror the ProfileMenu switcher here.
  const [switchingMode, setSwitchingMode] = useState(false);
  const inAdminMode = user?.mode === "admin";
  const showModeSwitcher = inAdminMode || (user?.can_switch_admin ?? false);

  const handleSwitchMode = async (target: "normal" | "admin") => {
    if (switchingMode) return;
    setSwitchingMode(true);
    try {
      await switchMode(target);
      navigate(
        target === "admin"
          ? homePathForUser({ ...user, mode: "admin", can_switch_admin: true })
          : "/home"
      );
    } catch {
      // Server refused (e.g. no longer eligible); leave the page as-is.
    } finally {
      setSwitchingMode(false);
    }
  };

  // Free personal accounts see an Upgrade CTA (moved here from the header in the
  // desktop shell). Mirrors the gate + navigation in Layout's header Upgrade.
  const currentPlanCode = user?.current_plan?.code ?? "basic_user";
  const isBasicPersonalUser =
    user?.account_type === "personal" &&
    currentPlanCode === "basic_user" &&
    user?.scope !== "platform" &&
    user?.scope !== "organization";

  const goToUpgrade = () => {
    if (!user) return;
    const params = new URLSearchParams({
      account: user.account_type,
      plan: currentPlanCode,
    });
    void navigate(`/billing?${params.toString()}`, {
      state: {
        accountType: user.account_type,
        currentPlan: user.current_plan,
        userId: user.id,
        email: user.email,
      },
    });
  };
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
  // The "Encrypt files in chat" toggle is shown to personal accounts and to
  // owners (org or platform).
  const isOwner =
    isOrgOwner || (isPlatformUser && user?.effective_role === "owner");
  const isOrgUser = user?.scope === "organization";
  const hideBilling = isPlatformUser || isOrgUser;
  // Self-service account deletion is for personal accounts only — business
  // (organization) and platform team members can't delete their own account.
  const isPersonal = user?.scope === "personal";
  const [deletingOrg, setDeletingOrg] = useState(false);
  const [deleteOrgError, setDeleteOrgError] = useState("");
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteAccountError, setDeleteAccountError] = useState("");

  // Organization rename (owner-only) — moved here from the standalone
  // /organization/settings page so all org settings live in one place.
  const currentOrgName = user?.organization_name ?? "";
  const [orgName, setOrgName] = useState(currentOrgName);
  const [orgSaving, setOrgSaving] = useState(false);
  const [orgSaved, setOrgSaved] = useState(false);
  const [orgError, setOrgError] = useState("");
  const orgDirty =
    orgName.trim().length > 0 && orgName.trim() !== currentOrgName;

  // Admin consoles (SSO, SCIM, …) live as tiles on the org-home dashboard and
  // were previously unreachable from this page — so an admin opening Settings
  // couldn't find SSO. Surface the ones the user may manage here too, reusing
  // the exact permission gates from OrganizationAdminHome.
  const adminConsoles = [
    {
      label: "Single Sign-On (OIDC)",
      description:
        "Let your team sign in with Google Workspace / Okta / Azure AD.",
      path: "/settings/sso",
      visible: hasPermission(user, "sso:manage"),
    },
    {
      label: "SCIM provisioning",
      description: "Mint bearer tokens so Okta / Entra can provision users.",
      path: "/settings/scim",
      visible: hasPermission(user, "webhooks:manage"),
    },
    {
      label: "Webhooks",
      description: "Outgoing event delivery and signing-secret rotation.",
      path: "/settings/webhooks",
      visible: hasPermission(user, "webhooks:manage"),
    },
    {
      label: "Shared inboxes",
      description: "Shared inboxes and customer-support queues.",
      path: "/settings/inboxes",
      visible: hasPermission(user, "inbox:manage"),
    },
    {
      label: "AI provider",
      description: "Choose the AI your team's assistant runs on.",
      path: "/settings/ai",
      visible: hasPermission(user, "ai:manage"),
    },
  ].filter((c) => c.visible);

  // "Encrypt files in chat" toggle (personal accounts + owners).
  const showChatEncrypt = isPersonal || isOwner;
  const [chatEncrypt, setChatEncrypt] = useState(
    user?.chat_encrypt_files ?? true
  );
  const [chatEncryptSaving, setChatEncryptSaving] = useState(false);
  const [chatEncryptError, setChatEncryptError] = useState("");
  useEffect(() => {
    setChatEncrypt(user?.chat_encrypt_files ?? true);
  }, [user?.chat_encrypt_files]);
  const toggleChatEncrypt = async (next: boolean) => {
    setChatEncryptError("");
    setChatEncryptSaving(true);
    setChatEncrypt(next); // optimistic
    try {
      await putChatEncryptFiles(next);
      await refresh();
    } catch (err) {
      setChatEncrypt(!next);
      setChatEncryptError(
        err instanceof Error ? err.message : "Could not update setting"
      );
    } finally {
      setChatEncryptSaving(false);
    }
  };

  const saveOrgName = async () => {
    setOrgError("");
    setOrgSaved(false);
    setOrgSaving(true);
    try {
      await updateMyOrganization(orgName.trim());
      await refresh();
      setOrgSaved(true);
    } catch (err) {
      setOrgError(
        err instanceof Error ? err.message : "Could not rename organization"
      );
    } finally {
      setOrgSaving(false);
    }
  };

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
        `Delete ${orgName}? This permanently removes the organization and every member account provisioned under it. This cannot be undone.`
      )
    ) {
      return;
    }
    setDeleteOrgError("");
    setDeletingOrg(true);
    try {
      await deleteMyOrganization();
      await refresh();
      void navigate("/home", { replace: true });
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
      // loadData only runs on mount, so a short-lived cache is safe — it just
      // spares the 3-request refetch when navigating back to Settings.
      const [accs, prof, sub] = await cachedLoad("settings", 8000, () =>
        Promise.all([getAccounts<Account>(), getProfile(), getSubscription()])
      );
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

        {/* Desktop shell: the Upgrade CTA, moved here from the header. Only for
          free personal accounts, matching the header gate on the web. */}
        {desktop && isBasicPersonalUser && (
          <section className="settings-card settings-upgrade-card">
            <h2 className="settings-card-title">Upgrade</h2>
            <div className="settings-rows">
              <p className="settings-upgrade-blurb">
                Get more storage, higher limits, and team features.
              </p>
              <button
                type="button"
                className="settings-billing-link settings-upgrade-btn"
                onClick={goToUpgrade}
              >
                Upgrade plan
              </button>
            </div>
          </section>
        )}

        {/* Desktop shell: the account links that live in the header ProfileMenu
          dropdown on the web (which the desktop shell hides). */}
        {desktop && (
          <section className="settings-card">
            <h2 className="settings-card-title">Account</h2>
            <div className="settings-rows">
              <button
                type="button"
                className="settings-account-link"
                onClick={() => void navigate("/profile")}
              >
                <span className="settings-account-link-icon">👤</span>
                <span>My Profile</span>
              </button>
              {canViewIntegrations(user) && (
                <button
                  type="button"
                  className="settings-account-link"
                  onClick={() => void navigate("/integrations")}
                >
                  <span className="settings-account-link-icon">🔌</span>
                  <span>Integrations</span>
                </button>
              )}
              <button
                type="button"
                className="settings-account-link"
                aria-expanded={appearanceOpen}
                onClick={() => setAppearanceOpen((o) => !o)}
              >
                <span className="settings-account-link-icon">🎨</span>
                <span>Appearance</span>
                <span className="settings-account-link-chevron">
                  {appearanceOpen ? "▾" : "›"}
                </span>
              </button>
              {appearanceOpen && (
                <div className="settings-appearance-panel">
                  <ThemeCustomizer />
                </div>
              )}
              {showModeSwitcher && (
                <button
                  type="button"
                  className="settings-account-link"
                  disabled={switchingMode}
                  onClick={() =>
                    void handleSwitchMode(inAdminMode ? "normal" : "admin")
                  }
                >
                  <span className="settings-account-link-icon">
                    {inAdminMode ? "🚪" : "🛡️"}
                  </span>
                  <span>
                    {switchingMode
                      ? "Switching…"
                      : inAdminMode
                        ? "Exit admin mode"
                        : "Switch to admin mode"}
                  </span>
                </button>
              )}
              <button
                type="button"
                className="settings-account-link settings-account-logout"
                onClick={() => logout()}
              >
                <span className="settings-account-link-icon">⏻</span>
                <span>Log out</span>
              </button>
            </div>
          </section>
        )}

        {showChatEncrypt && (
          <section className="settings-card">
            <h2 className="settings-card-title">Privacy</h2>
            <div className="settings-rows">
              <label
                className="settings-usage-row"
                style={{ cursor: "pointer" }}
              >
                <span>Encrypt files in chat (end-to-end)</span>
                <span className={`toggle-switch${chatEncrypt ? " on" : ""}`}>
                  <input
                    type="checkbox"
                    className="toggle-switch-input"
                    role="switch"
                    aria-checked={chatEncrypt}
                    checked={chatEncrypt}
                    disabled={chatEncryptSaving}
                    onChange={(e) => void toggleChatEncrypt(e.target.checked)}
                  />
                  <span className="toggle-switch-slider" aria-hidden="true" />
                </span>
              </label>
            </div>
            <p className="settings-support-empty" style={{ textAlign: "left" }}>
              When on, files you attach in chat are encrypted on your device so
              the server can&apos;t read them. When off, attachments are stored
              encrypted at rest but readable by the server.
            </p>
            {chatEncryptError && (
              <p className="settings-danger-error">{chatEncryptError}</p>
            )}
          </section>
        )}

        {adminConsoles.length > 0 && (
          <section className="settings-card">
            <h2 className="settings-card-title">Administration</h2>
            <div className="settings-rows">
              {adminConsoles.map((c) => (
                <div className="settings-usage-row" key={c.path}>
                  <span title={c.description}>{c.label}</span>
                  <button
                    type="button"
                    className="settings-billing-link"
                    onClick={() => navigate(c.path)}
                  >
                    Open
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {(isPersonal || isPlatformUser) && (
          <section className="settings-card">
            <h2 className="settings-card-title">Domains</h2>
            <div className="settings-rows">
              <div className="settings-usage-row">
                <span>Connect a custom domain to your account</span>
                <button
                  type="button"
                  className="settings-billing-link"
                  onClick={() => navigate("/coming-soon")}
                >
                  Manage domains
                </button>
              </div>
            </div>
          </section>
        )}

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

        {!isPlatformUser && (
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
        )}

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
          <section className="settings-card">
            <h2 className="settings-card-title">Organization</h2>
            <div className="settings-rows">
              <label className="settings-usage-row">
                <span>Organization name</span>
                <input
                  value={orgName}
                  maxLength={120}
                  placeholder="Organization name"
                  onChange={(e) => {
                    setOrgName(e.target.value);
                    setOrgSaved(false);
                  }}
                  style={{
                    padding: "6px 10px",
                    border: "1px solid #d1d5db",
                    borderRadius: 6,
                    minWidth: 220,
                  }}
                />
              </label>
            </div>
            {orgError && <p className="settings-danger-error">{orgError}</p>}
            {orgSaved && (
              <p className="settings-support-empty">Organization renamed.</p>
            )}
            <button
              type="button"
              className="settings-billing-link"
              disabled={!orgDirty || orgSaving}
              onClick={() => void saveOrgName()}
            >
              {orgSaving ? "Saving…" : "Save changes"}
            </button>
          </section>
        )}

        {isOrgOwner && (
          <section className="settings-card settings-danger">
            <h2 className="settings-card-title settings-danger-title">
              Danger zone
            </h2>
            <p className="settings-danger-text">
              Permanently delete this organization and every member account
              provisioned under it. This cannot be undone.
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
              {deletingOrg ? "Deleting…" : "Delete organization"}
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
