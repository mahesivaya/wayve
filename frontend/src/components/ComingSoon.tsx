import "./comingSoon.css";

// A generic placeholder page for features that are not shipped yet. Routed to
// from sidebar entries whose backing feature is still being built (e.g. the
// Domains link). Intentionally content-free beyond the headline so it can be
// reused for any "not ready yet" surface.
export default function ComingSoon({
  feature = "This feature",
}: {
  feature?: string;
}) {
  return (
    <div className="coming-soon">
      <div className="coming-soon-card">
        <h1 className="coming-soon-title">Coming soon</h1>
        <p className="coming-soon-subtitle">
          {feature} is on the way. Check back shortly.
        </p>
      </div>
    </div>
  );
}
