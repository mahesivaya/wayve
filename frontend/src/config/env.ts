import { runtimeConfig } from "./runtimeConfig";

// Resolved API / WebSocket bases. Priority: runtime config from the backend
// (`/api/config`) → build-time `VITE_*` → the page origin. Functions, not
// constants, because runtime config is fetched asynchronously at boot.

/** API base for HTTP calls; "" means same-origin. */
export function getApiBase(): string {
  return runtimeConfig().apiBase || import.meta.env.VITE_API_URL || "";
}

/** WebSocket base, e.g. `wss://host`. */
export function getWsBase(): string {
  const configured =
    runtimeConfig().wsBase ||
    import.meta.env.VITE_WS_URL ||
    import.meta.env.VITE_WS_BASE_URL ||
    "";
  if (configured) {
    return configured.startsWith("ws") ? configured : `ws://${configured}`;
  }
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss" : "ws"}://${host}`;
}
