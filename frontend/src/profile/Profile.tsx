import { useEffect, useState, type ChangeEvent } from "react";
import { changePassword } from "../api/Auth";
import { buildLoginWrapForPassword } from "../orgKeys/memberLogin";
import {
  deleteAvatar,
  getProfile,
  updateProfile,
  uploadAvatar,
  type ProfileData,
} from "../api/profile";
import { useAuth } from "../auth/useAuth";
import Avatar from "../components/Avatar";
import { getApiBase } from "../config/env";
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
      : null
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

  // Avatar upload. `avatarBust` cache-busts the <img> after a successful upload
  // so the new image shows immediately despite the serve URL being unchanged.
  const [avatarBust, setAvatarBust] = useState(0);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  // Success confirmation ("photo updated/removed"), auto-cleared like `status`.
  const [avatarNotice, setAvatarNotice] = useState<string | null>(null);
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);

  const onPickAvatar = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the user re-pick the same file later
    if (!file) return;
    setAvatarBusy(true);
    setAvatarError(null);
    setAvatarNotice(null);
    try {
      const hadAvatar = Boolean(profile?.avatar_url);
      const { avatar_url } = await uploadAvatar(file);
      setProfile((p) => (p ? { ...p, avatar_url } : p));
      setAvatarBust((b) => b + 1);
      setAvatarNotice(
        hadAvatar ? "✓ Profile photo updated" : "✓ Profile photo uploaded"
      );
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setAvatarBusy(false);
    }
  };

  const onRemoveAvatar = async () => {
    setAvatarBusy(true);
    setAvatarError(null);
    setAvatarNotice(null);
    try {
      await deleteAvatar();
      setProfile((p) => (p ? { ...p, avatar_url: null } : p));
      setAvatarBust((b) => b + 1);
      setAvatarNotice("✓ Profile photo removed");
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setAvatarBusy(false);
    }
  };

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

  // The avatar confirmation lingers a touch longer than the save toast so it
  // isn't missed while the eye is on the photo, then clears itself.
  useEffect(() => {
    if (!avatarNotice) return;
    const t = setTimeout(() => setAvatarNotice(null), 3000);
    return () => clearTimeout(t);
  }, [avatarNotice]);

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
      // If this device has the user's E2E private key cached, re-wrap it under
      // the new password so the server-side login envelope
      // (member_login_wrapped_keys) stays in sync — otherwise the backend
      // rejects the change ("must include the re-wrapped login envelope") or
      // the user gets locked out at next login.
      const newLoginWrap = await buildLoginWrapForPassword(
        user?.id,
        user?.email,
        newPw
      );
      await changePassword(
        isCreatingPassword ? null : currentPw,
        newPw,
        newLoginWrap
      );
      setPwStatus(
        isCreatingPassword ? "Password created ✓" : "Password updated ✓"
      );
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
      setShowPwForm(false);
      setProfile((prev) => (prev ? { ...prev, auth_provider: "local" } : prev));
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
  const roleLabel =
    profile.role_label ?? user?.role_label ?? "Personal workspace owner";
  const roleKey = profile.effective_role ?? user?.effective_role ?? "owner";

  return (
    <div className="settings-page">
      <div className="settings-stack">
        <h1 className="settings-page-title">My Profile</h1>

        <section className="settings-card">
          <h2 className="settings-card-title">Profile photo</h2>
          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            <div style={{ position: "relative", width: 72, height: 72 }}>
              <Avatar
                name={profile.email}
                src={
                  profile.avatar_url
                    ? `${getApiBase()}${profile.avatar_url}?v=${avatarBust}`
                    : undefined
                }
                size={72}
              />
              {/* Single small edit button overlaid on the avatar; opens a
                  compact menu to change or remove the photo. */}
              <button
                type="button"
                onClick={() => setAvatarMenuOpen((o) => !o)}
                disabled={avatarBusy}
                aria-label="Edit profile photo"
                aria-haspopup="menu"
                aria-expanded={avatarMenuOpen}
                title="Edit profile photo"
                style={{
                  position: "absolute",
                  right: -2,
                  bottom: -2,
                  width: 26,
                  height: 26,
                  borderRadius: "50%",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "2px solid var(--color-surface, #fff)",
                  background: "var(--color-primary-action, #2563eb)",
                  color: "#fff",
                  cursor: avatarBusy ? "default" : "pointer",
                  fontSize: 12,
                  lineHeight: 1,
                  padding: 0,
                }}
              >
                {avatarBusy ? "…" : "✎"}
              </button>

              {avatarMenuOpen && (
                <>
                  {/* Click-away backdrop. */}
                  <div
                    onClick={() => setAvatarMenuOpen(false)}
                    style={{ position: "fixed", inset: 0, zIndex: 10 }}
                  />
                  <div
                    role="menu"
                    style={{
                      position: "absolute",
                      top: "78px",
                      left: 0,
                      zIndex: 11,
                      minWidth: 150,
                      background: "var(--color-surface, #fff)",
                      border: "1px solid var(--color-border, #d1d5db)",
                      borderRadius: 8,
                      boxShadow: "0 6px 18px rgba(0,0,0,0.15)",
                      overflow: "hidden",
                    }}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      className="avatar-menu-item"
                      onClick={() => {
                        setAvatarMenuOpen(false);
                        document.getElementById("avatar-input")?.click();
                      }}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: "8px 12px",
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                      }}
                    >
                      {profile.avatar_url ? "Change photo" : "Upload photo"}
                    </button>
                    {profile.avatar_url && (
                      <button
                        type="button"
                        role="menuitem"
                        className="avatar-menu-item"
                        onClick={() => {
                          setAvatarMenuOpen(false);
                          void onRemoveAvatar();
                        }}
                        style={{
                          display: "block",
                          width: "100%",
                          textAlign: "left",
                          padding: "8px 12px",
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "#dc2626",
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>

            <div>
              <input
                id="avatar-input"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => void onPickAvatar(e)}
                disabled={avatarBusy}
                style={{ display: "none" }}
              />
              <p style={{ margin: 0, fontSize: "0.85em", opacity: 0.7 }}>
                PNG, JPEG, or WebP. Max 2 MB.
              </p>
              {avatarError && (
                <span className="profile-status profile-status-error">
                  {avatarError}
                </span>
              )}
              {!avatarError && avatarNotice && (
                <span className="profile-status">{avatarNotice}</span>
              )}
            </div>
          </div>
        </section>

        <section className="settings-card">
          <h2 className="settings-card-title">Account</h2>
          <div className="settings-rows">
            <div className="settings-usage-row">
              <span>Email</span>
              <strong>{profile.email}</strong>
            </div>
            <div className="settings-usage-row">
              <span>Account Type</span>
              <strong style={{ textTransform: "capitalize" }}>
                {accountType}
              </strong>
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
                  {profile.auth_provider === "google"
                    ? "Password"
                    : "New password"}
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
                  {profile.auth_provider === "google"
                    ? "Confirm password"
                    : "Confirm new password"}
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
