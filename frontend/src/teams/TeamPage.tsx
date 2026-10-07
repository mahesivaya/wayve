import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import {
  addTeamMember,
  deleteTeam,
  getTeam,
  removeTeamMember,
  type Team,
} from "../api/workspace";
import { PersonIcon } from "../icons";
import { findSampleTeam } from "./sampleTeams";
import "./teams.css";

// A real team's roster is saved server-side (team_members) and comes back with
// the team from /api/teams/<slug>. A display-only sample team has no row to
// save to, so edits there stay in this browser session, as before. `id` is set
// only for saved rows.
type Member = {
  id?: number;
  name: string;
  role: string;
  email: string;
};

type Draft = Omit<Member, "id">;
const EMPTY_DRAFT: Draft = { name: "", role: "", email: "" };

export default function TeamPage() {
  const { slug = "" } = useParams();
  const { user } = useAuth();

  // The team is fetched from the backend by slug. `undefined` = still loading,
  // `null` = not found (or not in the caller's org).
  const [team, setTeam] = useState<Omit<Team, "members"> | null | undefined>(
    undefined
  );

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
  }

  // A real backend team wins. Only when there is no row for the slug does the
  // display-only sample take over, bringing its own roster — a real team must
  // never be shown invented members, so the seeding happens on this branch
  // alone.
  useEffect(() => {
    let cancelled = false;
    getTeam(slug)
      .then((t) => {
        if (cancelled) return;
        setTeam(t);
        setMembers((t.members ?? []).map(toMember));
      })
      .catch(() => {
        if (cancelled) return;
        const sample = findSampleTeam(slug);
        if (sample) {
          setTeam(sample);
          setMembers(sample.members);
        } else {
          setTeam(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Sample teams (negative ids) have no backend row: edits stay local there.
  const isSaved = !!team && team.id > 0;

  const canSubmit = draft.name.trim().length > 0 && !rosterBusy;
  const submitMember = async () => {
    if (!canSubmit || !team) return;
    const input = {
      name: draft.name.trim(),
      role: draft.role.trim(),
      email: draft.email.trim(),
    };
    setRosterError("");
    if (isSaved) {
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
    } else {
      setMembers((prev) => [
        ...prev,
        { ...input, role: input.role || "Member" },
      ]);
    }
    setDraft(EMPTY_DRAFT);
    setAdding(false);
  };

  const removeMember = async (index: number) => {
    const member = members[index];
    if (!member || !team) return;
    if (!window.confirm(`Remove ${member.name} from ${team.name}?`)) return;
    setRosterError("");
    if (isSaved && member.id !== undefined) {
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
    }
    setMembers((prev) => prev.filter((_, i) => i !== index));
  };

  const removeTeam = async () => {
    if (!team || team.id <= 0) return;
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
      <section className="team-members u-panel">
        {/* The page is the member list and nothing else, so this row carries
            both the count and the add action the header used to hold. */}
        <div className="team-members-head">
          <h2 className="team-section-title">
            Members <span className="team-member-count">{members.length}</span>
          </h2>
          {/* Add-member action — visible only to a team admin / manager. */}
          {canManageMembers && (
            <button
              type="button"
              className="team-add-btn"
              onClick={() => setAdding((open) => !open)}
              aria-expanded={adding}
            >
              ＋ Add member
            </button>
          )}
          {/* Sample teams (negative ids) have no row to delete. */}
          {isOwner && team.id > 0 && (
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
              onChange={(e) => setDraft({ ...draft, email: e.target.value })}
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

        <ul className="team-member-list">
          {members.map((m, i) => (
            <li key={`${m.email || m.name}-${i}`} className="team-member">
              <span className="team-avatar" aria-hidden="true">
                <PersonIcon size={22} />
              </span>
              <span className="team-member-info">
                <span className="team-member-name">{m.name}</span>
                <span className="team-member-role">{m.role}</span>
              </span>
              {m.email && (
                <a className="team-member-email" href={`mailto:${m.email}`}>
                  {m.email}
                </a>
              )}
              {canManageMembers && (
                <button
                  type="button"
                  className="team-member-remove"
                  onClick={() => void removeMember(i)}
                  disabled={rosterBusy}
                  aria-label={`Delete ${m.name}`}
                >
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function toMember(m: {
  id?: number;
  name: string;
  role: string | null;
  email: string | null;
}): Member {
  return {
    id: m.id,
    name: m.name,
    role: m.role || "Member",
    email: m.email ?? "",
  };
}
