import { useState } from "react";
import type { FormEvent } from "react";
import { register, type RecoveryMode } from "../api/Auth";
import { useAuth } from "../auth/useAuth";
import { homePathForAccount } from "../auth/accountHome";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { getApiBase } from "../config";
import "./login.css"; // ✅ reuse styles

type AccountKind = "personal" | "organization";

export default function Register() {
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  // Default to "full" — every personal user gets a 24-word recovery
  // phrase at signup. They're shown the words once, then never again
  // (RecoverPromptModal asks them to re-enter on a new device).
  const [recoveryMode, setRecoveryMode] = useState<RecoveryMode>("full");
  // The "Create organization →" CTA on the marketing home sends visitors
  // here with `?next=/organizations/new`. When that's present, default
  // the radio to "organization" so the selection matches the user's
  // intent without an extra click. Otherwise default to personal.
  const [accountKind, setAccountKind] = useState<AccountKind>(() =>
    (params.get("next") ?? "").startsWith("/organizations/new")
      ? "organization"
      : "personal"
  );
  const [error, setError] = useState(() =>
    params.get("error") === "email_exists"
      ? "This email is already registered. Please log in instead."
      : ""
  );

  const { login } = useAuth();
  const navigate = useNavigate();

  const handleGoogleSignup = () => {
    window.location.href = `${getApiBase()}/gmail/login?mode=signup`;
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
      const data = await register(email, password, confirm, recoveryMode);

      if (!data || !data.token) {
        throw new Error("No token returned from server");
      }

      login(data.token, data.account_type ?? "personal", true);

      // Post-register redirect rules (in priority order):
      //   1. Account-kind radio = "organization" → /organizations/new so the
      //      brand-new personal user is taken straight into the self-serve
      //      org creation flow. Beats `?next=` because the radio is the
      //      user's explicit, last-mile choice.
      //   2. `?next=/path` from a referring CTA — same-origin only
      //      (rejects "" / "//other.host" / non-leading-slash to prevent
      //      open-redirect into another origin).
      //   3. Fall back to the account-type home (e.g. /home for personal).
      const rawNext = params.get("next") ?? "";
      const safeNext =
        rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "";
      const fallback = homePathForAccount(data.account_type);
      const target =
        accountKind === "organization"
          ? "/organizations/new"
          : safeNext
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

        <fieldset className="account-kind-fieldset">
          <legend>Account type</legend>
          <label className="account-kind-option">
            <input
              type="radio"
              name="account-kind"
              value="personal"
              checked={accountKind === "personal"}
              onChange={() => setAccountKind("personal")}
            />
            <span>
              <strong>Personal account</strong>
              <small>
                Just for me — email, chat, files, AI on a private workspace.
              </small>
            </span>
          </label>
          <label className="account-kind-option">
            <input
              type="radio"
              name="account-kind"
              value="organization"
              checked={accountKind === "organization"}
              onChange={() => setAccountKind("organization")}
            />
            <span>
              <strong>Organization account</strong>
              <small>
                For my team — shared inboxes, multi-seat billing, and RBAC.
                You'll set up the organization right after signing up.
              </small>
            </span>
          </label>
        </fieldset>

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

        <fieldset className="recovery-mode-fieldset">
          <legend>Account security</legend>
          <p className="recovery-mode-help">
            Pick how your encrypted data is protected. Can't be changed later.
          </p>

          <label className="recovery-mode-option">
            <input
              type="radio"
              name="recovery-mode"
              value="basic"
              checked={recoveryMode === "basic"}
              onChange={() => setRecoveryMode("basic")}
            />
            <span>
              <strong>Basic — easiest</strong>
              <small>
                Sign in from any device with email + password. Wayve can
                read your content.
              </small>
            </span>
          </label>

          <label className="recovery-mode-option">
            <input
              type="radio"
              name="recovery-mode"
              value="full"
              checked={recoveryMode === "full"}
              onChange={() => setRecoveryMode("full")}
            />
            <span>
              <strong>Full encryption — recommended</strong>
              <small>
                24-word phrase restores your data on new devices. Wayve
                cannot read it without your phrase.
              </small>
            </span>
          </label>

          <label className="recovery-mode-option">
            <input
              type="radio"
              name="recovery-mode"
              value="password_only"
              checked={recoveryMode === "password_only"}
              onChange={() => setRecoveryMode("password_only")}
            />
            <span>
              <strong>Password reset only — strictest</strong>
              <small>
                Phrase only resets your password. Encrypted history stays
                on this device.
              </small>
            </span>
          </label>
        </fieldset>

        <button type="submit">Register</button>

        <div className="auth-divider"><span>or</span></div>

        <button
          type="button"
          className="google-btn"
          onClick={handleGoogleSignup}
        >
          Sign up with Google
        </button>

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
