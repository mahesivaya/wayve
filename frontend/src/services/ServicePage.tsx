import { Navigate, useNavigate, useParams } from "react-router-dom";
import { SERVICE_BY_SLUG, type ServiceSlug } from "./serviceData";
import DocsShell from "../docs/DocsShell";
import "./servicePage.css";

export default function ServicePage() {
  // navigate is still used by the in-content CTA buttons below; the
  // top header used to use it too, but the brand/nav now comes from
  // DocsShell → MarketingShell.
  const navigate = useNavigate();
  const { slug } = useParams();
  const service = slug ? SERVICE_BY_SLUG[slug as ServiceSlug] : null;

  if (!service) {
    return <Navigate to="/" replace />;
  }

  return (
    <DocsShell title={service.name}>
      <main className="service-page-main">
        <section className="service-page-hero">
          <div className={`service-page-icon ${service.accent}`}>{service.icon}</div>
          <p className="service-page-eyebrow">{service.eyebrow}</p>
          <h1>{service.name}</h1>
          <p className="service-page-summary">{service.summary}</p>
          <p className="service-page-description">{service.description}</p>
          <div className="service-page-actions">
            <button onClick={() => navigate(service.appPath)}>Open {service.name}</button>
            <button onClick={() => navigate("/register")}>Create account</button>
          </div>
        </section>

        <section className="service-page-section">
          <div>
            <p className="service-page-section-label">Features</p>
            <h2>What you can do</h2>
          </div>
          <div className="service-feature-grid">
            {service.features.map((feature) => (
              <article key={feature}>
                <span className="feature-check">✓</span>
                <p>{feature}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="service-page-section service-page-usecases">
          <div>
            <p className="service-page-section-label">Use cases</p>
            <h2>Built for daily work</h2>
          </div>
          <div className="service-usecase-list">
            {service.useCases.map((useCase) => (
              <p key={useCase}>{useCase}</p>
            ))}
          </div>
        </section>
      </main>
    </DocsShell>
  );
}
