import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { verifyEmail, resendVerification } from "../api/Auth";
import "./login.css";
import { usePublicTheme } from "../theme/usePublicTheme";
import PublicHeader from "../components/PublicHeader";
import { isDesktopApp } from "../utils/desktop";

// Mirror the server (SIGNUP_RESEND_WINDOW_SECONDS / SIGNUP_CODE_TTL_SECONDS in
// routes/auth.rs): a resend within the first minute would only re-send the same
// code, so Resend waits it out; each code stays valid for 10 minutes.
const RESEND_WAIT_MS = 60_000;
const CODE_TTL_MS = 10 * 60_000;

const mmss = (ms: number) => {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

// Code-entry screen reached from register, or from a login blocked as unverified,
// with the address passed as `?email=`. On success it hands off to /login, whose
// first successful sign-in is what sets up the E2E keys.
export default function VerifyEmail() {
  const { mode: publicTheme } = usePublicTheme();
  const [params] = useSearchParams();
  const email = params.get("email") ?? "";
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<"idle" | "verifying" | "done">("idle");
  const [error, setError] = useState(
    email ? "" : "Missing email — register or log in again to get a code."
  );
  const [info, setInfo] = useState("");
  const [resending, setResending] = useState(false);
  // Both arrivals here (register, a login blocked as unverified) have just
  // emailed a code, so the clocks start now; a successful resend restarts them.
  const [sentAt, setSentAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const navigate = useNavigate();

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const resendIn = Math.max(0, sentAt + RESEND_WAIT_MS - now);
  const expiresIn = Math.max(0, sentAt + CODE_TTL_MS - now);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    setInfo("");
    if (!email) {
      setError("Missing email.");
      return;
    }
    if (!/^\d{6}$/.test(code.trim())) {
      setError("Enter the 6-digit code.");
      return;
    }
    setStatus("verifying");
    try {
      await verifyEmail(email, code.trim());
      setStatus("done");
      setTimeout(
        () => navigate(`/login?verified=1&email=${encodeURIComponent(email)}`),
        1000
      );
    } catch (err) {
      setStatus("idle");
      setError(err instanceof Error ? err.message : "Verification failed");
    }
  };

  const resend = async () => {
    setError("");
    setInfo("");
    setResending(true);
    try {
      await resendVerification(email);
      // Past the resend window, so this is a new code; earlier ones still work.
      setSentAt(Date.now());
      setNow(Date.now());
      setInfo("New code sent — check your inbox.");
    } catch {
      setError("Couldn't resend right now. Try again in a moment.");
    } finally {
      setResending(false);
    }
  };

  return (
    <div
      className="login-page login-page--framed"
      data-public-theme={publicTheme}
    >
      {/* No marketing chrome in the desktop (Electron) shell, as on Login. */}
      {!isDesktopApp() && <PublicHeader showActions={false} />}
      <div className="login-page-body">
        <form className="login-card" onSubmit={submit}>
          <h2>Verify your email</h2>

          {status === "done" ? (
            <p className="subtitle">Verified! Redirecting to login…</p>
          ) : (
            <>
              <p className="subtitle">
                Enter the 6-digit code sent to <strong>{email}</strong>.
              </p>
              {email && (
                <p className="subtitle" aria-live="polite">
                  {expiresIn > 0
                    ? `Your code expires in ${mmss(expiresIn)}.`
                    : "Your code has expired — tap Resend for a new one."}
                </p>
              )}
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6-digit code"
                value={code}
                maxLength={6}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                required
                autoFocus
              />
              <button type="submit" disabled={status === "verifying"}>
                {status === "verifying" ? "Verifying…" : "Verify"}
              </button>
              <button
                type="button"
                className="link-button"
                onClick={resend}
                disabled={!email || resending || resendIn > 0}
              >
                {resending
                  ? "Sending…"
                  : resendIn > 0
                    ? `Resend in ${mmss(resendIn)}`
                    : "Resend code"}
              </button>
              {info && <p className="subtitle">{info}</p>}
              {error && <p className="error">{error}</p>}
            </>
          )}

          <p className="switch-auth">
            <Link to="/login">Back to login</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
