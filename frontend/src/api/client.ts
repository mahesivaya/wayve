import { getApiBase } from "../config/env";
import {
  clearAuthToken,
  getAuthToken,
  noteSessionExpiredOnce,
} from "../auth/token";
import { logger } from "../utils/logger";
import { reportClientError } from "./errorLogs";

// Never report the error-log endpoint itself, or a broken logger fans out into
// an infinite POST loop. 401 is session expiry (surfaced via redirect), and
// `/api/logout` is routinely torn down mid-flight by the navigation that
// follows it — neither is a real failure.
function shouldReportFailure(path: string, status?: number): boolean {
  if (path.includes("/api/error-logs")) return false;
  if (path.includes("/api/logout")) return false;
  if (status === 401) return false;
  return true;
}

type ApiOptions = RequestInit & {
  auth?: boolean;

  // Throw the backend's 401 message instead of forcing a logout/redirect. For
  // endpoints where 401 does not mean the session died (wrong current
  // password, MFA challenge, partial auth flows).
  preserve401?: boolean;

  // Return the Response instead of throwing, so the caller can branch on the
  // status. Each covers a case where the status is a meaningful answer rather
  // than an error: 404 = "no recovery key on file yet", 410 = expired
  // secure-message token, 403 = login rejected pending email verification.
  preserve404?: boolean;
  preserve410?: boolean;
  preserve403?: boolean;

  // Opt-in short-TTL cache for GET responses, in milliseconds. Off by default.
  // Any non-GET request clears the whole GET cache, so callers never see data
  // stale past a mutation.
  cacheTtlMs?: number;
};

// Identical concurrent GETs share one network request. Only genuinely
// simultaneous calls share a result, so this can't serve stale data.
const inflightGets = new Map<string, Promise<Response>>();

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
    preserve403 = false,
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
  // The preserve flags fold into the key so two GETs to the same URL with
  // different 404/410 handling never share a result.
  const cacheKey = `${method} ${url}|${preserve401 ? 1 : 0}${preserve404 ? 1 : 0}${preserve410 ? 1 : 0}`;

  if (!isGet) invalidateGetCache();

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

    if (response.status === 401) {
      let message = "Unauthorized";

      try {
        const data = await response.clone().json();

        message = data?.error || data?.message || message;
      } catch {
        // ignore
      }

      if (preserve401) {
        throw new Error(message);
      }

      logger.error("Unauthorized");

      clearAuthToken();

      // Soft session expiry: notify the app exactly once (not per failing
      // request) so AuthContext drops the user and ProtectedRoute does an
      // in-app redirect to /login, rather than hard-reloading the SPA.
      if (noteSessionExpiredOnce() && typeof window !== "undefined") {
        window.dispatchEvent(new Event("rwayve:session-expired"));
      }

      throw new Error(message);
    }

    // The caller opted to handle these statuses itself, so hand back the
    // Response untouched instead of throwing.
    if (
      (response.status === 404 && preserve404) ||
      (response.status === 410 && preserve410) ||
      (response.status === 403 && preserve403)
    ) {
      return response;
    }

    if (!response.ok) {
      let message = `Request failed (${response.status} ${response.statusText || "HTTP error"})`;

      try {
        const data = await response.clone().json();

        message = data?.error || data?.message || message;
      } catch {
        // Most Actix handlers here return a raw string body rather than a JSON
        // envelope, so fall back to the text to surface the real reason (e.g.
        // "Meeting cannot be in the past") instead of a generic status message.
        try {
          const text = (await response.clone().text()).trim();
          if (text) {
            message = `${message}: ${text}`;
          }
        } catch {
          // give up — leave the generic message
        }
      }

      // Only genuinely unexpected failures reach the central error log; 4xx
      // validation errors are routine and would drown it.
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

  if (!isGet) {
    return run();
  }

  if (cacheTtlMs && cacheTtlMs > 0) {
    const hit = getCache.get(cacheKey);
    if (hit && hit.expires > Date.now()) {
      return hit.res.clone();
    }
  }

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
  // Every awaiter gets its own clone, so the shared body is never consumed and
  // stays re-readable by all callers.
  return response.clone();
}

/**
 * Typed JSON wrapper around {@link apiFetch}. `T` is an unchecked cast, but it
 * lives here rather than at every call site — which is also where a runtime
 * validator would slot in. No status check needed: `apiFetch` already throws on
 * every non-`ok` response.
 */
export async function apiFetchJson<T>(
  path: string,
  options?: ApiOptions
): Promise<T> {
  const response = await apiFetch(path, options);
  return response.json() as Promise<T>;
}
