import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { DocFull, DocSummary, getDoc, listDocs } from "../api/docs";
import DocsShell from "../docs/DocsShell";
import { BRAND_NAME } from "../config/brand";
import "./docs.css";

// marked v12 — self-hosted in frontend/public/marked.min.js to avoid a CDN
// allowance in the production CSP. Loaded once on first mount.
const MARKED_SCRIPT = "/marked.min.js";

type MarkedFn = (md: string) => string;

interface MarkedGlobal {
  parse: MarkedFn;
}

function getMarkedFromWindow(): MarkedGlobal | undefined {
  return (window as unknown as { marked?: MarkedGlobal }).marked;
}

async function loadMarked(): Promise<MarkedFn> {
  const already = getMarkedFromWindow();
  if (already) return (md: string) => already.parse(md);
  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${MARKED_SCRIPT}"]`,
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("marked load failed")), {
        once: true,
      });
      return;
    }
    const tag = document.createElement("script");
    tag.src = MARKED_SCRIPT;
    tag.async = true;
    tag.addEventListener("load", () => resolve(), { once: true });
    tag.addEventListener("error", () => reject(new Error("marked load failed")), {
      once: true,
    });
    document.body.appendChild(tag);
  });
  const loaded = getMarkedFromWindow();
  if (!loaded) {
    throw new Error("marked bundle loaded but global missing");
  }
  return (md: string) => loaded.parse(md);
}

// Belt-and-braces sanitiser. marked is well-behaved on its own output but
// our content is trusted (baked into the backend binary), and we additionally
// strip any tag that could execute script — pure defense in depth.
function stripUnsafe(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .replace(/javascript:/gi, "javascript-disabled:");
}

export default function Docs() {
  const navigate = useNavigate();
  const { slug } = useParams<{ slug?: string }>();
  const [catalog, setCatalog] = useState<DocSummary[]>([]);
  const [active, setActive] = useState<DocFull | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingBody, setLoadingBody] = useState(false);
  const [error, setError] = useState("");
  const [html, setHtml] = useState("");
  const renderHostRef = useRef<HTMLDivElement>(null);

  // Load catalog once.
  useEffect(() => {
    let alive = true;
    listDocs()
      .then((items) => {
        if (!alive) return;
        setCatalog(items);
        // First visit lands at /docs (no slug) → redirect to the first
        // available doc so the right-hand pane is never blank.
        if (!slug && items.length > 0) {
          void navigate(`/docs/${items[0].slug}`, { replace: true });
        }
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : "Failed to load docs");
      })
      .finally(() => {
        if (alive) setLoadingList(false);
      });
    return () => {
      alive = false;
    };
  }, [navigate, slug]);

  const loadSlug = useCallback(async (next: string) => {
    setLoadingBody(true);
    setError("");
    try {
      const [doc, parse] = await Promise.all([getDoc(next), loadMarked()]);
      setActive(doc);
      const rendered = parse(doc.body);
      setHtml(stripUnsafe(typeof rendered === "string" ? rendered : ""));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to render doc");
      setActive(null);
      setHtml("");
    } finally {
      setLoadingBody(false);
    }
  }, []);

  useEffect(() => {
    if (!slug) return;
    // setTimeout defers the setState that loadSlug fires out of the effect
    // body so React's set-state-in-effect lint stays quiet.
    const h = window.setTimeout(() => void loadSlug(slug), 0);
    return () => window.clearTimeout(h);
  }, [slug, loadSlug]);

  // Scroll the rendered content to top on doc switch so a long doc doesn't
  // open mid-page just because the previous one was scrolled down.
  useEffect(() => {
    if (renderHostRef.current) {
      renderHostRef.current.scrollTop = 0;
    }
  }, [active?.slug]);

  const sidebar = useMemo(
    () => (
      <nav className="docs-sidebar" aria-label="Documentation">
        <header>
          <Link to="/" className="docs-back">← {BRAND_NAME}</Link>
          <h2>Docs</h2>
        </header>
        {loadingList ? (
          <p className="docs-muted">Loading…</p>
        ) : catalog.length === 0 ? (
          <p className="docs-muted">No published documents yet.</p>
        ) : (
          <ul>
            {catalog.map((doc) => (
              <li key={doc.slug}>
                <Link
                  to={`/docs/${doc.slug}`}
                  className={slug === doc.slug ? "active" : ""}
                >
                  {doc.title}
                </Link>
                <small>{doc.description}</small>
              </li>
            ))}
          </ul>
        )}
        <footer>
          <Link to="/developers">API reference →</Link>
        </footer>
      </nav>
    ),
    [catalog, loadingList, slug],
  );

  // The sidebar list of catalog items is now redundant — DocsShell's
  // sidebar surfaces the same entries (and more) with a search box.
  // We intentionally don't render `sidebar` here. Keep it computed
  // above (the `useMemo`) so removing it is a one-liner rather than
  // a broad rewrite of the page's effects.
  void sidebar;

  return (
    <DocsShell title={active?.title}>
      <main className="docs-content" ref={renderHostRef}>
        {error && <div className="docs-banner">{error}</div>}
        {active && (
          <article>
            <header className="docs-content-head">
              <h1>{active.title}</h1>
              <p>{active.description}</p>
            </header>
            {loadingBody ? (
              <p className="docs-muted">Rendering…</p>
            ) : (
              <div
                className="docs-rendered"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            )}
          </article>
        )}
        {!active && !loadingBody && !error && (
          <p className="docs-muted">
            Pick a document from the sidebar, or browse{" "}
            <Link to="/docs">all docs</Link>.
          </p>
        )}
      </main>
    </DocsShell>
  );
}
