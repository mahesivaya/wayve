import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { verifyEmail, resendVerification } from "../api/Auth";
import "./login.css";

// Code-entry screen reached after register (or a login blocked as unverified),
// with the address passed as `?email=`. The user types the 6-digit code that was
// emailed. On success we send them to /login (with the "Verified — sign in"
// banner + email prefilled) — first sign-in sets up E2E keys.
export default function VerifyEmail() {
  const [params] = useSearchParams();
  const email = params.get("email") ?? "";
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<"idle" | "verifying" | "done">("idle");
  const [error, setError] = useState(
    email ? "" : "Missing email — register or log in again to get a code."
  );
  const [info, setInfo] = useState("");
  const navigate = useNavigate();

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
    try {
      await resendVerification(email);
      setInfo("A new code has been sent — check your inbox.");
    } catch {
      setError("Couldn't resend right now. Try again in a moment.");
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <h2>Verify your email</h2>

        {status === "done" ? (
          <p className="subtitle">Verified! Redirecting to login…</p>
        ) : (
          <>
            <p className="subtitle">
              Enter the 6-digit code sent to <strong>{email}</strong>.
            </p>
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
              disabled={!email}
            >
              Resend code
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
  );
}
