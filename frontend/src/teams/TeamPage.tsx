import { useCallback, useEffect, useState } from "react";
import {
  useParams,
  useSearchParams,
  Link,
  useNavigate,
} from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import {
  addTeamMember,
  deleteTeam,
  getTeam,
  removeTeamMember,
  type Team,
} from "../api/workspace";
import { PlusIcon } from "../icons";
import DocumentsBox from "../documents/DocumentsBox";
import TeamDescription from "./TeamDescription";
import TeamMemberCard from "./TeamMemberCard";
import TeamMembersTable, { type Member } from "./TeamMembersTable";
import "./teams.css";

// A team's roster is saved server-side (team_members) and comes back with the
// team from /api/teams/<slug>.
type Draft = Pick<Member, "name" | "role" | "email">;
const EMPTY_DRAFT: Draft = { name: "", role: "", email: "" };

const TEAM_TABS = [
  { key: "overview", label: "Overview" },
  { key: "documents", label: "Documents" },
  { key: "members", label: "Members" },
] as const;
type TeamTab = (typeof TEAM_TABS)[number]["key"];

export default function TeamPage() {
  const { slug = "" } = useParams();
  const { user } = useAuth();

  // Kept in the URL so a reload or the back button stays on the same section,
  // and a link to another team starts on its Overview.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: TeamTab =
    TEAM_TABS.find((t) => t.key === searchParams.get("tab"))?.key ?? "overview";

  // The team is fetched from the backend by slug. `undefined` = still loading,
  // `null` = not found (or not in the caller's org).
  const [team, setTeam] = useState<Omit<Team, "members"> | null | undefined>(
    undefined
  );

  // Admins only (owner, super admin, admin). Not members:manage, which the
  // security role also holds. The backend enforces the same permission.
  const canEditDescription = hasPermission(user, "org:settings");

  // There is no per-team role data yet, so this gates on the org/platform
  // "members:manage" permission. Swap it for a per-team manager check when real
  // team membership lands.
  const canManageMembers = hasPermission(user, "members:manage");

  // Same rule as creating a team (Layout's sidebar ＋, and the backend's
  // require_owner): an org or platform owner, in admin mode.
  const adminMode = user?.mode !== "normal" || !user?.can_switch_admin;
  const isOwner =
    adminMode &&
    (user?.scope === "organization" || user?.scope === "platform") &&
    user?.effective_role === "owner";
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const [members, setMembers] = useState<Member[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [rosterBusy, setRosterBusy] = useState(false);
  const [rosterError, setRosterError] = useState("");
  // By id, so the card closes by itself when its member is removed.
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = members.find((m) => m.id === selectedId) ?? null;
  const closeCard = useCallback(() => setSelectedId(null), []);

  // Navigating between teams reuses this component, so view state resets during
  // render via a tracked previous value rather than in an effect. Chat.tsx uses
  // the same pattern.
  const [lastSlug, setLastSlug] = useState(slug);
  if (lastSlug !== slug) {
    setLastSlug(slug);
    setTeam(undefined);
    setMembers([]);
    setAdding(false);
    setDraft(EMPTY_DRAFT);
    setDeleting(false);
    setDeleteError("");
    setRosterBusy(false);
    setRosterError("");
    setSelectedId(null);
  }

  useEffect(() => {
    let cancelled = false;
    getTeam(slug)
      .then((t) => {
        if (cancelled) return;
        setTeam(t);
        setMembers((t.members ?? []).map(toMember));
      })
      .catch(() => {
        if (!cancelled) setTeam(null);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const canSubmit = draft.name.trim().length > 0 && !rosterBusy;
  const submitMember = async () => {
    if (!canSubmit || !team) return;
    const input = {
      name: draft.name.trim(),
      role: draft.role.trim(),
      email: draft.email.trim(),
    };
    setRosterError("");
    setRosterBusy(true);
    try {
      const saved = await addTeamMember(team.id, input);
      setMembers((prev) => [...prev, toMember(saved)]);
    } catch (err) {
      setRosterError(
        err instanceof Error ? err.message : "Failed to add member"
      );
      setRosterBusy(false);
      return;
    }
    setRosterBusy(false);
    setDraft(EMPTY_DRAFT);
    setAdding(false);
  };

  const removeMember = async (member: Member) => {
    if (!team) return;
    if (!window.confirm(`Remove ${member.name} from ${team.name}?`)) return;
    setRosterError("");
    setRosterBusy(true);
    try {
      await removeTeamMember(team.id, member.id);
    } catch (err) {
      setRosterError(
        err instanceof Error ? err.message : "Failed to remove member"
      );
      setRosterBusy(false);
      return;
    }
    setRosterBusy(false);
    setMembers((prev) => prev.filter((m) => m.id !== member.id));
  };

  const removeTeam = async () => {
    if (!team) return;
    if (
      !window.confirm(
        `Delete the team "${team.name}"? This removes it for everyone and can't be undone.`
      )
    ) {
      return;
    }
    setDeleting(true);
    setDeleteError("");
    try {
      await deleteTeam(team.id);
      void navigate("/home");
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "Failed to delete team"
      );
      setDeleting(false);
    }
  };

  if (team === undefined) {
    return (
      <div className="team-page u-page-shell">
        <div className="team-empty">
          <p>Loading team…</p>
        </div>
      </div>
    );
  }

  if (team === null) {
    return (
      <div className="team-page u-page-shell">
        <div className="team-empty">
          <h2>Team not found</h2>
          <p>No team matches “{slug}”.</p>
          <Link to="/home" className="team-back-link">
            ← Back to home
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="team-page u-page-shell">
      <h1 className="team-page-title">{team.name}</h1>
      <nav className="team-tabs" aria-label="Team sections">
        {TEAM_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`team-tab${tab === t.key ? " is-active" : ""}`}
            aria-current={tab === t.key ? "page" : undefined}
            onClick={() => setSearchParams({ tab: t.key })}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "overview" && (
        <section className="team-tab-panel team-overview" aria-label="Overview">
          <TeamDescription
            key={team.id}
            teamId={team.id}
            value={team.description ?? ""}
            canEdit={canEditDescription}
            onSaved={(description) =>
              setTeam((t) => (t ? { ...t, description } : t))
            }
          />
        </section>
      )}

      {tab === "documents" && (
        <section className="team-tab-panel" aria-label="Documents">
          <DocumentsBox key={team.id} teamId={team.id} />
        </section>
      )}

      {tab === "members" && (
        <div className="team-body">
          <section className="team-members u-panel">
            {/* The page is the member list and nothing else, so this row carries
            the add action the header used to hold. */}
            <div className="team-members-head">
              <h2 className="team-section-title">Members</h2>
              {/* Add-member action — visible only to a team admin / manager. */}
              {canManageMembers && (
                <button
                  type="button"
                  className="team-members-add"
                  onClick={() => setAdding((open) => !open)}
                  aria-expanded={adding}
                >
                  <PlusIcon size={16} aria-hidden="true" />
                  Add member
                </button>
              )}
              {isOwner && (
                <button
                  type="button"
                  className="team-delete-btn"
                  onClick={() => void removeTeam()}
                  disabled={deleting}
                >
                  {deleting ? "Deleting…" : "Delete team"}
                </button>
              )}
            </div>
            {deleteError && (
              <p className="team-delete-error" role="alert">
                {deleteError}
              </p>
            )}
            {rosterError && (
              <p className="team-delete-error" role="alert">
                {rosterError}
              </p>
            )}

            {canManageMembers && adding && (
              <form
                className="team-add-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitMember();
                }}
              >
                <input
                  type="text"
                  placeholder="Name"
                  aria-label="Member name"
                  value={draft.name}
                  autoFocus
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
                <input
                  type="text"
                  placeholder="Role"
                  aria-label="Member role"
                  value={draft.role}
                  onChange={(e) => setDraft({ ...draft, role: e.target.value })}
                />
                <input
                  type="email"
                  placeholder="email@example.com"
                  aria-label="Member email"
                  value={draft.email}
                  onChange={(e) =>
                    setDraft({ ...draft, email: e.target.value })
                  }
                />
                <div className="team-add-form-actions">
                  <button
                    type="submit"
                    className="team-add-btn"
                    disabled={!canSubmit}
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    className="team-add-cancel"
                    onClick={() => {
                      setAdding(false);
                      setDraft(EMPTY_DRAFT);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {/* Keyed so a team's search and filters don't carry over to the next. */}
            <TeamMembersTable
              key={team.id}
              members={members}
              canManage={canManageMembers}
              busy={rosterBusy}
              onRemove={(member) => void removeMember(member)}
              selectedId={selectedId}
              onSelect={(member) =>
                // Clicking the open member's name again closes the card.
                setSelectedId((id) => (id === member.id ? null : member.id))
              }
            />
          </section>
          {selected && <TeamMemberCard member={selected} onClose={closeCard} />}
        </div>
      )}
    </div>
  );
}

function toMember(m: {
  id: number;
  name: string;
  role: string | null;
  email: string | null;
  joined_at?: string | null;
  teams?: string[];
}): Member {
  return {
    id: m.id,
    name: m.name,
    role: m.role || "Member",
    email: m.email ?? "",
    joinedAt: m.joined_at ?? null,
    teams: m.teams ?? [],
  };
}
