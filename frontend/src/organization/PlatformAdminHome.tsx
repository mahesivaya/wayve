import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  createAdminOrganization,
  generateOrganizationApiKey,
  listAdminOrganizations,
  listOrganizationApiKeys,
  revokeOrganizationApiKey,
  type AdminOrganization,
  type ApiKey,
} from "../api/admin";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import { slugify } from "../auth/accountHome";
import MembersRolesPanel from "./MembersRolesPanel";
import "./admin-ui.css";
import "./platformAdmin.css";

export default function PlatformAdminHome() {
  const { user } = useAuth();
  const canManageMembers = hasPermission(user, "members:manage");
  const canManageApiKeys = hasPermission(user, "api_keys:manage");
  const canSeePlatformBilling =
    hasPermission(user, "billing:read") || hasPermission(user, "billing:manage");
  const canSeeDeveloper =
    hasPermission(user, "logs:read") ||
    hasPermission(user, "logs:read_limited") ||
    hasPermission(user, "api_keys:manage");
  const canSeeSupport = hasPermission(user, "members:read");
  const canSeeSecurity =
    hasPermission(user, "audit:read") || hasPermission(user, "security:manage");
  const isPlatformOwner = user?.effective_role === "owner";
  const [organizationName, setOrganizationName] = useState("");
  const [adminHandle, setAdminHandle] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [organizations, setOrganizations] = useState<AdminOrganization[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  // Collapsed by default — the form takes a lot of vertical space when most
  // platform admins are landing here to *browse* existing orgs, not create
  // new ones. The button reveals the form on demand.
  const [showCreateForm, setShowCreateForm] = useState(false);

  // API keys panel
  const [keyOrgId, setKeyOrgId] = useState<number | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState("");
  const [newRawKey, setNewRawKey] = useState("");

  useEffect(() => {
    // Organization data feeds both the member-management panels and API-key
    // panel. Roles without either permission have no organization data to load.
    if (!canManageMembers && !canManageApiKeys) return;

    let alive = true;

    listAdminOrganizations()
      .then((items) => {
        if (alive) setOrganizations(items);
      })
      .catch((err) => {
        if (alive) {
          setError(err instanceof Error ? err.message : "Failed to load organizations");
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [canManageMembers, canManageApiKeys]);

  const createOrganization = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setSuccess("");
    setCreating(true);

    const adminEmail = `${slugify(adminHandle)}@${slugify(organizationName)}.com`;

    try {
      const created = await createAdminOrganization({
        name: organizationName,
        adminUsername: adminHandle,
        adminEmail,
        adminPassword,
      });
      setOrganizations((prev) => {
        const exists = prev.some((item) => item.id === created.id);
        return exists
          ? prev.map((item) => (item.id === created.id ? created : item))
          : [...prev, created].sort((a, b) => a.name.localeCompare(b.name));
      });
      setOrganizationName("");
      setAdminHandle("");
      setAdminPassword("");
      setShowCreateForm(false);
      setSuccess(
        `Created organization ${created.name}` +
          (created.admin ? ` with admin ${created.admin.email}` : "")
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create organization");
    } finally {
      setCreating(false);
    }
  };

  const selectKeyOrg = async (value: string) => {
    setNewRawKey("");
    setKeyError("");
    const id = value ? Number(value) : null;
    setKeyOrgId(id);
    setApiKeys([]);
    if (id == null) return;

    setKeysLoading(true);
    try {
      setApiKeys(await listOrganizationApiKeys(id));
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : "Failed to load API keys");
    } finally {
      setKeysLoading(false);
    }
  };

  const generateKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (keyOrgId == null) return;
    setKeyError("");
    setNewRawKey("");
    setKeyBusy(true);
    try {
      const created = await generateOrganizationApiKey(keyOrgId, keyName.trim());
      setNewRawKey(created.api_key);
      setApiKeys((prev) => [
        {
          id: created.id,
          name: created.name,
          key_preview: created.key_preview,
          created_at: created.created_at,
          last_used_at: null,
          revoked_at: null,
        },
        ...prev,
      ]);
      setKeyName("");
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : "Failed to generate key");
    } finally {
      setKeyBusy(false);
    }
  };

  const revokeKey = async (keyId: number) => {
    if (keyOrgId == null) return;
    setKeyError("");
    try {
      await revokeOrganizationApiKey(keyOrgId, keyId);
      setApiKeys((prev) =>
        prev.map((key) =>
          key.id === keyId
            ? { ...key, revoked_at: new Date().toISOString() }
            : key
        )
      );
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : "Failed to revoke key");
    }
  };

  return (
    <div className="platform-admin-home u-page-shell">
      <div className="platform-admin-header u-panel u-flex-between">
        <div>
          <h1>Welcome {user?.role_label ?? "Platform member"}</h1>
          <p>{user?.email}</p>
        </div>
        {isPlatformOwner && (
          <Link to="/platform/secrets" className="u-btn-primary">
            Create secrets
          </Link>
        )}
      </div>

      {canManageMembers && (
      <section className="platform-admin-panel u-panel">
        <div className="platform-admin-section-header">
          <div>
            <h2>Create organization</h2>
            <p>Add a new organization and provision its primary administrator account.</p>
          </div>
          {!showCreateForm && (
            <button
              type="button"
              className="u-btn-primary"
              onClick={() => {
                setError("");
                setSuccess("");
                setShowCreateForm(true);
              }}
            >
              + Create new organization
            </button>
          )}
        </div>

        {showCreateForm && (
          <form className="platform-admin-form u-form-stack" onSubmit={createOrganization}>
            <label className="u-form-label">
              <span className="u-form-label-text">Organization name</span>
              <input
                className="u-form-control"
                value={organizationName}
                onChange={(event) => setOrganizationName(event.target.value)}
                placeholder="Enter organization name"
                required
              />
            </label>
            <label className="u-form-label">
              <span className="u-form-label-text">Organization admin handle</span>
              <input
                className="u-form-control"
                value={adminHandle}
                onChange={(event) => setAdminHandle(event.target.value)}
                placeholder="e.g. john"
                required
              />
            </label>
            {adminHandle && organizationName && (
              <p className="platform-admin-hint">
                Login email will be{" "}
                <strong>
                  {slugify(adminHandle)}@{slugify(organizationName)}.com
                </strong>
              </p>
            )}
            <label className="u-form-label">
              <span className="u-form-label-text">Organization admin password</span>
              <input
                className="u-form-control"
                type="password"
                value={adminPassword}
                onChange={(event) => setAdminPassword(event.target.value)}
                placeholder="At least 6 characters"
                minLength={6}
                required
              />
            </label>
            <div className="platform-admin-form-actions">
              <button className="u-btn-primary" type="submit" disabled={creating}>
                {creating ? "Creating..." : "Create Organization"}
              </button>
              <button
                type="button"
                className="platform-admin-cancel-btn"
                onClick={() => {
                  setShowCreateForm(false);
                  setOrganizationName("");
                  setAdminHandle("");
                  setAdminPassword("");
                  setError("");
                }}
                disabled={creating}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {error && <div className="platform-admin-error">{error}</div>}
        {success && <div className="platform-admin-success">{success}</div>}
      </section>
      )}

      {canManageMembers && (
      <section className="platform-admin-panel u-panel">
        <div className="platform-admin-section-header">
          <div>
            <h2>Organization names</h2>
            <p>All organizations currently available on the platform.</p>
          </div>
          <span>{organizations.length} total</span>
        </div>

        {loading ? (
          <div className="platform-admin-empty">Loading organizations...</div>
        ) : organizations.length === 0 ? (
          <div className="platform-admin-empty">No organizations created yet.</div>
        ) : (
          <div className="organization-name-list platform-organization-list">
            {organizations.map((org) => (
              <article key={org.id}>
                <strong>{org.name}</strong>
                <span>
                  {org.slug ? `${org.slug}.com · ` : ""}
                  {org.user_count} users
                  {org.admin && (
                    <>
                      <br /><small style={{ color: '#6b7280' }}>Admin: {org.admin.email}</small>
                    </>
                  )}
                </span>
              </article>
            ))}
          </div>
        )}
      </section>
      )}

      {canManageApiKeys && (
      <section className="platform-admin-panel u-panel">
        <div className="platform-admin-section-header">
          <div>
            <h2>API keys</h2>
            <p>Generate keys for programmatic (external) access to an organization.</p>
          </div>
        </div>

        <label className="platform-admin-key-org u-form-label">
          <span className="u-form-label-text">Organization</span>
          <select
            className="u-form-control"
            value={keyOrgId ?? ""}
            onChange={(event) => void selectKeyOrg(event.target.value)}
          >
            <option value="">Select an organization…</option>
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
        </label>

        {keyOrgId != null && (
          <>
            <form className="platform-admin-form u-form-stack" onSubmit={generateKey}>
              <label className="u-form-label">
                <span className="u-form-label-text">Key name</span>
                <input
                  className="u-form-control"
                  value={keyName}
                  onChange={(event) => setKeyName(event.target.value)}
                  placeholder="e.g. CI pipeline"
                  required
                />
              </label>
              <button className="u-btn-primary" type="submit" disabled={keyBusy}>
                {keyBusy ? "Generating..." : "Generate key"}
              </button>
            </form>

            {newRawKey && (
              <div className="platform-admin-key-reveal">
                <strong>Copy this key now — it is shown only once:</strong>
                <code>{newRawKey}</code>
              </div>
            )}

            {keyError && <div className="platform-admin-error">{keyError}</div>}

            {keysLoading ? (
              <div className="platform-admin-empty">Loading keys...</div>
            ) : apiKeys.length === 0 ? (
              <div className="platform-admin-empty">No API keys yet.</div>
            ) : (
              <div className="organization-name-list">
                {apiKeys.map((key) => (
                  <article key={key.id}>
                    <strong>{key.name}</strong>
                    <span>
                      <code>{key.key_preview}</code>
                      <br />
                      <small style={{ color: "#6b7280" }}>
                        {key.revoked_at
                          ? "Revoked"
                          : key.last_used_at
                            ? `Last used ${new Date(key.last_used_at).toLocaleDateString()}`
                            : "Never used"}
                      </small>
                    </span>
                    {!key.revoked_at && (
                      <button
                        type="button"
                        className="platform-admin-key-revoke"
                        onClick={() => void revokeKey(key.id)}
                      >
                        Revoke
                      </button>
                    )}
                  </article>
                ))}
              </div>
            )}
          </>
        )}
      </section>
      )}

      {(canSeePlatformBilling || canSeeDeveloper || canSeeSupport || canSeeSecurity) && (
        <section className="platform-admin-panel u-panel">
          <div className="platform-admin-section-header">
            <div>
              <h2>Platform consoles</h2>
              <p>Role-specific dashboards across the platform team.</p>
            </div>
          </div>
          <div className="organization-name-list platform-console-list">
            {canSeePlatformBilling && (
              <article>
                <strong>Billing</strong>
                <span>Revenue, customer subscriptions, invoices and payroll.</span>
                <Link to="/platform/billing" className="u-btn-primary">Open →</Link>
              </article>
            )}
            {canSeeSupport && (
              <article>
                <strong>Support</strong>
                <span>Customer activity, signups and shared-inbox queue.</span>
                <Link to="/platform/support" className="u-btn-primary">Open →</Link>
              </article>
            )}
            {canSeeDeveloper && (
              <article>
                <strong>Developer</strong>
                <span>API keys, audit traffic, webhooks and integrations.</span>
                <Link to="/platform/developer" className="u-btn-primary">Open →</Link>
              </article>
            )}
            {canSeeSecurity && (
              <article>
                <strong>Security</strong>
                <span>Audit logs, outcome filters and SIEM webhook forwarding.</span>
                <Link to="/security/audit" className="u-btn-primary">Open →</Link>
              </article>
            )}
            {hasPermission(user, "webhooks:manage") && (
              <article>
                <strong>SCIM provisioning</strong>
                <span>Mint bearer tokens so Okta / Entra can provision users.</span>
                <Link to="/settings/scim" className="u-btn-primary">Open →</Link>
              </article>
            )}
          </div>
        </section>
      )}

      <MembersRolesPanel scope="platform" />
    </div>
  );
}
