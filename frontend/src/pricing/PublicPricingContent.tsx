import { useNavigate } from "react-router-dom";
import { PLAN_CATALOG, type PlanTier } from "../billing/planCatalog";
import "./pricing.css";

// Public marketing pricing: one compact row of plans instead of three padded
// Personal / Organization / Enterprise section blocks. The plan data is the
// single source of truth in `billing/planCatalog.ts` (mirrored by the backend
// `billing/catalog.rs`); to change pricing/plans, edit those — not this file.

const AUDIENCE_LABEL: Record<PlanTier["audience"], string> = {
  personal: "Personal",
  organization: "Organization",
};

export default function PublicPricingContent() {
  const navigate = useNavigate();

  return (
    <div className="pricing-page pricing-simple">
      <header className="pricing-header">
        <h1>Plans &amp; Pricing</h1>
        <p>
          One workspace for mail, chat, calls, files, notes, and AI — pick the
          plan that fits.
        </p>
      </header>

      <div className="pricing-grid">
        {PLAN_CATALOG.map((tier) => {
          // Personal → personal signup; all org tiers (incl. Enterprise) →
          // business signup, which leads into self-serve checkout. The chosen
          // plan rides along as ?plan= so the post-signup billing step knows
          // which plan the visitor picked here.
          const ctaPath = `${
            tier.audience === "personal" ? "/register" : "/register-business"
          }?plan=${tier.code}`;
          return (
            <article key={tier.code} className="pricing-plan">
              <span className="pricing-plan-tag">
                {tier.tier === "enterprise"
                  ? "Enterprise"
                  : AUDIENCE_LABEL[tier.audience]}
              </span>
              <h3>{tier.name}</h3>
              <p className="pricing-plan-price">
                {tier.price}
                {tier.interval && (
                  <span className="pricing-plan-interval">
                    {" "}
                    / {tier.interval}
                  </span>
                )}
              </p>
              <p className="pricing-plan-desc">{tier.tagline}</p>
              {/* Features are collapsed by default so the card is just
                  name + price + CTA; <details> gives the open/close state and
                  keyboard/a11y behaviour for free, no component state. */}
              <details className="pricing-plan-details">
                <summary>What&apos;s included</summary>
                <ul className="pricing-plan-features">
                  {tier.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>
              </details>
              <button
                className="pricing-plan-cta"
                onClick={() => navigate(ctaPath)}
              >
                {tier.cta}
              </button>
            </article>
          );
        })}
      </div>

      <p className="pricing-simple-note">
        Every plan includes end-to-end encrypted chat, voice &amp; video calls,
        drive storage, notes, scheduler, and AI Chat. Switch or cancel any time.
      </p>
    </div>
  );
}
