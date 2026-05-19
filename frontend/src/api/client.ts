import { getApiBase } from "../config/env";
import { clearAuthToken, getAuthToken } from "../auth/token";

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
    throw new Error(
      err instanceof TypeError
        ? "Backend did not return a response. Check that the backend is running and not panicking for this request."
        : "Network request failed"
    );
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

    console.error(
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
      // ignore json parse errors
    }

    throw new Error(
      message
    );
  }

  return response;
}
