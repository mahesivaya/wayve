import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import {
  createEmployee,
  createPayrollRun,
  deleteEmployee,
  Employee,
  EmployeeInput,
  EmployeeStatus,
  EmploymentType,
  BillingHistoryRow,
  getPlatformBillingOverview,
  getStripeSnapshot,
  listBillingHistory,
  listEmployees,
  listOrganizationSubscriptions,
  listPayrollRuns,
  listPlatformInvoices,
  listUserSubscriptions,
  OrganizationSubscriptionRow,
  PayFrequency,
  PayrollRun,
  PayrollRunInput,
  PlatformBillingOverview,
  PlatformInvoiceRow,
  StripeSnapshot,
  updateEmployee,
  updatePayrollRunStatus,
  UserSubscriptionRow,
} from "../api/platformBilling";
import { fmtShortDate } from "../utils/datetime";
import "./platformBilling.css";

type Tab =
  | "stripe"
  | "history"
  | "users"
  | "organizations"
  | "invoices"
  | "employees"
  | "payroll";

function fmtMoney(cents: number | null | undefined, currency = "USD"): string {
  if (cents == null) return "—";
  const dollars = cents / 100;
  return dollars.toLocaleString(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  });
}

function fmtDate(value: string | null | undefined): string {
  return fmtShortDate(value);
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultPayrollPeriod(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { start: toISODate(start), end: toISODate(end) };
}

const EMPTY_EMPLOYEE: EmployeeInput = {
  full_name: "",
  email: "",
  job_title: "",
  department: "",
  employment_type: "full_time",
  status: "active",
  base_salary_cents: 0,
  currency: "USD",
  pay_frequency: "monthly",
  hire_date: null,
};

export default function PlatformBilling() {
  const { user } = useAuth();

  // Authorization is computed by the backend on every request — this is
  // purely a UI redirect to keep non-platform-billing users from ever
  // hitting the page and getting a useless 403. Same shape as the existing
  // PlatformAdminHome route.
  const canView =
    user?.scope === "platform" &&
    (hasPermission(user, "billing:read") || hasPermission(user, "billing:manage"));
  const canManage = hasPermission(user, "billing:manage");

  const [tab, setTab] = useState<Tab>("stripe");
  const [overview, setOverview] = useState<PlatformBillingOverview | null>(null);
  const [userSubs, setUserSubs] = useState<UserSubscriptionRow[]>([]);
  const [orgSubs, setOrgSubs] = useState<OrganizationSubscriptionRow[]>([]);
  const [invoices, setInvoices] = useState<PlatformInvoiceRow[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [payrollRuns, setPayrollRuns] = useState<PayrollRun[]>([]);
  const [history, setHistory] = useState<BillingHistoryRow[]>([]);
  const [historySearch, setHistorySearch] = useState("");

  // Stripe account live snapshot — lazy-loaded the first time the user
  // opens the "Stripe account" tab. Each fetch hits Stripe REST APIs so
  // we don't auto-poll; the refresh button re-pulls on demand.
  const [stripeSnap, setStripeSnap] = useState<StripeSnapshot | null>(null);
  const [stripeLoading, setStripeLoading] = useState(false);
  const [stripeError, setStripeError] = useState("");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [success, setSuccess] = useState("");

  // Employee form (create or edit). When editingId is null the form is in
  // create mode; otherwise it's editing that row.
  const [showEmployeeForm, setShowEmployeeForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [empDraft, setEmpDraft] = useState<EmployeeInput>(EMPTY_EMPLOYEE);

  // Payroll form
  const [showPayrollForm, setShowPayrollForm] = useState(false);
  const [payrollDraft, setPayrollDraft] = useState<PayrollRunInput>(() => {
    const { start, end } = defaultPayrollPeriod();
    return { period_start: start, period_end: end, notes: "", tax_rate_pct: 20 };
  });

  const reload = useCallback(async () => {
    if (!canView) return;
    setError("");
    try {
      const [ov, us, os, inv, emp, runs, hist] = await Promise.all([
        getPlatformBillingOverview(),
        listUserSubscriptions(),
        listOrganizationSubscriptions(),
        listPlatformInvoices(),
        listEmployees(),
        listPayrollRuns(),
        listBillingHistory(),
      ]);
      setOverview(ov);
      setUserSubs(us);
      setOrgSubs(os);
      setInvoices(inv);
      setEmployees(emp);
      setPayrollRuns(runs);
      setHistory(hist);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load billing data");
    } finally {
      setLoading(false);
    }
  }, [canView]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void reload();
    }, 0);
    return () => window.clearTimeout(handle);
  }, [reload]);

  const dismissBanners = () => {
    setError("");
    setSuccess("");
  };

  // ---- Employee actions -----------------------------------------------

  const openEmployeeCreate = () => {
    dismissBanners();
    setEditingId(null);
    setEmpDraft(EMPTY_EMPLOYEE);
    setShowEmployeeForm(true);
  };

  const openEmployeeEdit = (emp: Employee) => {
    dismissBanners();
    setEditingId(emp.id);
    setEmpDraft({
      full_name: emp.full_name,
      email: emp.email,
      job_title: emp.job_title ?? "",
      department: emp.department ?? "",
      employment_type: emp.employment_type,
      status: emp.status,
      base_salary_cents: emp.base_salary_cents,
      currency: emp.currency,
      pay_frequency: emp.pay_frequency,
      hire_date: emp.hire_date,
    });
    setShowEmployeeForm(true);
  };

  const closeEmployeeForm = () => {
    setShowEmployeeForm(false);
    setEditingId(null);
    setEmpDraft(EMPTY_EMPLOYEE);
  };

  const saveEmployee = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    dismissBanners();
    setBusy("save-employee");
    try {
      if (editingId == null) {
        await createEmployee(empDraft);
        setSuccess("Employee added");
      } else {
        await updateEmployee(editingId, empDraft);
        setSuccess("Employee updated");
      }
      closeEmployeeForm();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save employee");
    } finally {
      setBusy("");
    }
  };

  const removeEmployee = async (emp: Employee) => {
    if (!window.confirm(`Delete ${emp.full_name}? This cannot be undone.`)) {
      return;
    }
    dismissBanners();
    setBusy(`delete-employee:${emp.id}`);
    try {
      await deleteEmployee(emp.id);
      setSuccess(`Removed ${emp.full_name}`);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete employee");
    } finally {
      setBusy("");
    }
  };

  // ---- Payroll actions ------------------------------------------------

  const openPayrollForm = () => {
    dismissBanners();
    const { start, end } = defaultPayrollPeriod();
    setPayrollDraft({
      period_start: start,
      period_end: end,
      notes: "",
      tax_rate_pct: 20,
    });
    setShowPayrollForm(true);
  };

  const runPayroll = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    dismissBanners();
    setBusy("run-payroll");
    try {
      const run = await createPayrollRun(payrollDraft);
      setSuccess(
        `Created payroll run for ${run.item_count} employees, gross ${fmtMoney(
          run.total_gross_cents,
        )}`,
      );
      setShowPayrollForm(false);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run payroll");
    } finally {
      setBusy("");
    }
  };

  const setPayrollStatus = async (run: PayrollRun, status: PayrollRun["status"]) => {
    dismissBanners();
    setBusy(`payroll-status:${run.id}`);
    try {
      await updatePayrollRunStatus(run.id, status);
      setSuccess(`Payroll run #${run.id} → ${status}`);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update status");
    } finally {
      setBusy("");
    }
  };

  // ---- Render ---------------------------------------------------------

  const loadStripeSnapshot = useCallback(async () => {
    setStripeError("");
    setStripeLoading(true);
    try {
      const snap = await getStripeSnapshot();
      setStripeSnap(snap);
    } catch (err) {
      setStripeError(err instanceof Error ? err.message : "Failed to load Stripe data");
    } finally {
      setStripeLoading(false);
    }
  }, []);

  // First open of the Stripe tab triggers the live fetch. Subsequent
  // visits use the cached snapshot until the user hits Refresh.
  useEffect(() => {
    if (tab === "stripe" && stripeSnap === null && !stripeLoading) {
      void loadStripeSnapshot();
    }
  }, [tab, stripeSnap, stripeLoading, loadStripeSnapshot]);

  const tabs = useMemo(
    () =>
      [
        { key: "stripe" as const, label: "Stripe account" },
        { key: "history" as const, label: `History (${history.length})` },
        { key: "users" as const, label: `Users (${userSubs.length})` },
        { key: "organizations" as const, label: `Organizations (${orgSubs.length})` },
        { key: "invoices" as const, label: `Invoices (${invoices.length})` },
        { key: "employees" as const, label: `Employees (${employees.length})` },
        { key: "payroll" as const, label: `Payroll runs (${payrollRuns.length})` },
      ],
    [history, userSubs, orgSubs, invoices, employees, payrollRuns],
  );

  // Client-side search over the billing history — filter by user email, org,
  // plan, event or status so staff can quickly find one user's activity.
  const filteredHistory = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    if (!q) return history;
    return history.filter((h) =>
      [h.user_email, h.organization_name, h.plan_name, h.event, h.status].some(
        (v) => (v ?? "").toLowerCase().includes(q),
      ),
    );
  }, [history, historySearch]);

  if (!canView) {
    return <Navigate to="/" replace />;
  }

  if (loading) {
    return <div className="pb-loader">Loading platform billing…</div>;
  }

  return (
    <div className="pb-page">
      <header className="pb-header">
        <div>
          <h1>Platform Billing</h1>
          <p>
            Revenue, customer subscriptions, invoices and payroll across the
            whole platform · {user?.email}
          </p>
        </div>
      </header>

      {error && <div className="pb-banner">{error}</div>}
      {success && <div className="pb-banner success">{success}</div>}

      <section className="pb-overview" aria-label="Revenue overview">
        <Stat label="MRR" value={fmtMoney(overview?.mrr_cents)} sub={`ARR ${fmtMoney(overview?.arr_cents)}`} />
        <Stat
          label="Paid invoices (30d)"
          value={fmtMoney(overview?.paid_invoices_30d_cents)}
          sub={`${overview?.paid_invoices_30d_count ?? 0} invoices`}
        />
        <Stat
          label="Payroll / mo"
          value={fmtMoney(overview?.payroll_monthly_cost_cents)}
          sub={`Annual ${fmtMoney(overview?.payroll_annual_cost_cents)}`}
        />
        <Stat
          label="Active subscriptions"
          value={`${(overview?.active_user_subscriptions ?? 0) + (overview?.active_organization_subscriptions ?? 0)}`}
          sub={`${overview?.active_user_subscriptions ?? 0} users · ${overview?.active_organization_subscriptions ?? 0} orgs`}
        />
        <Stat
          label="Tenants"
          value={`${overview?.users_total ?? 0}`}
          sub={`${overview?.organizations_total ?? 0} organizations`}
        />
        <Stat
          label="Employees"
          value={`${overview?.active_employees ?? 0}`}
          sub={`${overview?.total_employees ?? 0} total`}
        />
      </section>

      <nav className="pb-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`pb-tab ${tab === t.key ? "active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "stripe" && (
        <section className="pb-section">
          <div className="pb-section-header">
            <h2>Stripe account</h2>
            <span className="pb-stat-sub">
              Live data pulled directly from Stripe
              {stripeSnap && stripeSnap.configured && stripeSnap.test_mode && (
                <span className="pb-stripe-pill"> · TEST MODE</span>
              )}
            </span>
            <button
              type="button"
              className="pb-stripe-refresh"
              onClick={() => void loadStripeSnapshot()}
              disabled={stripeLoading}
            >
              {stripeLoading ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {stripeError && <div className="pb-banner">{stripeError}</div>}

          {stripeLoading && !stripeSnap && (
            <div className="pb-empty">Loading Stripe snapshot…</div>
          )}

          {stripeSnap && !stripeSnap.configured && (
            <div className="pb-empty">
              Stripe isn't configured for this environment. Add{" "}
              <code>STRIPE_SECRET_KEY</code> to the backend env and restart to
              see live balance, payouts, and charges here.
            </div>
          )}

          {stripeSnap && stripeSnap.configured && (
            <>
              {/* Balance + last-30d summary cards */}
              <section className="pb-overview" aria-label="Stripe balance">
                <Stat
                  label="Available"
                  value={
                    stripeSnap.balance.available.length === 0
                      ? "—"
                      : stripeSnap.balance.available
                          .map((b) =>
                            fmtMoney(b.amount, b.currency.toUpperCase()),
                          )
                          .join(" · ")
                  }
                  sub="Ready to pay out"
                />
                <Stat
                  label="Pending"
                  value={
                    stripeSnap.balance.pending.length === 0
                      ? "—"
                      : stripeSnap.balance.pending
                          .map((b) =>
                            fmtMoney(b.amount, b.currency.toUpperCase()),
                          )
                          .join(" · ")
                  }
                  sub="Awaiting capture / settlement"
                />
                <Stat
                  label="Gross (30d)"
                  value={fmtMoney(
                    stripeSnap.last_30d.gross_cents,
                    stripeSnap.last_30d.currency.toUpperCase(),
                  )}
                  sub={`${stripeSnap.last_30d.transaction_count} transactions`}
                />
                <Stat
                  label="Net (30d)"
                  value={fmtMoney(
                    stripeSnap.last_30d.net_cents,
                    stripeSnap.last_30d.currency.toUpperCase(),
                  )}
                  sub={`Fees ${fmtMoney(stripeSnap.last_30d.fees_cents, stripeSnap.last_30d.currency.toUpperCase())}`}
                />
              </section>

              {/* Recent payouts */}
              <div className="pb-section-header" style={{ marginTop: 24 }}>
                <h3 style={{ margin: 0 }}>Recent payouts</h3>
                <span className="pb-stat-sub">
                  Transfers from Stripe balance to your bank
                </span>
              </div>
              {stripeSnap.payouts.length === 0 ? (
                <div className="pb-empty">No payouts yet.</div>
              ) : (
                <table className="pb-table">
                  <thead>
                    <tr>
                      <th>Payout</th>
                      <th>Status</th>
                      <th>Arrival</th>
                      <th>Created</th>
                      <th className="right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stripeSnap.payouts.map((p) => (
                      <tr key={p.id ?? Math.random()}>
                        <td>
                          <code>{p.id ?? "—"}</code>
                          {p.description && (
                            <>
                              <br />
                              <small style={{ color: "#6b7280" }}>{p.description}</small>
                            </>
                          )}
                        </td>
                        <td>
                          <span className={`pb-pill ${p.status ?? ""}`}>
                            {p.status ?? "—"}
                          </span>
                        </td>
                        <td>{p.arrival_date ? fmtShortDate(p.arrival_date * 1000) : "—"}</td>
                        <td>{p.created ? fmtShortDate(p.created * 1000) : "—"}</td>
                        <td className="right">
                          {fmtMoney(p.amount_cents, (p.currency ?? "usd").toUpperCase())}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {/* Recent charges */}
              <div className="pb-section-header" style={{ marginTop: 24 }}>
                <h3 style={{ margin: 0 }}>Recent charges</h3>
                <span className="pb-stat-sub">Last 10 payment events</span>
              </div>
              {stripeSnap.charges.length === 0 ? (
                <div className="pb-empty">No charges yet.</div>
              ) : (
                <table className="pb-table">
                  <thead>
                    <tr>
                      <th>Charge</th>
                      <th>Customer</th>
                      <th>Status</th>
                      <th>Created</th>
                      <th className="right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stripeSnap.charges.map((c) => (
                      <tr key={c.id ?? Math.random()}>
                        <td>
                          <code>{c.id ?? "—"}</code>
                          {c.description && (
                            <>
                              <br />
                              <small style={{ color: "#6b7280" }}>{c.description}</small>
                            </>
                          )}
                        </td>
                        <td>
                          {c.customer_email ?? "—"}
                          {c.customer_name && (
                            <>
                              <br />
                              <small style={{ color: "#6b7280" }}>{c.customer_name}</small>
                            </>
                          )}
                        </td>
                        <td>
                          <span
                            className={`pb-pill ${c.refunded ? "refunded" : c.status ?? ""}`}
                          >
                            {c.refunded ? "refunded" : c.status ?? "—"}
                          </span>
                          {c.receipt_url && (
                            <>
                              {" "}
                              <a
                                href={c.receipt_url}
                                target="_blank"
                                rel="noreferrer"
                                className="pb-link"
                              >
                                receipt
                              </a>
                            </>
                          )}
                        </td>
                        <td>{c.created ? fmtShortDate(c.created * 1000) : "—"}</td>
                        <td className="right">
                          {fmtMoney(c.amount_cents, (c.currency ?? "usd").toUpperCase())}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </section>
      )}

      {tab === "users" && (
        <section className="pb-section">
          <div className="pb-section-header">
            <h2>User payments</h2>
            <span className="pb-stat-sub">Personal accounts and their subscriptions</span>
          </div>
          {userSubs.length === 0 ? (
            <div className="pb-empty">No personal users yet.</div>
          ) : (
            <table className="pb-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Plan</th>
                  <th>Status</th>
                  <th className="right">Price</th>
                  <th className="right">Monthly</th>
                  <th>Renews</th>
                </tr>
              </thead>
              <tbody>
                {userSubs.map((row) => (
                  <tr key={row.user_id}>
                    <td>
                      <strong>{row.email}</strong>
                      {row.username && (
                        <>
                          <br />
                          <small style={{ color: "#6b7280" }}>{row.username}</small>
                        </>
                      )}
                    </td>
                    <td>{row.plan_name ?? row.plan_code ?? "Free"}</td>
                    <td>
                      <span className={`pb-pill ${row.status}`}>{row.status}</span>
                    </td>
                    <td className="right">
                      {row.amount_cents != null
                        ? `${fmtMoney(row.amount_cents, row.currency ?? "USD")}${row.billing_interval ? ` / ${row.billing_interval}` : ""}`
                        : "—"}
                    </td>
                    <td className="right">
                      {fmtMoney(row.monthly_cents, row.currency ?? "USD")}
                    </td>
                    <td>{fmtDate(row.current_period_end)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === "organizations" && (
        <section className="pb-section">
          <div className="pb-section-header">
            <h2>Organization payments</h2>
            <span className="pb-stat-sub">Per-org subscriptions and seat utilisation</span>
          </div>
          {orgSubs.length === 0 ? (
            <div className="pb-empty">No organizations yet.</div>
          ) : (
            <table className="pb-table">
              <thead>
                <tr>
                  <th>Organization</th>
                  <th>Plan</th>
                  <th>Status</th>
                  <th className="right">Seats</th>
                  <th className="right">Monthly</th>
                  <th>Renews</th>
                </tr>
              </thead>
              <tbody>
                {orgSubs.map((row) => (
                  <tr key={row.organization_id}>
                    <td>
                      <strong>{row.name}</strong>
                      {row.slug && (
                        <>
                          <br />
                          <small style={{ color: "#6b7280" }}>{row.slug}</small>
                        </>
                      )}
                    </td>
                    <td>{row.plan_name ?? row.plan_code ?? "Free"}</td>
                    <td>
                      <span className={`pb-pill ${row.status}`}>{row.status}</span>
                    </td>
                    <td className="right">
                      {row.seats_used}
                      {row.seat_limit != null ? ` / ${row.seat_limit}` : ""}
                    </td>
                    <td className="right">
                      {fmtMoney(row.monthly_cents, row.currency ?? "USD")}
                    </td>
                    <td>{fmtDate(row.current_period_end)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === "history" && (
        <section className="pb-section">
          <div className="pb-section-header">
            <h2>Billing history</h2>
            <span className="pb-stat-sub">
              Subscriptions, upgrades and payments across the platform
            </span>
            <input
              type="search"
              className="pb-search"
              placeholder="Search user, org, plan…"
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
              aria-label="Search billing history"
            />
          </div>
          {history.length > 0 && history[0]?.sample && (
            <div className="pb-stat-sub" style={{ marginBottom: 8 }}>
              Showing sample data — no billing events recorded yet.
            </div>
          )}
          {filteredHistory.length === 0 ? (
            <div className="pb-empty">
              {history.length === 0
                ? "No billing activity yet."
                : "No matches for that search."}
            </div>
          ) : (
            <table className="pb-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>User / Org</th>
                  <th>Event</th>
                  <th>Plan</th>
                  <th className="right">Amount paid</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredHistory.map((h, i) => (
                  <tr key={`${h.ts}-${h.user_email ?? h.organization_name}-${i}`}>
                    <td>{fmtDate(h.ts)}</td>
                    <td>{h.user_email ?? h.organization_name ?? "—"}</td>
                    <td>
                      <span className={`pb-pill ${h.event}`}>{h.event}</span>
                    </td>
                    <td>{h.plan_name ?? h.plan_code ?? "—"}</td>
                    <td className="right">
                      {fmtMoney(h.amount_cents, h.currency ?? "USD")}
                    </td>
                    <td>
                      <span className={`pb-pill ${h.status ?? ""}`}>
                        {h.status ?? "—"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === "invoices" && (
        <section className="pb-section">
          <div className="pb-section-header">
            <h2>Recent invoices</h2>
            <span className="pb-stat-sub">Latest 100 invoice events across the platform</span>
          </div>
          {invoices.length === 0 ? (
            <div className="pb-empty">No invoices yet.</div>
          ) : (
            <table className="pb-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Customer</th>
                  <th>Status</th>
                  <th className="right">Paid</th>
                  <th className="right">Due</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id}>
                    <td>{fmtDate(inv.created_at)}</td>
                    <td>
                      {inv.organization_name ?? inv.user_email ?? "—"}
                    </td>
                    <td>
                      <span className={`pb-pill ${inv.status}`}>{inv.status}</span>
                    </td>
                    <td className="right">
                      {fmtMoney(inv.amount_paid_cents, inv.currency ?? "USD")}
                    </td>
                    <td className="right">
                      {fmtMoney(inv.amount_due_cents, inv.currency ?? "USD")}
                    </td>
                    <td>
                      {inv.hosted_invoice_url && (
                        <a href={inv.hosted_invoice_url} target="_blank" rel="noreferrer">
                          View
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === "employees" && (
        <section className="pb-section">
          <div className="pb-section-header">
            <h2>Employees & salaries</h2>
            {canManage && !showEmployeeForm && (
              <button type="button" className="pb-btn" onClick={openEmployeeCreate}>
                + Add employee
              </button>
            )}
          </div>

          {showEmployeeForm && (
            <form className="pb-form" onSubmit={(e) => void saveEmployee(e)}>
              <label>
                Full name
                <input
                  required
                  value={empDraft.full_name}
                  onChange={(e) =>
                    setEmpDraft({ ...empDraft, full_name: e.target.value })
                  }
                />
              </label>
              <label>
                Email
                <input
                  required
                  type="email"
                  value={empDraft.email}
                  onChange={(e) =>
                    setEmpDraft({ ...empDraft, email: e.target.value })
                  }
                />
              </label>
              <label>
                Job title
                <input
                  value={empDraft.job_title ?? ""}
                  onChange={(e) =>
                    setEmpDraft({ ...empDraft, job_title: e.target.value })
                  }
                />
              </label>
              <label>
                Department
                <input
                  value={empDraft.department ?? ""}
                  onChange={(e) =>
                    setEmpDraft({ ...empDraft, department: e.target.value })
                  }
                />
              </label>
              <label>
                Employment type
                <select
                  value={empDraft.employment_type}
                  onChange={(e) =>
                    setEmpDraft({
                      ...empDraft,
                      employment_type: e.target.value as EmploymentType,
                    })
                  }
                >
                  <option value="full_time">Full time</option>
                  <option value="part_time">Part time</option>
                  <option value="contractor">Contractor</option>
                </select>
              </label>
              <label>
                Status
                <select
                  value={empDraft.status}
                  onChange={(e) =>
                    setEmpDraft({
                      ...empDraft,
                      status: e.target.value as EmployeeStatus,
                    })
                  }
                >
                  <option value="active">Active</option>
                  <option value="on_leave">On leave</option>
                  <option value="terminated">Terminated</option>
                </select>
              </label>
              <label>
                Salary (in {empDraft.currency ?? "USD"})
                <input
                  type="number"
                  min={0}
                  step={100}
                  value={(empDraft.base_salary_cents ?? 0) / 100}
                  onChange={(e) =>
                    setEmpDraft({
                      ...empDraft,
                      base_salary_cents: Math.round(
                        Number.parseFloat(e.target.value || "0") * 100,
                      ),
                    })
                  }
                />
              </label>
              <label>
                Pay frequency
                <select
                  value={empDraft.pay_frequency}
                  onChange={(e) =>
                    setEmpDraft({
                      ...empDraft,
                      pay_frequency: e.target.value as PayFrequency,
                    })
                  }
                >
                  <option value="monthly">Monthly</option>
                  <option value="biweekly">Biweekly</option>
                  <option value="weekly">Weekly</option>
                  <option value="annual">Annual</option>
                </select>
              </label>
              <label>
                Currency
                <input
                  value={empDraft.currency ?? "USD"}
                  maxLength={3}
                  onChange={(e) =>
                    setEmpDraft({ ...empDraft, currency: e.target.value.toUpperCase() })
                  }
                />
              </label>
              <label>
                Hire date
                <input
                  type="date"
                  value={empDraft.hire_date ?? ""}
                  onChange={(e) =>
                    setEmpDraft({ ...empDraft, hire_date: e.target.value || null })
                  }
                />
              </label>
              <div className="pb-form-actions">
                <button type="button" className="pb-btn secondary" onClick={closeEmployeeForm}>
                  Cancel
                </button>
                <button type="submit" className="pb-btn" disabled={busy === "save-employee"}>
                  {busy === "save-employee"
                    ? "Saving…"
                    : editingId == null
                      ? "Add employee"
                      : "Save changes"}
                </button>
              </div>
            </form>
          )}

          {employees.length === 0 ? (
            <div className="pb-empty">No employees yet.</div>
          ) : (
            <table className="pb-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Title</th>
                  <th>Dept</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th className="right">Base salary</th>
                  <th className="right">Monthly cost</th>
                  {canManage && <th></th>}
                </tr>
              </thead>
              <tbody>
                {employees.map((emp) => (
                  <tr key={emp.id}>
                    <td>
                      <strong>{emp.full_name}</strong>
                      <br />
                      <small style={{ color: "#6b7280" }}>{emp.email}</small>
                    </td>
                    <td>{emp.job_title ?? "—"}</td>
                    <td>{emp.department ?? "—"}</td>
                    <td>{emp.employment_type.replace("_", " ")}</td>
                    <td>
                      <span className={`pb-pill ${emp.status}`}>{emp.status.replace("_", " ")}</span>
                    </td>
                    <td className="right">
                      {fmtMoney(emp.base_salary_cents, emp.currency)} / {emp.pay_frequency}
                    </td>
                    <td className="right">
                      {fmtMoney(emp.monthly_cost_cents, emp.currency)}
                    </td>
                    {canManage && (
                      <td>
                        <div className="pb-row-actions">
                          <button
                            type="button"
                            className="pb-btn secondary"
                            onClick={() => openEmployeeEdit(emp)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="pb-btn danger"
                            onClick={() => void removeEmployee(emp)}
                            disabled={busy === `delete-employee:${emp.id}`}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === "payroll" && (
        <section className="pb-section">
          <div className="pb-section-header">
            <h2>Payroll runs</h2>
            {canManage && !showPayrollForm && (
              <button type="button" className="pb-btn" onClick={openPayrollForm}>
                + New payroll run
              </button>
            )}
          </div>

          {showPayrollForm && (
            <form className="pb-form" onSubmit={(e) => void runPayroll(e)}>
              <label>
                Period start
                <input
                  required
                  type="date"
                  value={payrollDraft.period_start}
                  onChange={(e) =>
                    setPayrollDraft({ ...payrollDraft, period_start: e.target.value })
                  }
                />
              </label>
              <label>
                Period end
                <input
                  required
                  type="date"
                  value={payrollDraft.period_end}
                  onChange={(e) =>
                    setPayrollDraft({ ...payrollDraft, period_end: e.target.value })
                  }
                />
              </label>
              <label>
                Tax rate (%)
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  value={payrollDraft.tax_rate_pct ?? 20}
                  onChange={(e) =>
                    setPayrollDraft({
                      ...payrollDraft,
                      tax_rate_pct: Number.parseFloat(e.target.value || "0"),
                    })
                  }
                />
              </label>
              <label>
                Notes
                <input
                  value={payrollDraft.notes ?? ""}
                  onChange={(e) =>
                    setPayrollDraft({ ...payrollDraft, notes: e.target.value })
                  }
                />
              </label>
              <div className="pb-form-actions">
                <button
                  type="button"
                  className="pb-btn secondary"
                  onClick={() => setShowPayrollForm(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="pb-btn"
                  disabled={busy === "run-payroll"}
                >
                  {busy === "run-payroll" ? "Generating…" : "Generate run"}
                </button>
              </div>
            </form>
          )}

          {payrollRuns.length === 0 ? (
            <div className="pb-empty">
              No payroll runs yet. Add active employees and generate the first run.
            </div>
          ) : (
            <table className="pb-table">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Status</th>
                  <th className="right">Employees</th>
                  <th className="right">Gross</th>
                  <th className="right">Tax</th>
                  <th className="right">Net</th>
                  <th>Paid at</th>
                  {canManage && <th></th>}
                </tr>
              </thead>
              <tbody>
                {payrollRuns.map((run) => (
                  <tr key={run.id}>
                    <td>
                      {fmtDate(run.period_start)} → {fmtDate(run.period_end)}
                    </td>
                    <td>
                      <span className={`pb-pill ${run.status}`}>{run.status}</span>
                    </td>
                    <td className="right">{run.item_count}</td>
                    <td className="right">{fmtMoney(run.total_gross_cents, run.currency)}</td>
                    <td className="right">{fmtMoney(run.total_tax_cents, run.currency)}</td>
                    <td className="right">{fmtMoney(run.total_net_cents, run.currency)}</td>
                    <td>{fmtDate(run.paid_at)}</td>
                    {canManage && (
                      <td>
                        <div className="pb-row-actions">
                          {run.status === "draft" && (
                            <button
                              type="button"
                              className="pb-btn secondary"
                              onClick={() => void setPayrollStatus(run, "approved")}
                              disabled={busy === `payroll-status:${run.id}`}
                            >
                              Approve
                            </button>
                          )}
                          {(run.status === "draft" || run.status === "approved") && (
                            <button
                              type="button"
                              className="pb-btn"
                              onClick={() => void setPayrollStatus(run, "paid")}
                              disabled={busy === `payroll-status:${run.id}`}
                            >
                              Mark paid
                            </button>
                          )}
                          {run.status !== "cancelled" && run.status !== "paid" && (
                            <button
                              type="button"
                              className="pb-btn danger"
                              onClick={() => void setPayrollStatus(run, "cancelled")}
                              disabled={busy === `payroll-status:${run.id}`}
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="pb-stat">
      <span className="pb-stat-label">{label}</span>
      <span className="pb-stat-value">{value}</span>
      {sub && <span className="pb-stat-sub">{sub}</span>}
    </div>
  );
}
