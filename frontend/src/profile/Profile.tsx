import { useEffect, useState } from "react";
import { changePassword } from "../api/Auth";
import { getProfile, updateProfile, type ProfileData } from "../api/profile";
import { useAuth } from "../auth/useAuth";
import { logger } from "../utils/logger";
import "./profile.css";

export default function Profile() {
  const { user } = useAuth();
  // Seed from AuthContext (already in memory from /api/me) so the header
  // paints instantly on first visit. getProfile() then fills the fields
  // /api/me doesn't carry (first/last name, auth_provider) — and it's cached,
  // so renavigating to /profile within the TTL makes no network call.
  const [profile, setProfile] = useState<ProfileData | null>(() =>
    user
      ? {
          id: user.id,
          email: user.email,
          first_name: null,
          last_name: null,
          auth_provider: "", // placeholder; overwritten by getProfile()
          account_type: user.account_type ?? undefined,
          effective_role: user.effective_role ?? null,
          role_label: user.role_label ?? null,
          organization_id: user.organization_id ?? null,
          organization_name: user.organization_name ?? null,
        }
      : null,
  );
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const [showPwForm, setShowPwForm] = useState(false);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
  const [pwStatus, setPwStatus] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const data = await getProfile();
        setProfile(data);
        setFirstName(data.first_name ?? "");
        setLastName(data.last_name ?? "");
      } catch (err) {
        logger.error(err);
      }
    };
    void load();
  }, []);

  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(null), 2000);
    return () => clearTimeout(t);
  }, [status]);

  useEffect(() => {
    if (!pwStatus) return;
    const t = setTimeout(() => setPwStatus(null), 2500);
    return () => clearTimeout(t);
  }, [pwStatus]);

  const submitPasswordChange = async () => {
    const isCreatingPassword = profile?.auth_provider === "google";

    if (newPw !== confirmPw) {
      setPwStatus("New passwords do not match");
      return;
    }
    if (newPw.length < 6) {
      setPwStatus("Password must be at least 6 characters");
      return;
    }
    setPwSaving(true);
    try {
      await changePassword(isCreatingPassword ? null : currentPw, newPw);
      setPwStatus(isCreatingPassword ? "Password created ✓" : "Password updated ✓");
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
      setShowPwForm(false);
      setProfile((prev) =>
        prev ? { ...prev, auth_provider: "local" } : prev
      );
    } catch (err: unknown) {
      setPwStatus(err instanceof Error ? err.message : "Update failed");
    } finally {
      setPwSaving(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const data = await updateProfile({
        first_name: firstName,
        last_name: lastName,
      });
      setProfile(data);
      setStatus("Saved ✓");
    } catch {
      setStatus("Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (!profile) {
    return (
      <div className="settings-page">
        <div className="profile-loading">Loading…</div>
      </div>
    );
  }

  const accountType = profile.account_type ?? user?.account_type ?? "personal";
  const roleLabel = profile.role_label ?? user?.role_label ?? "Personal workspace owner";
  const roleKey = profile.effective_role ?? user?.effective_role ?? "owner";

  return (
    <div className="settings-page">
      <div className="settings-stack">

        <h1 className="settings-page-title">My Profile</h1>

        <section className="settings-card">
          <h2 className="settings-card-title">Account</h2>
          <div className="settings-rows">
            <div className="settings-usage-row">
              <span>Email</span>
              <strong>{profile.email}</strong>
            </div>
            <div className="settings-usage-row">
              <span>Account Type</span>
              <strong style={{ textTransform: "capitalize" }}>{accountType}</strong>
            </div>
            <div className="settings-usage-row">
              <span>Access Role</span>
              <strong>{roleLabel}</strong>
            </div>
            <div className="settings-usage-row">
              <span>Role Key</span>
              <strong>{roleKey}</strong>
            </div>
          </div>
        </section>

        <section className="settings-card">
          <h2 className="settings-card-title">Name</h2>

          <div className="profile-row">
            <label htmlFor="profile-first">First name</label>
            <input
              id="profile-first"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="First name"
            />
          </div>

          <div className="profile-row">
            <label htmlFor="profile-last">Last name</label>
            <input
              id="profile-last"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              placeholder="Last name"
            />
          </div>

          <div className="profile-actions">
            <button
              type="button"
              className="profile-save"
              onClick={() => void save()}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {status && <span className="profile-status">{status}</span>}
          </div>
        </section>

        <section className="settings-card">
          <h2 className="settings-card-title">Password</h2>

          {!showPwForm ? (
            <div className="profile-actions">
              <button
                type="button"
                className="profile-save"
                onClick={() => setShowPwForm(true)}
              >
                {profile.auth_provider === "google"
                  ? "Create Password"
                  : "Change Password"}
              </button>
              {pwStatus && <span className="profile-status">{pwStatus}</span>}
            </div>
          ) : (
            <>
              {profile.auth_provider !== "google" && (
                <div className="profile-row">
                  <label htmlFor="profile-current-pw">Current password</label>
                  <input
                    id="profile-current-pw"
                    type="password"
                    value={currentPw}
                    onChange={(e) => setCurrentPw(e.target.value)}
                    autoComplete="current-password"
                  />
                </div>
              )}

              <div className="profile-row">
                <label htmlFor="profile-new-pw">
                  {profile.auth_provider === "google" ? "Password" : "New password"}
                </label>
                <input
                  id="profile-new-pw"
                  type="password"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  autoComplete="new-password"
                />
              </div>

              <div className="profile-row">
                <label htmlFor="profile-confirm-pw">
                  {profile.auth_provider === "google" ? "Confirm password" : "Confirm new password"}
                </label>
                <input
                  id="profile-confirm-pw"
                  type="password"
                  value={confirmPw}
                  onChange={(e) => setConfirmPw(e.target.value)}
                  autoComplete="new-password"
                />
              </div>

              <div className="profile-actions">
                <button
                  type="button"
                  className="profile-save"
                  onClick={() => void submitPasswordChange()}
                  disabled={pwSaving}
                >
                  {pwSaving
                    ? "Saving…"
                    : profile.auth_provider === "google"
                      ? "Create password"
                      : "Update password"}
                </button>
                <button
                  type="button"
                  className="profile-cancel"
                  onClick={() => {
                    setShowPwForm(false);
                    setCurrentPw("");
                    setNewPw("");
                    setConfirmPw("");
                  }}
                  disabled={pwSaving}
                >
                  Cancel
                </button>
                {pwStatus && <span className="profile-status">{pwStatus}</span>}
              </div>
            </>
          )}
        </section>

      </div>
    </div>
  );
}
