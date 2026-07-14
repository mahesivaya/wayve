import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import DocsShell from "./DocsShell";
import {
  DOC_CATEGORIES,
  DOCS,
  docsInCategory,
  type DocEntry,
} from "./manifest";
import { listDocs, type DocSummary } from "../api/docs";
import "./docsIndex.css";

/**
 * Landing page at /docs. The "Guides" section is populated from the backend's
 * `/api/docs` catalog, so a new markdown doc appears without a frontend rebuild.
 */
export default function DocsIndex() {
  const [query, setQuery] = useState("");
  // If the API is unreachable the page falls back to the static manifest and
  // stays usable.
  const [backendDocs, setBackendDocs] = useState<DocSummary[]>([]);
  const [backendError, setBackendError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listDocs()
      .then((items) => {
        if (!cancelled) setBackendDocs(items);
      })
      .catch((err) => {
        if (!cancelled)
          setBackendError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const normalizedQuery = query.trim().toLowerCase();

  // Backend catalog entries become additional "guide" entries, synthesized here
  // because their URLs aren't known at build time.
  const dynamicGuides: DocEntry[] = useMemo(
    () =>
      backendDocs.map((d) => ({
        path: `/docs/${d.slug}`,
        title: d.title,
        description: d.description,
        category: "guides",
      })),
    [backendDocs]
  );

  const allEntries: DocEntry[] = useMemo(
    () => [...DOCS, ...dynamicGuides],
    [dynamicGuides]
  );

  const matchesQuery = (d: DocEntry) => {
    if (!normalizedQuery) return true;
    const haystack = [d.title, d.description, ...(d.keywords ?? [])]
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  };

  const filtered = allEntries.filter(matchesQuery);

  return (
    <DocsShell title="All docs">
      <header className="docs-index-header">
        <p className="hero-kicker">Documentation</p>
        <h1>Fluxze docs</h1>
        <p className="docs-index-lead">
          API reference, product concepts, and integration guides — all in one
          place. Use the search below or browse by category.
        </p>

        <form
          role="search"
          className="docs-index-search"
          onSubmit={(event) => event.preventDefault()}
        >
          <input
            type="search"
            aria-label="Search all documentation"
            placeholder="Search the docs… (e.g. webhook, scope, rate limit)"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
        </form>
      </header>

      {/* While searching, results collapse into one flat list instead of the
          category grouping. */}
      {normalizedQuery && (
        <section className="docs-index-results">
          <h2>
            {filtered.length} match{filtered.length === 1 ? "" : "es"}
          </h2>
          {filtered.length === 0 ? (
            <p>No docs found for "{query}".</p>
          ) : (
            <ul className="docs-index-list">
              {filtered.map((d) => (
                <li key={d.path}>
                  <Link to={d.path} className="docs-index-card">
                    <strong>{d.title}</strong>
                    <span>{d.description}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!normalizedQuery &&
        DOC_CATEGORIES.map((cat) => {
          const staticItems = docsInCategory(cat.id);
          const dynamicItems = cat.id === "guides" ? dynamicGuides : [];
          const items = [...staticItems, ...dynamicItems];
          if (items.length === 0) return null;
          return (
            <section key={cat.id} className="docs-index-category">
              <header>
                <h2>{cat.label}</h2>
                <p>{cat.description}</p>
              </header>
              <ul className="docs-index-list">
                {items.map((d) => (
                  <li key={d.path}>
                    <Link to={d.path} className="docs-index-card">
                      <strong>{d.title}</strong>
                      <span>{d.description}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}

      {backendError && (
        <p className="docs-index-backend-error" role="status">
          (Couldn't load dynamic guide catalog: {backendError})
        </p>
      )}
    </DocsShell>
  );
}
