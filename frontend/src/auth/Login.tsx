import { logger } from "../utils/logger";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { login } from "../api/Auth";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { homePathForUser } from "../auth/accountHome";
import { getApiBase } from "../config";
import { ssoStartUrl } from "../api/sso";
import PublicHeader from "../components/PublicHeader";
import { isDesktopApp } from "../utils/desktop";
import { parseJwt } from "./bootToken";
import { unwrapAndCacheMemberKeys } from "../orgKeys/memberLogin";
import "./login.css";

// Hash-fragment error codes set by the backend SSO callback when something
// goes wrong (state mismatch, token verification, IdP error, etc.). Mapped
// to a friendly message here instead of leaking the raw code at the user.
const SSO_ERROR_LABELS: Record<string, string> = {
  invalid_state:
    "Your SSO sign-in expired or was tampered with. Please try again.",
  missing_code: "The identity provider didn't return an authorization code.",
  token_exchange_failed:
    "Couldn't complete the SSO handshake with your provider.",
  id_token_invalid: "Your identity provider returned an invalid token.",
  provisioning_failed: "We couldn't create your account from the SSO response.",
  discovery_failed: "Your identity provider is unreachable right now.",
  config_missing: "SSO is no longer configured for your organization.",
};

function parseSsoError(): string {
  if (typeof window === "undefined") return "";
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const errKey = hashParams.get("sso_error");
  if (!errKey) return "";
  const label = SSO_ERROR_LABELS[errKey] ?? `SSO error: ${errKey}`;
  const detail = hashParams.get("detail");
  return detail ? `${label} (${decodeURIComponent(detail)})` : label;
}

export default function Login() {
  const [params] = useSearchParams();
  // Arriving from the email-verification screen (?verified=1&email=...): show a
  // "Verified — sign in" banner and pre-fill the email so it's basically one tap.
  const verified = params.get("verified") === "1";
  const [email, setEmail] = useState(() => params.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [ssoMode, setSsoMode] = useState(false);
  const [ssoEmail, setSsoEmail] = useState("");
  const [ssoLoading, setSsoLoading] = useState(false);
  const [error, setError] = useState(() => {
    const queryErr =
      params.get("error") === "email_exists"
        ? "This email is already registered with a password. Please login."
        : "";
    const ssoErr = parseSsoError();
    return ssoErr || queryErr;
  });
  // One-shot notice when the previous session ended from the 15-min idle
  // timeout (set by AuthContext.logout("idle")). Read-and-clear so a refresh
  // doesn't keep showing it.
  const [idleNotice] = useState(() => {
    try {
      if (sessionStorage.getItem("wayve-logout-reason") === "idle") {
        sessionStorage.removeItem("wayve-logout-reason");
        return "You were signed out after 15 minutes of inactivity. Please sign in again.";
      }
    } catch {
      /* ignore */
    }
    return "";
  });
  const navigate = useNavigate();
  const { login: authLogin } = useAuth();

  // Strip the SSO error fragment after it's been displayed so a refresh
  // doesn't keep showing it.
  useEffect(() => {
    if (window.location.hash.includes("sso_error")) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  const handleLogin = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    try {
      const data = await login(email, password);

      // Local account that hasn't confirmed its email yet — send them to the
      // code-entry screen (email prefilled).
      if (data && data.error === "email_unverified") {
        navigate(`/verify-email?email=${encodeURIComponent(email)}`);
        return;
      }

      if (!data || !data.token) {
        throw new Error("No token returned");
      }

      // Org members: server returned a password-wrapped private key in
      // `login_wrap`. Unwrap with PBKDF2(password) and write to the
      // existing IndexedDB slot BEFORE authLogin runs setupEncryption —
      // that way setupEncryption's "key already on device" branch
      // short-circuits and the user lands fully set up. Personal users
      // get no login_wrap and follow the existing mnemonic path
      // unchanged.
      if (data.login_wrap) {
        try {
          const claims = parseJwt(data.token);
          if (claims) {
            await unwrapAndCacheMemberKeys(
              claims.sub,
              data.email ?? email,
              password,
              data.login_wrap
            );
          }
        } catch (err) {
          logger.error("org member key unwrap failed", err);
          setError(
            "Couldn't unlock your account keys — please contact your administrator."
          );
          return;
        }
      }

      // Forward the typed password so AuthContext can produce the
      // PBKDF2 login-wrap for a personal user on first signup-then-
      // login on this device. Existing users (key already in IDB) hit
      // the short-circuit branch in setupEncryption and the password
      // is never used.
      authLogin(data.token, data.account_type ?? "personal", false, password);

      // Org slug isn't known yet at login; routing settles to /organization/<slug>
      // once AuthContext's post-login /api/me fetch resolves.
      void navigate(homePathForUser({ account_type: data.account_type }));
    } catch {
      logger.warn("Login failed. Check your credentials.");
      setError("Login failed. Check your credentials.");
    }
  };

  const handleGoogle = () => {
    window.location.href = `${getApiBase()}/gmail/login?mode=signup`;
  };

  // Build the SSO start URL for the typed-in work email and redirect.
  // The backend looks up the org by email domain and either redirects to
  // the IdP or returns a 404 we surface inline.
  const handleSsoSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    const url = ssoStartUrl(ssoEmail);
    if (!url) {
      setError("Enter your full work email (e.g. you@acme.com).");
      return;
    }
    setSsoLoading(true);
    try {
      // Probe the start endpoint first so we can show a friendly inline
      // error if no SSO is configured for the domain. Following the 302
      // would either land on the IdP (good) or on /login with an error
      // hash (also OK but we can do better when we already know the
      // outcome).
      const probe = await fetch(url, {
        redirect: "manual",
        credentials: "include",
      });
      if (probe.status === 0 || (probe.status >= 300 && probe.status < 400)) {
        // Browsers report opaqueredirect as type/status 0 when we ask
        // redirect:manual — that's the success case.
        window.location.href = url;
        return;
      }
      if (probe.status === 404) {
        setError(
          "No SSO is configured for that email domain. Use email/password or contact your admin."
        );
        return;
      }
      const body = await probe.json().catch(() => null);
      setError(
        (body && (body.message as string)) ||
          `Couldn't start SSO (HTTP ${probe.status}).`
      );
    } catch (err) {
      logger.error(err);
      setError("Couldn't reach the SSO service. Try again in a moment.");
    } finally {
      setSsoLoading(false);
    }
  };

  return (
    <div className="login-page login-page--framed">
      {/* The public marketing header is for the web app; the desktop (Electron)
          shell has no marketing chrome, so hide it there. */}
      {!isDesktopApp() && <PublicHeader showActions={false} />}
      <div className="login-page-body">
        {ssoMode ? (
          <form className="login-card" onSubmit={handleSsoSubmit}>
            <h2>Sign in with SSO</h2>
            <p className="subtitle">
              Enter your work email. We&apos;ll redirect you to your
              organization&apos;s identity provider.
            </p>

            <input
              type="email"
              value={ssoEmail}
              onChange={(e) => setSsoEmail(e.target.value)}
              placeholder="you@your-company.com"
              autoFocus
              required
            />

            <button type="submit" disabled={ssoLoading}>
              {ssoLoading ? "Connecting…" : "Continue with SSO"}
            </button>

            {idleNotice && <p className="login-notice">{idleNotice}</p>}
            {error && <p className="error">{error}</p>}

            <p className="switch-auth">
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setSsoMode(false);
                  setError("");
                }}
              >
                ← Back to password sign-in
              </button>
            </p>
          </form>
        ) : (
          <form className="login-card" onSubmit={handleLogin}>
            {verified && (
              <p
                className="subtitle"
                style={{
                  color: "var(--color-success-strong, #16a34a)",
                  fontWeight: 600,
                }}
              >
                ✓ Verified — sign in to continue
              </p>
            )}
            <p className="subtitle">Login to your Fluxze account</p>

            <input
              type="text"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email or username"
              autoCapitalize="none"
              autoCorrect="off"
              required
            />

            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              required
            />

            <button type="submit">Login</button>

            <div className="auth-divider">
              <span>or</span>
            </div>

            {false && (
              <button
                type="button"
                className="sso-btn"
                disabled
                title="SSO sign-in is temporarily disabled"
                onClick={() => {
                  setSsoMode(true);
                  setError("");
                }}
              >
                Sign in with SSO
              </button>
            )}

            <button type="button" className="google-btn" onClick={handleGoogle}>
              Continue with Gmail
            </button>

            {idleNotice && <p className="login-notice">{idleNotice}</p>}
            {error && <p className="error">{error}</p>}

            <p className="switch-auth">
              <Link to="/forgot-password">Forgot password?</Link>
            </p>

            <p className="switch-auth">
              Don’t have an account? <Link to="/register">Register</Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
