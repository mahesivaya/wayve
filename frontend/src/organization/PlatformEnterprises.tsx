import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  createEnterpriseOrganization,
  listAdminOrganizations,
  type AdminOrganization,
} from "../api/admin";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import { formatBytes } from "../utils/bytes";
import OrganizationDetailDrawer from "./OrganizationDetailDrawer";
import "./admin-ui.css";
import "./platformAdmin.css";

export default function PlatformEnterprises() {
  const { user } = useAuth();
  // The backend gate for creating an org is platform scope + members:manage.
  const canCreate = hasPermission(user, "members:manage");

  const [enterprises, setEnterprises] = useState<AdminOrganization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedOrg, setSelectedOrg] = useState<AdminOrganization | null>(
    null
  );

  // ---- Create-enterprise form ----
  const [name, setName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createSuccess, setCreateSuccess] = useState("");

  const loadEnterprises = useCallback(() => {
    setLoading(true);
    listAdminOrganizations()
      .then((items) => {
        // Enterprise page: only orgs on the enterprise tier.
        setEnterprises(items.filter((org) => org.tier === "enterprise"));
        setError("");
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load enterprises")
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(loadEnterprises, [loadEnterprises]);

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreateError("");
    setCreateSuccess("");

    const orgName = name.trim();
    const email = ownerEmail.trim().toLowerCase();
    if (!orgName || !email || !ownerPassword) {
      setCreateError("Organization name, owner email, and password are required.");
      return;
    }
    if (ownerPassword.length < 6) {
      setCreateError("Owner password must be at least 6 characters.");
      return;
    }
    // The backend wants username, email, and password together; derive the
    // username from the email local-part so the form stays to three fields.
    const username = email.split("@")[0] || "owner";

    setCreating(true);
    try {
      const created = await createEnterpriseOrganization({
        name: orgName,
        adminUsername: username,
        adminEmail: email,
        adminPassword: ownerPassword,
      });
      setCreateSuccess(
        `Enterprise “${created.name}” created. Owner can sign in at ${email} with the password you set.`
      );
      setName("");
      setOwnerEmail("");
      setOwnerPassword("");
      loadEnterprises();
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Could not create the enterprise."
      );
    } finally {
      setCreating(false);
    }
  };

  const totals = useMemo(() => {
    return enterprises.reduce(
      (acc, ent) => ({
        storage: acc.storage + (ent.storage_used_bytes ?? 0),
        emailAccounts: acc.emailAccounts + (ent.email_account_count ?? 0),
      }),
      { storage: 0, emailAccounts: 0 }
    );
  }, [enterprises]);

  return (
    <div className="platform-admin-home u-page-shell">
      <div className="platform-admin-header u-panel u-flex-between">
        <div>
          <h1>Enterprise</h1>
          <p>All enterprises currently available on the platform.</p>
        </div>
        <Link to="/platform/home" className="u-btn-primary">
          ← Back to platform home
        </Link>
      </div>

      {/* ---- Create a new enterprise + owner ---- */}
      {canCreate && (
        <section className="platform-admin-panel u-panel">
          <div className="platform-admin-section-header">
            <div>
              <h2>Create an enterprise</h2>
              <p>
                Provision a new enterprise organization and its owner account.
                Enterprise data is server-readable (not end-to-end encrypted), so
                the owner can sign in and use the org right away.
              </p>
            </div>
          </div>

          <form
            className="platform-admin-form u-form-stack"
            onSubmit={handleCreate}
          >
            <label className="u-form-label">
              <span className="u-form-label-text">Organization name</span>
              <input
                className="u-form-control"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Corp"
                required
              />
            </label>
            <label className="u-form-label">
              <span className="u-form-label-text">Owner email</span>
              <input
                type="email"
                className="u-form-control"
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
                placeholder="owner@acme.com"
                autoComplete="off"
                required
              />
            </label>
            <label className="u-form-label">
              <span className="u-form-label-text">
                Temporary owner password
              </span>
              <input
                type="password"
                className="u-form-control"
                value={ownerPassword}
                onChange={(e) => setOwnerPassword(e.target.value)}
                placeholder="at least 6 characters · share it with the owner"
                autoComplete="new-password"
                required
              />
            </label>
            <button className="u-btn-primary" type="submit" disabled={creating}>
              {creating ? "Creating…" : "Create enterprise"}
            </button>
          </form>

          {createSuccess && (
            <div className="platform-admin-key-reveal">{createSuccess}</div>
          )}
          {createError && (
            <div className="platform-admin-error">{createError}</div>
          )}
        </section>
      )}

      {/* ---- Existing enterprises ---- */}
      <section className="platform-admin-panel u-panel">
        {loading ? (
          <div className="platform-admin-empty">Loading enterprises…</div>
        ) : error ? (
          <div className="platform-admin-error">{error}</div>
        ) : enterprises.length === 0 ? (
          <div className="platform-admin-empty">No enterprises yet.</div>
        ) : (
          <>
            <div className="platform-stat-grid">
              <div className="platform-stat-block">
                <span className="platform-stat-value">
                  {formatBytes(totals.storage)}
                </span>
                <span className="platform-stat-label">Total memory used</span>
              </div>
              <div className="platform-stat-block">
                <span className="platform-stat-value">
                  {totals.emailAccounts.toLocaleString()}
                </span>
                <span className="platform-stat-label">
                  Total email accounts
                </span>
              </div>
            </div>

            <div className="organization-grid organization-grid--stats">
              {enterprises.map((ent) => (
                <button
                  key={ent.id}
                  type="button"
                  className="organization-grid-tile organization-grid-tile--stats"
                  title={ent.name}
                  onClick={() => setSelectedOrg(ent)}
                >
                  <strong>{ent.name}</strong>
                  <span className="organization-tile-stats">
                    <span>{formatBytes(ent.storage_used_bytes ?? 0)} used</span>
                    <span>
                      {(ent.email_account_count ?? 0).toLocaleString()} email
                      accounts
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </section>

      {selectedOrg && (
        <OrganizationDetailDrawer
          org={selectedOrg}
          maxStorageBytes={Math.max(
            0,
            ...enterprises.map((e) => e.storage_used_bytes ?? 0)
          )}
          onClose={() => setSelectedOrg(null)}
        />
      )}
    </div>
  );
}
