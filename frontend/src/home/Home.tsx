import { useAuth } from "../auth/useAuth";
import { useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { SERVICES } from "../services/serviceData";
import ActivityDashboard from "./dashboard/ActivityDashboard";
import PersonalDashboard from "./dashboard/PersonalDashboard";
import { APP_TIME_ZONE } from "../utils/datetime";
import "./home.css";

export default function Home() {
  const { user } = useAuth();
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

  if (!user) {
    return (
      <div className="public-home">
        <header className="public-home-nav">
          <button className="public-home-brand" onClick={() => navigate("/")}>
            Fluxze
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
                <h2>More from Fluxze</h2>
                <div className="services-more-grid">
                  <button onClick={() => navigate("/organization")}>
                    <span className="service-icon organization">O</span>
                    <span>
                      <strong>Fluxze Organization</strong>
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
            </div>
          </section>

          <section className="home-info-band">
            <h2>Built for fast, secure, scalable work</h2>
            <p>Fast to use, private by default, and ready to grow with you.</p>
          </section>

          <section className="home-pillars">
            <article className="home-pillar">
              <header>
                <span className="home-pillar-icon">⚡</span>
                <h3>Fast — one place to get work done</h3>
              </header>
              <p>Every daily action one click away on the same screen.</p>
              <ul className="home-pillar-features">
                <li>
                  <strong>One workspace for everything.</strong> Mail, chat,
                  calls, files, notes, tasks, and AI.
                </li>
                <li>
                  <strong>Side-by-side apps.</strong> Open two tools at once.
                </li>
                <li>
                  <strong>Lightning-fast loads.</strong> Opens in seconds.
                </li>
                <li>
                  <strong>Real-time everything.</strong> Updates appear live.
                </li>
              </ul>
            </article>

            <article className="home-pillar">
              <header>
                <span className="home-pillar-icon">🛡️</span>
                <h3>Secure — privacy is the default, not a feature</h3>
              </header>
              <p>Your conversations and files are encrypted by default.</p>
              <ul className="home-pillar-features">
                <li>
                  <strong>End-to-end encrypted chat.</strong> Only you can read it.
                </li>
                <li>
                  <strong>Files encrypted at rest.</strong> 256-bit encryption.
                </li>
                <li>
                  <strong>Sign in your way.</strong> Email, Google, or Microsoft.
                </li>
                <li>
                  <strong>Granular roles.</strong> Fine-grained access control.
                </li>
                <li>
                  <strong>Audit-ready.</strong> Every action is logged.
                </li>
              </ul>
            </article>

            <article className="home-pillar">
              <header>
                <span className="home-pillar-icon">📈</span>
                <h3>Scalable — grow without rebuilding</h3>
              </header>
              <p>From one user to a whole organization on the same rails.</p>
              <ul className="home-pillar-features">
                <li>
                  <strong>Start free, upgrade later.</strong> Pay when you grow.
                </li>
                <li>
                  <strong>Solo → team → organization.</strong> Same data, same login.
                </li>
                <li>
                  <strong>Bring your existing mail.</strong> Connect Gmail or Outlook.
                </li>
                <li>
                  <strong>Build on Fluxze.</strong> Scoped service API keys.
                </li>
                <li>
                  <strong>Billing that just works.</strong> Powered by Stripe.
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
            <h2>Who Fluxze is for</h2>
            <p>One workspace that adapts from solo to organization.</p>
          </section>

          <section className="home-roles-grid">
            <article>
              <h3>🚀 Founders &amp; freelancers</h3>
              <p>Run your whole business from one tab.</p>
            </article>
            <article>
              <h3>👥 Small teams (2–20)</h3>
              <p>One login instead of five separate tools.</p>
            </article>
            <article>
              <h3>🏢 Growing organizations (20–100)</h3>
              <p>Admin controls, roles, and one invoice.</p>
            </article>
            <article>
              <h3>🏛️ Enterprise (100+)</h3>
              <p>Dedicated support, SLAs, and deeper audit access.</p>
            </article>
          </section>

          <section className="home-info-band home-comparison">
            <h2>Stop paying for five tools to do one job</h2>
            <p>Everything in one bill, one login, one place.</p>
            <div className="home-cta-actions">
              <button onClick={() => navigate("/register")}>Start free</button>
              <button onClick={() => navigate("/pricing")}>See plans</button>
              <button onClick={() => navigate("/enterprise")}>For organizations</button>
            </div>
          </section>

          <section id="pricing" className="home-info-band">
            <h2>Pricing</h2>
            <p>Simple plans for individuals and teams.</p>
          </section>

          <section className="home-info-grid">
            <article id="enterprise">
              <h2>Enterprise</h2>
              <p>Secure features for organization workflows.</p>
            </article>
            <article id="support">
              <h2>Support</h2>
              <p>Help with setup, billing, and workspaces.</p>
            </article>
            <article id="organization">
              <h2>Organization</h2>
              <p>Collaboration across files, schedules, and notes.</p>
            </article>
          </section>

          {/* Enterprise Pricing Section */}
          <section className="enterprise-pricing">
            <div className="enterprise-pricing-header">
              <h2>Enterprise Pricing</h2>
              <p>Plans for organizations of all sizes.</p>
            </div>
            <div className="pricing-table">
              <div className="pricing-card pricing-card-standard">
                <div className="pricing-header">
                  <h3>Team</h3>
                  <div className="pricing-price">
                    <span className="price-amount">$12</span>
                    <span className="price-period">/user/month</span>
                  </div>
                  <p className="pricing-description">For small teams getting started</p>
                </div>
                <ul className="pricing-features">
                  <li>✓ All core features included</li>
                  <li>✓ 50GB storage per user</li>
                  <li>✓ Basic admin controls</li>
                  <li>✓ Email support</li>
                  <li>✓ 30-day retention</li>
                </ul>
                <button className="pricing-cta" onClick={() => navigate("/register")}>Get Started</button>
              </div>
              <div className="pricing-card pricing-card-popular">
                <div className="popular-badge">Most Popular</div>
                <div className="pricing-header">
                  <h3>Business</h3>
                  <div className="pricing-price">
                    <span className="price-amount">$25</span>
                    <span className="price-period">/user/month</span>
                  </div>
                  <p className="pricing-description">For growing organizations</p>
                </div>
                <ul className="pricing-features">
                  <li>✓ Everything in Team</li>
                  <li>✓ Unlimited storage</li>
                  <li>✓ Advanced admin dashboard</li>
                  <li>✓ Priority support</li>
                  <li>✓ 1-year retention</li>
                  <li>✓ SSO integration</li>
                  <li>✓ API access</li>
                </ul>
                <button className="pricing-cta pricing-cta-primary" onClick={() => navigate("/enterprise")}>Contact Sales</button>
              </div>
              <div className="pricing-card pricing-card-enterprise">
                <div className="pricing-header">
                  <h3>Enterprise</h3>
                  <div className="pricing-price">
                    <span className="price-amount">Custom</span>
                  </div>
                  <p className="pricing-description">For large-scale deployments</p>
                </div>
                <ul className="pricing-features">
                  <li>✓ Everything in Business</li>
                  <li>✓ Custom SLA</li>
                  <li>✓ Dedicated account manager</li>
                  <li>✓ 24/7 phone support</li>
                  <li>✓ 7-year retention</li>
                  <li>✓ Advanced security features</li>
                  <li>✓ Custom integrations</li>
                  <li>✓ On-premise deployment option</li>
                </ul>
                <button className="pricing-cta" onClick={() => navigate("/enterprise")}>Contact Sales</button>
              </div>
            </div>
          </section>

          {/* FAQ Section */}
          <section className="faq-section">
            <div className="faq-header">
              <h2>Frequently Asked Questions</h2>
              <p>Quick answers about Fluxze Enterprise.</p>
            </div>
            <div className="faq-grid">
              <div className="faq-item">
                <h3>What security certifications does Fluxze have?</h3>
                <p>SOC 1 Type II, GDPR, and ISO 27001, audited annually.</p>
              </div>
              <div className="faq-item">
                <h3>Can I integrate Fluxze with my existing identity provider?</h3>
                <p>Yes — SAML 2.0 SSO with Okta, Azure AD, and Google Workspace.</p>
              </div>
              <div className="faq-item">
                <h3>What is your data retention policy?</h3>
                <p>Team 30 days, Business 1 year, Enterprise 7 years.</p>
              </div>
              <div className="faq-item">
                <h3>Do you offer on-premise deployment?</h3>
                <p>Yes — cloud or on-premise for Enterprise customers.</p>
              </div>
              <div className="faq-item">
                <h3>What kind of support do you offer?</h3>
                <p>Email, priority, or 24/7 phone support by plan.</p>
              </div>
              <div className="faq-item">
                <h3>Can I migrate data from other platforms?</h3>
                <p>Yes — we help migrate from Gmail, Outlook, and Slack.</p>
              </div>
            </div>
          </section>

          <footer className="public-home-footer">
            <div className="public-home-footer-grid">
              <div className="public-home-footer-brand">
                <button type="button" onClick={() => navigate("/")}>
                  <span className="public-home-footer-logo">✉</span>
                  <span>Fluxze</span>
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
                <button type="button" onClick={() => navigate("/enterprise")}>Fluxze for Business</button>
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
              © Fluxze B.V. {new Date().getFullYear()}
            </p>
          </footer>
        </main>
      </div>
    );
  }


  // Signed-in personal home — Activity Dashboard replaces the legacy
  // grid of app tiles (which duplicated the left sidebar's navigation).
  // Personal users get a three-section vertical dashboard (welcome +
  // Today + Emails) that's shaped around how an individual moves
  // through their day; org and platform-admin users continue to see
  // the 2×2 ActivityDashboard. The welcome header for ActivityDashboard
  // stays here because PersonalDashboard renders its own greeting.
  const firstName = user.email?.split("@")[0] ?? "there";
  const today = new Date().toLocaleDateString("en-US", {
    timeZone: APP_TIME_ZONE,
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  const isPersonalUser =
    user.scope === "personal" || user.account_type === "personal";

  if (isPersonalUser) {
    // Personal home owns its own scroll inside the Emails card, so it
    // skips the page-level `u-page-shell` (which sets `overflow-y: auto`
    // on the whole page) and uses a fixed-height flex wrapper instead.
    return (
      <div className="home-authed-personal">
        <PersonalDashboard />
      </div>
    );
  }

  return (
    <div className="home-authed u-page-shell">
      <header className="home-authed-greeting">
        <h1>Welcome back, {firstName}</h1>
        <p>{today}</p>
      </header>
      <ActivityDashboard />
    </div>
  );
}
