import { useEffect, useMemo, useState } from "react";
import { BRAND_NAME } from "../config/brand";
// swagger-ui-react ships its own CSS and must have it loaded once, here.
import "swagger-ui-react/swagger-ui.css";
import SwaggerUI from "swagger-ui-react";
import DocsShell from "../docs/DocsShell";
import "./swaggerDocs.css";

const SPEC_URL = "/api/openapi.json";

type OpenApiServer = {
  url: string;
  description?: string;
};

type OpenApiSpec = {
  servers?: OpenApiServer[];
  [key: string]: unknown;
};

// The spec's `servers` block is rewritten to put the page origin first.
// Otherwise "Production" is selected by default and "Try it out" fires requests
// at prod from a dev session. Operators can still flip to prod via the dropdown.
async function loadSpec(): Promise<OpenApiSpec> {
  const res = await fetch(SPEC_URL, { credentials: "same-origin" });
  if (!res.ok) {
    throw new Error(`Failed to load OpenAPI spec: ${res.status}`);
  }
  const spec = (await res.json()) as OpenApiSpec;
  const currentOrigin = window.location.origin;

  const existing = Array.isArray(spec.servers) ? spec.servers : [];
  // Drop an existing entry for our origin so the injection below doesn't
  // produce two identical dropdown options.
  const filtered = existing.filter(
    (s) => typeof s.url === "string" && s.url !== currentOrigin
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

  // Swagger UI remounts heavily whenever its `spec` prop changes identity, so
  // keep that identity pinned.
  const memoSpec = useMemo(() => spec, [spec]);

  return (
    <DocsShell>
      <article className="swagger-docs-shell">
        <header className="swagger-docs-header">
          <p className="hero-kicker">For developers</p>
          <h1>{BRAND_NAME} API</h1>
          <p>
            Interactive reference for the public, API-key-callable surface of
            Wayve. Click any endpoint to expand, then
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
