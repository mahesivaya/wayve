import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { SERVICES } from "../services/serviceData";
import ThemeToggle from "../theme/ThemeToggle";
import "../home/home.css";
import "./marketing.css";

// Shared chrome for public marketing pages (Enterprise, Support).
// Mirrors the localhost public Home header (brand + Products dropdown + nav
// links + Login/Register) so the marketing surface feels like one site.
// Logged-in visitors see Home/Logout instead of Login/Register.
export default function MarketingShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
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
          {user ? (
            <>
              <button className="home-login-btn" onClick={() => navigate("/home")}>
                Home
              </button>
              <button className="home-register-btn" onClick={() => logout()}>
                Logout
              </button>
            </>
          ) : (
            <>
              <button className="home-login-btn" onClick={() => navigate("/login")}>
                Login
              </button>
              <button className="home-register-btn" onClick={() => navigate("/register")}>
                Register
              </button>
            </>
          )}
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
                    </span>
                    <span className="service-description">{service.summary}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {children}
      </main>

      <footer className="marketing-footer">
        <div className="marketing-footer-inner">
          <div>
            <strong>Wayve</strong>
            <p>One private workspace for mail, chat, calls, files, and AI.</p>
          </div>
          <div>
            <h4>Product</h4>
            <button onClick={() => navigate("/pricing")}>Pricing</button>
            <button onClick={() => navigate("/enterprise")}>Enterprise</button>
            <button onClick={() => navigate("/support")}>Support</button>
          </div>
          <div>
            <h4>Account</h4>
            {user ? (
              <>
                <button onClick={() => navigate("/home")}>Home</button>
                <button onClick={() => logout()}>Logout</button>
              </>
            ) : (
              <>
                <button onClick={() => navigate("/login")}>Login</button>
                <button onClick={() => navigate("/register")}>Register</button>
              </>
            )}
          </div>
        </div>
        <p className="marketing-footer-legal">
          © {new Date().getFullYear()} Wayve. All rights reserved.
        </p>
      </footer>
    </div>
  );
}
