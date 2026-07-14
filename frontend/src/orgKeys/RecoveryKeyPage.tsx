// Owners land here on a device with no cached org private key. Entering the
// mnemonic both caches the key in IndexedDB and publishes a `user_pubkey` wrap,
// so the next session auto-loads it.

import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { getOrgKeys } from "./api";
import { unwrapOrgKeyWithMnemonic } from "./orgRecovery";

export default function RecoveryKeyPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [mnemonic, setMnemonic] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const orgId = user?.organization_id ?? null;

  useEffect(() => {
    if (!user) return;
    if (!orgId) {
      setError("Your account isn't bound to an organization.");
    }
  }, [user, orgId]);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!user || !orgId) return;
    setError("");
    setBusy(true);
    try {
      const keys = await getOrgKeys(orgId, { includeMnemonic: true });
      if (!keys.wrapped_mnemonic) {
        throw new Error(
          "This organization has no mnemonic-wrapped envelope on file — owner must complete bootstrap."
        );
      }
      await unwrapOrgKeyWithMnemonic(
        orgId,
        user.id,
        user.email,
        mnemonic,
        keys.wrapped_mnemonic
      );
      void navigate("/organization/home", { replace: true });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to unwrap recovery key."
      );
    } finally {
      setBusy(false);
    }
  };

  if (!user) return <div style={{ padding: 40 }}>Sign in first.</div>;

  return (
    <div style={{ padding: 40, maxWidth: 640 }}>
      <h2>🔑 Enter your organization recovery key</h2>
      <p>
        Type the 24 words separated by spaces. They unlock the organization
        master key on this device. Once unwrapped, this device will auto-load
        the master key on future sessions without re-asking.
      </p>
      <form onSubmit={submit}>
        <textarea
          rows={5}
          value={mnemonic}
          onChange={(e) => setMnemonic(e.target.value)}
          placeholder="word1 word2 word3 ..."
          style={{
            width: "100%",
            padding: 12,
            fontFamily: "monospace",
            border: "1px solid #d1d5db",
            borderRadius: 6,
          }}
          autoFocus
          required
        />
        {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
        <div style={{ marginTop: 16 }}>
          <button type="submit" disabled={busy}>
            {busy ? "Unlocking…" : "Unlock"}
          </button>
        </div>
      </form>
    </div>
  );
}
