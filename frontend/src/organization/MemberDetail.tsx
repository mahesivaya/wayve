import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  getOrganizationMemberDetail,
  getPlatformMemberDetail,
  type MemberDetail as Detail,
} from "../api/rbac";
import { useAuth } from "../auth/useAuth";
import { getApiBase } from "../config/env";
import { formatBytes } from "../utils/bytes";
import { fmtLongDate } from "../utils/datetime";
import "./admin-ui.css";
import "./platformAdmin.css";
import "./memberDetail.css";

// Human labels for the auth_provider discriminator on the users table.
const AUTH_LABELS: Record<string, string> = {
  local: "Email & password",
  google: "Google",
  sso: "SSO (Google Workspace)",
};

// Per-service storage rows, in the order shown. Keys match the `storage`
// object returned by the detail endpoint.
const STORAGE_SERVICES: { key: keyof Detail["storage"]; label: string }[] = [
  { key: "gmail_bytes", label: "Email" },
  { key: "drive_bytes", label: "Drive" },
  { key: "chat_bytes", label: "Chat" },
  { key: "notes_bytes", label: "Notes" },
  { key: "tasks_bytes", label: "Tasks" },
];

function displayName(u: Detail): string {
  const full = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return full || u.username || u.email.split("@")[0];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (name.slice(0, 2) || "?").toUpperCase();
}

type Props = { scope: "organization" | "platform" };

export default function MemberDetail({ scope }: Props) {
  const { id } = useParams<{ id: string }>();
  const { user: authUser } = useAuth();
  const orgId = authUser?.organization_id ?? null;

  const [member, setMember] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [avatarFailed, setAvatarFailed] = useState(false);

  const backTo =
    scope === "platform" ? "/platform/members" : "/organization/members";

  useEffect(() => {
    if (!id) return;
    // Org detail is authorized against the caller's own org; without an org id
    // there's nothing to query.
    if (scope === "organization" && orgId == null) {
      setLoading(false);
      setError("You are not part of an organization.");
      return;
    }
    let alive = true;
    setLoading(true);
    setError("");
    setAvatarFailed(false);
    const request =
      scope === "platform"
        ? getPlatformMemberDetail(Number(id))
        : getOrganizationMemberDetail(orgId as number, Number(id));
    request
      .then((m) => {
        if (alive) setMember(m);
      })
      .catch((err) => {
        if (alive)
          setError(
            err instanceof Error ? err.message : "Failed to load member"
          );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id, scope, orgId]);

  const name = member ? displayName(member) : "";
  const role = member?.platform_role ?? member?.organization_role ?? null;
  const scopeLabel = member?.platform_role
    ? "Platform"
    : member?.organization_role
      ? member.organization_name ?? "Organization"
      : null;

  return (
    <div className="platform-admin-home u-page-shell">
      <div className="md-breadcrumb">
        <Link to={backTo}>{scope === "platform" ? "Team" : "Members"}</Link>
        <span aria-hidden="true"> › </span>
        <span>{name || "Member"}</span>
      </div>

      {loading ? (
        <section className="platform-admin-panel u-panel">
          <div className="platform-admin-empty">Loading member…</div>
        </section>
      ) : error ? (
        <section className="platform-admin-panel u-panel">
          <div className="platform-admin-error">{error}</div>
        </section>
      ) : !member ? null : (
        <>
          <section className="platform-admin-panel u-panel md-identity">
            {member.avatar_path && !avatarFailed ? (
              <img
                className="md-avatar"
                src={`${getApiBase()}/api/users/${member.id}/avatar`}
                alt=""
                onError={() => setAvatarFailed(true)}
              />
            ) : (
              <span className="md-avatar md-avatar-initials" aria-hidden="true">
                {initials(name)}
              </span>
            )}
            <div className="md-identity-main">
              <h1>{name}</h1>
              <a className="md-email" href={`mailto:${member.email}`}>
                {member.email}
              </a>
              <div className="md-chips">
                <span
                  className={`md-chip ${member.email_verified ? "is-ok" : "is-warn"}`}
                >
                  {member.email_verified ? "Active" : "Unverified"}
                </span>
                {member.account_type && (
                  <span className="md-chip">
                    {member.account_type.replace(/_/g, " ")}
                  </span>
                )}
                {role && (
                  <span className="md-chip is-role">
                    {role.replace(/_/g, " ")}
                    {scopeLabel ? ` · ${scopeLabel}` : ""}
                  </span>
                )}
              </div>
            </div>
          </section>

          <section className="platform-admin-panel u-panel">
            <h2 className="md-section-title">
              Storage use for <strong>{name}</strong>
            </h2>
            <div className="md-storage-total">
              <span className="md-storage-total-label">Total used</span>
              <span className="md-storage-total-value">
                {formatBytes(member.storage.total_bytes)}
              </span>
            </div>
            <div className="md-storage-grid">
              {STORAGE_SERVICES.map((s) => {
                const bytes = member.storage[s.key];
                const pct =
                  member.storage.total_bytes > 0
                    ? Math.round((bytes / member.storage.total_bytes) * 100)
                    : 0;
                return (
                  <div key={s.key} className="md-storage-cell">
                    <span className="md-storage-cell-label">{s.label}</span>
                    <span className="md-storage-cell-value">
                      {formatBytes(bytes)}
                    </span>
                    <div className="md-storage-bar">
                      <div
                        className="md-storage-bar-fill"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="platform-admin-panel u-panel">
            <h2 className="md-section-title">Member information</h2>
            <dl className="md-info-grid">
              <div>
                <dt>Username</dt>
                <dd>{member.username || "—"}</dd>
              </div>
              <div>
                <dt>Sign-in method</dt>
                <dd>
                  {AUTH_LABELS[member.auth_provider ?? ""] ??
                    member.auth_provider ??
                    "—"}
                </dd>
              </div>
              <div>
                <dt>Account type</dt>
                <dd>{member.account_type?.replace(/_/g, " ") ?? "—"}</dd>
              </div>
              <div>
                <dt>Organization</dt>
                <dd>{member.organization_name ?? "—"}</dd>
              </div>
              <div>
                <dt>Role</dt>
                <dd>
                  {role ? (
                    <>
                      {role.replace(/_/g, " ")}
                      {scopeLabel ? ` (${scopeLabel})` : ""}
                    </>
                  ) : (
                    "No admin roles"
                  )}
                </dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>
                  {member.created_at ? fmtLongDate(member.created_at) : "—"}
                </dd>
              </div>
            </dl>
          </section>
        </>
      )}
    </div>
  );
}
