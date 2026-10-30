import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { resetPassword } from "../api/Auth";
import "./login.css";
import { usePublicTheme } from "../theme/usePublicTheme";
import PublicHeader from "../components/PublicHeader";
import { isDesktopApp } from "../utils/desktop";

export default function ResetPassword() {
  const { mode: publicTheme } = usePublicTheme();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "done">("idle");
  const [error, setError] = useState("");
  const navigate = useNavigate();

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    if (!token) {
      setError("Missing reset token.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }

    setStatus("saving");
    try {
      await resetPassword(token, password);
      setStatus("done");
      setTimeout(() => navigate("/login"), 1500);
    } catch (err: unknown) {
      setStatus("idle");
      setError(err instanceof Error ? err.message : "Reset failed");
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
          <h2>Set a new password</h2>

          {status === "done" ? (
            <p className="subtitle">Password updated. Redirecting to login…</p>
          ) : (
            <>
              <input
                type="password"
                placeholder="New password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <input
                type="password"
                placeholder="Confirm new password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
              <button type="submit" disabled={status === "saving"}>
                {status === "saving" ? "Saving…" : "Update password"}
              </button>
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
