import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { forgotPassword } from "../api/Auth";
import "./login.css";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState("");

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    setStatus("sending");
    try {
      await forgotPassword(email);
      setStatus("sent");
    } catch (err: unknown) {
      setStatus("idle");
      setError(err instanceof Error ? err.message : "Request failed");
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <h2>Forgot password?</h2>
        <p className="subtitle">
          Enter your email and we'll send you a reset link.
        </p>

        {status === "sent" ? (
          <p className="subtitle">
            If that account exists, a reset link has been sent. Check your
            inbox — the link expires in 30 minutes.
          </p>
        ) : (
          <>
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <button type="submit" disabled={status === "sending"}>
              {status === "sending" ? "Sending…" : "Send reset link"}
            </button>
            {error && <p className="error">{error}</p>}
          </>
        )}

        <p className="switch-auth">
          <Link to="/login">Back to login</Link>
          {" · "}
          <Link to="/recover-with-mnemonic">Have your recovery phrase?</Link>
        </p>
      </form>
    </div>
  );
}
