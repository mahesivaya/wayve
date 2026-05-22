import { useNavigate } from "react-router-dom";
import MarketingShell from "./MarketingShell";

const STATS = [
  { value: "256-bit", label: "AES-GCM encryption at rest" },
  { value: "9", label: "RBAC roles across scopes" },
  { value: "30s", label: "Background mailbox sync" },
  { value: "1-day", label: "Response SLA target" },
];

const FEATURES = [
  {
    icon: "🛡️",
    title: "Encrypted by default",
    body: "AES-256-GCM at rest, client-side RSA/AES envelopes for chat, and per-recipient delivery state. No plaintext message content ever sits on a backend disk.",
  },
  {
    icon: "👥",
    title: "RBAC done right",
    body: "Nine roles (owner, super_admin, admin, security, billing, developer, support, member, guest) across platform and organization scopes — and authorization is computed per request from the DB, never trusted from the JWT.",
  },
  {
    icon: "📬",
    title: "Bring your mailbox",
    body: "Connect Gmail or Outlook over OAuth. Mail provider clients live behind a single trait — IMAP, custom Exchange, and per-tenant SMTP are next, with no rewrite needed.",
  },
  {
    icon: "🔑",
    title: "Service API keys",
    body: "X-API-KEY access with explicit scope catalog, per-key rate limits, mandatory expiry on external keys, and full audit logging (api_key_audit_log).",
  },
  {
    icon: "💳",
    title: "Stripe-backed billing",
    body: "Plans, subscriptions, invoices, entitlements, and usage events projected from Stripe. Organization billing covers every member from one seat.",
  },
  {
    icon: "🧠",
    title: "AI you control",
    body: "AI Chat runs against the same workspace data — emails, notes, files — without sending content to consumer endpoints. Disable per organization or per user.",
  },
];

const USECASES = [
  {
    label: "IT & Security",
    title: "One workspace, one audit trail",
    body: "API key audit logs, per-request RBAC resolution, encrypted attachments, and tied-down OAuth scopes give security teams a single surface to review.",
  },
  {
    label: "Operations",
    title: "Email, schedule, and chat without context switching",
    body: "Replies, meeting holds, file shares, and notes live next to each other. Background workers keep Gmail/Outlook in sync every 30 seconds.",
  },
  {
    label: "Finance",
    title: "Predictable, per-org billing",
    body: "One Stripe subscription per organization. Plan changes are prorated; cancellations stay active until period end, then drop to free.",
  },
  {
    label: "Engineering",
    title: "Build on the same plane",
    body: "Internal services authenticate as a designated user via X-API-KEY. Scopes are matched at the route level, so the integration story doesn't reroute through a sidecar.",
  },
];

export default function Enterprise() {
  const navigate = useNavigate();

  return (
    <MarketingShell>
      <section className="marketing-hero">
        <div className="marketing-hero-copy">
          <p className="marketing-eyebrow">Wayve for Enterprise</p>
          <h1>One private workspace, ready for the org.</h1>
          <p className="lead">
            Mail, chat, calls, files, scheduling, and AI in one place — with
            the encryption, RBAC, and audit story your security team actually
            wants to read.
          </p>
          <div className="marketing-hero-actions">
            <button onClick={() => navigate("/register")}>Start a trial</button>
            <button onClick={() => navigate("/support")}>Talk to us</button>
          </div>
        </div>

        <div className="marketing-hero-visual">
          <div className="marketing-hero-card">
            <div className="marketing-hero-card-row">
              <span className="marketing-hero-card-icon">📧</span>
              <span className="marketing-hero-card-text">
                Q3 board agenda — encrypted
              </span>
              <span className="marketing-hero-card-meta">2m</span>
            </div>
            <div className="marketing-hero-card-row">
              <span className="marketing-hero-card-icon">💬</span>
              <span className="marketing-hero-card-text">
                #security: SAML rollout
              </span>
              <span className="marketing-hero-card-meta">9m</span>
            </div>
            <div className="marketing-hero-card-row">
              <span className="marketing-hero-card-icon">📅</span>
              <span className="marketing-hero-card-text">
                Procurement sync · 2:00 PM
              </span>
              <span className="marketing-hero-card-meta">Today</span>
            </div>
            <div className="marketing-hero-card-row">
              <span className="marketing-hero-card-icon">📁</span>
              <span className="marketing-hero-card-text">
                MSA — Acme Corp.pdf
              </span>
              <span className="marketing-hero-card-meta">Shared</span>
            </div>
            <div className="marketing-hero-card-row">
              <span className="marketing-hero-card-icon">🔑</span>
              <span className="marketing-hero-card-text">
                3 active API keys · 0 alerts
              </span>
              <span className="marketing-hero-card-meta">Healthy</span>
            </div>
          </div>
        </div>
      </section>

      <section className="marketing-stats">
        {STATS.map((stat) => (
          <div key={stat.label} className="marketing-stat">
            <p className="marketing-stat-value">{stat.value}</p>
            <p className="marketing-stat-label">{stat.label}</p>
          </div>
        ))}
      </section>

      <section className="marketing-section">
        <div className="marketing-section-header">
          <p className="marketing-eyebrow">Capabilities</p>
          <h2>What you get out of the box</h2>
          <p>
            No plugin sprawl. Every capability below ships with the platform
            and is governed by the same RBAC and audit layer.
          </p>
        </div>

        <div className="marketing-features">
          {FEATURES.map((feature) => (
            <article key={feature.title} className="marketing-feature">
              <div className="marketing-feature-icon">{feature.icon}</div>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="marketing-section">
        <div className="marketing-section-header">
          <p className="marketing-eyebrow">Use cases</p>
          <h2>Where Wayve fits</h2>
        </div>

        {USECASES.map((usecase) => (
          <div key={usecase.title} className="marketing-usecase">
            <span className="marketing-usecase-label">{usecase.label}</span>
            <div>
              <h3>{usecase.title}</h3>
              <p>{usecase.body}</p>
            </div>
          </div>
        ))}
      </section>

      <section className="marketing-cta">
        <h2>Ready to put your org on Wayve?</h2>
        <p>Custom SLAs, SSO, dedicated tenancy — let's scope it together.</p>
        <div className="marketing-cta-actions">
          <button onClick={() => navigate("/register")}>Create account</button>
          <button onClick={() => navigate("/support")}>Contact sales</button>
        </div>
      </section>
    </MarketingShell>
  );
}
