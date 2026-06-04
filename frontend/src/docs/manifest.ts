// Single source of truth for every page that lives under /docs/*.
//
// Every entry shows up in:
//   - DocsShell's sidebar (grouped by `category`)
//   - DocsIndex's search results
//   - The breadcrumb on each rendered page
//
// New docs only need to be added here (and registered as a route in
// App.tsx if they're a new page) — the sidebar/index pick them up
// automatically. The backend-driven markdown catalog (the `/api/docs`
// endpoint at backend/.../docs/handler.rs) is folded in dynamically by
// DocsIndex at runtime; entries in this file are the static surface
// the SPA owns.

import type { ServiceSlug } from "../services/serviceData";

export type DocCategory = "reference" | "concepts" | "guides";

export type DocEntry = {
  /** Canonical URL — always starts with `/docs/`. */
  path: string;
  title: string;
  /** One-sentence summary used in the index + search results. */
  description: string;
  category: DocCategory;
  /** Optional keyword list to boost search recall. */
  keywords?: string[];
};

export const DOC_CATEGORIES: Array<{ id: DocCategory; label: string; description: string }> = [
  {
    id: "reference",
    label: "Reference",
    description: "API surface, rate limits, scopes — the exact contracts integrators rely on.",
  },
  {
    id: "concepts",
    label: "Concepts",
    description: "Product surfaces and how they fit together in Wayve.",
  },
  {
    id: "guides",
    label: "Guides",
    description: "How-to walkthroughs and longer-form documentation.",
  },
];

// Hand-curated for now. When the catalog grows past ~30 items, consider
// auto-generating from a content directory; not worth the indirection
// today.
export const DOCS: DocEntry[] = [
  // ── Reference ───────────────────────────────────────────────────────
  {
    path: "/docs/api",
    title: "API reference",
    description:
      "Interactive Swagger UI. Authorize with an X-API-KEY, expand any endpoint, run live requests.",
    category: "reference",
    keywords: ["swagger", "openapi", "rest", "api", "endpoints", "x-api-key", "scopes"],
  },
  {
    path: "/docs/quotas",
    title: "Plans, quotas & rate limits",
    description:
      "Per-plan request quotas, the current account's usage, and how the four tiers (Free / Advance / Organization / Enterprise) differ.",
    category: "reference",
    keywords: ["quota", "rate limit", "tier", "plan", "pricing", "limits"],
  },
  {
    path: "/docs/developers",
    title: "Developer overview",
    description:
      "Landing page for integrators: SDK tutorials, scope catalog, embeddable Redoc reference.",
    category: "reference",
    keywords: ["sdk", "tutorial", "redoc", "code samples", "integrators"],
  },

  // ── Concepts ────────────────────────────────────────────────────────
  // Service detail pages — one per product surface. The serviceData
  // module already owns the metadata; we only need slug + display name
  // here. If a service is renamed there, refresh this list to match.
  {
    path: "/docs/services/mail",
    title: "Mail",
    description: "Email account connection, sync, send, and the encrypted-body model.",
    category: "concepts",
    keywords: ["email", "mail", "gmail", "outlook", "imap", "smtp"],
  },
  {
    path: "/docs/services/chat",
    title: "Chat",
    description: "Real-time direct messages and channels, with end-to-end encrypted envelopes.",
    category: "concepts",
    keywords: ["chat", "messaging", "channels", "e2e", "encryption"],
  },
  {
    path: "/docs/services/meet",
    title: "Meet",
    description: "Audio / video calls layered on Cloudflare Realtime TURN.",
    category: "concepts",
    keywords: ["call", "video", "audio", "webrtc", "turn", "cloudflare"],
  },
  {
    path: "/docs/services/calendar",
    title: "Calendar",
    description: "Scheduling, meeting links, Google Calendar / Zoom integration.",
    category: "concepts",
    keywords: ["calendar", "scheduler", "meetings", "zoom", "google calendar"],
  },
  {
    path: "/docs/services/drive",
    title: "Drive",
    description: "File upload, sharing, and per-file encrypted envelopes.",
    category: "concepts",
    keywords: ["drive", "files", "upload", "sharing", "encryption"],
  },
  {
    path: "/docs/services/notes",
    title: "Notes",
    description: "Personal notes synced across devices.",
    category: "concepts",
    keywords: ["notes", "writing"],
  },
  {
    path: "/docs/services/tasks",
    title: "Tasks",
    description: "To-do items with priority and status.",
    category: "concepts",
    keywords: ["tasks", "todo", "action items"],
  },
  {
    path: "/docs/services/ai",
    title: "AI",
    description: "Assistant chat backed by the configured Gemini key.",
    category: "concepts",
    keywords: ["ai", "assistant", "gemini", "chatgpt"],
  },
];

// Filter helpers used by both DocsShell and DocsIndex.
export function docsInCategory(category: DocCategory): DocEntry[] {
  return DOCS.filter((d) => d.category === category);
}

/** Path-prefix match so the sidebar can highlight the active entry. */
export function findDocByPath(pathname: string): DocEntry | undefined {
  return DOCS.find((d) => d.path === pathname);
}

/**
 * Map from a legacy URL to its canonical /docs/* equivalent. Used by
 * the alias routes in App.tsx to redirect old links. Listed in one
 * place so adding a new alias doesn't require touching the router.
 */
export const LEGACY_REDIRECTS: Record<string, string> = {
  "/developers": "/docs/developers",
  "/developers/quotas": "/docs/quotas",
};

/** Build the legacy /services/:slug → /docs/services/:slug map. */
export function legacyServiceRedirect(slug: ServiceSlug): string {
  return `/docs/services/${slug}`;
}
