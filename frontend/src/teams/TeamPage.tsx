import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import { getTeam, type Team } from "../api/workspace";
import "./teams.css";

// Members aren't yet persisted server-side, so the member list is local-only
// (an org owner can add rows in-session). The team itself — name, tagline,
// description — comes from the backend, keyed by the slug in /teams/<slug>.
type Member = {
  name: string;
  role: string;
  email: string;
};

function initials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0] ?? "")
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

const EMPTY_DRAFT: Member = { name: "", role: "", email: "" };

export default function TeamPage() {
  const { slug = "" } = useParams();
  const { user } = useAuth();

  // The team is fetched from the backend by slug. `undefined` = still loading,
  // `null` = not found (or not in the caller's org).
  const [team, setTeam] = useState<Team | null | undefined>(undefined);

  // Only a team admin / manager may add members. There's no per-team role data
  // yet, so we gate on the org/platform "members:manage" permission — the same
  // capability that governs member management elsewhere. When real team
  // membership lands, swap this for a per-team manager check.
  const canManageMembers = hasPermission(user, "members:manage");

  // Member list is local-only (not yet persisted); the "Add member" button
  // appends in-session.
  const [members, setMembers] = useState<Member[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Member>(EMPTY_DRAFT);

  // Reset view state synchronously when the slug changes (navigating between
  // teams reuses this component). Done during render via a tracked previous
  // value rather than in an effect — see Chat.tsx for the same pattern.
  const [lastSlug, setLastSlug] = useState(slug);
  if (lastSlug !== slug) {
    setLastSlug(slug);
    setTeam(undefined);
    setMembers([]);
    setAdding(false);
    setDraft(EMPTY_DRAFT);
  }

  // The fetch itself stays in an effect; setState runs in the async callbacks
  // (allowed) rather than synchronously in the effect body.
  useEffect(() => {
    let cancelled = false;
    getTeam(slug)
      .then((t) => !cancelled && setTeam(t))
      .catch(() => !cancelled && setTeam(null));
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const canSubmit = draft.name.trim().length > 0;
  const submitMember = () => {
    if (!canSubmit) return;
    setMembers((prev) => [
      ...prev,
      {
        name: draft.name.trim(),
        role: draft.role.trim() || "Member",
        email: draft.email.trim(),
      },
    ]);
    setDraft(EMPTY_DRAFT);
    setAdding(false);
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
      <header className="team-header">
        <div className="team-header-icon" aria-hidden="true">
          👥
        </div>
        <div className="team-header-text">
          <h1 className="team-title">{team.name}</h1>
          {team.tagline && <p className="team-tagline">{team.tagline}</p>}
        </div>
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
      </header>

      <section className="team-about u-panel">
        <h2 className="team-section-title">About</h2>
        <p className="team-description">
          {team.description || "No description yet."}
        </p>
      </section>

      <section className="team-members u-panel">
        <h2 className="team-section-title">
          Members <span className="team-member-count">{members.length}</span>
        </h2>

        {canManageMembers && adding && (
          <form
            className="team-add-form"
            onSubmit={(e) => {
              e.preventDefault();
              submitMember();
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
                {initials(m.name)}
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
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
