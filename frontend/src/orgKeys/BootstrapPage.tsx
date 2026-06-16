// First-time mnemonic display + confirm-words-back for the org master
// key. Reached at /organization/recovery-key/bootstrap?org=<id> after
// the owner finishes /api/organizations self-serve creation.

import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { bootstrapOrgMasterKey } from "./orgKeypair";
import { getOrgKeys } from "./api";
import "../recovery/recoverySeedModal.css";

type Phase =
  | { kind: "loading" }
  | { kind: "already_done" }
  | { kind: "display"; mnemonic: string[] }
  | { kind: "confirm"; mnemonic: string[]; entered: string }
  | { kind: "done" }
  | { kind: "error"; message: string };

export default function BootstrapPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const orgIdParam = params.get("org");
  const orgId = orgIdParam ? Number(orgIdParam) : NaN;

  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [copied, setCopied] = useState(false);

  const downloadMnemonic = (words: string[]) => {
    // Numbered + space-separated forms in the same file so the user can
    // pick whichever they want when restoring. No trailing whitespace.
    const numbered = words.map((w, i) => `${i + 1}. ${w}`).join("\n");
    const phrase = words.join(" ");
    const body = `Fluxze organization recovery key\nGenerated ${new Date().toISOString()}\n\n${numbered}\n\nPhrase:\n${phrase}\n`;
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fluxze-org-recovery-key.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    if (!user) return;
    if (!Number.isFinite(orgId)) {
      setPhase({
        kind: "error",
        message: "Missing or invalid ?org parameter.",
      });
      return;
    }
    let cancelled = false;
    // Idempotency guard: a previous visit may have already bootstrapped
    // this org. The backend rejects re-bootstrap with 400, which would
    // surface here as a confusing "Bootstrap failed" — even though the
    // org is in fact set up. Probe GET /keys first; if it returns the
    // pubkey, route the user to the dashboard with a clear message.
    (async () => {
      try {
        await getOrgKeys(orgId);
        if (!cancelled) setPhase({ kind: "already_done" });
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const notBootstrapped =
          message.includes("404") || /not[_ ]found/i.test(message);
        if (!notBootstrapped) {
          if (!cancelled) setPhase({ kind: "error", message });
          return;
        }
      }
      // Fresh org — actually bootstrap.
      try {
        const result = await bootstrapOrgMasterKey(orgId, user.id, user.email);
        if (cancelled) return;
        setPhase({ kind: "display", mnemonic: result.mnemonic.split(/\s+/) });
      } catch (err) {
        if (cancelled) return;
        const message =
          err instanceof Error
            ? err.message
            : "Failed to bootstrap the organization recovery key.";
        setPhase({ kind: "error", message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, orgId]);

  if (!user) {
    return (
      <div className="recovery-modal-backdrop" role="dialog" aria-modal="true">
        <div className="recovery-modal">
          <header>
            <h2>Sign in required</h2>
            <p>
              You must be signed in to bootstrap your organization recovery key.
            </p>
          </header>
        </div>
      </div>
    );
  }

  if (phase.kind === "loading") {
    return (
      <div className="recovery-modal-backdrop" role="dialog" aria-modal="true">
        <div className="recovery-modal">
          <header>
            <h2>Setting up your organization recovery key</h2>
            <p>
              Generating your encryption keypair and the 24-word recovery
              phrase. This can take up to 20 seconds on a fresh browser — please
              don't close this tab.
            </p>
          </header>
        </div>
      </div>
    );
  }

  if (phase.kind === "error") {
    return (
      <div className="recovery-modal-backdrop" role="dialog" aria-modal="true">
        <div className="recovery-modal">
          <header>
            <h2>Bootstrap failed</h2>
          </header>
          <p className="recovery-error">{phase.message}</p>
          <div className="recovery-actions">
            <button
              type="button"
              className="recovery-copy-btn"
              onClick={() => navigate("/organization/home")}
            >
              Back
            </button>
            <button
              type="button"
              className="recovery-primary-btn"
              onClick={() => window.location.reload()}
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase.kind === "already_done") {
    return (
      <div className="recovery-modal-backdrop" role="dialog" aria-modal="true">
        <div className="recovery-modal">
          <header>
            <h2>Recovery key already set up</h2>
            <p>
              Your organization recovery key was bootstrapped on a previous
              visit. The 24-word phrase is shown only once at creation — Fluxze
              cannot display it again. If you didn't save it, contact your
              platform administrator to rotate the key.
            </p>
          </header>
          <div className="recovery-actions">
            <button
              type="button"
              className="recovery-primary-btn"
              onClick={() => navigate("/organization/home", { replace: true })}
            >
              Go to organization home
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase.kind === "done") {
    return (
      <div className="recovery-modal-backdrop" role="dialog" aria-modal="true">
        <div className="recovery-modal">
          <header>
            <h2>Recovery key saved</h2>
            <p>
              Your organization master key is bootstrapped. Keep the 24-word
              phrase you wrote down somewhere safe — Fluxze cannot recover it
              for you if you lose it.
            </p>
          </header>
          <div className="recovery-actions">
            <button
              type="button"
              className="recovery-primary-btn"
              onClick={() => navigate("/organization/home", { replace: true })}
            >
              Continue to organization home
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase.kind === "display") {
    return (
      <div className="recovery-modal-backdrop" role="dialog" aria-modal="true">
        <div className="recovery-modal">
          <header>
            <h2>🔑 Your organization recovery key</h2>
            <p className="recovery-warning">
              Write these 24 words on paper and store them somewhere physically
              secure. Fluxze cannot recover this for you. Without these words,
              if you lose access to every browser you've used, you cannot
              decrypt any departing-member data — ever.
            </p>
          </header>

          <div className="recovery-grid">
            {phase.mnemonic.map((word, i) => (
              <div className="recovery-cell" key={i}>
                <span className="recovery-index">{i + 1}.</span>
                <span className="recovery-word">{word}</span>
              </div>
            ))}
          </div>

          <div className="recovery-actions">
            <button
              type="button"
              className="recovery-copy-btn"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(phase.mnemonic.join(" "))
                  .then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 2000);
                  });
              }}
            >
              {copied ? "Copied ✓" : "Copy phrase"}
            </button>
            <button
              type="button"
              className="recovery-copy-btn"
              onClick={() => downloadMnemonic(phase.mnemonic)}
            >
              Download .txt
            </button>
            <button
              type="button"
              className="recovery-primary-btn"
              onClick={() =>
                setPhase({
                  kind: "confirm",
                  mnemonic: phase.mnemonic,
                  entered: "",
                })
              }
            >
              I have written it down — confirm
            </button>
          </div>
        </div>
      </div>
    );
  }

  // phase.kind === "confirm"
  const onConfirm = () => {
    const words = phase.entered.trim().toLowerCase().split(/\s+/);
    const expected = phase.mnemonic.map((w) => w.toLowerCase());
    if (
      words.length !== expected.length ||
      words.some((w, i) => w !== expected[i])
    ) {
      setPhase({
        kind: "error",
        message:
          "The words you entered don't match. Go back and try again — the original phrase is gone the moment you leave this page.",
      });
      return;
    }
    setPhase({ kind: "done" });
  };

  return (
    <div className="recovery-modal-backdrop" role="dialog" aria-modal="true">
      <div className="recovery-modal">
        <header>
          <h2>Confirm your recovery key</h2>
          <p>
            Re-type the 24 words separated by spaces to confirm you saved them.
          </p>
        </header>
        <textarea
          className="recovery-confirm-input"
          rows={5}
          value={phase.entered}
          onChange={(e) =>
            setPhase({
              kind: "confirm",
              mnemonic: phase.mnemonic,
              entered: e.target.value,
            })
          }
          autoFocus
        />
        <div className="recovery-actions">
          <button
            type="button"
            className="recovery-copy-btn"
            onClick={() =>
              setPhase({ kind: "display", mnemonic: phase.mnemonic })
            }
          >
            Back to view words
          </button>
          <button
            type="button"
            className="recovery-primary-btn"
            onClick={onConfirm}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
