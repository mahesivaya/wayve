import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BRAND_NAME } from "../config/brand";
import { SERVICES } from "../services/serviceData";
import "../home/home.css";

// Reusable public marketing header (brand + Products dropdown + nav links +
// optional Login/Register actions + mobile hamburger). Mirrors the landing
// header in [Home.tsx](../home/Home.tsx) so the public surface feels like one
// site. Pass `showActions={false}` on pages where the auth buttons are
// redundant (e.g. the Login/Register pages themselves).
export default function PublicHeader({
  showActions = true,
}: {
  showActions?: boolean;
}) {
  const navigate = useNavigate();
  const [servicesOpen, setServicesOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const servicesMenuRef = useRef<HTMLDivElement | null>(null);
  const servicesDropdownRef = useRef<HTMLElement | null>(null);
  const mobileMenuRef = useRef<HTMLDivElement | null>(null);
  const burgerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!servicesOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (servicesMenuRef.current?.contains(target)) return;
      if (servicesDropdownRef.current?.contains(target)) return;
      setServicesOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
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
    navigate(path);
  };

  return (
    <>
      <header className="public-home-nav">
        <button className="public-home-brand" onClick={() => navigate("/")}>
          {BRAND_NAME}
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

        {showActions && (
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
        )}

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
            {showActions && (
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
    </>
  );
}
