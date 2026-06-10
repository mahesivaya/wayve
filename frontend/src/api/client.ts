import { getApiBase } from "../config/env";
import {
  clearAuthToken,
  getAuthToken,
  noteSessionExpiredOnce,
} from "../auth/token";
import { logger } from "../utils/logger";
import { reportClientError } from "./errorLogs";

// Skip reporting failures of the error-log endpoint itself — otherwise a
// broken logger fans out into an infinite POST loop. Also skip routine
// 401 (treated as session expiry, surfaced via redirect, not an error)
// and `/api/logout` — the AuthContext fires logout async then immediately
// clears the token and navigates, so the in-flight POST is routinely
// torn down mid-flight on rapid clicks. The user is logged out either
// way; the spurious "network" report just adds noise to the dashboard.
function shouldReportFailure(path: string, status?: number): boolean {
  if (path.includes("/api/error-logs")) return false;
  if (path.includes("/api/logout")) return false;
  if (status === 401) return false;
  return true;
}

type ApiOptions = RequestInit & {
  auth?: boolean;

  // Preserve backend 401
  // messages without forcing
  // logout/redirect.
  preserve401?: boolean;

  // Return the Response on 404 instead of throwing. For endpoints where
  // "not found" is an expected, meaningful answer (e.g. the wrapped-key
  // lookup: 404 = "no recovery key on file yet"), so callers can branch
  // on res.status === 404 rather than catching a thrown error.
  preserve404?: boolean;

  // Same, for 410 Gone — e.g. an expired secure-message token.
  preserve410?: boolean;

  // Opt-in short-TTL response cache for GET requests, in milliseconds.
  // When set and > 0, a successful GET is cached by URL and re-served
  // (cloned) for repeat calls within the window — so remount-on-navigation
  // doesn't refetch. Off by default. Any non-GET request clears the whole
  // GET cache, so callers never see data stale past a mutation.
  cacheTtlMs?: number;
};

// In-flight GET coalescing: identical concurrent GETs share one network
// request. Staleness-free — only genuinely simultaneous calls share a result.
const inflightGets = new Map<string, Promise<Response>>();

// Opt-in short-TTL GET cache (see cacheTtlMs). Keyed the same as coalescing.
const getCache = new Map<string, { res: Response; expires: number }>();

/**
 * Drop cached GET responses. With no argument, clears everything (what every
 * mutation does automatically). Pass a substring to clear only matching URLs.
 */
export function invalidateGetCache(prefix?: string): void {
  if (!prefix) {
    getCache.clear();
    return;
  }
  for (const key of getCache.keys()) {
    if (key.includes(prefix)) getCache.delete(key);
  }
}

export async function apiFetch(path: string, options: ApiOptions = {}) {
  const {
    auth = true,
    preserve401 = false,
    preserve404 = false,
    preserve410 = false,
    cacheTtlMs,
    headers,
    ...rest
  } = options;

  const token = getAuthToken();
  const url = path.startsWith("http")
    ? path
    : `${getApiBase()}${path.startsWith("/") ? path : `/${path}`}`;

  const method = (rest.method ?? "GET").toString().toUpperCase();
  const isGet = method === "GET";
  // Coalescing/cache key. Preserve flags fold in so two GETs to the same URL
  // with different 404/410 handling never share a result.
  const cacheKey = `${method} ${url}|${preserve401 ? 1 : 0}${preserve404 ? 1 : 0}${preserve410 ? 1 : 0}`;

  // Mutations invalidate the whole GET cache — a read after any write can
  // never be stale past the mutation.
  if (!isGet) invalidateGetCache();

  // The actual network + status handling. Returns the success (or preserved
  // 404/410) Response, or throws on error. Wrapped so GETs can coalesce/cache.
  const run = async (): Promise<Response> => {
    let response: Response;

    try {
      response = await fetch(url, {
        ...rest,
        credentials: "include",

        headers: {
          "Content-Type": "application/json",

          ...(auth && token
            ? {
                Authorization: `Bearer ${token}`,
              }
            : {}),

          ...headers,
        },
      });
    } catch (err) {
      const message =
        err instanceof TypeError
          ? "Backend did not return a response. Check that the backend is running and not panicking for this request."
          : "Network request failed";
      if (shouldReportFailure(path)) {
        reportClientError({
          severity: "error",
          message: `[network] ${message}`,
          method: (rest.method as string | undefined) ?? "GET",
          extra: { path },
        });
      }
      throw new Error(message);
    }

    // ================= 401 =================

    if (response.status === 401) {
      let message = "Unauthorized";

      try {
        const data = await response.clone().json();

        message = data?.error || data?.message || message;
      } catch {
        // ignore
      }

      // Some endpoints intentionally
      // return 401 without invalidating
      // the session.
      //
      // Example:
      // - wrong current password
      // - MFA challenge
      // - partial auth flows

      if (preserve401) {
        throw new Error(message);
      }

      logger.error("Unauthorized");

      clearAuthToken();

      // Soft session-expiry: clear the token and notify the app ONCE so
      // AuthContext drops the user and ProtectedRoute does an in-app
      // React-Router redirect to /login. The old `window.location.href`
      // hard-reloaded the whole SPA on every 401 — a jarring full-page
      // "blink" whenever any background request expired.
      if (noteSessionExpiredOnce() && typeof window !== "undefined") {
        window.dispatchEvent(new Event("rwayve:session-expired"));
      }

      throw new Error(message);
    }

    // ================= OTHER ERRORS =================

    // Caller opted to handle these itself (expected "not found" / "gone"):
    // hand back the Response untouched instead of throwing, so it can branch
    // on the status.
    if (
      (response.status === 404 && preserve404) ||
      (response.status === 410 && preserve410)
    ) {
      return response;
    }

    if (!response.ok) {
      let message = `Request failed (${response.status} ${response.statusText || "HTTP error"})`;

      try {
        const data = await response.clone().json();

        message = data?.error || data?.message || message;
      } catch {
        // JSON parse failed — body is probably plain text (most Actix
        // handlers in this codebase return `HttpResponse::BadRequest()
        // .body("...")` with a raw string instead of a JSON envelope).
        // Surface that text instead of swallowing it so callers can see
        // the real reason (e.g. "Meeting cannot be in the past") rather
        // than a generic "Request failed (400 Bad Request)".
        try {
          const text = (await response.clone().text()).trim();
          if (text) {
            message = `${message}: ${text}`;
          }
        } catch {
          // give up — leave the generic message
        }
      }

      // Report failed API responses to the central error log so platform
      // staff can see what users hit. We narrow the report to genuinely
      // unexpected failures: 5xx (server fault) and unauthenticated 4xx
      // that aren't 401 — 4xx validation errors are intentionally noisy.
      if (
        shouldReportFailure(path, response.status) &&
        (response.status >= 500 || response.status === 0)
      ) {
        reportClientError({
          severity: "error",
          message: `[api ${response.status}] ${message}`,
          method: (rest.method as string | undefined) ?? "GET",
          status_code: response.status,
          request_id: response.headers.get("x-request-id") ?? undefined,
          extra: { path },
        });
      }

      throw new Error(message);
    }

    return response;
  };

  // Non-GET: run directly — never coalesced or cached.
  if (!isGet) {
    return run();
  }

  // GET: serve a fresh cached response without touching the network.
  if (cacheTtlMs && cacheTtlMs > 0) {
    const hit = getCache.get(cacheKey);
    if (hit && hit.expires > Date.now()) {
      return hit.res.clone();
    }
  }

  // Coalesce identical concurrent GETs onto one in-flight request.
  let shared = inflightGets.get(cacheKey);
  if (!shared) {
    shared = run().finally(() => {
      inflightGets.delete(cacheKey);
    });
    inflightGets.set(cacheKey, shared);
  }
  const response = await shared;

  if (cacheTtlMs && cacheTtlMs > 0 && response.ok) {
    getCache.set(cacheKey, {
      res: response.clone(),
      expires: Date.now() + cacheTtlMs,
    });
  }
  // Every awaiter (including the first) gets its own clone, so the shared
  // body is never consumed and stays re-readable by all callers.
  return response.clone();
}

/**
 * Typed JSON wrapper around {@link apiFetch}. The repeated
 * `const res = await apiFetch(...); return res.json() as Promise<T>;`
 * pattern across the api/ layer becomes one call here.
 *
 * The cast is still a cast — TypeScript can't prove the server returned
 * shape `T`. It just lives in one place instead of every call site, which
 * is also where a future runtime validator (zod / generated OpenAPI types)
 * would slot in.
 *
 * `apiFetch` already throws on every non-`ok` response, so this helper
 * doesn't need its own status check.
 */
export async function apiFetchJson<T>(
  path: string,
  options?: ApiOptions
): Promise<T> {
  const response = await apiFetch(path, options);
  return response.json() as Promise<T>;
}
