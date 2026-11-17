import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { visibleIntegrations } from "./catalog";
import { useIntegrationConnections } from "./useIntegrationConnections";

// The settings menu's rows under "Integrations": one per connected service,
// each opening the Integrations page with that service's panel showing.
export default function ConnectedIntegrationLinks({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const { user } = useAuth();
  const location = useLocation();
  const { connected } = useIntegrationConnections(user);
  const openService =
    location.pathname === "/integrations"
      ? new URLSearchParams(location.search).get("service")
      : null;

  return (
    <>
      {visibleIntegrations(user)
        .filter((service) => connected[service.key])
        .map((service) => (
          <Link
            key={service.key}
            to={`/integrations?service=${service.key}`}
            title={service.name}
            className={`sidebar-link ${
              openService === service.key ? "active" : ""
            }`.trim()}
            onClick={onNavigate}
          >
            <span
              className="sidebar-icon sidebar-icon--brand"
              aria-hidden="true"
            >
              {service.icon}
            </span>
            <span className="sidebar-label">{service.name}</span>
          </Link>
        ))}
    </>
  );
}
