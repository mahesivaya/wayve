import { logger } from "../utils/logger";
import { useState } from "react";
import type { FormEvent } from "react";
import { login } from "../api/Auth";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { homePathForUser } from "../auth/accountHome";
import { getApiBase } from "../config";
import "./login.css";

export default function Login() {
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(() =>
    params.get("error") === "email_exists"
      ? "This email is already registered with a password. Please login."
      : ""
  );
  const navigate = useNavigate();
  const { login: authLogin } = useAuth();

  const handleLogin = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    try {
      const data = await login(email, password);

      if (!data || !data.token) {
        throw new Error("No token returned");
      }

      authLogin(data.token, data.account_type ?? "personal");

      // Org slug isn't known yet at login; routing settles to /organization/<slug>
      // once AuthContext's post-login /api/me fetch resolves.
      navigate(homePathForUser({ account_type: data.account_type }));
    } catch (err) {
      logger.error(err);
      setError("Login failed. Check your credentials.");
    }
  };

  const handleGoogle = () => {
    window.location.href = `${getApiBase()}/gmail/login?mode=signup`;
  };

  const handleOutlook = () => {
    window.location.href = `${getApiBase()}/outlook/login?mode=signup`;
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleLogin}>
        <h2>Welcome back 👋</h2>
        <p className="subtitle">Login to your Wayve account</p>

        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
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

        <div className="auth-divider"><span>or</span></div>

        <button
          type="button"
          className="google-btn"
          onClick={handleGoogle}
        >
          Continue with Gmail
        </button>

        <button
          type="button"
          className="outlook-btn"
          onClick={handleOutlook}
        >
          Continue with Outlook
        </button>

        {error && <p className="error">{error}</p>}

        <p className="switch-auth">
          <Link to="/forgot-password">Forgot password?</Link>
        </p>

        <p className="switch-auth">
          Don’t have an account?{" "}
          <Link to="/register">Register</Link>
        </p>
      </form>
    </div>
  );
}
