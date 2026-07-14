import { useEffect, useRef, useState, type ReactNode } from "react";
import { BRAND_NAME } from "../config/brand";
import BrandLogo from "../components/BrandLogo";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import "../home/home.css";
import "./marketing.css";

// Shared chrome for public marketing pages. Logged-in visitors see Home/Logout
// instead of Login/Register.
export default function MarketingShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  // Docs are internal/platform-only: hide the link from personal accounts,
  // organizations, and logged-out visitors (the public main page).
  const isPlatform =
    user?.account_type === "platform_admin" ||
    !!user?.username?.startsWith("platform-");
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
          <button onClick={() => navigate("/pricing")}>Pricing</button>
          {isPlatform && (
            <button onClick={() => navigate("/docs")}>Docs</button>
          )}
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
                onClick={() => navigate("/pricing")}
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
            <button onClick={() => goMobile("/pricing")}>Pricing</button>
            {isPlatform && (
              <button onClick={() => goMobile("/docs")}>Docs</button>
            )}
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
                  onClick={() => goMobile("/pricing")}
                >
                  Register
                </button>
              </>
            )}
          </div>
        )}
      </header>

      <main className="public-home-main">{children}</main>

      <footer className="marketing-footer">
        <p className="marketing-footer-legal">
          © {new Date().getFullYear()} {BRAND_NAME}. All rights reserved.
        </p>
      </footer>
    </div>
  );
}
