import { useAuth } from "../auth/useAuth";
import { BRAND_NAME } from "../config/brand";
import BrandLogo from "../components/BrandLogo";
import { useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { SERVICES } from "../services/serviceData";
import ActivityDashboard from "./dashboard/ActivityDashboard";
import HeroMock from "./HeroMock";
import DownloadApp from "./DownloadApp";
import PersonalDashboard from "./dashboard/PersonalDashboard";
import { reportVisit } from "../api/visits";
import "./home.css";

export default function Home() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [servicesOpen, setServicesOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const servicesMenuRef = useRef<HTMLDivElement | null>(null);
  const servicesDropdownRef = useRef<HTMLElement | null>(null);
  const mobileMenuRef = useRef<HTMLDivElement | null>(null);
  const burgerRef = useRef<HTMLButtonElement | null>(null);

  // Navigate from the mobile hamburger menu, closing it on the way out.
  const goMobile = (path: string) => {
    setMobileMenuOpen(false);
    void navigate(path);
  };

  // Record this visit once per session — covers anonymous visitors opening
  // fluxze.com. The backend captures IP + user-agent server-side.
  useEffect(() => {
    reportVisit(window.location.pathname, document.referrer);
  }, []);

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

  useEffect(() => {
    if (!mobileMenuOpen) return;

    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      // Clicks on the toggle button or inside the menu shouldn't close it
      // (the button has its own toggle handler).
      if (burgerRef.current?.contains(target)) return;
      if (mobileMenuRef.current?.contains(target)) return;
      setMobileMenuOpen(false);
    };

    document.addEventListener("pointerdown", closeOnOutsidePointerDown);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointerDown);
    };
  }, [mobileMenuOpen]);

  if (!user) {
    return (
      <div className="public-home">
        <header className="public-home-nav">
          <button className="public-home-brand" onClick={() => navigate("/")}>
            <BrandLogo
              className="brand-mark"
              size={40}
              gradientId="fluxze-home-mark"
            />
            <span>{BRAND_NAME}</span>
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
            <button onClick={() => navigate("/support")}>Support</button>
          </nav>

          <div className="public-home-actions">
            <button
              className="home-login-btn"
              onClick={() => navigate("/login")}
            >
              Login
            </button>
            <button
              className="home-register-btn"
              onClick={() => navigate("/register")}
            >
              Register
            </button>
          </div>

          {/* Mobile hamburger — collapses the links + actions at ≤1120px. */}
          <button
            type="button"
            ref={burgerRef}
            className="public-home-burger"
            aria-label="Menu"
            aria-expanded={mobileMenuOpen}
            onClick={() => setMobileMenuOpen((open) => !open)}
          >
            <span />
            <span />
            <span />
          </button>

          {mobileMenuOpen && (
            <div className="public-home-mobile-menu" ref={mobileMenuRef}>
              <button
                onClick={() => {
                  setMobileMenuOpen(false);
                  setServicesOpen(true);
                }}
              >
                Products
              </button>
              <button onClick={() => goMobile("/pricing")}>Pricing</button>
              <button onClick={() => goMobile("/support")}>Support</button>
              <button onClick={() => goMobile("/login")}>Login</button>
              <button
                className="home-register-btn"
                onClick={() => goMobile("/register")}
              >
                Register
              </button>
            </div>
          )}
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
                    <span className="service-title">{service.name}</span>
                  </button>
                ))}
              </div>

              <div className="services-more">
                <h2>More from Fluxze</h2>
                <div className="services-more-grid">
                  <button onClick={() => navigate("/organization")}>
                    <span className="service-title">Fluxze Organization</span>
                  </button>
                  <button onClick={() => navigate("/login")}>
                    <span className="service-title">Secure Login</span>
                  </button>
                  <button onClick={() => navigate("/register")}>
                    <span className="service-title">Create Account</span>
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* ===================== HERO ===================== */}
          <section className="hx-hero">
            <div className="hx-hero-glow" aria-hidden="true" />
            <div className="hx-hero-grid" aria-hidden="true" />
            <div className="hx-hero-inner">
              <button
                type="button"
                className="hx-announce"
                onClick={() => navigate("/services/meet")}
              >
                <span className="hx-announce-tag">New</span>
                End-to-end encrypted calls &amp; meetings
                <span className="hx-announce-arrow" aria-hidden="true">
                  →
                </span>
              </button>

              <h1 className="hx-hero-title">
                Your entire workspace,
                <br />
                <span className="hx-grad">in one secure tab.</span>
              </h1>

              <p className="hx-hero-sub">
                Email, chat, calls, files, notes, tasks, and AI — unified,
                end-to-end encrypted, and fast. Replace five disconnected tools
                with one private home for your team.
              </p>

              <div className="hx-hero-cta">
                <button
                  className="hx-btn-primary"
                  onClick={() => navigate("/register")}
                >
                  Start free
                </button>
                <button
                  className="hx-btn-ghost"
                  onClick={() => navigate("/pricing")}
                >
                  See pricing <span aria-hidden="true">→</span>
                </button>
                {/* Auto-detects Apple Silicon vs Intel and lets the user
                    override. Files hosted at /download/Fluxze-<arch>.dmg. */}
                <DownloadApp />
              </div>
            </div>

            {/* Animated product mockup — a faux Fluxze app window */}
            <HeroMock />

            <div className="hx-chips" aria-label="Capabilities">
              {[
                "End-to-end encrypted",
                "Real-time sync",
                "RBAC roles",
                "Gmail & Outlook",
              ].map((c) => (
                <span key={c} className="hx-chip">
                  {c}
                </span>
              ))}
            </div>
          </section>

          {/* ===================== BENTO FEATURES ===================== */}
          <section className="hx-section">
            <div className="hx-section-head">
              <p className="hx-eyebrow">Why Fluxze</p>
              <h2>One platform. Everything your team runs on.</h2>
              <p className="hx-section-sub">
                Fast to use, private by default, and ready to scale from one
                person to a whole organization — without rebuilding.
              </p>
            </div>

            <div className="hx-bento">
              <article className="hx-bento-card hx-bento-lead">
                <span className="hx-bento-icon">⚡</span>
                <h3>Fast — one place to get work done</h3>
                <p>
                  Every daily action one click away on the same screen. Open two
                  tools side by side, with real-time updates and sub-second
                  loads.
                </p>
                <ul className="hx-bento-list">
                  <li>
                    One workspace for mail, chat, calls, files, notes & AI
                  </li>
                  <li>Side-by-side split-pane apps</li>
                  <li>Live updates — no refresh, no installs</li>
                </ul>
              </article>

              <article className="hx-bento-card">
                <span className="hx-bento-icon">🛡️</span>
                <h3>Secure by default</h3>
                <p>
                  End-to-end encrypted chat, files encrypted at rest with
                  256-bit AES, granular roles, and audit-ready logging.
                </p>
              </article>

              <article className="hx-bento-card">
                <span className="hx-bento-icon">📈</span>
                <h3>Scales with you</h3>
                <p>
                  Start free, upgrade when you grow. Solo → team → organization
                  on the same data and login, billed cleanly through Stripe.
                </p>
              </article>

              <article className="hx-bento-card hx-bento-wide">
                <span className="hx-bento-icon">🔌</span>
                <h3>Built to plug into your stack</h3>
                <p>
                  Bring your existing Gmail or Outlook, automate with scoped
                  service API keys, and keep everything observable with
                  transparent audit trails.
                </p>
              </article>
            </div>
          </section>

          {/* ===================== PRODUCTS ===================== */}
          <section className="hx-section">
            <div className="hx-section-head">
              <p className="hx-eyebrow">Products</p>
              <h2>Eight apps, one login.</h2>
            </div>
            <div className="hx-products">
              {SERVICES.map((service) => (
                <button
                  key={service.slug}
                  type="button"
                  className="hx-product"
                  onClick={() => navigate(`/services/${service.slug}`)}
                >
                  <span className="hx-product-name">{service.name}</span>
                </button>
              ))}
            </div>
          </section>

          {/* ===================== STATS ===================== */}
          <section className="hx-stats">
            {[
              { v: "8+", l: "Tools replaced in one app" },
              { v: "256-bit", l: "Encryption at rest" },
              { v: "0", l: "Extensions or installs" },
            ].map((s) => (
              <div key={s.l} className="hx-stat">
                <p className="hx-stat-value">{s.v}</p>
                <p className="hx-stat-label">{s.l}</p>
              </div>
            ))}
          </section>

          {/* ===================== WHO IT'S FOR ===================== */}
          <section className="hx-section">
            <div className="hx-section-head">
              <p className="hx-eyebrow">Who it's for</p>
              <h2>Built for every stage</h2>
            </div>
            <div className="hx-roles">
              <article className="hx-role">
                <span className="hx-role-emoji">👤</span>
                <h3>Personal</h3>
                <p>Email, chat, drive, tasks and notes — your whole day in one tab.</p>
              </article>
              <article className="hx-role">
                <span className="hx-role-emoji">🚀</span>
                <h3>Startups</h3>
                <p>One login instead of five tools. Get your team running in minutes.</p>
              </article>
              <article className="hx-role">
                <span className="hx-role-emoji">🏢</span>
                <h3>Business</h3>
                <p>Roles and admin controls, shared inboxes, and a single invoice.</p>
              </article>
              <article className="hx-role">
                <span className="hx-role-emoji">🏛️</span>
                <h3>Enterprise</h3>
                <p>SSO &amp; SCIM, dedicated support, SLAs, and deep audit access.</p>
              </article>
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
                <h3>
                  Can I integrate Fluxze with my existing identity provider?
                </h3>
                <p>
                  Yes — SAML 2.0 SSO with Okta, Azure AD, and Google Workspace.
                </p>
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
                <h3>Can I migrate data from other platforms?</h3>
                <p>Yes — we help migrate from Gmail, Outlook, and Slack.</p>
              </div>
            </div>
          </section>
        </main>

        <footer className="public-home-footer">
          <div className="public-home-footer-grid">
            <div className="public-home-footer-brand">
              <button type="button" onClick={() => navigate("/")}>
                <span className="public-home-footer-logo">✉</span>
                <span>Fluxze</span>
              </button>
            </div>

            <nav className="public-home-footer-column" aria-label="Company">
              <button type="button" onClick={() => navigate("/support")}>
                Support
              </button>
              <button type="button" onClick={() => navigate("/pricing")}>
                Pricing
              </button>
              <button type="button" onClick={() => navigate("/about")}>
                Privacy Policy
              </button>
              <button type="button" onClick={() => navigate("/developers")}>
                Developers
              </button>
              <button type="button" onClick={() => navigate("/enterprise")}>
                Technical white paper
              </button>
            </nav>

            <nav className="public-home-footer-column" aria-label="Product">
              <button type="button" onClick={() => navigate("/enterprise")}>
                Fluxze for Business
              </button>
              <button type="button" onClick={() => navigate("/services/email")}>
                Email Aliases
              </button>
              <button type="button" onClick={() => navigate("/developers")}>
                Release notes
              </button>
              <button type="button" onClick={() => navigate("/services/email")}>
                Encrypted Email
              </button>
              <button type="button" onClick={() => navigate("/support")}>
                Status
              </button>
            </nav>

            <nav className="public-home-footer-column" aria-label="Resources">
              <button type="button" onClick={() => navigate("/about")}>
                Terms of service
              </button>
              <button type="button" onClick={() => navigate("/about")}>
                Press
              </button>
              <button type="button" onClick={() => navigate("/services/email")}>
                Private Email
              </button>
              <button type="button" onClick={() => navigate("/support")}>
                Contact
              </button>
              <button type="button" onClick={() => navigate("/logs/audit")}>
                Transparency Report
              </button>
            </nav>

            <div className="public-home-footer-social" aria-label="Follow us">
              <h2>Follow us</h2>
              <div className="public-home-social-links">
                <a href="https://www.facebook.com" aria-label="Facebook">
                  f
                </a>
                <a href="https://www.instagram.com" aria-label="Instagram">
                  ◎
                </a>
                <a href="https://www.linkedin.com" aria-label="LinkedIn">
                  in
                </a>
                <a href="https://mastodon.social" aria-label="Mastodon">
                  m
                </a>
                <a href="https://x.com" aria-label="X">
                  x
                </a>
                <a href="https://www.youtube.com" aria-label="YouTube">
                  ▶
                </a>
              </div>
            </div>
          </div>

          <p className="public-home-footer-legal">
            © {BRAND_NAME} {new Date().getFullYear()}
          </p>
        </footer>
      </div>
    );
  }

  // Signed-in personal home — Activity Dashboard replaces the legacy
  // grid of app tiles (which duplicated the left sidebar's navigation).
  // Personal users get a three-section vertical dashboard (welcome +
  // Today + Emails) that's shaped around how an individual moves
  // through their day; org and platform-admin users continue to see
  // the 2×2 ActivityDashboard.
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
      <ActivityDashboard />
    </div>
  );
}
