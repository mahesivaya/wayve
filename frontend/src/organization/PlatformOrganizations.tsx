import { FormEvent, useEffect, useState } from "react";
import {
  generateOrganizationApiKey,
  listAdminOrganizations,
  listOrganizationApiKeys,
  revokeOrganizationApiKey,
  type AdminOrganization,
  type ApiKey,
} from "../api/admin";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import { fmtShortDate } from "../utils/datetime";
import { formatBytes } from "../utils/bytes";
import OrganizationDetailDrawer from "./OrganizationDetailDrawer";
import "./admin-ui.css";
import "./platformAdmin.css";

export default function PlatformOrganizations() {
  const { user } = useAuth();
  const canManageMembers = hasPermission(user, "members:manage");
  const canManageApiKeys = hasPermission(user, "api_keys:manage");

  const [organizations, setOrganizations] = useState<AdminOrganization[]>([]);
  const [loading, setLoading] = useState(true);
  const [, setError] = useState("");
  const [selectedOrg, setSelectedOrg] = useState<AdminOrganization | null>(
    null
  );
  const [viewMode, setViewMode] = useState<"list" | "block">("list");

  const [keyOrgId, setKeyOrgId] = useState<number | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState("");
  const [newRawKey, setNewRawKey] = useState("");

  useEffect(() => {
    if (!canManageMembers && !canManageApiKeys) return;

    let alive = true;

    listAdminOrganizations()
      .then((items) => {
        // Business page: every org that is NOT on the enterprise tier
        // (Startups / Business / not-yet-subscribed). Enterprise orgs live on
        // the dedicated /platform/enterprise page.
        if (alive)
          setOrganizations(items.filter((org) => org.tier !== "enterprise"));
      })
      .catch((err) => {
        if (alive) {
          setError(
            err instanceof Error ? err.message : "Failed to load organizations"
          );
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [canManageMembers, canManageApiKeys]);

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
      setKeyError(
        err instanceof Error ? err.message : "Failed to load API keys"
      );
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
      const created = await generateOrganizationApiKey(
        keyOrgId,
        keyName.trim()
      );
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
      setKeyError(
        err instanceof Error ? err.message : "Failed to generate key"
      );
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
      {canManageMembers && (
        <section className="platform-admin-panel u-panel">
          <div className="platform-admin-section-header">
            <div>
              <h2>Business</h2>
              <p>All businesses currently available on the platform.</p>
            </div>
            <div className="org-header-right">
              <span>{organizations.length} total</span>
              <div
                className="org-view-toggle"
                role="group"
                aria-label="View mode"
              >
                <button
                  type="button"
                  className={viewMode === "list" ? "active" : ""}
                  aria-pressed={viewMode === "list"}
                  title="List view"
                  onClick={() => setViewMode("list")}
                >
                  ☰
                </button>
                <button
                  type="button"
                  className={viewMode === "block" ? "active" : ""}
                  aria-pressed={viewMode === "block"}
                  title="Block view"
                  onClick={() => setViewMode("block")}
                >
                  ▦
                </button>
              </div>
            </div>
          </div>

          {loading ? (
            <div className="platform-admin-empty">Loading businesses...</div>
          ) : organizations.length === 0 ? (
            <div className="platform-admin-empty">
              No businesses created yet.
            </div>
          ) : viewMode === "list" ? (
            <table className="org-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="org-table-num">Members</th>
                  <th className="org-table-num">Email accounts</th>
                  <th className="org-table-num">Storage</th>
                  <th>Admin</th>
                </tr>
              </thead>
              <tbody>
                {organizations.map((org) => (
                  <tr
                    key={org.id}
                    className="org-table-row"
                    onClick={() => setSelectedOrg(org)}
                    title={`View ${org.name}`}
                  >
                    <td>
                      <strong>{org.name}</strong>
                    </td>
                    <td className="org-table-num">{org.user_count}</td>
                    <td className="org-table-num">
                      {org.email_account_count ?? 0}
                    </td>
                    <td className="org-table-num">
                      {formatBytes(org.storage_used_bytes ?? 0)}
                    </td>
                    <td>{org.admin?.email ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="organization-grid">
              {organizations.map((org) => (
                <button
                  key={org.id}
                  type="button"
                  className="organization-grid-tile"
                  title={org.name}
                  onClick={() => setSelectedOrg(org)}
                >
                  <strong>{org.name}</strong>
                </button>
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
              <p>
                Generate keys for programmatic (external) access to a business.
              </p>
            </div>
          </div>

          <label className="platform-admin-key-org u-form-label">
            <span className="u-form-label-text">Business</span>
            <select
              className="u-form-control"
              value={keyOrgId ?? ""}
              onChange={(event) => void selectKeyOrg(event.target.value)}
            >
              <option value="">Select a business…</option>
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          </label>

          {keyOrgId != null && (
            <>
              <form
                className="platform-admin-form u-form-stack"
                onSubmit={generateKey}
              >
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
                <button
                  className="u-btn-primary"
                  type="submit"
                  disabled={keyBusy}
                >
                  {keyBusy ? "Generating..." : "Generate key"}
                </button>
              </form>

              {newRawKey && (
                <div className="platform-admin-key-reveal">
                  <strong>Copy this key now — it is shown only once:</strong>
                  <code>{newRawKey}</code>
                </div>
              )}

              {keyError && (
                <div className="platform-admin-error">{keyError}</div>
              )}

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
                              ? `Last used ${fmtShortDate(key.last_used_at)}`
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

      {selectedOrg && (
        <OrganizationDetailDrawer
          org={selectedOrg}
          maxStorageBytes={Math.max(
            0,
            ...organizations.map((o) => o.storage_used_bytes ?? 0)
          )}
          onClose={() => setSelectedOrg(null)}
        />
      )}
    </div>
  );
}
