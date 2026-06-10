import { apiFetch, apiFetchJson } from "./client";

export type PlatformBillingOverview = {
  users_total: number;
  organizations_total: number;
  active_user_subscriptions: number;
  active_organization_subscriptions: number;
  active_employees: number;
  total_employees: number;
  mrr_cents: number;
  arr_cents: number;
  paid_invoices_30d_cents: number;
  paid_invoices_30d_count: number;
  payroll_monthly_cost_cents: number;
  payroll_annual_cost_cents: number;
  currency: string;
};

export type UserSubscriptionRow = {
  user_id: number;
  email: string;
  username: string | null;
  account_type: string;
  status: string;
  plan_code: string | null;
  plan_name: string | null;
  amount_cents: number | null;
  monthly_cents: number | null;
  currency: string | null;
  billing_interval: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
};

export type OrganizationSubscriptionRow = {
  organization_id: number;
  name: string;
  slug: string | null;
  seats_used: number;
  seat_limit: number | null;
  status: string;
  plan_code: string | null;
  plan_name: string | null;
  amount_cents: number | null;
  monthly_cents: number | null;
  currency: string | null;
  billing_interval: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
};

export type PlatformInvoiceRow = {
  id: number;
  amount_paid_cents: number | null;
  amount_due_cents: number | null;
  currency: string | null;
  status: string;
  created_at: string | null;
  hosted_invoice_url: string | null;
  user_email: string | null;
  organization_name: string | null;
};

// A single billing activity event for the History timeline. `sample` is true
// for the illustrative fallback rows the backend returns when no real billing
// data exists yet.
export type BillingHistoryRow = {
  ts: string | null;
  event: "payment" | "subscribed" | "upgraded" | string;
  user_email: string | null;
  organization_name: string | null;
  plan_name: string | null;
  plan_code: string | null;
  amount_cents: number | null;
  currency: string | null;
  status: string | null;
  sample?: boolean;
};

export type EmploymentType = "full_time" | "part_time" | "contractor";
export type EmployeeStatus = "active" | "on_leave" | "terminated";
export type PayFrequency = "monthly" | "biweekly" | "weekly" | "annual";

export type Employee = {
  id: number;
  user_id: number | null;
  full_name: string;
  email: string;
  job_title: string | null;
  department: string | null;
  employment_type: EmploymentType;
  status: EmployeeStatus;
  base_salary_cents: number;
  currency: string;
  pay_frequency: PayFrequency;
  monthly_cost_cents: number;
  hire_date: string | null;
  created_at: string | null;
};

export type EmployeeInput = {
  full_name: string;
  email: string;
  job_title?: string | null;
  department?: string | null;
  employment_type?: EmploymentType;
  status?: EmployeeStatus;
  base_salary_cents?: number;
  currency?: string;
  pay_frequency?: PayFrequency;
  hire_date?: string | null;
};

export type PayrollRun = {
  id: number;
  period_start: string | null;
  period_end: string | null;
  status: "draft" | "approved" | "paid" | "cancelled";
  total_gross_cents: number;
  total_tax_cents: number;
  total_net_cents: number;
  currency: string;
  item_count: number;
  notes: string | null;
  created_at: string | null;
  paid_at: string | null;
};

export type PayrollRunInput = {
  period_start: string;
  period_end: string;
  notes?: string | null;
  tax_rate_pct?: number;
};

// ---- HTTP --------------------------------------------------------------

export const getPlatformBillingOverview = () =>
  apiFetchJson<PlatformBillingOverview>("/api/platform-billing/overview");

export const listUserSubscriptions = () =>
  apiFetchJson<UserSubscriptionRow[]>(
    "/api/platform-billing/user-subscriptions"
  );

export const listOrganizationSubscriptions = () =>
  apiFetchJson<OrganizationSubscriptionRow[]>(
    "/api/platform-billing/organization-subscriptions"
  );

export const listPlatformInvoices = () =>
  apiFetchJson<PlatformInvoiceRow[]>("/api/platform-billing/invoices");

export const listBillingHistory = (limit = 200) =>
  apiFetchJson<BillingHistoryRow[]>(
    `/api/platform-billing/history?limit=${limit}`
  );

export const listEmployees = () =>
  apiFetchJson<Employee[]>("/api/platform-billing/employees");

export const createEmployee = (input: EmployeeInput) =>
  apiFetchJson<Employee>("/api/platform-billing/employees", {
    method: "POST",
    body: JSON.stringify(input),
  });

export const updateEmployee = (id: number, input: EmployeeInput) =>
  apiFetchJson<Employee>(`/api/platform-billing/employees/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });

export const deleteEmployee = (id: number) =>
  apiFetch(`/api/platform-billing/employees/${id}`, { method: "DELETE" });

export const listPayrollRuns = () =>
  apiFetchJson<PayrollRun[]>("/api/platform-billing/payroll-runs");

export const createPayrollRun = (input: PayrollRunInput) =>
  apiFetchJson<PayrollRun>("/api/platform-billing/payroll-runs", {
    method: "POST",
    body: JSON.stringify(input),
  });

export const updatePayrollRunStatus = (
  id: number,
  status: PayrollRun["status"]
) =>
  apiFetchJson<{ id: number; status: string; paid_at: string | null }>(
    `/api/platform-billing/payroll-runs/${id}`,
    { method: "PATCH", body: JSON.stringify({ status }) }
  );

// ── Live Stripe account snapshot ─────────────────────────────────────
// Calls Stripe's REST API directly server-side (balance, payouts,
// charges, balance_transactions) and projects the responses into a
// small, stable JSON shape. Returns `configured: false` when the
// environment has no STRIPE_SECRET_KEY (so the UI can render a stub).

export type StripeBalanceAmount = {
  amount: number;
  currency: string;
};

export type StripePayoutRow = {
  id: string | null;
  amount_cents: number | null;
  currency: string | null;
  status: string | null;
  arrival_date: number | null;
  created: number | null;
  type: string | null;
  description: string | null;
};

export type StripeChargeRow = {
  id: string | null;
  amount_cents: number | null;
  currency: string | null;
  status: string | null;
  paid: boolean | null;
  refunded: boolean | null;
  created: number | null;
  description: string | null;
  receipt_url: string | null;
  customer_email: string | null;
  customer_name: string | null;
};

export type StripeSnapshot =
  | {
      configured: false;
      message: string;
    }
  | {
      configured: true;
      test_mode: boolean;
      balance: {
        pending: StripeBalanceAmount[];
        available: StripeBalanceAmount[];
      };
      payouts: StripePayoutRow[];
      charges: StripeChargeRow[];
      last_30d: {
        gross_cents: number;
        fees_cents: number;
        net_cents: number;
        transaction_count: number;
        currency: string;
      };
    };

export const getStripeSnapshot = () =>
  apiFetchJson<StripeSnapshot>("/api/platform-billing/provider-snapshot");
