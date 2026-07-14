// Shown exactly once, at first key generation. There is no verification step:
// the user is trusted to copy or download the phrase, and losing both password
// and phrase means the account is unrecoverable. That is a deliberate product
// call to keep signup friction low.
//
// Continue calls `onConfirmed`, which uploads the AES-GCM wrapped private key.
// An upload failure keeps the modal open so the user can retry.

import { useEffect, useMemo, useState } from "react";
import { MNEMONIC_WORD_COUNT } from "../crypto/mnemonic";
import type { RecoveryMode } from "../auth/authContextValue";
import { useAuth } from "../auth/useAuth";
import "./recoverySeedModal.css";

interface Props {
  mnemonic: string;
  // Accepted for source compatibility but unused: there is only one mode now.
  recoveryMode?: RecoveryMode;
  onConfirmed: () => Promise<void> | void;
  busy?: boolean;
  error?: string | null;
}

export default function RecoverySeedModal({
  mnemonic,
  onConfirmed,
  busy,
  error,
}: Props) {
  const { user } = useAuth();
  const words = useMemo(() => mnemonic.split(" "), [mnemonic]);
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

  // Keyed to the account scope so personal and platform-team keys land in
  // distinct files. The org master key is downloaded from BootstrapPage instead.
  const recoveryFileName =
    user?.scope === "platform"
      ? "fluxze.platform-recovery-key.txt"
      : "fluxze-recovery-key.txt";

  // Disable keyboard shortcuts that could accidentally close the modal.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") e.preventDefault();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  function copyMnemonic() {
    void navigator.clipboard?.writeText(mnemonic).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  }

  function downloadMnemonic() {
    const body = [
      "Fluxze recovery phrase",
      "=====================",
      "",
      "Keep this file somewhere safe and offline. This is the ONLY way",
      "to recover your account if you forget your password or lose this",
      "device. Fluxze cannot reset it for you.",
      "",
      mnemonic,
      "",
      `Generated: ${new Date().toISOString()}`,
    ].join("\n");
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = recoveryFileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setDownloaded(true);
  }

  return (
    <div className="recovery-modal-backdrop" role="dialog" aria-modal="true">
      <div className="recovery-modal">
        <header>
          <h2>Save your recovery phrase</h2>
          <p>
            These {MNEMONIC_WORD_COUNT} words are the <strong>only</strong> way
            to recover your account if you forget your password or switch to a
            new device. Fluxze cannot reset them for you — losing both the
            password and this phrase means your encrypted content (emails, chat,
            drive, tasks, calendar, notes) is unrecoverable. Copy or download
            them and keep them somewhere safe — not in a screenshot, not in
            another app on this device.
          </p>
        </header>

        <div className="recovery-grid">
          {words.map((word, i) => (
            <div className="recovery-cell" key={i}>
              <span className="recovery-index">{i + 1}.</span>
              <span className="recovery-word">{word}</span>
            </div>
          ))}
        </div>

        {error && <p className="recovery-error">{error}</p>}

        <div className="recovery-actions">
          <button
            type="button"
            className="recovery-copy-btn"
            onClick={copyMnemonic}
            disabled={busy}
          >
            {copied ? "Copied ✓" : "Copy"}
          </button>
          <button
            type="button"
            className="recovery-copy-btn"
            onClick={downloadMnemonic}
            disabled={busy}
          >
            {downloaded ? "Downloaded ✓" : "Download"}
          </button>
          <button
            type="button"
            className="recovery-primary-btn"
            onClick={() => void onConfirmed()}
            disabled={busy}
          >
            {busy ? "Saving recovery…" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
