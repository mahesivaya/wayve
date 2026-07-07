import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  getOrganizationMemberDetail,
  getPlatformMemberDetail,
  getPlatformMemberProjects,
  setPlatformMemberProjects,
  getOrganizationMemberProjects,
  setOrganizationMemberProjects,
  type MemberDetail as Detail,
} from "../api/rbac";
import { listGithubRepos, type GithubRepo } from "../api/github";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
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

// Editable per-user project (repo) access, shown on the platform member page.
// Non-admin platform members only see the repos granted here on their Projects
// page; admins are unrestricted. Read-only for viewers without members:manage.
function ProjectsAccessCard({
  scope,
  orgId,
  userId,
  name,
  canManage,
}: {
  scope: "organization" | "platform";
  /** Required for org scope — the org whose member is being granted. */
  orgId: number | null;
  userId: number;
  name: string;
  canManage: boolean;
}) {
  const [granted, setGranted] = useState<string[] | null>(null);
  const [allRepos, setAllRepos] = useState<GithubRepo[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const loadGranted = () =>
    scope === "platform"
      ? getPlatformMemberProjects(userId)
      : getOrganizationMemberProjects(orgId as number, userId);
  const saveGranted = (repos: string[]) =>
    scope === "platform"
      ? setPlatformMemberProjects(userId, repos)
      : setOrganizationMemberProjects(orgId as number, userId, repos);

  useEffect(() => {
    let alive = true;
    loadGranted()
      .then((repos) => alive && setGranted(repos))
      .catch(() => alive && setGranted([]));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, scope, orgId]);

  const beginEdit = async () => {
    setErr("");
    setDraft(new Set(granted ?? []));
    setEditing(true);
    if (allRepos === null) {
      try {
        const repos = await listGithubRepos();
        setAllRepos(Array.isArray(repos) ? repos : []);
      } catch {
        setAllRepos([]);
        setErr("Couldn't load the repository list.");
      }
    }
  };

  const toggle = (fullName: string) =>
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(fullName)) next.delete(fullName);
      else next.add(fullName);
      return next;
    });

  const save = async () => {
    setSaving(true);
    setErr("");
    try {
      const repos = await saveGranted(Array.from(draft));
      setGranted(repos);
      setEditing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="md-card">
      <div className="md-card-head">
        <h2 className="md-card-title">Projects access</h2>
        {canManage && !editing && (
          <button
            type="button"
            className="md-edit-btn"
            onClick={() => void beginEdit()}
          >
            Edit
          </button>
        )}
      </div>
      <p className="md-card-sub">
        Repositories {name} can access in Code Repo. Owners, super admins, and
        admins always see every project regardless of this list.
      </p>

      {err && <p className="platform-admin-error">{err}</p>}

      {!editing ? (
        granted === null ? (
          <p className="md-empty-note">Loading…</p>
        ) : granted.length === 0 ? (
          <p className="md-empty-note">No projects granted yet.</p>
        ) : (
          <div className="md-chip-list">
            {granted.map((r) => (
              <span key={r} className="md-chip is-repo">
                {r}
              </span>
            ))}
          </div>
        )
      ) : allRepos === null ? (
        <p className="md-empty-note">Loading repositories…</p>
      ) : allRepos.length === 0 ? (
        <p className="md-empty-note">No repositories available.</p>
      ) : (
        <>
          <div className="md-repo-checklist">
            {allRepos.map((r) => (
              <label key={r.full_name} className="md-repo-row">
                <input
                  type="checkbox"
                  checked={draft.has(r.full_name)}
                  onChange={() => toggle(r.full_name)}
                />
                <span className="md-repo-name">{r.full_name}</span>
                <span
                  className={`md-repo-vis ${r.private ? "is-private" : "is-public"}`}
                >
                  {r.private ? "Private" : "Public"}
                </span>
              </label>
            ))}
          </div>
          <div className="md-card-actions">
            <button
              type="button"
              className="md-save-btn"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="md-cancel-btn"
              disabled={saving}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </section>
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
        ? // `id` here is the member's username (canonical) or numeric id
          // (legacy) — the platform endpoint resolves either.
          getPlatformMemberDetail(id)
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

            {/* Per-member Code Repo access. Org scope needs the caller's org id;
                render only once it's known so the fetch is authorized. */}
            {(scope === "platform" || (scope === "organization" && orgId != null)) && (
              <ProjectsAccessCard
                scope={scope}
                orgId={orgId}
                userId={member.id}
                name={name}
                canManage={hasPermission(authUser, "members:manage")}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
