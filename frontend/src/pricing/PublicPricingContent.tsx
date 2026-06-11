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
    tagline: "Free personal plan to get started.",
    features: [
      "1 GB encrypted storage",
      "Up to 1,000 emails per day",
      "End-to-end encrypted chat",
      "1 seat",
    ],
    cta: "Get started",
  },
  {
    id: "advance",
    name: "Advance",
    price: "7.00 USD",
    interval: "month",
    tagline: "Personal paid plan with higher limits.",
    features: [
      "10 GB encrypted storage",
      "Unlimited daily emails",
      "1,000 encrypt/decrypt ops per day",
      "Priority email sync",
    ],
    cta: "Choose plan",
  },
  {
    id: "most-advance",
    name: "Most Advance",
    price: "15.00 USD",
    interval: "month",
    tagline: "Top personal tier with full AI access.",
    features: [
      "50 GB encrypted storage",
      "Unlimited email & calls",
      "Full AI assistant access",
      "Priority support",
    ],
    cta: "Choose plan",
  },
  {
    id: "startups",
    name: "Startups",
    price: "8.00 USD",
    interval: "user / month",
    tagline: "For small teams getting off the ground.",
    features: [
      "Up to 20 members",
      "Unlimited shared storage",
      "Shared org workspace",
      "Admin & billing controls",
    ],
    cta: "Contact sales",
  },
  {
    id: "business",
    name: "Business",
    price: "12.00 USD",
    interval: "user / month",
    tagline: "For growing organizations up to 100 members.",
    features: [
      "Up to 100 members",
      "Unlimited storage & email",
      "SSO + role-based access",
      "Audit logs & priority support",
    ],
    cta: "Contact sales",
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: "Contact sales",
    interval: null,
    tagline: "100+ members with unlimited everything.",
    features: [
      "Unlimited members",
      "Dedicated success manager",
      "Custom onboarding & SLA",
      "SSO, SCIM & advanced security",
    ],
    cta: "Contact sales",
  },
];

// Which public tiers belong to the "Personal" section; the rest fall under
// "Business & Enterprise". Mirrors the grouped layout of the logged-in
// (personal-account) pricing page.
const PUBLIC_PERSONAL_IDS = ["basic", "advance", "most-advance"];

export default function PublicPricingContent() {
  const navigate = useNavigate();
  const personalTiers = PUBLIC_TIERS.filter((tier) =>
    PUBLIC_PERSONAL_IDS.includes(tier.id)
  );
  const businessTiers = PUBLIC_TIERS.filter(
    (tier) => !PUBLIC_PERSONAL_IDS.includes(tier.id)
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
