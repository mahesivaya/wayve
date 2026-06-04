import { useNavigate } from "react-router-dom";
import "./pricing.css";

// The public marketing pricing tiers, grouped into Personal vs Business. Shared
// between the /pricing page (wrapped in MarketingShell) and the landing page's
// pricing section, so both stay in sync. This component renders ONLY the
// content (no shell), so callers supply their own page chrome.

type PublicTier = {
  id: string;
  name: string;
  price: string;
  interval: string | null;
  tagline: string;
  features: string[];
  cta: string;
};

const PUBLIC_TIERS: PublicTier[] = [
  {
    id: "basic",
    name: "Basic",
    price: "Free",
    interval: null,
    tagline: "Free personal plan with daily email send/receive limits.",
    features: [
      "1 GB storage",
      "1 seat",
      "Billed monthly",
      "Up to 1,000 emails per day",
    ],
    cta: "Get started",
  },
  {
    id: "advance",
    name: "Advance",
    price: "7.00 USD",
    interval: "month",
    tagline: "Personal paid plan with encrypted app usage allowance.",
    features: [
      "10 GB storage",
      "1 seat",
      "End-to-end encrypted chat",
      "1,000 encrypt/decrypt ops per day",
    ],
    cta: "Choose plan",
  },
  {
    id: "more-advance",
    name: "More Advance",
    price: "15.00 USD",
    interval: "month",
    tagline: "Power-user tier — higher limits, priority sync, full AI access.",
    features: [
      "50 GB storage",
      "1 seat",
      "Unlimited daily emails",
      "Priority email + AI sync",
    ],
    cta: "Choose plan",
  },
  {
    id: "small-organization",
    name: "Small organization",
    price: "10.00 USD",
    interval: "user / month",
    tagline: "1–100 users with unlimited email send/receive and memory.",
    features: [
      "Unlimited storage",
      "1–100 seats",
      "Shared org subscription",
      "Admin & billing controls",
    ],
    cta: "Choose plan",
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: "Contact sales",
    interval: null,
    tagline: "100+ users with unlimited everything. SSO, audit log, support.",
    features: [
      "Unlimited storage",
      "100+ seats",
      "SSO + RBAC",
      "Dedicated support",
    ],
    cta: "Contact sales",
  },
];

// Which public tiers belong to the "Personal" section; the rest fall under
// "Business & Enterprise". Mirrors the grouped layout of the logged-in
// (personal-account) pricing page.
const PUBLIC_PERSONAL_IDS = ["basic", "advance", "more-advance"];

export default function PublicPricingContent() {
  const navigate = useNavigate();
  const personalTiers = PUBLIC_TIERS.filter((tier) =>
    PUBLIC_PERSONAL_IDS.includes(tier.id),
  );
  const businessTiers = PUBLIC_TIERS.filter(
    (tier) => !PUBLIC_PERSONAL_IDS.includes(tier.id),
  );

  const renderTier = (tier: PublicTier) => (
    <article key={tier.id} className="pricing-plan">
      <h3>{tier.name}</h3>
      <p className="pricing-plan-price">
        {tier.price}
        {tier.interval && (
          <span className="pricing-plan-interval"> / {tier.interval}</span>
        )}
      </p>
      <p className="pricing-plan-desc">{tier.tagline}</p>
      <ul className="pricing-plan-features">
        {tier.features.map((feature) => (
          <li key={feature}>{feature}</li>
        ))}
      </ul>
      <button
        className="pricing-plan-cta"
        onClick={() => navigate("/register")}
      >
        {tier.cta}
      </button>
    </article>
  );

  return (
    <div className="pricing-page">
      <header className="pricing-header">
        <h1>Plans &amp; Pricing</h1>
        <p>
          One workspace for mail, chat, calls, files, notes, and AI — pick the
          plan that fits.
        </p>
      </header>

      <section className="pricing-section">
        <h2>Personal</h2>
        <p className="pricing-section-sub">For individual accounts.</p>
        <div className="pricing-grid">{personalTiers.map(renderTier)}</div>
      </section>

      <section className="pricing-section">
        <h2>Business &amp; Enterprise</h2>
        <p className="pricing-section-sub">
          For teams and organizations of any size.
        </p>
        <div className="pricing-grid">{businessTiers.map(renderTier)}</div>
      </section>
    </div>
  );
}
