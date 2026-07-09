import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BRAND_NAME } from "../config/brand";
import BrandLogo from "./BrandLogo";
import "../home/home.css";

// Reusable public marketing header (brand + nav links + optional
// Login/Register actions + mobile hamburger). Mirrors the landing header in
// [Home.tsx](../home/Home.tsx) so the public surface feels like one site. Pass
// `showActions={false}` on pages where the auth buttons are redundant (e.g. the
// Login/Register pages themselves).
export default function PublicHeader({
  showActions = true,
}: {
  showActions?: boolean;
}) {
  const navigate = useNavigate();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement | null>(null);
  const burgerRef = useRef<HTMLButtonElement | null>(null);

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
    <>
      <header className="public-home-nav">
        <button className="public-home-brand" onClick={() => navigate("/")}>
          <BrandLogo className="brand-mark" size={40} />
          <span>{BRAND_NAME}</span>
        </button>

        <nav className="public-home-links" aria-label="Main navigation">
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
    </>
  );
}
