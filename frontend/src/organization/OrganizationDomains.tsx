// Enterprise-owner domain page: generate a challenge token, publish it as a DNS
// TXT record, then confirm. Verified state is kept per domain in localStorage.
// This is distinct from the platform-staff DNS-TXT verification at
// /platform/domains.
import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { apiFetch } from "../api/client";
import "./organizationDomains.css";

const STORAGE_PREFIX = "rwayve.orgDomain.";

type DomainState = { token: string | null; verifiedAt: string | null };

function domainFromEmail(email?: string | null): string {
  if (!email) return "";
  const at = email.lastIndexOf("@");
  return at >= 0
    ? email
        .slice(at + 1)
        .trim()
        .toLowerCase()
    : "";
}

function readState(domain: string): DomainState {
  if (!domain) return { token: null, verifiedAt: null };
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + domain);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DomainState>;
      return {
        token: parsed.token ?? null,
        verifiedAt: parsed.verifiedAt ?? null,
      };
    }
  } catch {
    // malformed / unavailable — treat as fresh.
  }
  return { token: null, verifiedAt: null };
}

function writeState(domain: string, state: DomainState) {
  try {
    localStorage.setItem(STORAGE_PREFIX + domain, JSON.stringify(state));
  } catch {
    // private mode / quota — state just won't persist this session.
  }
}

function makeToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export default function OrganizationDomains() {
  const { user } = useAuth();
  const initialDomain = domainFromEmail(user?.email);
  const [domain, setDomain] = useState(initialDomain);
  const [state, setState] = useState<DomainState>(() =>
    readState(initialDomain)
  );
  const [copied, setCopied] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Custom-domain verification is a business / enterprise organization feature.
  const tier = user?.current_plan?.tier;
  const canManage =
    user?.scope === "organization" &&
    (tier === "business" || tier === "enterprise");
  if (user && !canManage) {
    return <Navigate to="/home" replace />;
  }

  const orgName = user?.organization_name ?? "your organization";
  const d = domain.trim().toLowerCase();
  const txtName = d ? `_wayve-challenge.${d}` : "";
  const txtValue = state.token ? `wayve-verify=${state.token}` : "";

  const onDomainChange = (value: string) => {
    const next = value.trim().toLowerCase();
    setDomain(next);
    setState(readState(next));
    setError(null);
  };

  const generate = () => {
    if (!d) return;
    const next: DomainState = { token: makeToken(), verifiedAt: null };
    writeState(d, next);
    setState(next);
    setError(null);
  };

  // Real verification: the backend runs a live DNS TXT lookup for the published
  // challenge. A domain you don't control has no such record, so it won't
  // verify — we only flip to verified on a confirmed lookup.
  const verify = async () => {
    if (!d || !state.token || checking) return;
    setChecking(true);
    setError(null);
    try {
      const res = await apiFetch("/api/org-domains/verify", {
        method: "POST",
        body: JSON.stringify({ domain: d, token: state.token }),
      });
      const data = (await res.json()) as {
        verified?: boolean;
        message?: string;
      };
      if (res.ok && data.verified) {
        const next: DomainState = {
          token: state.token,
          verifiedAt: new Date().toISOString(),
        };
        writeState(d, next);
        setState(next);
      } else {
        setError(data.message ?? "TXT record not found yet.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verification failed.");
    } finally {
      setChecking(false);
    }
  };

  const reset = () => {
    try {
      localStorage.removeItem(STORAGE_PREFIX + d);
    } catch {
      // ignore
    }
    setState({ token: null, verifiedAt: null });
    setError(null);
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(text);
      window.setTimeout(() => setCopied(null), 1500);
    });
  };

  const locked = !!state.token || !!state.verifiedAt;

  return (
    <div className="u-page-shell org-domains-page">
      <div className="org-domains-card">
        <h1>Domain</h1>
        <p className="org-domains-sub">
          Verify ownership of {orgName}&apos;s email domain by publishing a DNS
          TXT record. We check the live DNS record, so only a domain whose DNS
          you control will verify.
        </p>

        <label className="org-domains-label" htmlFor="org-domain-input">
          Domain
        </label>
        <div className="org-domains-row">
          <input
            id="org-domain-input"
            className="org-domains-input"
            value={domain}
            onChange={(e) => onDomainChange(e.target.value)}
            placeholder="acme.com"
            disabled={locked}
            aria-label="Organization domain"
          />
          <span
            className={`org-domains-status ${
              state.verifiedAt
                ? "is-verified"
                : state.token
                  ? "is-pending"
                  : "is-none"
            }`}
          >
            {state.verifiedAt
              ? "Verified"
              : state.token
                ? "Pending"
                : "Not verified"}
          </span>
        </div>

        {state.verifiedAt ? (
          <div className="org-domains-verified">
            <span>
              ✓ {d} is verified ·{" "}
              {new Date(state.verifiedAt).toLocaleDateString()}
            </span>
            <button type="button" className="org-domains-undo" onClick={reset}>
              Remove verification
            </button>
          </div>
        ) : state.token ? (
          <>
            <div className="org-domains-txt">
              <p className="org-domains-txt-help">
                Add this TXT record to {d}&apos;s DNS, then click Verify:
              </p>
              <div className="org-domains-txt-row">
                <span className="org-domains-txt-key">Name</span>
                <code className="org-domains-txt-val">{txtName}</code>
                <button
                  type="button"
                  className="org-domains-copy"
                  onClick={() => copy(txtName)}
                >
                  {copied === txtName ? "✓" : "Copy"}
                </button>
              </div>
              <div className="org-domains-txt-row">
                <span className="org-domains-txt-key">Value</span>
                <code className="org-domains-txt-val">{txtValue}</code>
                <button
                  type="button"
                  className="org-domains-copy"
                  onClick={() => copy(txtValue)}
                >
                  {copied === txtValue ? "✓" : "Copy"}
                </button>
              </div>
            </div>
            {error && <p className="org-domains-error">{error}</p>}
            <div className="org-domains-actions">
              <button
                type="button"
                className="org-domains-verify-btn"
                onClick={() => void verify()}
                disabled={checking}
              >
                {checking ? "Verifying…" : "Verify Domain Ownership"}
              </button>
              <button
                type="button"
                className="org-domains-undo"
                onClick={reset}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <button
            type="button"
            className="org-domains-verify-btn"
            onClick={generate}
            disabled={!d}
          >
            Generate verification token
          </button>
        )}
      </div>
    </div>
  );
}
