// Runtime configuration fetched from the backend (`GET /api/config`) at boot,
// so one frontend build runs in any environment/machine without a rebuild.
// Values are cached after the first load; an empty string means "not
// configured — fall back to build-time VITE_* or the page origin".

export type RuntimeConfig = {
  apiBase: string;
  wsBase: string;
  stripePublishableKey: string | null;
  environment: string;
  // Platform-wide UI font key (set by the platform owner); null = app default.
  fontKey: string | null;
};

const EMPTY: RuntimeConfig = {
  apiBase: "",
  wsBase: "",
  stripePublishableKey: null,
  environment: "unknown",
  fontKey: null,
};

let cached: RuntimeConfig | null = null;

/**
 * Fetch runtime config from the backend once and cache it. Never rejects — on
 * any failure it caches empty defaults so callers fall back to build-time
 * `VITE_*` values or the page origin, and the app still boots.
 */
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  if (cached) return cached;
  try {
    // Relative `/api/config` when same-origin; an explicit VITE_API_URL wins
    // for split-host dev setups without a proxy.
    const base = import.meta.env.VITE_API_URL || "";
    const res = await fetch(`${base}/api/config`, { credentials: "include" });
    if (res.ok) {
      const data = await res.json();
      cached = {
        apiBase: typeof data.api_base === "string" ? data.api_base : "",
        wsBase: typeof data.ws_base === "string" ? data.ws_base : "",
        stripePublishableKey:
          typeof data.stripe_publishable_key === "string"
            ? data.stripe_publishable_key
            : null,
        environment:
          typeof data.environment === "string" ? data.environment : "unknown",
        fontKey:
          data.ui && typeof data.ui.font_key === "string"
            ? data.ui.font_key
            : null,
      };
      return cached;
    }
  } catch {
    // fall through to empty defaults
  }
  cached = EMPTY;
  return cached;
}

/** The cached runtime config; empty defaults until `loadRuntimeConfig` resolves. */
export function runtimeConfig(): RuntimeConfig {
  return cached ?? EMPTY;
}
