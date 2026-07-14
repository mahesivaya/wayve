import { useState } from "react";
import type { FormEvent } from "react";
import { register } from "../api/Auth";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { getApiBase } from "../config";
import PublicHeader from "../components/PublicHeader";
import "./login.css"; // ✅ reuse styles

export default function Register() {
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState(() =>
    params.get("error") === "email_exists"
      ? "This email is already registered. Please log in instead."
      : ""
  );
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  const handleGmailSignup = () => {
    window.location.href = `${getApiBase()}/gmail/login?mode=signup`;
  };

  const handleRegister = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    try {
      // The account is created unverified: the user must enter the emailed 6-digit
      // code before they can log in, and that first login is what sets up the E2E
      // keypair and recovery phrase. No auto-login.
      await register(email, password, confirmPassword, "full");
      navigate(`/verify-email?email=${encodeURIComponent(email)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page login-page--framed">
      <PublicHeader showActions={false} />
      <div className="login-page-body">
        <form className="login-card" onSubmit={handleRegister}>
          <h2>Create account </h2>
          <p className="subtitle">Join Fluxze to get started</p>

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
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
          />

          <button type="submit" disabled={submitting}>
            {submitting ? "Creating…" : "Register"}
          </button>

          <div className="auth-divider">
            <span>or sign up with</span>
          </div>

          <div className="auth-oauth-row">
            <button
              type="button"
              className="google-btn"
              aria-label="Sign up with Google"
              onClick={handleGmailSignup}
            >
              Gmail
            </button>
          </div>

          {error && <p className="error">{error}</p>}

          <p className="switch-auth">
            Already have an account? <Link to="/login">Login</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
