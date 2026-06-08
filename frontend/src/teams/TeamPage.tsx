import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import "./teams.css";

// Fake team data — placeholder until real per-team data is wired to the
// backend. Keyed by the slug used in the sidebar links (/teams/<slug>).
type Member = {
  name: string;
  role: string;
  email: string;
};

type Team = {
  name: string;
  tagline: string;
  description: string;
  members: Member[];
};

const TEAMS: Record<string, Team> = {
  "team-a": {
    name: "Team A",
    tagline: "Core platform & infrastructure",
    description:
      "Team A owns the core platform: the API gateway, authentication, and the shared services every other team builds on. They keep the lights on and set the engineering standards for the rest of the org.",
    members: [
      { name: "Ava Mitchell", role: "Team Lead", email: "ava@example.com" },
      { name: "Liam Chen", role: "Backend Engineer", email: "liam@example.com" },
      { name: "Sofia Rossi", role: "Backend Engineer", email: "sofia@example.com" },
      { name: "Noah Williams", role: "SRE / DevOps", email: "noah@example.com" },
      { name: "Priya Nair", role: "Product Manager", email: "priya@example.com" },
    ],
  },
  "team-b": {
    name: "Team B",
    tagline: "Growth & product experience",
    description:
      "Team B focuses on the customer-facing product: onboarding, billing, and the dashboard experience. They run experiments, ship UI improvements, and own the metrics that drive activation and retention.",
    members: [
      { name: "Maya Thompson", role: "Team Lead", email: "maya@example.com" },
      { name: "Ethan Park", role: "Frontend Engineer", email: "ethan@example.com" },
      { name: "Hana Suzuki", role: "Frontend Engineer", email: "hana@example.com" },
      { name: "Diego Alvarez", role: "Designer", email: "diego@example.com" },
      { name: "Grace Okafor", role: "Data Analyst", email: "grace@example.com" },
    ],
  },
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
  const team = TEAMS[slug];

  // Only a team admin / manager may add members. There's no per-team role data
  // in this sample yet, so we gate on the org/platform "members:manage"
  // permission — the same capability that governs member management elsewhere.
  // When real team membership lands, swap this for a per-team manager check.
  const canManageMembers = hasPermission(user, "members:manage");

  // Member list is stateful so the "Add member" button can append. Seeded from
  // the (fake) team data; resets when navigating between teams (the same
  // component renders for every /teams/:slug).
  const [members, setMembers] = useState<Member[]>(team?.members ?? []);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Member>(EMPTY_DRAFT);
  const [lastSlug, setLastSlug] = useState(slug);
  if (lastSlug !== slug) {
    setLastSlug(slug);
    setMembers(team?.members ?? []);
    setAdding(false);
    setDraft(EMPTY_DRAFT);
  }

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

  if (!team) {
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
          <p className="team-tagline">{team.tagline}</p>
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
        <p className="team-description">{team.description}</p>
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
              <button type="submit" className="team-add-btn" disabled={!canSubmit}>
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
