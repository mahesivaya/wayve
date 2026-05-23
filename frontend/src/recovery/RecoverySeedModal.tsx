// Single-step recovery modal shown exactly once at first key generation.
//
//   Display the words → Copy + Download + Continue.
//
// The user is trusted to copy or download the phrase before clicking
// Continue. There's no follow-up verification step — keeping signup
// friction low is the explicit product call. "Lost password + lost
// recovery phrase = account permanently unrecoverable" is the accepted
// trade-off, surfaced by the copy on this modal and again by the
// /recover-with-mnemonic page.
//
// Clicking Continue invokes `onConfirmed`, which uploads the AES-GCM
// wrapped private key to the server. Upload failure (e.g. no network)
// keeps the modal open and shows the error so the user can retry.

import { useEffect, useMemo, useState } from "react";
import { MNEMONIC_WORD_COUNT } from "../crypto/mnemonic";
import type { RecoveryMode } from "../auth/authContextValue";
import "./recoverySeedModal.css";

interface Props {
  mnemonic: string;
  // Drives the explainer paragraph. "full" mentions cross-device
  // restore; "password_only" makes clear the phrase only resets a
  // forgotten password.
  recoveryMode: RecoveryMode;
  onConfirmed: () => Promise<void> | void;
  busy?: boolean;
  error?: string | null;
}

export default function RecoverySeedModal({
  mnemonic,
  recoveryMode,
  onConfirmed,
  busy,
  error,
}: Props) {
  const words = useMemo(() => mnemonic.split(" "), [mnemonic]);
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

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
      "Wayve recovery phrase",
      "=====================",
      "",
      "Keep this file somewhere safe and offline. This is the ONLY way",
      "to recover your account if you forget your password or lose this",
      "device. Wayve cannot reset it for you.",
      "",
      mnemonic,
      "",
      `Generated: ${new Date().toISOString()}`,
    ].join("\n");
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "wayve-recovery-phrase.txt";
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
          {recoveryMode === "password_only" ? (
            <p>
              These {MNEMONIC_WORD_COUNT} words are the <strong>only</strong>{" "}
              way to reset your password if you forget it. Wayve cannot
              reset them for you. Encrypted chat, notes, and files will
              not follow you to other devices in this mode — that's the
              tradeoff for keeping your encryption key on this device
              only. Copy or download the phrase and keep it somewhere
              safe — not a screenshot, not another app on this device.
            </p>
          ) : (
            <p>
              These {MNEMONIC_WORD_COUNT} words are the <strong>only</strong>{" "}
              way to recover your account if you forget your password or
              switch to a new device. Wayve cannot reset them for you.
              Copy or download them and keep them somewhere safe — not in
              a screenshot, not in another app on this device.
            </p>
          )}
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
