import { useAuth } from "../auth/useAuth";
import { useNavigate } from "react-router-dom";
import { useGlobalSearch } from "../search/SearchContext";
import { useEffect, useMemo, useRef, useState } from "react";
import { SERVICES } from "../services/serviceData";
import ThemeToggle from "../theme/ThemeToggle";
import "./home.css";

type AppPermission = "apps:use";

// `requiredPermission` is checked against `user.permissions[]` — the
// catalog is in backend/src/security/rbac.rs::Permission. Granular
// per-app strings like `email:read` are NOT in that catalog (they'd
// silently hide every card for every user). The right gate today is
// `apps:use`, which every authed user from Member upward holds.
// /call is intentionally absent — calls live inside Chat's conversation
// header (audio + video icons on a 1:1 DM). The /call route is still
// reachable directly for legacy bookmarks.
const HOME_CARDS = [
  { path: "/emails", title: "📧 Emails", description: "View and send emails", requiredPermission: "apps:use" },
  { path: "/chat", title: "💬 Chat", description: "Real-time messaging", requiredPermission: "apps:use" },
  { path: "/scheduler", title: "📅 Scheduler", description: "Manage your meetings", requiredPermission: "apps:use" },
  { path: "/drive", title: "📁 Drive", description: "Store and manage files", requiredPermission: "apps:use" },
  { path: "/notes", title: "📝 Notes", description: "Store and manage notes", requiredPermission: "apps:use" },
  { path: "/tasks", title: "☑ Tasks", description: "Create and track tasks", requiredPermission: "apps:use" },
  { path: "/aichat", title: "✨ AI Chat", description: "Chat with AI", requiredPermission: "apps:use" },
] satisfies Array<{
  path: string;
  title: string;
  description: string;
  requiredPermission?: AppPermission;
}>;

export default function Home() {
  const { user } = useAuth();
  const { normalizedSearchQuery } = useGlobalSearch();
  const navigate = useNavigate();
  const [servicesOpen, setServicesOpen] = useState(false);
  const servicesMenuRef = useRef<HTMLDivElement | null>(null);
  const servicesDropdownRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!servicesOpen) return;

    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (servicesMenuRef.current?.contains(target)) return;
      if (servicesDropdownRef.current?.contains(target)) return;
      setServicesOpen(false);
    };

    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
    };
  }, [servicesOpen]);

  const visibleCards = useMemo(() => {
    // Filter by permissions first (if user exists), then by search query
    const allowedCards = HOME_CARDS.filter((card) => {
      if (!card.requiredPermission) return true;
      return user?.permissions?.includes(card.requiredPermission);
    });

    if (!normalizedSearchQuery) return allowedCards;
    return allowedCards.filter((card) =>
      [card.title, card.description]
        .join(" ")
        .toLowerCase()
        .includes(normalizedSearchQuery)
    );
  }, [normalizedSearchQuery, user?.permissions]);

  if (!user) {
    return (
      <div className="public-home">
        <header className="public-home-nav">
          <button className="public-home-brand" onClick={() => navigate("/")}>
            Wayve
          </button>

          <nav className="public-home-links" aria-label="Main navigation">
            <div className="services-menu" ref={servicesMenuRef}>
              <button
                className={`services-trigger ${servicesOpen ? "active" : ""}`}
                onClick={() => setServicesOpen((open) => !open)}
                aria-expanded={servicesOpen}
                aria-controls="services-dropdown"
              >
                Products
                <span className="services-caret" aria-hidden="true" />
              </button>
            </div>

            <button onClick={() => navigate("/pricing")}>Pricing</button>
            <button onClick={() => navigate("/enterprise")}>Enterprise</button>
            <button onClick={() => navigate("/support")}>Support</button>
          </nav>

          <div className="public-home-actions">
            <ThemeToggle />
            <button className="home-login-btn" onClick={() => navigate("/login")}>
              Login
            </button>
            <button className="home-register-btn" onClick={() => navigate("/register")}>
              Register
            </button>
          </div>
        </header>

        <main className="public-home-main">
          {servicesOpen && (
            <section
              id="services-dropdown"
              ref={servicesDropdownRef}
              className="services-dropdown-panel"
              aria-label="Available services"
            >
              <div className="services-grid">
                {SERVICES.map((service) => (
                  <button
                    key={service.slug}
                    className="service-item"
                    onClick={() => navigate(`/services/${service.slug}`)}
                  >
                    <span className={`service-icon ${service.accent}`}>
                      {service.icon}
                    </span>
                    <span className="service-copy">
                      <span className="service-title-row">
                        <span className="service-title">{service.name}</span>
                        {service.slug === "meet" && <span className="service-badge">New</span>}
                      </span>
                      <span className="service-description">{service.summary}</span>
                    </span>
                  </button>
                ))}
              </div>

              <div className="services-more">
                <h2>More from Wayve</h2>
                <div className="services-more-grid">
                  <button onClick={() => navigate("/organization")}>
                    <span className="service-icon organization">O</span>
                    <span>
                      <strong>Wayve Organization</strong>
                      <small>Team tools for communication and work.</small>
                    </span>
                  </button>
                  <button onClick={() => navigate("/login")}>
                    <span className="service-icon security">S</span>
                    <span>
                      <strong>Secure Login</strong>
                      <small>Access your private workspace.</small>
                    </span>
                  </button>
                  <button onClick={() => navigate("/register")}>
                    <span className="service-icon account">+</span>
                    <span>
                      <strong>Create Account</strong>
                      <small>Start using all services in one place.</small>
                    </span>
                  </button>
                </div>
              </div>
            </section>
          )}

          <section className="public-home-hero">
            <div className="hero-copy">
              <p className="hero-kicker">Private workspace for modern teams</p>
              <h1>One home for email, chat, calls, files, notes, and AI.</h1>
              <p>
                Wayve brings daily work tools into a single secure app, with fast
                switching between personal productivity and team collaboration.
              </p>
              <div className="hero-actions">
                <button onClick={() => navigate("/register")}>Get started</button>
                <button onClick={() => navigate("/login")}>Sign in</button>
              </div>
            </div>
          </section>

          <section className="home-info-band">
            <h2>Built for fast, secure, scalable work</h2>
            <p>
              Three promises shape every decision behind Wayve: get things
              done in seconds, keep your work private by default, and grow
              with you from one user to a whole organization. Here&apos;s
              what that looks like in practice.
            </p>
          </section>

          <section className="home-pillars">
            <article className="home-pillar">
              <header>
                <span className="home-pillar-icon">⚡</span>
                <h3>Fast — one place to get work done</h3>
              </header>
              <p>
                Stop hopping between five tools to send an email, ping a
                teammate, share a file, and book a meeting. Wayve puts every
                daily action one click away on the same screen.
              </p>
              <ul className="home-pillar-features">
                <li>
                  <strong>One workspace for everything.</strong> Mail, chat,
                  calls, scheduler, drive, notes, tasks, and AI assistant —
                  no tab juggling, no app sprawl.
                </li>
                <li>
                  <strong>Side-by-side apps.</strong> Open Chat next to Email,
                  or Drive next to Notes, without leaving the page you&apos;re
                  on.
                </li>
                <li>
                  <strong>Lightning-fast loads.</strong> The app only
                  downloads what you&apos;re using, so the first open takes
                  seconds and the rest feels instant.
                </li>
                <li>
                  <strong>Real-time everything.</strong> Messages, mail
                  updates, and meeting changes appear live — no refresh
                  button, no waiting.
                </li>
              </ul>
            </article>

            <article className="home-pillar">
              <header>
                <span className="home-pillar-icon">🛡️</span>
                <h3>Secure — privacy is the default, not a feature</h3>
              </header>
              <p>
                Most platforms store your data in the clear and call security
                a premium add-on. Wayve flips that: your conversations and
                files are encrypted before they leave your device, and access
                is checked on every single action.
              </p>
              <ul className="home-pillar-features">
                <li>
                  <strong>End-to-end encrypted chat.</strong> Messages are
                  locked on your device before anyone sees them — not even
                  Wayve can read your conversations.
                </li>
                <li>
                  <strong>Files encrypted at rest.</strong> Industry-standard
                  256-bit encryption protects every uploaded file on our
                  servers.
                </li>
                <li>
                  <strong>Sign in the way you want.</strong> Email and
                  password, Google, or Microsoft — with one-hour password
                  reset links and rate-limited login attempts.
                </li>
                <li>
                  <strong>Granular roles.</strong> Nine permission levels
                  (Owner, Admin, Security, Billing, Developer, Support,
                  Member, Guest, and more) so the right people see the right
                  things.
                </li>
                <li>
                  <strong>Audit-ready.</strong> Every service API call is
                  logged, every role change recorded, every key has an
                  expiry. Compliance teams love this.
                </li>
              </ul>
            </article>

            <article className="home-pillar">
              <header>
                <span className="home-pillar-icon">📈</span>
                <h3>Scalable — grow without rebuilding</h3>
              </header>
              <p>
                A workspace that suits one person on day one shouldn&apos;t
                need a migration when you become twenty, or two hundred.
                Wayve is designed so your account, your team, and your bills
                grow on the same rails.
              </p>
              <ul className="home-pillar-features">
                <li>
                  <strong>Start free, upgrade later.</strong> Basic plan
                  forever; bump up only when you need more storage, more
                  seats, or more AI.
                </li>
                <li>
                  <strong>Solo → team → organization.</strong> Add teammates
                  with one invite; promote to an organization workspace
                  whenever you&apos;re ready — same data, same login.
                </li>
                <li>
                  <strong>Bring your existing mail.</strong> Connect Gmail or
                  Outlook in two clicks; more providers (IMAP, custom
                  domains) on the way without breaking anything.
                </li>
                <li>
                  <strong>Build on Wayve.</strong> Service API keys with
                  scoped access let your other tools talk to Wayve safely.
                </li>
                <li>
                  <strong>Billing that just works.</strong> Powered by
                  Stripe — switch plans any time, prorated automatically, no
                  surprises on the invoice.
                </li>
              </ul>
            </article>
          </section>

          <section className="home-stats">
            <div>
              <p className="home-stat-value">8+</p>
              <p className="home-stat-label">Tools replaced in one app</p>
            </div>
            <div>
              <p className="home-stat-value">9</p>
              <p className="home-stat-label">RBAC roles for fine control</p>
            </div>
            <div>
              <p className="home-stat-value">256-bit</p>
              <p className="home-stat-label">Encryption at rest</p>
            </div>
            <div>
              <p className="home-stat-value">30s</p>
              <p className="home-stat-label">Mailbox sync cadence</p>
            </div>
            <div>
              <p className="home-stat-value">0</p>
              <p className="home-stat-label">Extensions or installs</p>
            </div>
          </section>

          <section className="home-info-band">
            <h2>Who Wayve is for</h2>
            <p>
              From a freelancer juggling clients to an organization scaling
              past a hundred employees — the same workspace adapts to where
              you are.
            </p>
          </section>

          <section className="home-roles-grid">
            <article>
              <h3>🚀 Founders &amp; freelancers</h3>
              <p>
                Run your whole business from one tab. Mail for clients,
                scheduler for meetings, drive for deliverables, AI assistant
                for drafts — without paying for five different SaaS bills.
              </p>
            </article>
            <article>
              <h3>👥 Small teams (2–20)</h3>
              <p>
                Replace Slack, Zoom, Gmail, Drive, and Notion with one
                login. Shared channels, side-by-side apps, encrypted DMs,
                and team-wide file storage on a single plan.
              </p>
            </article>
            <article>
              <h3>🏢 Growing organizations (20–100)</h3>
              <p>
                Admin controls for onboarding, role-based permissions for
                department-level access, billing for the whole organization
                in one invoice. Add a department, not a new vendor.
              </p>
            </article>
            <article>
              <h3>🏛️ Enterprise (100+)</h3>
              <p>
                Dedicated support, custom SLAs, deeper audit access, and a
                roadmap that includes SSO and procurement-friendly contracts.
                Built to satisfy security review without slowing it down.
              </p>
            </article>
          </section>

          <section className="home-info-band home-comparison">
            <h2>Stop paying for five tools to do one job</h2>
            <p>
              Email, chat, calls, files, notes, tasks, scheduling, and AI in
              one bill, one login, one place. Wayve replaces the cluttered
              stack — and your team gets one workspace to learn, not five.
            </p>
            <div className="home-cta-actions">
              <button onClick={() => navigate("/register")}>Start free</button>
              <button onClick={() => navigate("/pricing")}>See plans</button>
              <button onClick={() => navigate("/enterprise")}>For organizations</button>
            </div>
          </section>

          <section id="pricing" className="home-info-band">
            <h2>Pricing</h2>
            <p>Simple plans for individuals, growing teams, and organization workspaces.</p>
          </section>

          <section className="home-info-grid">
            <article id="enterprise">
              <h2>Enterprise</h2>
              <p>Secure productivity features ready for organization workflows.</p>
            </article>
            <article id="support">
              <h2>Support</h2>
              <p>Guidance for teams setting up communication, billing, and workspaces.</p>
            </article>
            <article id="organization">
              <h2>Organization</h2>
              <p>Organized collaboration across files, schedules, and notes.</p>
            </article>
          </section>

          <footer className="public-home-footer">
            <div className="public-home-footer-grid">
              <div className="public-home-footer-brand">
                <button type="button" onClick={() => navigate("/")}>
                  <span className="public-home-footer-logo">✉</span>
                  <span>Wayve</span>
                </button>
              </div>

              <nav className="public-home-footer-column" aria-label="Company">
                <button type="button" onClick={() => navigate("/support")}>Support</button>
                <button type="button" onClick={() => navigate("/pricing")}>Pricing</button>
                <button type="button" onClick={() => navigate("/about")}>Privacy Policy</button>
                <button type="button" onClick={() => navigate("/developers")}>Developers</button>
                <button type="button" onClick={() => navigate("/enterprise")}>Technical white paper</button>
              </nav>

              <nav className="public-home-footer-column" aria-label="Product">
                <button type="button" onClick={() => navigate("/enterprise")}>Wayve for Business</button>
                <button type="button" onClick={() => navigate("/services/email")}>Email Aliases</button>
                <button type="button" onClick={() => navigate("/developers")}>Release notes</button>
                <button type="button" onClick={() => navigate("/services/email")}>Encrypted Email</button>
                <button type="button" onClick={() => navigate("/support")}>Status</button>
              </nav>

              <nav className="public-home-footer-column" aria-label="Resources">
                <button type="button" onClick={() => navigate("/about")}>Terms of service</button>
                <button type="button" onClick={() => navigate("/about")}>Press</button>
                <button type="button" onClick={() => navigate("/services/email")}>Private Email</button>
                <button type="button" onClick={() => navigate("/support")}>Contact</button>
                <button type="button" onClick={() => navigate("/security/audit")}>Transparency Report</button>
              </nav>

              <div className="public-home-footer-social" aria-label="Follow us">
                <h2>Follow us</h2>
                <div className="public-home-social-links">
                  <a href="https://www.facebook.com" aria-label="Facebook">f</a>
                  <a href="https://www.instagram.com" aria-label="Instagram">◎</a>
                  <a href="https://www.linkedin.com" aria-label="LinkedIn">in</a>
                  <a href="https://mastodon.social" aria-label="Mastodon">m</a>
                  <a href="https://x.com" aria-label="X">x</a>
                  <a href="https://www.youtube.com" aria-label="YouTube">▶</a>
                </div>
              </div>
            </div>

            <p className="public-home-footer-legal">
              © Wayve B.V. {new Date().getFullYear()}
            </p>
          </footer>
        </main>
      </div>
    );
  }


  return (
    <div className="dashboard u-page-shell">
      {/* GRID */}
      <div className="dashboard-grid">
        {visibleCards.map((card) => (
          <div key={card.path} className="card u-card u-card-interactive" onClick={() => navigate(card.path)}>
            <h3>{card.title}</h3>
            <p>{card.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
