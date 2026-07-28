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
  putMeetingAlertMinutes,
  type ProfileData,
} from "../api/profile";
import {
  deleteMyAccount,
  deleteMyOrganization,
  updateMyOrganization,
  updateOrgSprintDays,
} from "../api/admin";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import { cachedLoad } from "../api/cache";
import { listMyTickets, type SupportTicket } from "../api/support";
import SupportModal from "../support/SupportModal";
import SupportTicketView from "../support/SupportTicketView";
import { fmtDate, fmtShortDate } from "../utils/datetime";
import { isDesktopApp } from "../utils/desktop";
import SettingsShell from "./SettingsShell";
import {
  desktopNotificationsEnabled,
  notificationSupport,
  requestNotificationPermission,
  setDesktopNotificationsEnabled,
  type NotificationSupport,
} from "../components/desktopNotifications";

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
  // Desktop shell only: the header ProfileMenu dropdown is gone there, so its
  // account links (My Profile / Integrations / Appearance / Log out) are
  // surfaced as an Account card on this page instead.
  const desktop = isDesktopApp();

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
  // The ticket being read, or null. Read-only — see SupportTicketView.
  const [viewingTicketId, setViewingTicketId] = useState<number | null>(null);
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

  // Meeting alert lead time. Server-stored so it follows the user across
  // devices; 0 means meeting alerts are off.
  const MEETING_LEAD_CHOICES = [0, 5, 10, 15, 30];
  // Derived from `user` rather than mirrored into state, so there's no effect
  // resyncing the two. `pendingLead` is the optimistic override shown while the
  // PUT is in flight; clearing it falls back to whatever the server now says —
  // which reverts the control automatically if the save failed.
  const [pendingLead, setPendingLead] = useState<number | null>(null);
  const [meetingLeadError, setMeetingLeadError] = useState("");
  const meetingLead = pendingLead ?? user?.meeting_alert_minutes ?? 10;
  const changeMeetingLead = async (next: number) => {
    setMeetingLeadError("");
    setPendingLead(next);
    try {
      await putMeetingAlertMinutes(next);
      await refresh();
    } catch (err) {
      setMeetingLeadError(
        err instanceof Error ? err.message : "Could not update setting"
      );
    } finally {
      setPendingLead(null);
    }
  };

  // Org sprint (cycle) length in days, 1–90. Same optimistic pattern as the
  // meeting-lead control; the value lives on the organization, not the user.
  const [pendingSprint, setPendingSprint] = useState<number | null>(null);
  const [sprintError, setSprintError] = useState("");
  const sprintDays =
    pendingSprint ?? user?.organization_sprint_total_days ?? 14;
  const changeSprintDays = async (next: number) => {
    const clamped = Math.min(90, Math.max(1, Math.round(next)));
    if (clamped === sprintDays) return;
    setSprintError("");
    setPendingSprint(clamped);
    try {
      await updateOrgSprintDays(clamped);
      await refresh();
    } catch (err) {
      setSprintError(
        err instanceof Error ? err.message : "Could not update sprint length"
      );
    } finally {
      setPendingSprint(null);
    }
  };

  // Desktop (OS-level) notifications are per-device: browser permission plus a
  // local switch. Deliberately not server-stored — see desktopNotifications.ts.
  const [notifPermission, setNotifPermission] = useState<NotificationSupport>(
    () => notificationSupport()
  );
  const [desktopNotifs, setDesktopNotifs] = useState(() =>
    desktopNotificationsEnabled()
  );
  const enableDesktopNotifs = async () => {
    setNotifPermission(await requestNotificationPermission());
  };
  const toggleDesktopNotifs = (next: boolean) => {
    setDesktopNotificationsEnabled(next);
    setDesktopNotifs(next);
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
    <SettingsShell title={<>Settings &amp; Privacy</>}>
      <>
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

        <section className="settings-card">
          <h2 className="settings-card-title">Notifications</h2>
          <div className="settings-rows">
            <label className="settings-usage-row">
              <span>Alert me before a meeting starts</span>
              <select
                className="settings-select"
                value={meetingLead}
                disabled={pendingLead !== null}
                onChange={(e) => void changeMeetingLead(Number(e.target.value))}
              >
                {MEETING_LEAD_CHOICES.map((m) => (
                  <option key={m} value={m}>
                    {m === 0 ? "Off" : `${m} minutes before`}
                  </option>
                ))}
              </select>
            </label>

            <label className="settings-usage-row" style={{ cursor: "pointer" }}>
              <span>
                Also show a desktop notification
                <small>This device only</small>
              </span>
              {notifPermission === "granted" ? (
                <span className={`toggle-switch${desktopNotifs ? " on" : ""}`}>
                  <input
                    type="checkbox"
                    className="toggle-switch-input"
                    role="switch"
                    aria-checked={desktopNotifs}
                    checked={desktopNotifs}
                    onChange={(e) => toggleDesktopNotifs(e.target.checked)}
                  />
                  <span className="toggle-switch-slider" aria-hidden="true" />
                </span>
              ) : (
                <button
                  type="button"
                  className="settings-secondary-btn"
                  disabled={
                    notifPermission === "denied" ||
                    notifPermission === "unsupported"
                  }
                  onClick={() => void enableDesktopNotifs()}
                >
                  {notifPermission === "denied"
                    ? "Blocked in browser"
                    : notifPermission === "unsupported"
                      ? "Not supported"
                      : "Enable"}
                </button>
              )}
            </label>
          </div>
          <p className="settings-support-empty" style={{ textAlign: "left" }}>
            Meeting alerts appear as a card in the corner of the app. Desktop
            notifications additionally surface them outside the browser, but
            only while Wayve is open in a tab.
            {notifPermission === "denied" &&
              " Your browser is blocking notifications for this site — re-allow them in site settings to turn this on."}
          </p>
          {meetingLeadError && (
            <p className="settings-danger-error">{meetingLeadError}</p>
          )}
        </section>

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

        {/* Deliberately NOT in the Administration card below. That card is
            gated per-console and, for org/platform accounts, is hidden entirely
            in normal session mode (downscope_for_mode demotes a non-personal
            owner to `member`) — which made this page unreachable without first
            switching to admin mode. Reading statuses is ungated on the backend
            and the page renders read-only without `task_statuses:manage`, so
            the entry point is always shown and the page itself decides whether
            editing is offered. */}
        <section className="settings-card">
          <h2 className="settings-card-title">Tasks</h2>
          <div className="settings-rows">
            <div className="settings-usage-row">
              <span data-tooltip="Name, colour and order the statuses tasks move through.">
                Task statuses
              </span>
              <button
                type="button"
                className="settings-billing-link"
                onClick={() => navigate("/settings/statuses")}
              >
                Open
              </button>
            </div>
          </div>
        </section>

        {adminConsoles.length > 0 && (
          <section className="settings-card">
            <h2 className="settings-card-title">Administration</h2>
            <div className="settings-rows">
              {adminConsoles.map((c) => (
                <div className="settings-usage-row" key={c.path}>
                  <span data-tooltip={c.description}>{c.label}</span>
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
              <span data-tooltip="Number of emails synced to your local rwayve mailbox. Your Gmail/Outlook account may hold many more — sync pulls the most recent batch and grows over time.">
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
                    <span
                      className="settings-account-email"
                      data-tooltip={acc.email}
                    >
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
                <li key={t.id}>
                  {/* The whole row opens the ticket read-only, so the status
                      pill is clickable along with everything else — a filed
                      report is a record, not a form to reopen. */}
                  <button
                    type="button"
                    className="settings-ticket-row settings-ticket-row--open"
                    onClick={() => setViewingTicketId(t.id)}
                    aria-label={`Open ticket #${t.id}: ${t.subject}`}
                  >
                    <span className="settings-ticket-main">
                      <span
                        className="settings-ticket-subject"
                        data-tooltip={t.subject}
                      >
                        #{t.id} · {t.subject}
                      </span>
                      <span className="settings-ticket-meta">
                        {t.category} · {fmtDate(t.created_at)}
                        {t.attachment_count > 0 &&
                          ` · ${t.attachment_count} attachment${t.attachment_count === 1 ? "" : "s"}`}
                      </span>
                    </span>
                    <span
                      className={`settings-ticket-status status-${t.status}`}
                    >
                      {t.status.replace("_", " ")}
                    </span>
                  </button>
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
              <label className="settings-usage-row">
                <span>Sprint length (days)</span>
                <input
                  type="number"
                  min={1}
                  max={90}
                  step={1}
                  // Uncontrolled + keyed to the saved value so it resets to the
                  // canonical number after a save; commits on blur / Enter.
                  key={sprintDays}
                  defaultValue={sprintDays}
                  disabled={pendingSprint !== null}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  onBlur={(e) => void changeSprintDays(Number(e.target.value))}
                  style={{
                    padding: "6px 10px",
                    border: "1px solid #d1d5db",
                    borderRadius: 6,
                    minWidth: 90,
                  }}
                />
              </label>
            </div>
            {sprintError && (
              <p className="settings-danger-error">{sprintError}</p>
            )}
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

        {supportOpen && (
          <SupportModal
            onClose={() => setSupportOpen(false)}
            onSubmitted={() => void loadTickets()}
          />
        )}

        <SupportTicketView
          ticketId={viewingTicketId}
          onClose={() => setViewingTicketId(null)}
        />
      </>
    </SettingsShell>
  );
}
