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
    "/api/platform-billing/user-subscriptions",
  );

export const listOrganizationSubscriptions = () =>
  apiFetchJson<OrganizationSubscriptionRow[]>(
    "/api/platform-billing/organization-subscriptions",
  );

export const listPlatformInvoices = () =>
  apiFetchJson<PlatformInvoiceRow[]>("/api/platform-billing/invoices");

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
  status: PayrollRun["status"],
) =>
  apiFetchJson<{ id: number; status: string; paid_at: string | null }>(
    `/api/platform-billing/payroll-runs/${id}`,
    { method: "PATCH", body: JSON.stringify({ status }) },
  );
