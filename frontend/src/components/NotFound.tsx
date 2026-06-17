import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { reportClientError } from "../api/errorLogs";
import "./comingSoon.css";

// Catch-all 404 page for unknown client routes. Previously the router silently
// redirected unknown paths to home, which hid broken links and logged nothing.
// This shows an explicit 404 and reports it (severity "warn") to /api/error-logs
// so bad links surface on the platform logs dashboard.
export default function NotFound({ homePath = "/" }: { homePath?: string }) {
  const { pathname, search } = useLocation();

  useEffect(() => {
    reportClientError({
      severity: "warn",
      message: `404: ${pathname}${search}`,
    });
  }, [pathname, search]);

  return (
    <div className="coming-soon">
      <div className="coming-soon-card">
        <h1 className="coming-soon-title">404</h1>
        <p className="coming-soon-subtitle">
          We couldn&apos;t find the page you were looking for.
        </p>
        <Link className="coming-soon-link" to={homePath}>
          Go back home
        </Link>
      </div>
    </div>
  );
}
