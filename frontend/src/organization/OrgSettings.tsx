import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { deleteMyOrganization, updateMyOrganization } from "../api/admin";
import "./organizationAdmin.css";
import "./orgSettings.css";

// Owner-only organization profile settings. Currently just rename; the
// backend (PATCH /api/organizations/me) re-derives the slug and busts the
// org-name cache for every member, so a refresh() here updates the header,
// billing page, etc.
export default function OrgSettings() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();

  const isOwner =
    user?.scope === "organization" && user?.effective_role === "owner";
  const current = user?.organization_name ?? "";

  const [name, setName] = useState(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const [deletingOrg, setDeletingOrg] = useState(false);
  const [deleteOrgError, setDeleteOrgError] = useState("");

  if (!isOwner) {
    return (
      <div className="u-page-shell">
        <section className="u-panel org-settings-card">
          <h1 className="org-settings-title">Organization settings</h1>
          <p className="org-settings-note">
            Only the organization owner can change these settings.
          </p>
        </section>
      </div>
    );
  }

  const trimmed = name.trim();
  const dirty = trimmed.length > 0 && trimmed !== current;

  const save = async () => {
    setError("");
    setSaved(false);
    setSaving(true);
    try {
      await updateMyOrganization(trimmed);
      await refresh();
      setSaved(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not rename organization"
      );
    } finally {
      setSaving(false);
    }
  };

  // Revert the owner's account back to a personal account by deleting the
  // organization. The backend requires the subscription to be cancelled first
  // and returns a clear 409 message we surface below.
  const onDeleteOrg = async () => {
    const orgName = current || "this organization";
    if (
      !window.confirm(
        `Delete ${orgName}? Every member account you added will be removed and your own account will revert to a personal account.`
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

  return (
    <div className="u-page-shell">
      <section className="u-panel org-settings-card">
        <h1 className="org-settings-title">Organization settings</h1>

        <label className="org-settings-field">
          <span className="org-settings-label">Organization name</span>
          <input
            className="org-settings-input"
            value={name}
            maxLength={120}
            placeholder="Organization name"
            onChange={(e) => {
              setName(e.target.value);
              setSaved(false);
            }}
          />
        </label>

        {error && <p className="org-settings-error">{error}</p>}
        {saved && <p className="org-settings-success">Organization renamed.</p>}

        <div className="org-settings-actions">
          <button
            className="org-settings-cancel"
            type="button"
            onClick={() => navigate("/organization/home")}
          >
            Back
          </button>
          <button
            className="org-settings-save"
            type="button"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </section>

      <section className="u-panel org-settings-card org-settings-danger">
        <h2 className="org-settings-danger-title">
          Switch back to a personal account
        </h2>
        <p className="org-settings-note">
          This deletes <strong>{current || "the organization"}</strong> and
          reverts your account to a personal account. Every member account you
          provisioned is removed; your own emails, chats, and files stay on your
          account. <strong>Cancel the organization&apos;s subscription on the
          Billing page first</strong> — the organization can&apos;t be deleted
          while a paid plan is active.
        </p>
        {deleteOrgError && (
          <p className="org-settings-error">{deleteOrgError}</p>
        )}
        <div className="org-settings-actions">
          <button
            className="org-settings-cancel"
            type="button"
            onClick={() => navigate("/billing")}
          >
            Go to Billing
          </button>
          <button
            className="org-settings-danger-btn"
            type="button"
            disabled={deletingOrg}
            onClick={() => void onDeleteOrg()}
          >
            {deletingOrg
              ? "Reverting…"
              : "Delete organization & revert to personal"}
          </button>
        </div>
      </section>
    </div>
  );
}
