import { useAuth } from "../auth/useAuth";
import { useNavigate } from "react-router-dom";
import { useGlobalSearch } from "../search/SearchContext";
import { useState, useMemo } from "react";
import { SERVICES } from "../services/serviceData";
import "./home.css";

const HOME_CARDS = [
  { path: "/emails", title: "📧 Emails", description: "View and send emails" },
  { path: "/chat", title: "💬 Chat", description: "Real-time messaging" },
  // /call removed from the home grid — calls live inside [Chat](../chat/Chat.tsx)'s
  // conversation header (audio + video icons on a 1:1 DM). The /call route is
  // still reachable directly for any existing bookmarks.
  { path: "/scheduler", title: "📅 Scheduler", description: "Manage your meetings" },
  { path: "/drive", title: "📁 Drive", description: "Store and manage files" },
  { path: "/notes", title: "📝 Notes", description: "Store and manage notes" },
  { path: "/tasks", title: "☑ Tasks", description: "Create and track tasks" },
  { path: "/aichat", title: "✨ AI Chat", description: "Chat with AI" },
  { path: "/about", title: "ⓘ About", description: "Learn how Wayve fits together" },
];

export default function Home() {
  const { user } = useAuth();
  const { normalizedSearchQuery } = useGlobalSearch();
  const navigate = useNavigate();
  const [servicesOpen, setServicesOpen] = useState(true);

  const visibleCards = useMemo(() => {
    if (!normalizedSearchQuery) return HOME_CARDS;
    return HOME_CARDS.filter((card) =>
      [card.title, card.description]
        .join(" ")
        .toLowerCase()
        .includes(normalizedSearchQuery)
    );
  }, [normalizedSearchQuery]);

  if (!user) {
    return (
      <div className="public-home">
        <header className="public-home-nav">
          <button className="public-home-brand" onClick={() => navigate("/")}>
            Wayve
          </button>

          <nav className="public-home-links" aria-label="Main navigation">
            <div className="services-menu">
              <button
                className={`services-trigger ${servicesOpen ? "active" : ""}`}
                onClick={() => setServicesOpen((open) => !open)}
                aria-expanded={servicesOpen}
                aria-controls="services-dropdown"
              >
                Services
                <span className="services-caret" aria-hidden="true">
                  {servicesOpen ? "⌃" : "⌄"}
                </span>
              </button>
            </div>

          <button onClick={() => navigate("/organization")}>Organization</button>
            <button onClick={() => navigate("/#pricing")}>Pricing</button>
            <button onClick={() => navigate("/#x")}>X</button>
            <button onClick={() => navigate("/#y")}>Y</button>
            <button onClick={() => navigate("/#z")}>Z</button>
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
              <h1>One home for mail, chat, calls, files, notes, and AI.</h1>
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

          <section id="pricing" className="home-info-band">
            <h2>Pricing</h2>
            <p>Simple plans for individuals, growing teams, and organization workspaces.</p>
          </section>

          <section className="home-info-grid">
            <article id="x">
              <h2>X</h2>
              <p>Flexible communication tools for day-to-day work.</p>
            </article>
            <article id="y">
              <h2>Y</h2>
              <p>Organized collaboration across files, schedules, and notes.</p>
            </article>
            <article id="z">
              <h2>Z</h2>
              <p>Secure productivity features ready for organization workflows.</p>
            </article>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="dashboard u-page-shell">
      {/* HEADER */}
      <div className="dashboard-header u-panel u-flex-between">
        <h2>Welcome {user.role_label ?? "Personal workspace owner"}</h2>
        <p>{user.email}</p>
      </div>

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
