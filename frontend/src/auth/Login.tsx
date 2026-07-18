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

// Error codes the backend SSO callback puts in the hash fragment, mapped so the
// raw code is never shown to the user.
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
  // The email-verification screen sends users back here as ?verified=1&email=...
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
  // Set by AuthContext.logout("idle"). Read once and cleared, so a refresh
  // doesn't keep showing the notice.
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

  // Strip the SSO error fragment once displayed, so a refresh doesn't repeat it.
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

      // A local account cannot log in until it confirms its email.
      if (data && data.error === "email_unverified") {
        navigate(`/verify-email?email=${encodeURIComponent(email)}`);
        return;
      }

      if (!data || !data.token) {
        throw new Error("No token returned");
      }

      // Org members get a password-wrapped private key in `login_wrap`, which
      // must reach IndexedDB before authLogin runs setupEncryption so that
      // setupEncryption takes its "key already on device" short-circuit.
      // Personal users get no login_wrap and follow the mnemonic path instead.
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

      // The password is forwarded only so AuthContext can derive the PBKDF2
      // login-wrap on a personal user's first login from this device.
      authLogin(data.token, data.account_type ?? "personal", false, password);

      // The org slug is not known yet; routing settles on /organization/<slug>
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

  // The backend resolves the org from the email domain and either redirects to
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
      // Probe the start endpoint first so an unconfigured domain produces an
      // inline error rather than a redirect back to /login with an error hash.
      const probe = await fetch(url, {
        redirect: "manual",
        credentials: "include",
      });
      if (probe.status === 0 || (probe.status >= 300 && probe.status < 400)) {
        // Under redirect:manual an opaqueredirect surfaces as status 0, which is
        // the success case here.
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
                data-tooltip="SSO sign-in is temporarily disabled"
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
              Don’t have an account? <Link to="/pricing">Register</Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
