// Boot-time token + JWT helpers extracted from AuthContext so the auth
// provider stays focused on React state and side effects. None of these
// helpers depend on the provider — they read `window.location`, the
// stored auth token, and decode the JWT payload.

import { getAuthToken, setAuthToken } from "./token";
import { logger } from "../utils/logger";

const log = logger.scope("auth");

export type Claims = {
  sub: number;
  email: string;
  account_type?: string;
  organization_id?: number | null;
  exp?: number;
};

const decodeBase64Url = (value: string): string => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (normalized.length % 4)) % 4;
  const padded = normalized.padEnd(normalized.length + padding, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

// Decode JWT payload. Returns null on malformed/expired tokens so callers
// can treat a stale token the same as no token.
export const parseJwt = (token: string): Claims | null => {
  try {
    const claims = JSON.parse(decodeBase64Url(token.split(".")[1])) as Claims;
    if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
};

// Resolve the boot-time token: prefer the OAuth redirect token from the URL
// fragment, otherwise reuse the stored one. The fragment keeps the token out
// of server logs, referrers, and browser request history.
//
// `isFreshSignup` mirrors the `#signup=true` (Google) and `#sso=true&new=true`
// (enterprise SSO) markers the backend writes on fresh-account landings. The
// bootstrap useEffect threads this into setupEncryption so a brand-new
// OAuth/SSO user gets the 24-word seed modal — instead of being prompted to
// enter a phrase they were never given.
export const resolveBootToken = (): {
  token: string | null;
  isFreshSignup: boolean;
} => {
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const tokenFromHash = hashParams.get("token");
  const isSignup = hashParams.has("signup");
  const isOAuthLanding =
    isSignup || hashParams.has("connected") || hashParams.has("sso");
  // `signup=true` is set on every signup-FLOW landing (the same backend
  // handler serves both new signups and existing-user re-signins because
  // the "Sign in with Google" button on /login also uses
  // ?mode=signup). The `&new=true` add-on is set only when the OAuth
  // round actually inserted a new user row — that's the one case where
  // we want to generate fresh keys + show the 24-word seed modal.
  const isOAuthNewUser =
    (isSignup && hashParams.get("new") === "true") ||
    (hashParams.has("sso") && hashParams.get("new") === "true");
  const isFreshSignup = isOAuthNewUser;

  // Two OAuth-landing shapes:
  //   1. `#signup=true&token=...` — older flows put the JWT in the
  //      fragment so it stays out of server logs.
  //   2. `#signup=true` (no token) — newer flows set the JWT via an
  //      HttpOnly cookie at the OAuth callback and only use the
  //      fragment to carry UI markers like `signup`/`connected`/`sso`.
  // Either way we want to clean the fragment from the URL and surface
  // `isFreshSignup` so the bootstrap setupEncryption knows to show
  // the seed modal instead of asking for an existing recovery phrase.
  if (isOAuthLanding) {
    if (tokenFromHash) {
      log.info("restoring token from OAuth redirect (hash-token)");
      setAuthToken(tokenFromHash);
    } else {
      log.info("OAuth redirect (cookie-token); cleaning fragment");
    }
    const path = window.location.pathname || "/home";
    window.history.replaceState(
      {},
      document.title,
      `${path}${window.location.search}`,
    );
    return { token: tokenFromHash ?? getAuthToken(), isFreshSignup };
  }

  return { token: getAuthToken(), isFreshSignup: false };
};
