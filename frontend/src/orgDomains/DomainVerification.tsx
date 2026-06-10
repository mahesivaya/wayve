// Platform-owner domain administration. Claim a custom domain for an
// organization, publish the DNS TXT challenge, and verify ownership. Only a
// verified domain lets that org mint `*@domain` member addresses (enforced
// server-side in admin_create_user). Reached at /platform/domains?org=<id>.
//
// Backend: backend/crates/wayve-server/src/organization/domains.rs

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { type AdminOrganization, listAdminOrganizations } from "../api/admin";
import {
  type OrgDomain,
  claimOrgDomain,
  deleteOrgDomain,
  listOrgDomains,
  verifyOrgDomain,
} from "./api";

export default function DomainVerification() {
  const [params, setParams] = useSearchParams();
  const orgParam = params.get("org");
  const [orgId, setOrgId] = useState<number | null>(
    orgParam && Number.isFinite(Number(orgParam)) ? Number(orgParam) : null
  );
  const [orgs, setOrgs] = useState<AdminOrganization[]>([]);

  const [domains, setDomains] = useState<OrgDomain[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newDomain, setNewDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async (id: number) => {
    setLoading(true);
    setError(null);
    try {
      setDomains(await listOrgDomains(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load domains");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (orgId != null) void load(orgId);
  }, [orgId, load]);

  // Populate the org picker so the owner chooses by name instead of having
  // to know the numeric ID. Platform staff only (same gate as this page).
  useEffect(() => {
    (async () => {
      try {
        setOrgs(await listAdminOrganizations());
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Failed to load organizations"
        );
      }
    })();
  }, []);

  const selectOrg = (value: string) => {
    if (!value) {
      setOrgId(null);
      setParams({});
      return;
    }
    const id = Number(value);
    setError(null);
    setOrgId(id);
    setParams({ org: String(id) });
  };

  const claim = async () => {
    if (orgId == null) return;
    const d = newDomain.trim();
    if (!d) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await claimOrgDomain(orgId, d);
      setNewDomain("");
      await load(orgId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to claim domain");
    } finally {
      setBusy(false);
    }
  };

  const verify = async (domainId: number) => {
    if (orgId == null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await verifyOrgDomain(orgId, domainId);
      setNotice(
        res.verified
          ? `✓ ${res.domain} verified — the org can now create addresses on it.`
          : (res.message ?? "TXT record not found yet.")
      );
      await load(orgId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (domainId: number, domain: string) => {
    if (orgId == null) return;
    if (!window.confirm(`Remove the claim on ${domain}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteOrgDomain(orgId, domainId);
      await load(orgId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete domain");
    } finally {
      setBusy(false);
    }
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(text);
      window.setTimeout(() => setCopied(null), 2000);
    });
  };

  return (
    <div style={{ padding: 40, maxWidth: 760 }}>
      <h2>🌐 Organization domain verification</h2>
      <p style={{ color: "#6b7280" }}>
        Claim a domain for an organization and prove ownership via DNS. Only a{" "}
        <strong>verified</strong> domain may be used to create member email
        addresses on it — this is what stops anyone minting{" "}
        <code>x@usa.com</code> on a domain they don&apos;t control.
      </p>

      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          margin: "16px 0",
        }}
      >
        <label htmlFor="orgSelect" style={{ fontWeight: 600 }}>
          Organization
        </label>
        <select
          id="orgSelect"
          value={orgId ?? ""}
          onChange={(e) => selectOrg(e.target.value)}
          style={{ padding: "6px 10px", minWidth: 280 }}
        >
          <option value="">Select an organization…</option>
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name} (#{o.id})
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div style={{ color: "#b91c1c", fontWeight: 600, margin: "8px 0" }}>
          {error}
        </div>
      )}
      {notice && (
        <div style={{ color: "#047857", fontWeight: 600, margin: "8px 0" }}>
          {notice}
        </div>
      )}

      {orgId != null && (
        <>
          <div style={{ display: "flex", gap: 8, margin: "16px 0" }}>
            <input
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && claim()}
              placeholder="acme.com"
              style={{ padding: "6px 10px", flex: 1 }}
            />
            <button onClick={claim} disabled={busy || !newDomain.trim()}>
              Claim domain
            </button>
          </div>

          {loading ? (
            <p style={{ color: "#6b7280" }}>Loading…</p>
          ) : domains.length === 0 ? (
            <p style={{ color: "#6b7280" }}>
              No domains claimed for org {orgId} yet.
            </p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0 }}>
              {domains.map((d) => (
                <li
                  key={d.id}
                  style={{
                    border: "1px solid #e5e7eb",
                    borderRadius: 8,
                    padding: 16,
                    marginBottom: 12,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <strong style={{ fontSize: 16 }}>{d.domain}</strong>
                    <span
                      style={{
                        padding: "2px 10px",
                        borderRadius: 999,
                        fontSize: 12,
                        fontWeight: 700,
                        background: d.verified ? "#d1fae5" : "#fef3c7",
                        color: d.verified ? "#047857" : "#92400e",
                      }}
                    >
                      {d.verified ? "Verified" : "Pending"}
                    </span>
                  </div>

                  {!d.verified && d.txt_name && d.txt_value && (
                    <div style={{ marginTop: 12, fontSize: 14 }}>
                      <p style={{ margin: "0 0 6px", color: "#6b7280" }}>
                        Add this TXT record to {d.domain}&apos;s DNS, then click
                        Verify:
                      </p>
                      <div
                        style={{
                          fontFamily: "monospace",
                          background: "#f9fafb",
                          border: "1px solid #e5e7eb",
                          borderRadius: 6,
                          padding: 10,
                        }}
                      >
                        <div>
                          <span style={{ color: "#6b7280" }}>Name: </span>
                          {d.txt_name}{" "}
                          <button
                            onClick={() => copy(d.txt_name as string)}
                            style={{ fontSize: 12 }}
                          >
                            {copied === d.txt_name ? "✓" : "Copy"}
                          </button>
                        </div>
                        <div>
                          <span style={{ color: "#6b7280" }}>Value: </span>
                          {d.txt_value}{" "}
                          <button
                            onClick={() => copy(d.txt_value as string)}
                            style={{ fontSize: 12 }}
                          >
                            {copied === d.txt_value ? "✓" : "Copy"}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    {!d.verified && (
                      <button onClick={() => verify(d.id)} disabled={busy}>
                        Verify
                      </button>
                    )}
                    <button
                      onClick={() => remove(d.id, d.domain)}
                      disabled={busy}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
