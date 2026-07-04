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
import { fmtDate, fmtLongDate } from "../utils/datetime";
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
// object returned by the detail endpoint. The dot color mirrors Workspace's
// per-app coloring so the breakdown scans at a glance.
const STORAGE_SERVICES: {
  key: keyof Detail["storage"];
  label: string;
  color: string;
}[] = [
  { key: "gmail_bytes", label: "Email", color: "#d93025" },
  { key: "drive_bytes", label: "Drive", color: "#1a73e8" },
  { key: "chat_bytes", label: "Chat", color: "#12b76a" },
  { key: "notes_bytes", label: "Notes", color: "#f59e0b" },
  { key: "tasks_bytes", label: "Tasks", color: "#7c4dff" },
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

function CloudIcon() {
  return (
    <svg
      className="md-storage-cloud"
      viewBox="0 0 24 24"
      width="40"
      height="40"
      aria-hidden="true"
    >
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        d="M7 18h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 6.5 9 3.5 3.5 0 0 0 7 18Z"
      />
    </svg>
  );
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
  // Left card's "unit" row: org name for org members, "Platform" for staff.
  const unitLabel = scope === "platform" ? "Scope" : "Organization";
  const unitValue =
    scope === "platform" ? "Platform" : (member?.organization_name ?? "—");

  return (
    <div className="md-page">
      <div className="md-breadcrumb">
        <Link to={backTo}>{scope === "platform" ? "Team" : "Members"}</Link>
        <span aria-hidden="true"> › </span>
        <span>{name || "Member"}</span>
      </div>

      {loading ? (
        <div className="md-card">
          <div className="platform-admin-empty">Loading member…</div>
        </div>
      ) : error ? (
        <div className="md-card">
          <div className="platform-admin-error">{error}</div>
        </div>
      ) : !member ? null : (
        <div className="md-layout">
          {/* Left identity card — avatar, name, status, created, unit. */}
          <aside className="md-idcard">
            <div className="md-idcard-head">
              {member.avatar_path && !avatarFailed ? (
                <img
                  className="md-avatar"
                  src={`${getApiBase()}/api/users/${member.id}/avatar`}
                  alt=""
                  onError={() => setAvatarFailed(true)}
                />
              ) : (
                <span
                  className="md-avatar md-avatar-initials"
                  aria-hidden="true"
                >
                  {initials(name)}
                </span>
              )}
              <h1 className="md-idcard-name">{name}</h1>
              <a className="md-idcard-email" href={`mailto:${member.email}`}>
                {member.email}
              </a>
              <div
                className={`md-status ${member.email_verified ? "is-ok" : "is-warn"}`}
              >
                {member.email_verified ? "Active" : "Unverified"}
              </div>
              {member.created_at && (
                <div className="md-idcard-created">
                  Created: {fmtDate(member.created_at)}
                </div>
              )}
            </div>
            <div className="md-idcard-unit">
              <span className="md-idcard-unit-label">{unitLabel}</span>
              <span className="md-idcard-unit-value">{unitValue}</span>
            </div>
          </aside>

          {/* Right column — storage, member info, roles. */}
          <div className="md-content">
            <section className="md-card">
              <h2 className="md-card-title">
                Storage use for <strong>{name}</strong>
              </h2>
              <div className="md-storage-row">
                <div className="md-storage-total">
                  <CloudIcon />
                  <div className="md-storage-total-text">
                    <span className="md-storage-total-label">Total used</span>
                    <span className="md-storage-total-value">
                      {formatBytes(member.storage.total_bytes)}
                    </span>
                  </div>
                </div>
                <div className="md-storage-services">
                  {STORAGE_SERVICES.map((s) => (
                    <div key={s.key} className="md-storage-service">
                      <span
                        className="md-storage-dot"
                        style={{ background: s.color }}
                        aria-hidden="true"
                      />
                      <span className="md-storage-service-label">
                        {s.label}
                      </span>
                      <span className="md-storage-service-value">
                        {formatBytes(member.storage[s.key])}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="md-card">
              <h2 className="md-card-title">Member information</h2>
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
                  <dt>Created</dt>
                  <dd>
                    {member.created_at ? fmtLongDate(member.created_at) : "—"}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="md-card">
              <h2 className="md-card-title">Roles and privileges</h2>
              {role ? (
                <div className="md-role-line">
                  <span className="md-chip is-role">
                    {role.replace(/_/g, " ")}
                  </span>
                  {scopeLabel && (
                    <span className="md-role-scope">{scopeLabel}</span>
                  )}
                </div>
              ) : (
                <p className="md-empty-note">
                  {name} doesn't have any admin roles or privileges.
                </p>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
