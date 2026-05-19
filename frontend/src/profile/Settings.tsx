import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";

import "./profile.css";

import { changePassword } from "../api/Auth";
import { deleteAccount, getAccounts } from "../api/email";
import { getSubscription, type SubscriptionResponse } from "../api/billing";
import { getProfile, type ProfileData } from "../api/profile";
import { useAuth } from "../auth/useAuth";

type Account = {
  id: number;
  email: string;
};

const BYTES_IN_MB = 1024 ** 2;
const BYTES_IN_GB = 1024 ** 3;
const DEFAULT_MEMORY_LIMIT = 10 * BYTES_IN_GB;

export default function Settings() {
  const { user } = useAuth();
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
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordStatus, setPasswordStatus] = useState("");

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

  useEffect(() => {
    if (!passwordStatus) return;
    const timer = window.setTimeout(() => setPasswordStatus(""), 2500);
    return () => window.clearTimeout(timer);
  }, [passwordStatus]);

  const updatePassword = async () => {
    const isCreatingPassword = profile?.auth_provider === "google";

    if (!isCreatingPassword && currentPassword.trim().length === 0) {
      setPasswordStatus("Current password is required");
      return;
    }
    if (newPassword.length < 6) {
      setPasswordStatus("New password must be at least 6 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordStatus("New passwords do not match");
      return;
    }

    setPasswordSaving(true);
    setPasswordStatus("");
    try {
      await changePassword(isCreatingPassword ? null : currentPassword, newPassword);
      setPasswordStatus(isCreatingPassword ? "Password created" : "Password updated");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setProfile((prev) =>
        prev ? { ...prev, auth_provider: "local" } : prev
      );
    } catch (err) {
      setPasswordStatus(err instanceof Error ? err.message : "Password update failed");
    } finally {
      setPasswordSaving(false);
    }
  };

  const remove = async (
    id: number,
    email: string
  ) => {
    if (
      !confirm(
        `Disconnect ${email}? Synced messages will be removed.`
      )
    ) {
      return;
    }

    try {
      await deleteAccount(id);

      setAccounts((prev) =>
        prev.filter(
          (a) => a.id !== id
        )
      );

    } catch {
      alert(
        "Failed to remove account"
      );
    }
  };

  return (
    <div className="settings-page">
      <div className="settings-card">

        <h2 className="settings-title">
          Settings & Privacy
        </h2>

        {user && (
          <div className="settings-usage-section">
            <div className="settings-usage-row">
              <span>User</span>
              <strong>{profile ? `${profile.first_name ?? ""} ${profile.last_name ?? ""}`.trim() || user.email : "Loading…"}</strong>
            </div>
            <div className="settings-usage-row">
              <span>Email</span>
              <strong>{user.email}</strong>
            </div>
            <div className="settings-usage-row">
              <span>Account Type</span>
              <strong style={{ textTransform: "capitalize" }}>{user.account_type}</strong>
            </div>
            <div className="settings-usage-row">
              <span>Access Role</span>
              <strong>{profile?.role_label ?? user.role_label ?? "Personal workspace owner"}</strong>
            </div>
            <div className="settings-usage-row">
              <span>Role Key</span>
              <strong>{profile?.effective_role ?? user.effective_role ?? "owner"}</strong>
            </div>
          </div>
        )}

        <div className="settings-section-title">
          Password
        </div>

        <div className="settings-password-section">
          {profile?.auth_provider !== "google" && (
            <div className="profile-row">
              <label htmlFor="settings-current-password">
                Current password
              </label>
              <input
                id="settings-current-password"
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                autoComplete="current-password"
              />
            </div>
          )}

          <div className="profile-row">
            <label htmlFor="settings-new-password">
              New password
            </label>
            <input
              id="settings-new-password"
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
            />
          </div>

          <div className="profile-row">
            <label htmlFor="settings-confirm-password">
              Confirm new password
            </label>
            <input
              id="settings-confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
            />
          </div>

          <div className="profile-actions">
            <button
              type="button"
              className="profile-save"
              onClick={() => void updatePassword()}
              disabled={passwordSaving}
            >
              {passwordSaving ? "Updating…" : "Update password"}
            </button>
            {passwordStatus && (
              <span className="profile-status">{passwordStatus}</span>
            )}
          </div>
        </div>

        <div className="settings-section-title">
          Storage & Usage
        </div>

        <div className="settings-usage-section">
          <div className="settings-usage-row">
            <span>Memory Used</span>
            <strong className={!loaded ? "settings-loading-text" : ""}>
              {profile?.memory_used_bytes !== undefined 
                ? `${(profile.memory_used_bytes / BYTES_IN_GB).toFixed(1)} GB / 
                   ${((profile.memory_limit_bytes ?? DEFAULT_MEMORY_LIMIT) / BYTES_IN_GB).toFixed(0)} GB` 
                : "Loading…"}
            </strong>
          </div>
          <div className="settings-usage-row">
            <span>Emails</span>
            <strong>
              {profile?.total_emails !== undefined ? `${profile.total_emails.toLocaleString()} emails` : "Loading…"}
            </strong>
          </div>
          <div className="settings-usage-row">
            <span>Email Storage</span>
            <strong>{profile?.email_storage_bytes !== undefined ? `${(profile.email_storage_bytes / BYTES_IN_MB).toFixed(1)} MB` : "Loading…"}</strong>
          </div>
          <div className="settings-usage-row">
            <span>Drive Storage</span>
            <strong>{profile?.drive_storage_bytes !== undefined ? `${(profile.drive_storage_bytes / BYTES_IN_MB).toFixed(1)} MB` : "Loading…"}</strong>
          </div>
          <div className="settings-usage-row">
            <span>Other Apps (Chat, Notes)</span>
            <strong>{profile?.other_storage_bytes !== undefined ? `${(profile.other_storage_bytes / BYTES_IN_MB).toFixed(1)} MB` : "Loading…"}</strong>
          </div>
          <div className="settings-usage-row">
            <span>Connected Accounts</span>
            <strong>
              {loaded ? `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}` : "Loading…"}
            </strong>
          </div>
        </div>

        <div className="settings-section-title">
          Billing &amp; Plans
        </div>

        <div className="settings-usage-section">
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

        <div className="settings-section-title">
          Connected email accounts
        </div>

        {!loaded ? (
          <div className="settings-empty">
            Loading…
          </div>

        ) : accounts.length === 0 ? (
          <div className="settings-empty">
            No email accounts connected.
          </div>

        ) : (
          <div className="settings-list">
            {accounts.map((acc) => (
              <div
                key={acc.id}
                className="settings-account"
              >
                <span className="settings-account-icon">
                  📧
                </span>

                <span
                  className="settings-account-email"
                  title={acc.email}
                >
                  {acc.email}
                </span>

                <button
                  className="settings-account-delete"

                  onClick={() =>
                    void remove(
                      acc.id,
                      acc.email
                    )
                  }
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
