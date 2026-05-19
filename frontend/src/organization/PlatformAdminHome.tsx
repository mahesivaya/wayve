import { FormEvent, useEffect, useState } from "react";
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
import "./platformAdmin.css";

export default function PlatformAdminHome() {
  const { user } = useAuth();
  const canManageMembers = hasPermission(user, "members:manage");
  const canManageApiKeys = hasPermission(user, "api_keys:manage");
  const [organizationName, setOrganizationName] = useState("");
  const [adminHandle, setAdminHandle] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [organizations, setOrganizations] = useState<AdminOrganization[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

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
    <div className="platform-admin-home">
      <div className="platform-admin-header">
        <div>
          <h1>Welcome {user?.role_label ?? "Platform member"}</h1>
          <p>{user?.email}</p>
        </div>
      </div>

      {canManageMembers && (
      <section className="platform-admin-panel">
        <div className="platform-admin-section-header">
          <div>
            <h2>Create organization</h2>
            <p>Add a new organization and provision its primary administrator account.</p>
          </div>
        </div>

        <form className="platform-admin-form" onSubmit={createOrganization}>
          <label>
            <span>Organization name</span>
            <input
              value={organizationName}
              onChange={(event) => setOrganizationName(event.target.value)}
              placeholder="Enter organization name"
              required
            />
          </label>
          <label>
            <span>Organization admin handle</span>
            <input
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
          <label>
            <span>Organization admin password</span>
            <input
              type="password"
              value={adminPassword}
              onChange={(event) => setAdminPassword(event.target.value)}
              placeholder="At least 6 characters"
              minLength={6}
              required
            />
          </label>
          <button type="submit" disabled={creating}>
            {creating ? "Creating..." : "Create Organization"}
          </button>
        </form>

        {error && <div className="platform-admin-error">{error}</div>}
        {success && <div className="platform-admin-success">{success}</div>}
      </section>
      )}

      {canManageMembers && (
      <section className="platform-admin-panel">
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
          <div className="organization-name-list">
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
      <section className="platform-admin-panel">
        <div className="platform-admin-section-header">
          <div>
            <h2>API keys</h2>
            <p>Generate keys for programmatic (external) access to an organization.</p>
          </div>
        </div>

        <label className="platform-admin-key-org">
          <span>Organization</span>
          <select
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
            <form className="platform-admin-form" onSubmit={generateKey}>
              <label>
                <span>Key name</span>
                <input
                  value={keyName}
                  onChange={(event) => setKeyName(event.target.value)}
                  placeholder="e.g. CI pipeline"
                  required
                />
              </label>
              <button type="submit" disabled={keyBusy}>
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

      <MembersRolesPanel scope="platform" />
    </div>
  );
}
