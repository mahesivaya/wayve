// Blocking modal asking the user to enter their 24-word recovery phrase
// so we can unwrap the server-stored envelope and restore the local
// keypair. Used when AuthContext detects local IndexedDB keys are
// missing (new device / cleared browser storage) for a "full" recovery-
// mode user. Distinct from RecoverPage (the standalone /recover route)
// — this is opened automatically right after login so the user can't
// accidentally try to use encrypted features without keys.
//
// "password_only" accounts can't restore via this flow (server only
// holds a throwaway credential, not the real private key), so
// AuthContext suppresses the modal for those.

import { FormEvent, useState } from "react";
import {
  MNEMONIC_WORD_COUNT,
  mnemonicToEntropy,
  normalizeMnemonicInput,
} from "../crypto/mnemonic";
import { unwrapKeysFromRecovery } from "../crypto/recovery";
import { fetchWrappedKey } from "../api/recovery";
import "./recoverySeedModal.css";

type Props = {
  userId: number;
  email: string;
  onUnlocked: () => void;
  onLogout: () => void;
};

export default function RecoverPromptModal({
  userId,
  email,
  onUnlocked,
  onLogout,
}: Props) {
  const [mnemonic, setMnemonic] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // Validate locally first so we don't hit the server with garbage.
      const entropy = await mnemonicToEntropy(normalizeMnemonicInput(mnemonic));

      const envelope = await fetchWrappedKey();
      if (!envelope) {
        setError(
          "No recovery key is stored for this account. " +
            "If you signed up before recovery was added, ask support."
        );
        return;
      }

      await unwrapKeysFromRecovery(envelope, entropy, userId, email);
      onUnlocked();
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
          <h2>Enter your recovery phrase</h2>
          <p>
            This device doesn't have your encryption keys yet. Paste the{" "}
            {MNEMONIC_WORD_COUNT}-word phrase you saved at registration to
            unlock your encrypted chat, notes, and email on this device. The
            phrase never leaves your browser.
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
              onClick={onLogout}
              disabled={busy}
            >
              Log out
            </button>
            <button
              type="submit"
              className="recovery-primary-btn"
              disabled={busy}
            >
              {busy ? "Unlocking…" : "Unlock"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
