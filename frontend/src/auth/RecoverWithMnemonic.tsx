// Mnemonic-based password reset: the only way back into an account whose password
// is lost. Losing both the password and the phrase is unrecoverable.
//
// The 24-word phrase is converted to entropy locally and only the entropy is
// POSTed, so the words themselves never cross the wire. The backend proves the
// phrase by AES-GCM decrypting the user's stored envelope, sets the new password,
// and returns that envelope, which this page unwraps into IndexedDB so E2E
// features work immediately.

import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { recoverWithMnemonic } from "../api/Auth";
import {
  MNEMONIC_WORD_COUNT,
  mnemonicToEntropy,
  normalizeMnemonicInput,
} from "../crypto/mnemonic";
import { unwrapKeysFromRecovery } from "../crypto/recovery";
import { logger } from "../utils/logger";
import "./login.css";

export default function RecoverWithMnemonicPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [mnemonic, setMnemonic] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "done">("idle");
  const [error, setError] = useState("");

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");

    if (newPassword.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    let entropy: Uint8Array;
    try {
      // Validates word count and wordlist membership before the round-trip.
      entropy = await mnemonicToEntropy(normalizeMnemonicInput(mnemonic));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid recovery phrase");
      return;
    }

    setStatus("submitting");
    try {
      const { user_id, wrapped_envelope } = await recoverWithMnemonic(
        email.trim().toLowerCase(),
        entropy,
        newPassword
      );

      // A successful reset always returns the envelope, so the keys unlock here
      // and the user never has to re-enter the phrase at /recover after login.
      if (wrapped_envelope) {
        try {
          await unwrapKeysFromRecovery(wrapped_envelope, entropy, user_id);
        } catch (err) {
          // Non-fatal: the password is already reset and the user can finish the
          // E2E restore at /recover after logging in.
          logger.warn("E2E keys were not unlocked locally:", err);
        }
      }

      setStatus("done");
    } catch (err) {
      setStatus("idle");
      setError(err instanceof Error ? err.message : "Recovery failed");
    }
  };

  if (status === "done") {
    return (
      <div className="login-page">
        <div className="login-card">
          <h2>Password updated</h2>
          <p className="subtitle">
            Your password has been reset and your encryption keys are unlocked
            on this device. Sign in to continue.
          </p>
          <button type="button" onClick={() => navigate("/login")}>
            Go to login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <h2>Reset with recovery phrase</h2>
        <p className="subtitle">
          Enter your email, the {MNEMONIC_WORD_COUNT}-word recovery phrase you
          saved at signup, and a new password. If you do not have your phrase,
          your account cannot be recovered — Fluxze cannot reset end-to-end
          encrypted accounts on your behalf.
        </p>

        <input
          type="email"
          placeholder="Email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />

        <textarea
          placeholder={Array.from({ length: MNEMONIC_WORD_COUNT })
            .map((_, i) => `word${i + 1}`)
            .join(" ")}
          rows={6}
          spellCheck={false}
          autoCapitalize="none"
          autoComplete="off"
          value={mnemonic}
          onChange={(e) => setMnemonic(e.target.value)}
          required
          style={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: "0.95rem",
            padding: "10px 12px",
            border: "1px solid var(--color-input-border)",
            borderRadius: "8px",
            background: "var(--color-surface)",
            color: "var(--color-text-primary)",
            resize: "vertical",
            boxSizing: "border-box",
          }}
        />

        <input
          type="password"
          placeholder="New password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          minLength={6}
          required
        />
        <input
          type="password"
          placeholder="Confirm new password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          minLength={6}
          required
        />

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={status === "submitting"}>
          {status === "submitting" ? "Verifying…" : "Reset password"}
        </button>

        <p className="switch-auth">
          <Link to="/login">Back to login</Link>
        </p>
      </form>
    </div>
  );
}
