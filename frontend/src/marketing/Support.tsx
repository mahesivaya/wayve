import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import MarketingShell from "./MarketingShell";

export default function Support() {
  const navigate = useNavigate();
  const { user } = useAuth();

  return (
    <MarketingShell>
      <section className="marketing-hero">
        <div className="marketing-hero-copy">
          <p className="marketing-eyebrow">Support</p>
          <h1>We're here when something doesn't feel right.</h1>
          <p className="lead">
            Most questions are answered below. If yours isn't, send us a note —
            a real person reads every message, usually within a business day.
          </p>
          <div className="marketing-hero-actions">
            <button
              onClick={() =>
                (window.location.href = "mailto:mahesh@fluxze.com")
              }
            >
              Email support
            </button>
            {user?.account_type !== "platform_admin" &&
              !user?.username?.startsWith("platform-") && (
                <button onClick={() => navigate("/pricing")}>
                  See pricing
                </button>
              )}
          </div>
        </div>

        <div className="marketing-hero-visual">
          <div className="marketing-hero-card">
            <div className="marketing-hero-card-row">
              <span className="marketing-hero-card-icon">✅</span>
              <span className="marketing-hero-card-text">
                All systems operational
              </span>
              <span className="marketing-hero-card-meta">Live</span>
            </div>
            <div className="marketing-hero-card-row">
              <span className="marketing-hero-card-icon">📬</span>
              <span className="marketing-hero-card-text">
                Mail sync — healthy
              </span>
              <span className="marketing-hero-card-meta">30s</span>
            </div>
            <div className="marketing-hero-card-row">
              <span className="marketing-hero-card-icon">💬</span>
              <span className="marketing-hero-card-text">
                WebSocket chat — healthy
              </span>
              <span className="marketing-hero-card-meta">0ms</span>
            </div>
            <div className="marketing-hero-card-row">
              <span className="marketing-hero-card-icon">📞</span>
              <span className="marketing-hero-card-text">Calls — healthy</span>
              <span className="marketing-hero-card-meta">0ms</span>
            </div>
            <div className="marketing-hero-card-row">
              <span className="marketing-hero-card-icon">💳</span>
              <span className="marketing-hero-card-text">
                Billing — healthy
              </span>
              <span className="marketing-hero-card-meta">Stripe</span>
            </div>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
