import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { homePathForUser } from "../auth/accountHome";
import {
  getApiCatalogue,
  type ApiCatalogue,
  type ApiEndpoint,
} from "../api/openapi";
import "./platformApis.css";

// Every endpoint the platform publishes, grouped by area and laid out the way a
// Swagger page is: a coloured verb, the path, its summary, and the details on
// expand. The rows come from the backend's own OpenAPI document rather than a
// hand-kept list, so this page can't fall out of step with the API.
//
// It is a reader, not a client: there is no "Try it out" here. The full
// reference with request/response schemas stays at /docs/api.

const rowKey = (e: ApiEndpoint) => `${e.method} ${e.path}`;

export default function PlatformApis() {
  const { user } = useAuth();
  // Platform staff only — this is the platform's own surface area. UI gating
  // only; every endpoint listed still enforces its own scope and permissions.
  const canView = user?.scope === "platform";

  const [catalogue, setCatalogue] = useState<ApiCatalogue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [openRow, setOpenRow] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canView) return;
    setError("");
    try {
      setCatalogue(await getApiCatalogue());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load the API catalogue"
      );
    } finally {
      setLoading(false);
    }
  }, [canView]);

  // Deferred out of the effect body so it doesn't setState synchronously.
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // Path, summary, verb, operation id and scope are all searchable, so "email"
  // and "POST" and "drive:write" each narrow the list the way you'd expect.
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (e: ApiEndpoint) =>
      !needle ||
      `${e.method} ${e.path} ${e.summary} ${e.operationId} ${e.scope} ${e.tag}`
        .toLowerCase()
        .includes(needle);

    const byTag = new Map<string, ApiEndpoint[]>();
    for (const endpoint of catalogue?.endpoints ?? []) {
      if (!matches(endpoint)) continue;
      const list = byTag.get(endpoint.tag) ?? [];
      list.push(endpoint);
      byTag.set(endpoint.tag, list);
    }
    return [...byTag.entries()];
  }, [catalogue, query]);

  if (!canView) return <Navigate to={homePathForUser(user)} replace />;

  const shown = groups.reduce((total, [, list]) => total + list.length, 0);
  const all = catalogue?.endpoints.length ?? 0;

  return (
    <div className="api-page">
      <header className="api-header">
        <h1>API</h1>
        <p>
          Every endpoint the platform publishes, read live from the API&nbsp;
          specification
          {catalogue?.version ? ` (${catalogue.version})` : ""}. For request and
          response schemas, open the <Link to="/docs/api">API reference</Link>.
        </p>
      </header>

      {error && <div className="api-banner">{error}</div>}

      <div className="api-toolbar">
        <input
          className="api-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by path, verb, scope or summary…"
          aria-label="Filter endpoints"
        />
        <span className="api-count">
          {loading
            ? "Loading…"
            : query
              ? `${shown} of ${all} endpoints`
              : `${all} endpoints`}
        </span>
      </div>

      {!loading && all === 0 && !error && (
        <p className="api-empty">The specification declares no endpoints.</p>
      )}

      {!loading && all > 0 && shown === 0 && (
        <p className="api-empty">No endpoint matches “{query}”.</p>
      )}

      {groups.map(([tag, endpoints]) => (
        <section className="api-group" key={tag}>
          <div className="api-group-head">
            <h2>{tag}</h2>
            {catalogue?.groups[tag] && (
              <p className="api-group-desc">{catalogue.groups[tag]}</p>
            )}
          </div>

          <ul className="api-rows">
            {endpoints.map((endpoint) => {
              const key = rowKey(endpoint);
              const open = openRow === key;
              return (
                <li className="api-row" key={key}>
                  <button
                    type="button"
                    className={`api-row-head${open ? " is-open" : ""}`}
                    onClick={() => setOpenRow(open ? null : key)}
                    aria-expanded={open}
                  >
                    <span
                      className={`api-method api-method--${endpoint.method.toLowerCase()}`}
                    >
                      {endpoint.method}
                    </span>
                    <code className="api-path">{endpoint.path}</code>
                    <span className="api-summary">{endpoint.summary}</span>
                    <span className="api-caret" aria-hidden="true">
                      {open ? "▾" : "▸"}
                    </span>
                  </button>

                  {open && (
                    <dl className="api-row-detail">
                      <div>
                        <dt>Scope</dt>
                        <dd>
                          {endpoint.scope ? (
                            <code>{endpoint.scope}</code>
                          ) : (
                            <span className="api-muted">
                              None declared — session auth only
                            </span>
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Operation</dt>
                        <dd>
                          <code>{endpoint.operationId || "—"}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Auth</dt>
                        <dd>
                          <code>X-API-KEY</code> header, or a signed-in session
                        </dd>
                      </div>
                    </dl>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
