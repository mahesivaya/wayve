import { useEffect, useMemo, useState } from "react";
// Note: swagger-ui-react ships its own CSS — has to be loaded once,
// here, so the UI renders with the expected layout.
import "swagger-ui-react/swagger-ui.css";
import SwaggerUI from "swagger-ui-react";
import DocsShell from "../docs/DocsShell";
import "./swaggerDocs.css";

// Tells Swagger UI where to draw the live API spec from. Always the
// same path; the backend serves it at /api/openapi.json regardless of
// environment.
const SPEC_URL = "/api/openapi.json";

type OpenApiServer = {
  url: string;
  description?: string;
};

type OpenApiSpec = {
  servers?: OpenApiServer[];
  [key: string]: unknown;
};

// Fetch the spec ourselves so we can rewrite its `servers` block to
// match the page origin. Without this, a user opening the page on
// localhost would see "Production" selected by default — and
// "Try it out" would fire requests at prod from their dev session.
// Putting the current origin first makes the default sensible
// while still allowing operators to flip to prod via the dropdown.
async function loadSpec(): Promise<OpenApiSpec> {
  const res = await fetch(SPEC_URL, { credentials: "same-origin" });
  if (!res.ok) {
    throw new Error(`Failed to load OpenAPI spec: ${res.status}`);
  }
  const spec = (await res.json()) as OpenApiSpec;
  const currentOrigin = window.location.origin;

  const existing = Array.isArray(spec.servers) ? spec.servers : [];
  // Drop any server entry that already matches our origin so we
  // don't end up with two identical dropdown options after the
  // injection below.
  const filtered = existing.filter(
    (s) => typeof s.url === "string" && s.url !== currentOrigin,
  );

  spec.servers = [
    { url: currentOrigin, description: "This origin" },
    ...filtered,
  ];
  return spec;
}

export default function SwaggerDocs() {
  const [spec, setSpec] = useState<OpenApiSpec | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadSpec()
      .then((s) => {
        if (!cancelled) setSpec(s);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Stable identity so SwaggerUI doesn't see a new prop every render.
  // Swagger UI internally remounts a lot when its `spec` prop's
  // identity changes — `useMemo` keeps it pinned.
  const memoSpec = useMemo(() => spec, [spec]);

  return (
    <DocsShell>
      <article className="swagger-docs-shell">
        <header className="swagger-docs-header">
          <p className="hero-kicker">For developers</p>
          <h1>Wayve API</h1>
          <p>
            Interactive reference for the public, API-key-callable
            surface of Wayve. Click any endpoint to expand, then
            <strong> Authorize </strong> at the top to paste an
            <code> X-API-KEY </code> and use <strong>Try it out</strong>
            to fire live requests. The spec itself is served at{" "}
            <code>{SPEC_URL}</code>.
          </p>
        </header>

        {error && (
          <div className="swagger-docs-error" role="alert">
            <strong>Couldn't load API spec.</strong>
            <span>{error}</span>
          </div>
        )}

        {!error && !memoSpec && (
          <div className="swagger-docs-loading">Loading spec…</div>
        )}

        {memoSpec && (
          <div className="swagger-docs-ui">
            <SwaggerUI spec={memoSpec} />
          </div>
        )}
      </article>
    </DocsShell>
  );
}
