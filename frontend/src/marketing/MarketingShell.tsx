import { useEffect, useRef, useState, type ReactNode } from "react";
import { BRAND_NAME } from "../config/brand";
import BrandLogo from "../components/BrandLogo";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { SERVICES } from "../services/serviceData";
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
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const servicesMenuRef = useRef<HTMLDivElement | null>(null);
  const servicesDropdownRef = useRef<HTMLElement | null>(null);
  const mobileMenuRef = useRef<HTMLDivElement | null>(null);
  const burgerRef = useRef<HTMLButtonElement | null>(null);

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
    const close = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (burgerRef.current?.contains(target)) return;
      if (mobileMenuRef.current?.contains(target)) return;
      setMobileMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [mobileMenuOpen]);

  const goMobile = (path: string) => {
    setMobileMenuOpen(false);
    void navigate(path);
  };

  return (
    <div className="public-home">
      <header className="public-home-nav">
        <button className="public-home-brand" onClick={() => navigate("/")}>
          <BrandLogo
            className="brand-mark"
            size={40}
            gradientId="fluxze-nav-mark"
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
          <button onClick={() => navigate("/docs")}>Docs</button>
          <button onClick={() => navigate("/support")}>Support</button>
        </nav>

        <div className="public-home-actions">
          {user ? (
            <>
              <button
                className="home-login-btn"
                onClick={() => navigate("/home")}
              >
                Home
              </button>
              <button className="home-register-btn" onClick={() => logout()}>
                Logout
              </button>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>

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
            <button onClick={() => goMobile("/docs")}>Docs</button>
            <button onClick={() => goMobile("/support")}>Support</button>
            {user ? (
              <>
                <button onClick={() => goMobile("/home")}>Home</button>
                <button
                  className="home-register-btn"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    logout();
                  }}
                >
                  Logout
                </button>
              </>
            ) : (
              <>
                <button onClick={() => goMobile("/login")}>Login</button>
                <button
                  className="home-register-btn"
                  onClick={() => goMobile("/register")}
                >
                  Register
                </button>
              </>
            )}
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
          </section>
        )}

        {children}
      </main>

      <footer className="marketing-footer">
        <div className="marketing-footer-inner">
          <div>
            <strong className="marketing-footer-brand">
              <BrandLogo
                className="brand-mark"
                size={32}
                gradientId="fluxze-footer-mark"
              />
              {BRAND_NAME}
            </strong>
            <p>One private workspace for mail, chat, calls, files, and AI.</p>
          </div>
          <div>
            <h4>Product</h4>
            <button onClick={() => navigate("/pricing")}>Pricing</button>
            <button onClick={() => navigate("/enterprise")}>Enterprise</button>
            <button onClick={() => navigate("/support")}>Support</button>
          </div>
          <div>
            <h4>Developers</h4>
            <button onClick={() => navigate("/docs")}>All docs</button>
            <button onClick={() => navigate("/docs/api")}>API reference</button>
            <button onClick={() => navigate("/docs/quotas")}>
              Quotas & tiers
            </button>
            <button onClick={() => navigate("/docs/developers")}>
              SDK & guides
            </button>
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
          © {new Date().getFullYear()} {BRAND_NAME}. All rights reserved.
        </p>
      </footer>
    </div>
  );
}
