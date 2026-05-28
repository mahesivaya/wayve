import { useState } from "react";
import type { FormEvent } from "react";
import { register } from "../api/Auth";
import { useAuth } from "../auth/useAuth";
import { homePathForAccount } from "../auth/accountHome";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { getApiBase } from "../config";
import "./login.css"; // ✅ reuse styles

export default function Register() {
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState(() =>
    params.get("error") === "email_exists"
      ? "This email is already registered. Please log in instead."
      : ""
  );

  const { login } = useAuth();
  const navigate = useNavigate();

  const handleGmailSignup = () => {
    window.location.href = `${getApiBase()}/gmail/login?mode=signup`;
  };

  const handleOutlookSignup = () => {
    window.location.href = `${getApiBase()}/outlook/login?mode=signup`;
  };

  const handleRegister = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    // ✅ basic validation
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }

    try {
      // All new signups start in "basic" recovery mode — sign in with
      // email + password from anywhere, no seed phrase required. The
      // 24-word phrase + zero-knowledge "full" mode is offered later
      // as part of the upgrade flow (see /billing → security upgrade),
      // so the registration form stays a single-click "create
      // account" with no decision fatigue.
      const data = await register(email, password, confirm, "basic");

      if (!data || !data.token) {
        throw new Error("No token returned from server");
      }

      login(data.token, data.account_type ?? "personal", true);

      // Post-register redirect rules (in priority order):
      //   1. `?next=/path` from a referring CTA — same-origin only
      //      (rejects "" / "//other.host" / non-leading-slash to prevent
      //      open-redirect into another origin). This still covers the
      //      "create organization → /organizations/new" CTA path; the
      //      explicit account-kind radio on this form was removed since
      //      every new signup starts as a personal account by default.
      //   2. Fall back to the account-type home (e.g. /home for personal).
      const rawNext = params.get("next") ?? "";
      const safeNext =
        rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "";
      const fallback = homePathForAccount(data.account_type);
      const target = safeNext
        ? safeNext
        : fallback.startsWith("/") ? fallback : `/${fallback}`;
      void navigate(target);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleRegister}>
        <h2>Create account </h2>
        <p className="subtitle">Join Wayve to get started</p>

        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />

        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        <input
          type="password"
          placeholder="Confirm Password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />

        <button type="submit">Register</button>

        <div className="auth-divider"><span>or sign up with</span></div>

        <div className="auth-oauth-row">
          <button
            type="button"
            className="google-btn"
            onClick={handleGmailSignup}
          >
            Gmail
          </button>
          <button
            type="button"
            className="outlook-btn"
            onClick={handleOutlookSignup}
          >
            Outlook
          </button>
        </div>

        {/* ✅ Error message */}
        {error && <p className="error">{error}</p>}

        {/* ✅ Switch to login */}
        <p className="switch-auth">
          Already have an account?{" "}
          <Link to="/login">Login</Link>
        </p>
      </form>
    </div>
  );
}
