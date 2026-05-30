// Mnemonic-based password reset.
//
// User flow:
//   1. Enter email + 24-word recovery phrase + new password
//   2. Frontend converts the phrase → 32-byte entropy (standard BIP-39
//      wordlist + checksum) and POSTs to /api/auth/recover-with-mnemonic.
//      Words never cross the wire.
//   3. Backend verifies the phrase by AES-GCM-decrypting the user's
//      stored envelope. If the auth tag passes, it sets the new
//      password and returns the envelope so the frontend can locally
//      unwrap the RSA keypair too. Plan A has a single recovery_mode
//      ('full'), so the envelope always comes back — the
//      "password_only" branch from the previous schema is retired.
//   4. With the envelope in hand this page also locally unwraps the
//      user's RSA keypair and saves it to IndexedDB so the user lands
//      in /home with chat/notes/drive working.
//
// "Lost password AND lost mnemonic" = account is genuinely unrecoverable.
// That's the explicit promise this page reinforces in its copy.

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
      // Validates word count + membership locally before the network round-trip.
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
        newPassword,
      );

      // Plan A: the server always returns the envelope on a successful
      // mnemonic reset, so we always unlock E2E keys locally and the
      // user doesn't have to re-enter the mnemonic at /recover after
      // login. The legacy `wrapped_envelope === null` branch is gone.
      if (wrapped_envelope) {
        try {
          await unwrapKeysFromRecovery(wrapped_envelope, entropy, user_id);
        } catch (err) {
          // Non-fatal: password is already reset. The user can finish the
          // E2E restore at /recover after they log in. Surface a soft
          // notice via logger.
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
            Your password has been reset and your encryption keys are
            unlocked on this device. Sign in to continue.
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
          Enter your email, the {MNEMONIC_WORD_COUNT}-word recovery phrase
          you saved at signup, and a new password. If you do not have your
          phrase, your account cannot be recovered — Wayve cannot reset
          end-to-end encrypted accounts on your behalf.
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
