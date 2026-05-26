import { useEffect, useState } from "react";
import { changePassword } from "../api/Auth";
import { getProfile, updateProfile, type ProfileData } from "../api/profile";
import { logger } from "../utils/logger";
import "./profile.css";

export default function Profile() {
  const [profile, setProfile] = useState<ProfileData | null>(null);
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
    } catch(err) {
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
      <div className="profile-page">
        <div className="profile-loading">Loading…</div>
      </div>
    );
  }

  return (
    <div className="profile-page">
      <div className="profile-card">
        <h2 className="profile-title">My Profile</h2>

        <div className="profile-row">
          <label>Username</label>
          <div className="profile-readonly">{profile.email}</div>
        </div>

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
            className="profile-save"
            onClick={save}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {status && <span className="profile-status">{status}</span>}
        </div>

        <div className="profile-password-section">
          <h3 className="profile-section-title">Password</h3>

          {!showPwForm ? (
            <button
              type="button"
              className="profile-save"
              onClick={() => setShowPwForm(true)}
            >
              {profile.auth_provider === "google"
                ? "Create Password"
                : "Change Password"}
            </button>
          ) : (
            <>
              {profile.auth_provider !== "google" && (
                <div className="profile-row">
                  <label htmlFor="profile-current-pw">
                    Current password
                  </label>
                  <input
                    id="profile-current-pw"
                    type="password"
                    value={currentPw}
                    onChange={(e) => setCurrentPw(e.target.value)}
                  />
                </div>
              )}

              <div className="profile-row">
                <label htmlFor="profile-new-pw">
                  {profile.auth_provider === "google"
                    ? "Password"
                    : "New password"}
                </label>
                <input
                  id="profile-new-pw"
                  type="password"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                />
              </div>

              <div className="profile-row">
                <label htmlFor="profile-confirm-pw">
                  {profile.auth_provider === "google"
                    ? "Confirm password"
                    : "Confirm new password"}
                </label>
                <input
                  id="profile-confirm-pw"
                  type="password"
                  value={confirmPw}
                  onChange={(e) => setConfirmPw(e.target.value)}
                />
              </div>

              <div className="profile-actions">
                <button
                  type="button"
                  className="profile-save"
                  onClick={submitPasswordChange}
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
              </div>
            </>
          )}

          {pwStatus && <p className="profile-status">{pwStatus}</p>}
        </div>
      </div>
    </div>
  );
}
