import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
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
import "./admin-ui.css";
import "./platformAdmin.css";

export default function PlatformOrganizations() {
  const { user } = useAuth();
  const canManageMembers = hasPermission(user, "members:manage");
  const canManageApiKeys = hasPermission(user, "api_keys:manage");

  const [organizations, setOrganizations] = useState<AdminOrganization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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
        if (alive) setOrganizations(items);
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
            <span>{organizations.length} total</span>
          </div>

          {loading ? (
            <div className="platform-admin-empty">Loading businesses...</div>
          ) : organizations.length === 0 ? (
            <div className="platform-admin-empty">
              No businesses created yet.
            </div>
          ) : (
            <div className="organization-grid">
              {organizations.map((org) => (
                <Link
                  key={org.id}
                  to={`/platform/organizations/${org.id}`}
                  state={{ from: "organizations" }}
                  className="organization-grid-tile"
                  title={org.name}
                >
                  <strong>{org.name}</strong>
                </Link>
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
    </div>
  );
}
