import { useAuth } from "../auth/useAuth";
import { useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { SERVICES } from "../services/serviceData";
import ThemeToggle from "../theme/ThemeToggle";
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
                {/* Direct path to org creation for visitors evaluating Wayve
                    as a team workspace. Register first (no auth means we
                    can't promote an account that doesn't exist), then
                    Register.tsx honours `?next=` and forwards to
                    /organizations/new instead of the default account home. */}
                <button
                  className="hero-actions-secondary"
                  onClick={() =>
                    navigate("/register?next=/organizations/new")
                  }
                >
                  Create organization →
                </button>
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
                  <strong>One workspace for everything.</strong> Email, chat,
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

          {/* Enterprise Features Section */}
          <section className="enterprise-features">
            <div className="enterprise-features-header">
              <h2>Enterprise-Grade Security & Compliance</h2>
              <p>Built to meet the most demanding security requirements with industry-standard certifications</p>
            </div>
            <div className="enterprise-features-grid">
              <div className="enterprise-feature-card">
                <div className="enterprise-feature-icon">🔐</div>
                <h3>End-to-End Encryption</h3>
                <p>All data encrypted at rest and in transit using AES-256. Zero-knowledge architecture ensures your data remains private.</p>
              </div>
              <div className="enterprise-feature-card">
                <div className="enterprise-feature-icon">🛡️</div>
                <h3>SOC 2 Type II Certified</h3>
                <p>Audited security controls meeting AICPA trust services criteria for security, availability, and confidentiality.</p>
              </div>
              <div className="enterprise-feature-card">
                <div className="enterprise-feature-icon">🌍</div>
                <h3>GDPR Compliant</h3>
                <p>Full compliance with EU data protection regulations. Data residency options in EU, US, and Asia-Pacific regions.</p>
              </div>
              <div className="enterprise-feature-card">
                <div className="enterprise-feature-icon">🔑</div>
                <h3>SSO & SAML</h3>
                <p>Enterprise single sign-on with Okta, Azure AD, Google Workspace, and custom SAML 2.0 identity providers.</p>
              </div>
              <div className="enterprise-feature-card">
                <div className="enterprise-feature-icon">📊</div>
                <h3>Audit Logs</h3>
                <p>Comprehensive logging of all user actions, API calls, and administrative changes with 7-year retention.</p>
              </div>
              <div className="enterprise-feature-card">
                <div className="enterprise-feature-icon">👥</div>
                <h3>SCIM Provisioning</h3>
                <p>Automated user provisioning and deprovisioning through System for Cross-domain Identity Management.</p>
              </div>
            </div>
          </section>

          {/* Trust Badges Section */}
          <section className="trust-badges">
            <div className="trust-badges-header">
              <h2>Trusted by Industry Leaders</h2>
              <p>Join thousands of organizations that trust Wayve for their critical communications</p>
            </div>
            <div className="trust-badges-grid">
              <div className="trust-badge">SOC 2</div>
              <div className="trust-badge">GDPR</div>
              <div className="trust-badge">ISO 27001</div>
              <div className="trust-badge">HIPAA</div>
              <div className="trust-badge">CCPA</div>
              <div className="trust-badge">PCI DSS</div>
            </div>
          </section>

          {/* Integrations Section */}
          <section className="integrations-section">
            <div className="integrations-header">
              <h2>Seamless Integrations</h2>
              <p>Connect Wayve with your existing tools and workflows</p>
            </div>
            <div className="integrations-grid">
              <div className="integration-item">
                <div className="integration-icon">📧</div>
                <span>Gmail</span>
              </div>
              <div className="integration-item">
                <div className="integration-icon">📅</div>
                <span>Google Calendar</span>
              </div>
              <div className="integration-item">
                <div className="integration-icon">🔵</div>
                <span>Microsoft 365</span>
              </div>
              <div className="integration-item">
                <div className="integration-icon">📊</div>
                <span>Slack</span>
              </div>
              <div className="integration-item">
                <div className="integration-icon">💼</div>
                <span>Salesforce</span>
              </div>
              <div className="integration-item">
                <div className="integration-icon">🗂️</div>
                <span>Dropbox</span>
              </div>
              <div className="integration-item">
                <div className="integration-icon">🔗</div>
                <span>Zapier</span>
              </div>
              <div className="integration-item">
                <div className="integration-icon">⚡</div>
                <span>Webhooks</span>
              </div>
            </div>
          </section>

          {/* Testimonials Section */}
          <section className="testimonials-section">
            <div className="testimonials-header">
              <h2>What Our Customers Say</h2>
              <p>See how organizations transform their productivity with Wayve</p>
            </div>
            <div className="testimonials-grid">
              <div className="testimonial-card">
                <div className="testimonial-content">
                  <p>"Wayve replaced 5 different tools for our team. The security features give our IT department peace of mind, while employees love the unified interface."</p>
                </div>
                <div className="testimonial-author">
                  <div className="author-avatar">SK</div>
                  <div className="author-info">
                    <strong>Sarah Kim</strong>
                    <span>CTO, TechCorp Inc.</span>
                  </div>
                </div>
              </div>
              <div className="testimonial-card">
                <div className="testimonial-content">
                  <p>"The enterprise features are exactly what we needed. SSO integration was seamless, and the audit logs satisfy our compliance requirements."</p>
                </div>
                <div className="testimonial-author">
                  <div className="author-avatar">MJ</div>
                  <div className="author-info">
                    <strong>Michael Johnson</strong>
                    <span>VP of Security, FinanceHub</span>
                  </div>
                </div>
              </div>
              <div className="testimonial-card">
                <div className="testimonial-content">
                  <p>"Implementation was smooth and the ROI was immediate. We've reduced our SaaS spend by 40% while improving team collaboration."</p>
                </div>
                <div className="testimonial-author">
                  <div className="author-avatar">EP</div>
                  <div className="author-info">
                    <strong>Emily Patel</strong>
                    <span>CEO, StartupXYZ</span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Enterprise Pricing Section */}
          <section className="enterprise-pricing">
            <div className="enterprise-pricing-header">
              <h2>Enterprise Pricing</h2>
              <p>Flexible plans designed for organizations of all sizes</p>
            </div>
            <div className="pricing-table">
              <div className="pricing-card pricing-card-standard">
                <div className="pricing-header">
                  <h3>Team</h3>
                  <div className="pricing-price">
                    <span className="price-amount">$12</span>
                    <span className="price-period">/user/month</span>
                  </div>
                  <p className="pricing-description">Perfect for small teams getting started</p>
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
              <p>Everything you need to know about Wayve Enterprise</p>
            </div>
            <div className="faq-grid">
              <div className="faq-item">
                <h3>What security certifications does Wayve have?</h3>
                <p>Wayve is SOC 2 Type II certified, GDPR compliant, and ISO 27001 certified. We undergo annual third-party security audits to maintain these certifications.</p>
              </div>
              <div className="faq-item">
                <h3>Can I integrate Wayve with my existing identity provider?</h3>
                <p>Yes, Wayve supports SSO through SAML 2.0 and integrates with Okta, Azure AD, Google Workspace, and other major identity providers.</p>
              </div>
              <div className="faq-item">
                <h3>What is your data retention policy?</h3>
                <p>Retention periods vary by plan: Team (30 days), Business (1 year), and Enterprise (7 years). Custom retention options are available for Enterprise customers.</p>
              </div>
              <div className="faq-item">
                <h3>Do you offer on-premise deployment?</h3>
                <p>Yes, Enterprise customers can choose cloud or on-premise deployment. Our team will work with you to determine the best option for your requirements.</p>
              </div>
              <div className="faq-item">
                <h3>What kind of support do you offer?</h3>
                <p>Team plans include email support, Business plans include priority support, and Enterprise plans include 24/7 phone support with a dedicated account manager.</p>
              </div>
              <div className="faq-item">
                <h3>Can I migrate data from other platforms?</h3>
                <p>Yes, we offer migration assistance from Gmail, Outlook, Slack, and other popular platforms. Our team handles the entire migration process.</p>
              </div>
            </div>
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
