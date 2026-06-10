import "./about.css";

const capabilityGroups = [
  {
    title: "Unified Workspace",
    text: "Fluxze brings email, chat, calls, files, notes, tasks, scheduling, and AI into one place so switching between daily tools feels direct instead of scattered.",
  },
  {
    title: "Team Ready",
    text: "Organizations can use shared spaces, member roles, billing, and admin views while individuals still keep a simple personal workspace.",
  },
  {
    title: "Secure By Design",
    text: "Authentication, private storage patterns, encrypted message handling, and account-level ownership checks keep sensitive work tied to the right user or organization.",
  },
  {
    title: "Expandable Platform",
    text: "The app is structured so billing, usage limits, AI features, email providers, and future productivity modules can grow without forcing one large rewrite.",
  },
];

const architectureLayers = [
  {
    title: "Frontend Experience",
    items: [
      "Single-page React app with route-level lazy loading for Emails, Chat, Scheduler, Drive, Billing, AI Chat, and About.",
      "Split-pane workspace support so a user can keep one app open while switching another app beside it.",
      "Global search context and email view controls keep shared UI state outside individual screens.",
    ],
  },
  {
    title: "Backend Services",
    items: [
      "Rust Actix APIs centralize authentication, user ownership checks, email provider actions, billing, file access, and scheduling.",
      "Background workers handle email sync and body hydration separately from the user-facing request path.",
      "Provider-specific logic is isolated so Gmail, Outlook, billing providers, and future integrations can evolve independently.",
    ],
  },
  {
    title: "Data & Ownership",
    items: [
      "Core data is tied to either a user or an organization, which keeps personal and team workspaces separate.",
      "Email accounts, files, billing records, usage events, subscriptions, and organization members can be checked at the server boundary.",
      "Local UI preferences such as layout and sidebar width are stored client-side, while business state stays in the database.",
    ],
  },
];

const trustDetails = [
  "JWT-based protected routes with server confirmation through the profile endpoint.",
  "Account and organization ownership checks before returning private records.",
  "Encrypted message/body handling paths where sensitive content is stored protected instead of plain text.",
  "Webhook-driven billing updates so subscription state is based on provider events, not only browser redirects.",
];

const roadmap = [
  "Deeper usage metering for AI, storage, email accounts, and organization seats.",
  "More admin controls for organization owners and platform administrators.",
  "Performance tracing around slow page loads, provider calls, background sync, and database queries.",
  "Better entitlement enforcement so each feature can be enabled, limited, or upgraded cleanly.",
];

export default function About() {
  return (
    <main className="about-page">
      <section className="about-intro">
        <p className="about-kicker">About Fluxze</p>
        <h1>
          One secure workspace for communication, planning, files, and AI.
        </h1>
        <p>
          Fluxze is designed as a practical work hub: users can manage email,
          collaborate through chat and calls, organize schedules and files, and
          use AI without jumping between many disconnected apps.
        </p>
      </section>

      <section className="about-grid" aria-label="Fluxze capabilities">
        {capabilityGroups.map((group) => (
          <article className="about-card" key={group.title}>
            <h2>{group.title}</h2>
            <p>{group.text}</p>
          </article>
        ))}
      </section>

      <section className="about-details">
        <h2>How It Fits Together</h2>
        <p>
          The frontend focuses on the daily user experience, while the Rust
          backend owns authentication, provider integrations, billing logic,
          storage, and access checks. This keeps the interface fast to evolve
          while important business rules stay centralized on the server.
        </p>
      </section>

      <section className="about-section">
        <div className="about-section-heading">
          <p className="about-kicker">Architecture</p>
          <h2>Built as connected layers, not one giant screen.</h2>
        </div>
        <div className="about-layer-grid">
          {architectureLayers.map((layer) => (
            <article className="about-layer" key={layer.title}>
              <h3>{layer.title}</h3>
              <ul>
                {layer.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="about-two-column">
        <article className="about-panel">
          <p className="about-kicker">Security & Trust</p>
          <h2>Private work should stay attached to the right owner.</h2>
          <ul>
            {trustDetails.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        </article>

        <article className="about-panel">
          <p className="about-kicker">Billing & Growth</p>
          <h2>Plans can map to real product limits.</h2>
          <p>
            Billing is designed to connect subscriptions, invoices, usage
            events, organization seats, and entitlements. That means a plan can
            unlock features like storage, AI credits, email accounts, team
            members, or admin controls without scattering plan checks across
            every screen.
          </p>
        </article>
      </section>

      <section className="about-section">
        <div className="about-section-heading">
          <p className="about-kicker">Next Improvements</p>
          <h2>Where the platform can become stronger next.</h2>
        </div>
        <div className="about-roadmap">
          {roadmap.map((item, index) => (
            <div className="about-roadmap-item" key={item}>
              <span>{index + 1}</span>
              <p>{item}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
