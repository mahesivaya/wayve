import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";

import "./profile.css";

import { deleteAccount, getAccounts } from "../api/email";
import { getSubscription, type SubscriptionResponse } from "../api/billing";
import { getProfile, type ProfileData } from "../api/profile";

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

export default function Settings() {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<(ProfileData & {
    total_emails?: number;
    email_storage_bytes?: number;
    drive_storage_bytes?: number;
    other_storage_bytes?: number;
    memory_used_bytes?: number;
    memory_limit_bytes?: number;
  }) | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionResponse | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loaded, setLoaded] = useState(false);

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

  useEffect(() => {
    void loadData();
  }, [loadData]);

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
                {profile?.memory_used_bytes !== undefined
                  ? `${formatBytes(profile.memory_used_bytes)} / ${(
                      (profile.memory_limit_bytes ?? DEFAULT_MEMORY_LIMIT) / BYTES_IN_GB
                    ).toFixed(0)} GB`
                  : "Loading…"}
              </strong>
            </div>
            <div className="settings-usage-row">
              <span title="Number of emails synced to your local rwayve mailbox. Your Gmail/Outlook account may hold many more — sync pulls the most recent batch and grows over time.">
                Synced Emails
              </span>
              <strong>
                {profile?.total_emails !== undefined ? `${profile.total_emails.toLocaleString()} emails` : "Loading…"}
              </strong>
            </div>
            <div className="settings-usage-row">
              <span>Email Storage</span>
              <strong>{profile?.email_storage_bytes !== undefined ? formatBytes(profile.email_storage_bytes) : "Loading…"}</strong>
            </div>
            <div className="settings-usage-row">
              <span>Drive Storage</span>
              <strong>{profile?.drive_storage_bytes !== undefined ? formatBytes(profile.drive_storage_bytes) : "Loading…"}</strong>
            </div>
            <div className="settings-usage-row">
              <span>Other Apps (Chat, Notes)</span>
              <strong>{profile?.other_storage_bytes !== undefined ? formatBytes(profile.other_storage_bytes) : "Loading…"}</strong>
            </div>
            <div className="settings-usage-row">
              <span>Connected Accounts</span>
              <strong>
                {loaded ? `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}` : "Loading…"}
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

        <section className="settings-card">
          <h2 className="settings-card-title">Billing &amp; Plans</h2>
          <div className="settings-rows">
            <div className="settings-usage-row">
              <span>Current Plan</span>
              <strong>{subscription?.subscription?.plan_name ?? "Basic User Free"}</strong>
            </div>
            <div className="settings-usage-row">
              <span>Status</span>
              <strong>{subscription?.subscription?.status ?? "free"}</strong>
            </div>
            <div className="settings-usage-row">
              <span>Renewal</span>
              <strong>
                {subscription?.subscription?.current_period_end
                  ? new Date(subscription.subscription.current_period_end).toLocaleDateString()
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

      </div>
    </div>
  );
}
