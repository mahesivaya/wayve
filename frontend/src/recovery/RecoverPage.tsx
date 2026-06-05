// Restore a private key from a recovery mnemonic on a fresh device.
//
// Flow:
//   1. User signs in normally (their session JWT is valid)
//   2. Lands here at /recover (manual nav or auto-prompted by Auth if
//      no IndexedDB key is found)
//   3. Pastes the recovery words → membership check against the wordlist
//   4. Fetch the wrapped envelope from /api/me/wrapped-key
//   5. PBKDF2(mnemonic) → derive wrapping key → AES-GCM decrypt
//      (wrong words → auth-tag verification fails, clean error)
//   6. Save the recovered keypair into IndexedDB
//   7. Redirect to /home — chat / notes / drive / attachments now work

import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import {
  MNEMONIC_WORD_COUNT,
  mnemonicToEntropy,
  normalizeMnemonicInput,
} from "../crypto/mnemonic";
import { unwrapKeysFromRecovery } from "../crypto/recovery";
import { fetchWrappedKey } from "../api/recovery";
import "./recoverySeedModal.css";

export default function RecoverPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [mnemonic, setMnemonic] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!user) {
      setError("You need to sign in before restoring your recovery key.");
      return;
    }

    setBusy(true);
    try {
      // Validate locally first so we don't hit the server with garbage.
      const entropy = await mnemonicToEntropy(normalizeMnemonicInput(mnemonic));

      const envelope = await fetchWrappedKey();
      if (!envelope) {
        setError("No recovery key is stored for this account.");
        return;
      }

      await unwrapKeysFromRecovery(envelope, entropy, user.id);
      void navigate("/home", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recovery failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="recovery-modal-backdrop">
      <div className="recovery-modal">
        <header>
          <h2>Restore your encryption key</h2>
          <p>
            Paste the {MNEMONIC_WORD_COUNT}-word recovery phrase you
            wrote down at signup. Fluxze will use it to unlock your
            encrypted notes, files, and chat history on this device. The
            phrase never leaves your browser.
          </p>
          <p style={{ marginTop: 6, fontSize: "0.85rem", opacity: 0.75 }}>
            Only works for accounts registered with{" "}
            <em>Full encryption recovery</em>. Accounts on the
            password-reset-only setting can't restore encrypted content
            this way.
          </p>
        </header>

        <form onSubmit={handleSubmit}>
          <textarea
            value={mnemonic}
            onChange={(e) => setMnemonic(e.target.value)}
            placeholder={Array.from({ length: MNEMONIC_WORD_COUNT })
              .map((_, i) => `word${i + 1}`)
              .join(" ")}
            rows={6}
            autoFocus
            spellCheck={false}
            autoCapitalize="none"
            style={{
              width: "100%",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: "0.95rem",
              padding: "12px",
              border: "1px solid var(--color-input-border)",
              borderRadius: "8px",
              marginBottom: "12px",
              boxSizing: "border-box",
              background: "var(--color-surface)",
              color: "var(--color-text-primary)",
            }}
          />

          {error && <p className="recovery-error">{error}</p>}

          <div className="recovery-actions">
            <button
              type="button"
              className="recovery-secondary-btn"
              onClick={() => navigate(-1)}
              disabled={busy}
            >
              Cancel
            </button>
            <button type="submit" className="recovery-primary-btn" disabled={busy}>
              {busy ? "Restoring…" : "Restore key"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
