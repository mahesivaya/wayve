import { getApiBase } from "../config/env";
import { clearAuthToken, getAuthToken } from "../auth/token";
import { logger } from "../utils/logger";
import { reportClientError } from "./errorLogs";

// Skip reporting failures of the error-log endpoint itself — otherwise a
// broken logger fans out into an infinite POST loop. Also skip routine
// 401 (treated as session expiry, surfaced via redirect, not an error).
function shouldReportFailure(path: string, status?: number): boolean {
  if (path.includes("/api/error-logs")) return false;
  if (status === 401) return false;
  return true;
}

type ApiOptions =
  RequestInit & {
    auth?: boolean;

    // Preserve backend 401
    // messages without forcing
    // logout/redirect.
    preserve401?: boolean;
  };

export async function apiFetch(
  path: string,
  options: ApiOptions = {}
) {
  const {
    auth = true,

    preserve401 = false,

    headers,

    ...rest
  } = options;

  const token = getAuthToken();
  const url = path.startsWith("http")
    ? path
    : `${getApiBase()}${path.startsWith("/") ? path : `/${path}`}`;

  let response: Response;

  try {
    response =
      await fetch(
        url,
        {
          ...rest,
          credentials: "include",

          headers: {
            "Content-Type":
              "application/json",

            ...(auth && token
              ? {
                  Authorization:
                    `Bearer ${token}`,
                }
              : {}),

            ...headers,
          },
        }
      );
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

  if (
    response.status === 401
  ) {
    let message =
      "Unauthorized";

    try {
      const data =
        await response
          .clone()
          .json();

      message =
        data?.error ||
        data?.message ||
        message;

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
      throw new Error(
        message
      );
    }

    logger.error(
      "Unauthorized"
    );

    clearAuthToken();

    // Avoid jsdom/Vitest
    // navigation crashes.

    if (
      import.meta.env.MODE !==
      "test"
    ) {
      window.location.href =
        "/login";
    }

    throw new Error(
      message
    );
  }

  // ================= OTHER ERRORS =================

  if (!response.ok) {
    let message =
      `Request failed (${response.status} ${response.statusText || "HTTP error"})`;

    try {
      const data =
        await response
          .clone()
          .json();

      message =
        data?.error ||
        data?.message ||
        message;

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

    throw new Error(
      message
    );
  }

  return response;
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
  options?: ApiOptions,
): Promise<T> {
  const response = await apiFetch(path, options);
  return response.json() as Promise<T>;
}
