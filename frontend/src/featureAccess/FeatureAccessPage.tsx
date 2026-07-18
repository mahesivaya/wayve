import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/useAuth";
import {
  getFeatureAccess,
  updateFeatureAccess,
  type FeatureAccess,
} from "../api/featureAccess";
import "./featureAccess.css";

// Prettify a role key for display: "super_admin" -> "Super admin".
function roleLabel(role: string): string {
  const spaced = role.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Owner-only matrix of gateable features against roles. The owner column is
// always on and disabled so an owner cannot lock themselves out, which the
// backend enforces too. The backend serves and saves the matrix for whichever
// scope the caller belongs to, and changes take effect on the member's next
// request.
export default function FeatureAccessPage() {
  const { user } = useAuth();
  const isOwner =
    (user?.scope === "organization" || user?.scope === "platform") &&
    user?.effective_role === "owner";
  const scopeLabel = user?.scope === "platform" ? "platform" : "organization";

  const [data, setData] = useState<FeatureAccess | null>(null);
  const [loadError, setLoadError] = useState("");
  // Working copy of allowed roles per feature key, edited before Save.
  const [draft, setDraft] = useState<Record<string, Set<string>>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [banner, setBanner] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);

  const reload = useCallback(() => {
    void getFeatureAccess()
      .then((d) => {
        setData(d);
        setDraft(
          Object.fromEntries(
            d.features.map((f) => [f.key, new Set(f.allowed_roles)])
          )
        );
      })
      .catch((e: unknown) =>
        setLoadError(e instanceof Error ? e.message : "Failed to load access")
      );
  }, []);

  useEffect(() => {
    if (isOwner) reload();
  }, [isOwner, reload]);

  // Auto-clear the success/error banner after a few seconds.
  useEffect(() => {
    if (!banner) return;
    const t = window.setTimeout(() => setBanner(null), 4000);
    return () => window.clearTimeout(t);
  }, [banner]);

  const dirty = useMemo(() => {
    if (!data) return {} as Record<string, boolean>;
    const out: Record<string, boolean> = {};
    for (const f of data.features) {
      const cur = draft[f.key] ?? new Set<string>();
      const orig = new Set(f.allowed_roles);
      out[f.key] = cur.size !== orig.size || [...cur].some((r) => !orig.has(r));
    }
    return out;
  }, [data, draft]);

  if (!isOwner) {
    return (
      <div className="feature-access u-page-shell">
        <p className="feature-access-empty">
          Only an organization or platform owner can manage feature access.
        </p>
      </div>
    );
  }

  const toggle = (featureKey: string, role: string) => {
    if (role === "owner") return; // owner is always allowed
    setDraft((prev) => {
      const next = new Set(prev[featureKey] ?? []);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return { ...prev, [featureKey]: next };
    });
  };

  const resetToDefault = (featureKey: string, defaults: string[]) => {
    setDraft((prev) => ({ ...prev, [featureKey]: new Set(defaults) }));
  };

  const save = (featureKey: string) => {
    const roles = [...(draft[featureKey] ?? new Set<string>())];
    setSavingKey(featureKey);
    setBanner(null);
    void updateFeatureAccess(featureKey, roles)
      .then((updated) => {
        setData((prev) =>
          prev
            ? {
                ...prev,
                features: prev.features.map((f) =>
                  f.key === featureKey
                    ? { ...f, allowed_roles: updated.allowed_roles }
                    : f
                ),
              }
            : prev
        );
        setDraft((prev) => ({
          ...prev,
          [featureKey]: new Set(updated.allowed_roles),
        }));
        setBanner({ kind: "ok", text: `Saved ${updated.label} access.` });
      })
      .catch((e: unknown) =>
        setBanner({
          kind: "err",
          text: e instanceof Error ? e.message : "Failed to save",
        })
      )
      .finally(() => setSavingKey(null));
  };

  return (
    <div className="feature-access u-page-shell">
      <header className="feature-access-header">
        <h1 className="feature-access-title">Feature access</h1>
        <p className="feature-access-subtitle">
          Choose which roles in your {scopeLabel} can use each feature. The
          owner always has access.
        </p>
      </header>

      {loadError && (
        <div className="feature-access-banner is-err" role="alert">
          {loadError}
        </div>
      )}
      {banner && (
        <div
          className={`feature-access-banner ${banner.kind === "ok" ? "is-ok" : "is-err"}`}
          role="status"
        >
          {banner.text}
        </div>
      )}

      {data === null && !loadError ? (
        <p className="feature-access-empty">Loading…</p>
      ) : (
        data && (
          <div className="feature-access-tablewrap">
            <table className="feature-access-table">
              <thead>
                <tr>
                  <th className="feature-access-feature-col">Feature</th>
                  {data.roles.map((r) => (
                    <th key={r} className="feature-access-role-col">
                      {roleLabel(r)}
                    </th>
                  ))}
                  <th className="feature-access-actions-col" />
                </tr>
              </thead>
              <tbody>
                {data.features.map((f) => {
                  const set = draft[f.key] ?? new Set<string>();
                  return (
                    <tr key={f.key}>
                      <th scope="row" className="feature-access-feature-col">
                        {f.label}
                      </th>
                      {data.roles.map((r) => (
                        <td key={r} className="feature-access-role-col">
                          <input
                            type="checkbox"
                            aria-label={`${f.label} – ${roleLabel(r)}`}
                            checked={r === "owner" ? true : set.has(r)}
                            disabled={r === "owner"}
                            onChange={() => toggle(f.key, r)}
                          />
                        </td>
                      ))}
                      <td className="feature-access-actions-col">
                        <button
                          type="button"
                          className="feature-access-reset"
                          onClick={() => resetToDefault(f.key, f.default_roles)}
                          data-tooltip="Reset to the default roles"
                        >
                          Reset
                        </button>
                        <button
                          type="button"
                          className="feature-access-save"
                          disabled={!dirty[f.key] || savingKey === f.key}
                          onClick={() => save(f.key)}
                        >
                          {savingKey === f.key ? "Saving…" : "Save"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
