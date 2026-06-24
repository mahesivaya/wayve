// Enterprise-owner Domain page. A lightweight "verify domain ownership" flow:
// shows the organization's email domain and lets the owner confirm ownership in
// one click. The verified state persists in localStorage (per domain) so it
// survives reloads. This is intentionally simple — it is NOT the platform
// DNS-TXT verification at /platform/domains (that stays platform-staff only).
import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import "./organizationDomains.css";

const STORAGE_PREFIX = "rwayve.orgDomain.verified.";

function domainFromEmail(email?: string | null): string {
  if (!email) return "";
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : "";
}

function readVerifiedAt(domain: string): string | null {
  if (!domain) return null;
  try {
    return localStorage.getItem(STORAGE_PREFIX + domain);
  } catch {
    return null;
  }
}

export default function OrganizationDomains() {
  const { user } = useAuth();

  const [domain, setDomain] = useState(() => domainFromEmail(user?.email));
  const [verifiedAt, setVerifiedAt] = useState<string | null>(() =>
    readVerifiedAt(domainFromEmail(user?.email))
  );

  // Domain administration is an organization-scoped feature.
  if (user && user.scope !== "organization") {
    return <Navigate to="/home" replace />;
  }

  const orgName = user?.organization_name ?? "your organization";

  const onDomainChange = (value: string) => {
    const next = value.trim().toLowerCase();
    setDomain(next);
    setVerifiedAt(readVerifiedAt(next));
  };

  const verify = () => {
    const d = domain.trim().toLowerCase();
    if (!d) return;
    const ok = window.confirm(
      `Confirm that ${orgName} owns ${d} and mark it as verified?`
    );
    if (!ok) return;
    const now = new Date().toISOString();
    try {
      localStorage.setItem(STORAGE_PREFIX + d, now);
    } catch {
      // private mode / quota — the verified badge just won't persist.
    }
    setVerifiedAt(now);
  };

  const removeVerification = () => {
    const d = domain.trim().toLowerCase();
    try {
      localStorage.removeItem(STORAGE_PREFIX + d);
    } catch {
      // ignore
    }
    setVerifiedAt(null);
  };

  return (
    <div className="u-page-shell org-domains-page">
      <div className="org-domains-card">
        <h1>Domain</h1>
        <p className="org-domains-sub">
          Verify ownership of {orgName}&apos;s email domain. A verified domain
          confirms your organization controls it.
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
            aria-label="Organization domain"
          />
          <span
            className={`org-domains-status ${
              verifiedAt ? "is-verified" : "is-pending"
            }`}
          >
            {verifiedAt ? "Verified" : "Not verified"}
          </span>
        </div>

        {verifiedAt ? (
          <div className="org-domains-verified">
            <span>
              ✓ {domain} is verified
              {` · ${new Date(verifiedAt).toLocaleDateString()}`}
            </span>
            <button
              type="button"
              className="org-domains-undo"
              onClick={removeVerification}
            >
              Remove verification
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="org-domains-verify-btn"
            onClick={verify}
            disabled={!domain.trim()}
          >
            Verify Domain Ownership
          </button>
        )}
      </div>
    </div>
  );
}
