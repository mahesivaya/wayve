import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import MarketingShell from "./MarketingShell";

const CHANNELS = [
  {
    icon: "✉️",
    title: "Email support",
    body: "For account, billing, or product questions. Replies within one business day.",
    actionLabel: "support@rwayve.maheshg.me",
    href: "mailto:support@rwayve.maheshg.me",
  },
  {
    icon: "🛡️",
    title: "Security disclosures",
    body: "Found a vulnerability? Report it privately before any public disclosure.",
    actionLabel: "security@rwayve.maheshg.me",
    href: "mailto:security@rwayve.maheshg.me",
  },
  {
    icon: "📊",
    title: "Status & incidents",
    body: "Production incidents and scheduled maintenance are posted on the status page.",
    actionLabel: "View status →",
    href: "https://rwayve.maheshg.me",
  },
  {
    icon: "💼",
    title: "Sales & enterprise",
    body: "Custom SLAs, procurement reviews, dedicated tenancy. Walk us through your environment.",
    actionLabel: "Talk to sales →",
    route: "/enterprise",
  },
];

const FAQ = [
  {
    q: "How do I reset my password?",
    a: "Click “Forgot password” on the login screen. You'll receive a reset email; the link is valid for one hour. If you don't see it, check spam — outbound mail is sent from the platform's transactional sender.",
  },
  {
    q: "How do I connect Gmail or Outlook?",
    a: "Open the Emails app and select “Connect mailbox.” You'll be redirected through Google or Microsoft OAuth and brought back when consent completes. The required scopes are read-only message access plus the user's email address — nothing more.",
  },
  {
    q: "How do I upgrade my plan?",
    a: "On personal accounts, the Home page surfaces an Upgrade banner if you're on the free tier. From there, head to Pricing, pick a plan, and Stripe handles the rest. Organization plans are managed by an org admin from Billing.",
  },
  {
    q: "How do I cancel my subscription?",
    a: "From the Billing page, click “Manage subscription.” Your plan stays active until the end of the current billing period, then automatically drops to the free tier. You won't lose data — only paid feature limits are enforced.",
  },
  {
    q: "Is my data encrypted?",
    a: "Yes. AES-256-GCM at rest for message and email bodies, with HKDF-SHA512 key derivation. Chat uses an additional client-side RSA/AES envelope so the server only ever stores ciphertext it can't decrypt to plaintext content.",
  },
  {
    q: "Can I export my data?",
    a: "Yes — Drive files, notes, and email exports are available from the Profile page. For full account exports including chat history, email support and we'll generate a signed archive.",
  },
  {
    q: "Can I delete my account?",
    a: "From Profile → Settings, choose “Delete account.” This is irreversible and cascades through messages, files, notes, and meetings owned by the account. Organization-owned data remains with the org.",
  },
  {
    q: "Do you support SSO?",
    a: "SAML and OIDC for organization plans are on the roadmap. Today, Google and Microsoft OAuth are supported for individual sign-in. If SSO is a procurement blocker, reach out via the Enterprise page.",
  },
];

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
            <button onClick={() => (window.location.href = "mailto:support@rwayve.maheshg.me")}>
              Email support
            </button>
            {user?.account_type !== "platform_admin" && !user?.username?.startsWith("platform-") && (
              <button onClick={() => navigate("/pricing")}>See pricing</button>
            )}
          </div>
        </div>

        <div className="marketing-hero-visual">
          <div className="marketing-hero-card">
            <div className="marketing-hero-card-row">
              <span className="marketing-hero-card-icon">✅</span>
              <span className="marketing-hero-card-text">All systems operational</span>
              <span className="marketing-hero-card-meta">Live</span>
            </div>
            <div className="marketing-hero-card-row">
              <span className="marketing-hero-card-icon">📬</span>
              <span className="marketing-hero-card-text">Mail sync — healthy</span>
              <span className="marketing-hero-card-meta">30s</span>
            </div>
            <div className="marketing-hero-card-row">
              <span className="marketing-hero-card-icon">💬</span>
              <span className="marketing-hero-card-text">WebSocket chat — healthy</span>
              <span className="marketing-hero-card-meta">0ms</span>
            </div>
            <div className="marketing-hero-card-row">
              <span className="marketing-hero-card-icon">📞</span>
              <span className="marketing-hero-card-text">Calls — healthy</span>
              <span className="marketing-hero-card-meta">0ms</span>
            </div>
            <div className="marketing-hero-card-row">
              <span className="marketing-hero-card-icon">💳</span>
              <span className="marketing-hero-card-text">Billing — healthy</span>
              <span className="marketing-hero-card-meta">Stripe</span>
            </div>
          </div>
        </div>
      </section>

      <section className="marketing-section">
        <div className="marketing-section-header">
          <p className="marketing-eyebrow">Contact</p>
          <h2>Pick the right channel</h2>
          <p>
            Most issues fit into one of these. Routing to the right inbox up
            front saves a round-trip.
          </p>
        </div>

        <div className="marketing-channels">
          {CHANNELS.map((channel) => (
            <div key={channel.title} className="marketing-channel">
              <div className="marketing-channel-icon">{channel.icon}</div>
              <h3>{channel.title}</h3>
              <p>{channel.body}</p>
              <button
                className="marketing-channel-link"
                onClick={() => {
                  if (channel.route) navigate(channel.route);
                  else if (channel.href) window.location.href = channel.href;
                }}
              >
                {channel.actionLabel}
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="marketing-section">
        <div className="marketing-section-header">
          <p className="marketing-eyebrow">FAQ</p>
          <h2>Frequently asked</h2>
          <p>Click any question to expand the answer.</p>
        </div>

        <div className="marketing-faq">
          {FAQ.map((entry) => (
            <details key={entry.q}>
              <summary>{entry.q}</summary>
              <p>{entry.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="marketing-cta">
        <h2>Still stuck?</h2>
        <p>Tell us what's happening — we'll dig in and reply within one business day.</p>
        <div className="marketing-cta-actions">
          <button onClick={() => (window.location.href = "mailto:support@rwayve.maheshg.me")}>
            Email support
          </button>
          <button onClick={() => navigate("/enterprise")}>
            Enterprise inquiry
          </button>
        </div>
      </section>
    </MarketingShell>
  );
}
