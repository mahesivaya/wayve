import { useMemo, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import MarketingShell from "../marketing/MarketingShell";
import Layout from "../components/Layout";
import { useAuth } from "../auth/useAuth";
import {
  DOC_CATEGORIES,
  DOCS,
  docsInCategory,
  findDocByPath,
  type DocEntry,
} from "./manifest";
import "./docsShell.css";

type DocsShellProps = {
  children: ReactNode;
  /**
   * Optional override for the page's breadcrumb title. Defaults to
   * the title from the manifest entry that matches the current
   * route. Useful for dynamic pages (e.g. /docs/:slug rendering an
   * arbitrary markdown title not pinned in the manifest).
   */
  title?: string;
};

/**
 * Persistent docs chrome: MarketingShell on the outside (brand + nav
 * + footer) and a left-rail navigation tree on the inside. Search is
 * client-side over the static manifest — fast and dependency-free.
 *
 * The shell wraps every /docs/* page (the hub, Swagger UI, services,
 * quotas, developers, markdown docs). Pages stay simple — they just
 * render their body content, the shell handles the rest.
 */
export default function DocsShell({ children, title }: DocsShellProps) {
  const location = useLocation();
  const { user } = useAuth();
  const [query, setQuery] = useState("");

  // Authenticated users keep their normal app chrome (Header, app
  // switcher, profile/logout menu) when reading docs — clicking
  // "Docs" from the platform/organization home shouldn't dump them
  // out into the public marketing shell. Anonymous visitors get
  // MarketingShell (brand + Login/Register), which is the right
  // chrome for someone evaluating the API contract before signing
  // up. Both shells accept arbitrary children; only the wrapper
  // outside the docs grid changes between the two paths.
  const OuterShell = user ? Layout : MarketingShell;

  const currentDoc = useMemo(() => findDocByPath(location.pathname), [
    location.pathname,
  ]);

  const normalizedQuery = query.trim().toLowerCase();
  const matchesQuery = (d: DocEntry) => {
    if (!normalizedQuery) return true;
    const haystack = [
      d.title,
      d.description,
      ...(d.keywords ?? []),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  };

  const breadcrumbLabel = title ?? currentDoc?.title;

  return (
    <OuterShell>
      <div className="docs-shell">
        <aside className="docs-sidebar" aria-label="Documentation navigation">
          {/* Search is its own form element so Enter doesn't accidentally
              submit the surrounding shell. The filter is live (oninput)
              — the form tag is purely for semantics + autofill. */}
          <form
            className="docs-search"
            role="search"
            onSubmit={(event) => event.preventDefault()}
          >
            <label htmlFor="docs-search-input" className="docs-search-label">
              Search docs
            </label>
            <input
              id="docs-search-input"
              type="search"
              className="docs-search-input"
              placeholder="Search…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </form>

          <nav className="docs-nav">
            {DOC_CATEGORIES.map((cat) => {
              const items = docsInCategory(cat.id).filter(matchesQuery);
              // Hide a whole category whose every entry is filtered out
              // — keeps the empty-search-result state quiet rather
              // than showing three empty headings.
              if (items.length === 0) return null;
              return (
                <section key={cat.id} className="docs-nav-section">
                  <h4 className="docs-nav-heading">{cat.label}</h4>
                  <ul className="docs-nav-list">
                    {items.map((d) => {
                      const active = d.path === location.pathname;
                      return (
                        <li key={d.path}>
                          <Link
                            to={d.path}
                            className={`docs-nav-link${active ? " is-active" : ""}`}
                            aria-current={active ? "page" : undefined}
                          >
                            {d.title}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}

            {normalizedQuery && DOCS.filter(matchesQuery).length === 0 && (
              <p className="docs-nav-empty">No docs match "{query}".</p>
            )}
          </nav>
        </aside>

        <main className="docs-content">
          {/* Breadcrumb — "Docs › <Page>". Skipped on the index page
              itself (location is /docs and currentDoc is undefined). */}
          {breadcrumbLabel && location.pathname !== "/docs" && (
            <nav className="docs-breadcrumb" aria-label="Breadcrumb">
              <Link to="/docs">Docs</Link>
              <span aria-hidden="true"> › </span>
              <span>{breadcrumbLabel}</span>
            </nav>
          )}

          {children}
        </main>
      </div>
    </OuterShell>
  );
}
