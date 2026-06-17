import { useSearchParams } from "react-router-dom";
import "./comingSoon.css";

// A generic placeholder page for features that are not shipped yet. Routed to
// from sidebar entries whose backing feature is still being built (e.g. the
// Domains link, or the add-to-sidebar apps). The feature name can be passed
// either as the `feature` prop (route default) or a `?feature=` query param
// (query wins), so one route serves every "not ready yet" surface.
export default function ComingSoon({
  feature = "This feature",
}: {
  feature?: string;
}) {
  const [params] = useSearchParams();
  const name = params.get("feature")?.trim() || feature;
  return (
    <div className="coming-soon">
      <div className="coming-soon-card">
        <h1 className="coming-soon-title">Coming soon</h1>
        <p className="coming-soon-subtitle">
          {name} is on the way. Check back shortly.
        </p>
      </div>
    </div>
  );
}
