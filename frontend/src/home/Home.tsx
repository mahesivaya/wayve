import { useAuth } from "../auth/useAuth";
import { BRAND_NAME } from "../config/brand";
import BrandLogo from "../components/BrandLogo";
import { BrandIcon } from "../integrations/BrandIcon";
import { useNavigate } from "react-router-dom";
import { useEffect, useRef, useState, lazy, Suspense } from "react";
import HeroMock from "./HeroMock";
import DownloadApp from "./DownloadApp";
import { reportVisit } from "../api/visits";
import "./home.css";

// Home renders the AI Chat surface for every signed-in user (the sidebar AI
// Chat item is removed). Lazy so the logged-out marketing page never fetches it.
const AIChat = lazy(() => import("../aichat/AIChat"));

export default function Home() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
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
          {/* ===================== HERO ===================== */}
          <section className="hx-hero">
            <div className="hx-hero-glow" aria-hidden="true" />
            <div className="hx-hero-grid" aria-hidden="true" />
            <div className="hx-hero-inner">
              <div className="hx-announce">
                Private. Secure. Built for modern teams.
              </div>

              <h1 className="hx-hero-title">
                <span>The operating system</span>
                <br />
                <span className="hx-grad">for your workspace.</span>
              </h1>

              <p className="hx-hero-sub">
                Unify communication, collaboration, and knowledge in one place.
                <br />
                End-to-end encrypted. Fast by design. Built for focus.
              </p>

              <div className="hx-hero-cta">
                <button
                  className="hx-btn-primary"
                  onClick={() => navigate("/pricing")}
                >
                  Get Started <span aria-hidden="true">→</span>
                </button>
                <button
                  className="hx-btn-ghost"
                  onClick={() => navigate("/book-demo")}
                >
                  Book a Demo
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
                "Blazing fast",
                "Private by design",
                "Built for teams",
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

          {/* ===================== INTEGRATIONS ===================== */}
          <section className="hx-section">
            <div className="hx-section-head">
              <p className="hx-eyebrow">Integrations</p>
              <h2>Connect a service</h2>
              <p className="hx-section-sub">
                Bring the tools you already use. Connect your mail, code, and
                issues — then work with them right inside Fluxze.
              </p>
            </div>
            <div className="hx-integrations">
              {[
                {
                  name: "Jira",
                  icon: "jira",
                  status: "Connect",
                  desc: "Sync Jira issues into Tasks and get real-time updates from Jira via webhook.",
                },
                {
                  name: "GitHub",
                  icon: "github",
                  status: "Enabled",
                  enabled: true,
                  desc: "Browse repositories, commits, diffs, and CI runs from your linked projects.",
                },
                {
                  name: "Gmail",
                  icon: "gmail",
                  status: "Connect",
                  desc: "Connect a Gmail mailbox to import its mail and read it under Emails.",
                },
                {
                  name: "Outlook",
                  icon: "outlook",
                  status: "Connect",
                  desc: "Connect an Outlook mailbox to import its mail and read it under Emails.",
                },
                {
                  name: "GitLab",
                  icon: "gitlab",
                  status: "Connect",
                  desc: "Connect GitLab (cloud or self-hosted) and import your assigned issues into Tasks.",
                },
                {
                  name: "More",
                  icon: "more",
                  status: "Explore",
                  desc: "Slack, scoped service API keys, webhooks, and more — connect the rest of your stack.",
                },
              ].map((it) => (
                <article key={it.name} className="hx-integration">
                  <div className="hx-integration-head">
                    <span className="hx-integration-icon">
                      {it.icon === "more" ? (
                        <svg
                          viewBox="0 0 24 24"
                          width="22"
                          height="22"
                          fill="#475569"
                          aria-hidden="true"
                        >
                          <circle cx="5" cy="12" r="2" />
                          <circle cx="12" cy="12" r="2" />
                          <circle cx="19" cy="12" r="2" />
                        </svg>
                      ) : (
                        <BrandIcon name={it.icon} />
                      )}
                    </span>
                    <span className="hx-integration-titles">
                      <span className="hx-integration-name">{it.name}</span>
                      <span
                        className={`hx-integration-status ${
                          it.enabled ? "is-enabled" : ""
                        }`}
                      >
                        {it.status}
                      </span>
                    </span>
                  </div>
                  <p className="hx-integration-desc">{it.desc}</p>
                </article>
              ))}
            </div>
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
        </main>

        <footer className="public-home-footer">
          <p className="public-home-footer-legal">
            © {BRAND_NAME} {new Date().getFullYear()}
          </p>
        </footer>
      </div>
    );
  }

  // Home IS the AI Chat page for every signed-in user (personal, organization,
  // and platform). Clicking Home (which routes to "/") lands the user straight
  // in AI Chat; the AI Chat sidebar item is removed (see Layout). `hideHeader`
  // keeps the surface chrome-free — no "AI Chat / provider / model" bar.
  return (
    <div className="home-authed-aichat">
      <Suspense
        fallback={<div className="split-loading">Loading AI Chat…</div>}
      >
        <AIChat hideHeader />
      </Suspense>
    </div>
  );
}
