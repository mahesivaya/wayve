import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import { getTeam, type Team } from "../api/workspace";
import { PersonIcon } from "../icons";
import { findSampleTeam } from "./sampleTeams";
import "./teams.css";

// Members aren't yet persisted server-side, so the member list is local-only
// (an org owner can add rows in-session). The team itself — name, tagline,
// description — comes from the backend, keyed by the slug in /teams/<slug>.
type Member = {
  name: string;
  role: string;
  email: string;
};

const EMPTY_DRAFT: Member = { name: "", role: "", email: "" };

export default function TeamPage() {
  const { slug = "" } = useParams();
  const { user } = useAuth();

  // The team is fetched from the backend by slug. `undefined` = still loading,
  // `null` = not found (or not in the caller's org).
  const [team, setTeam] = useState<Team | null | undefined>(undefined);

  // There is no per-team role data yet, so this gates on the org/platform
  // "members:manage" permission. Swap it for a per-team manager check when real
  // team membership lands.
  const canManageMembers = hasPermission(user, "members:manage");

  const [members, setMembers] = useState<Member[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Member>(EMPTY_DRAFT);

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
  }

  // A real backend team wins. Only when there is no row for the slug does the
  // display-only sample take over, bringing its own roster — a real team must
  // never be shown invented members, so the seeding happens on this branch
  // alone.
  useEffect(() => {
    let cancelled = false;
    getTeam(slug)
      .then((t) => !cancelled && setTeam(t))
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
        </div>

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
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
