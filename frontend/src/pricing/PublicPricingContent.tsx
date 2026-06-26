import { useNavigate } from "react-router-dom";
import { PLAN_CATALOG, type PlanTier } from "../billing/planCatalog";
import "./pricing.css";

// Public marketing pricing, grouped into Personal / Organization / Enterprise.
// Shared between the /pricing page (wrapped in MarketingShell) and the landing
// page's pricing section. The plan data is the single source of truth in
// `billing/planCatalog.ts` (mirrored by the backend `billing/catalog.rs`); to
// change pricing/plans, edit those — not this component.

export default function PublicPricingContent() {
  const navigate = useNavigate();
  const personalTiers = PLAN_CATALOG.filter((p) => p.audience === "personal");
  const businessTiers = PLAN_CATALOG.filter(
    (p) => p.audience === "organization" && p.tier !== "enterprise"
  );
  const enterpriseTiers = PLAN_CATALOG.filter((p) => p.tier === "enterprise");

  const renderTier = (tier: PlanTier) => {
    // Personal → personal signup; all org tiers (incl. Enterprise) → business
    // signup, which leads into self-serve checkout.
    const ctaPath =
      tier.audience === "personal" ? "/register" : "/register-business";
    return (
      <article key={tier.code} className="pricing-plan">
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
        <button className="pricing-plan-cta" onClick={() => navigate(ctaPath)}>
          {tier.cta}
        </button>
      </article>
    );
  };

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
        <h2>Organization</h2>
        <p className="pricing-section-sub">
          For teams and growing organizations.
        </p>
        <div className="pricing-grid">{businessTiers.map(renderTier)}</div>
      </section>

      <section className="pricing-section">
        <h2>Enterprise</h2>
        <p className="pricing-section-sub">
          For 100+ members — unlimited scale, SSO &amp; SCIM, and dedicated
          support.
        </p>
        <div className="pricing-grid">{enterpriseTiers.map(renderTier)}</div>
      </section>
    </div>
  );
}
