import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import MarketingShell from "../marketing/MarketingShell";
import Layout from "../components/Layout";
import { useAuth } from "../auth/useAuth";
import {
  DOC_CATEGORIES,
  DOCS,
  docsInCategory,
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
  /**
   * Render the nav (search + category dropdowns) as a horizontal header
   * above a single, full-width content column, instead of the left sidebar
   * rail. Used by the Developers page.
   */
  single?: boolean;
};

/**
 * Persistent docs chrome: MarketingShell on the outside (brand + nav
 * + footer) and a navigation tree on the inside. Search is client-side
 * over the static manifest — fast and dependency-free.
 *
 * The shell wraps every /docs/* page (the hub, Swagger UI, services,
 * quotas, developers, markdown docs). Pages stay simple — they just
 * render their body content, the shell handles the rest. With `single`
 * the nav becomes a top header and the content goes full-width.
 */
export default function DocsShell({
  children,
  single = false,
}: DocsShellProps) {
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

  const normalizedQuery = query.trim().toLowerCase();
  const matchesQuery = (d: DocEntry) => {
    if (!normalizedQuery) return true;
    const haystack = [d.title, d.description, ...(d.keywords ?? [])]
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  };

  // Which category holds the current doc — its dropdown opens automatically
  // in the sidebar layout.
  const activeCategoryId = useMemo(() => {
    for (const cat of DOC_CATEGORIES) {
      if (docsInCategory(cat.id).some((d) => d.path === location.pathname)) {
        return cat.id;
      }
    }
    return undefined;
  }, [location.pathname]);

  // Collapsible nav sections ("Reference" etc. as dropdowns). In the sidebar
  // the active doc's category starts open; in the single/header layout the
  // dropdowns are popovers, so they start closed.
  const [openCats, setOpenCats] = useState<Set<string>>(() =>
    single
      ? new Set<string>()
      : new Set(
          [activeCategoryId ?? DOC_CATEGORIES[0]?.id].filter(
            Boolean
          ) as string[]
        )
  );
  // Sidebar layout: keep the active category open as the user navigates.
  useEffect(() => {
    if (single || !activeCategoryId) return;
    setOpenCats((prev) =>
      prev.has(activeCategoryId) ? prev : new Set(prev).add(activeCategoryId)
    );
  }, [single, activeCategoryId]);

  // Search + collapsible category list — shared between the sidebar and the
  // single-column header layouts.
  const navBlock = (
    <>
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

      <nav
        className={single ? "docs-topnav-cats" : "docs-nav"}
        aria-label="Documentation"
      >
        {DOC_CATEGORIES.map((cat) => {
          const items = docsInCategory(cat.id).filter(matchesQuery);
          // Hide a whole category whose every entry is filtered out — keeps
          // the empty-search-result state quiet.
          if (items.length === 0) return null;
          return (
            <details
              key={cat.id}
              className="docs-nav-section"
              open={openCats.has(cat.id) || Boolean(normalizedQuery)}
              onToggle={(event) => {
                const isOpen = event.currentTarget.open;
                setOpenCats((prev) => {
                  const next = new Set(prev);
                  if (isOpen) next.add(cat.id);
                  else next.delete(cat.id);
                  return next;
                });
              }}
            >
              <summary className="docs-nav-heading">{cat.label}</summary>
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
            </details>
          );
        })}

        {normalizedQuery && DOCS.filter(matchesQuery).length === 0 && (
          <p className="docs-nav-empty">No docs match "{query}".</p>
        )}
      </nav>
    </>
  );

  const mainBlock = <main className="docs-content">{children}</main>;

  return (
    <OuterShell>
      {/* `.docs-shell` is the query container; the inner grid collapses to a
          single column when this container is narrow (split pane OR mobile). */}
      <div
        className={`docs-shell${single ? " docs-shell--single" : ""}${
          user ? " docs-shell--app" : ""
        }`}
      >
        {single ? (
          <>
            <header
              className="docs-topnav"
              aria-label="Documentation navigation"
            >
              {navBlock}
            </header>
            {mainBlock}
          </>
        ) : (
          <div className="docs-shell-grid">
            <aside
              className="docs-sidebar"
              aria-label="Documentation navigation"
            >
              {navBlock}
            </aside>
            {mainBlock}
          </div>
        )}
      </div>
    </OuterShell>
  );
}
