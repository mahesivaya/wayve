// Boot-time token and JWT helpers. None of these depend on AuthContext: they
// read `window.location`, the stored auth token, and the JWT payload.

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

// Returns null on a malformed or expired token, so callers can treat a stale
// token exactly like no token at all.
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

// Prefer the OAuth redirect token from the URL fragment, otherwise reuse the
// stored one. The fragment carries the token specifically because fragments are
// never sent to the server, keeping it out of server logs, referrers, and
// browser request history.
//
// `isFreshSignup` mirrors the markers the backend writes on fresh-account
// landings, and setupEncryption uses it to show the 24-word seed modal rather
// than asking a brand-new OAuth user for a phrase they were never given.
export const resolveBootToken = (): {
  token: string | null;
  isFreshSignup: boolean;
} => {
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const tokenFromHash = hashParams.get("token");
  const isSignup = hashParams.has("signup");
  const isOAuthLanding =
    isSignup || hashParams.has("connected") || hashParams.has("sso");
  // `signup=true` appears on every signup-flow landing, including existing users
  // re-signing in, because /login's "Sign in with Google" button also uses
  // ?mode=signup. Only `&new=true` means the OAuth round actually inserted a new
  // user row, which is the sole case where we generate fresh keys.
  const isOAuthNewUser =
    (isSignup && hashParams.get("new") === "true") ||
    (hashParams.has("sso") && hashParams.get("new") === "true");
  const isFreshSignup = isOAuthNewUser;

  // Two OAuth-landing shapes exist. Older flows put the JWT in the fragment
  // (`#signup=true&token=...`) so it stayed out of server logs; newer flows set
  // it as an HttpOnly cookie at the callback and use the fragment only for UI
  // markers. Either way, clean the fragment out of the URL.
  if (isOAuthLanding) {
    if (tokenFromHash) {
      log.info("restoring token from OAuth redirect (hash-token)");
      setAuthToken(tokenFromHash);
    } else {
      log.info("OAuth redirect (cookie-token); cleaning fragment");
    }
    // A Google or SSO landing is a fresh login, so expand the sidebar as the
    // password `login()` path does. A mailbox-connect landing (`#connected`) is a
    // mid-session return, not a login, so it is skipped.
    if (isSignup || hashParams.has("sso")) {
      try {
        localStorage.setItem("rwayve.sidebar.collapsed", "0");
      } catch {
        // Storage unavailable; Layout falls back to expanded anyway.
      }
    }
    const path = window.location.pathname || "/home";
    window.history.replaceState(
      {},
      document.title,
      `${path}${window.location.search}`
    );
    return { token: tokenFromHash ?? getAuthToken(), isFreshSignup };
  }

  return { token: getAuthToken(), isFreshSignup: false };
};
