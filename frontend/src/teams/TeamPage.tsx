import { useParams, Link } from "react-router-dom";
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

export default function TeamPage() {
  const { slug = "" } = useParams();
  const team = TEAMS[slug];

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
        <div>
          <h1 className="team-title">{team.name}</h1>
          <p className="team-tagline">{team.tagline}</p>
        </div>
      </header>

      <section className="team-about u-panel">
        <h2 className="team-section-title">About</h2>
        <p className="team-description">{team.description}</p>
      </section>

      <section className="team-members u-panel">
        <h2 className="team-section-title">
          Members <span className="team-member-count">{team.members.length}</span>
        </h2>
        <ul className="team-member-list">
          {team.members.map((m) => (
            <li key={m.email} className="team-member">
              <span className="team-avatar" aria-hidden="true">
                {initials(m.name)}
              </span>
              <span className="team-member-info">
                <span className="team-member-name">{m.name}</span>
                <span className="team-member-role">{m.role}</span>
              </span>
              <a className="team-member-email" href={`mailto:${m.email}`}>
                {m.email}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
