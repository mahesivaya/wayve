// Platform-admin billing console handlers. Read-only aggregation across the
// whole tenant base (BillingRead) plus payroll CRUD (BillingManage). Every
// route gates on platform scope on top of the permission check — a personal-
// or org-scope user who happens to hold a billing role for their own tenant
// must not see other tenants' revenue.

use crate::prelude::*;
use wayve_security::rbac::{Permission, RoleContext, Scope, require_permission};
use actix_web::{delete, patch, put};
use chrono::{DateTime, NaiveDate, Utc};
use sqlx::Row;
use tracing::instrument;

pub fn routes(cfg: &mut web::ServiceConfig) {
    cfg.service(get_overview)
        .service(list_user_subscriptions)
        .service(list_organization_subscriptions)
        .service(list_recent_invoices)
        .service(list_employees)
        .service(create_employee)
        .service(update_employee)
        .service(delete_employee)
        .service(list_payroll_runs)
        .service(create_payroll_run)
        .service(update_payroll_run_status);
}

async fn gate(
    req: &HttpRequest,
    pool: &PgPool,
    perm: Permission,
) -> std::result::Result<RoleContext, HttpResponse> {
    let ctx = require_permission(req, pool, perm).await?;
    if ctx.scope != Scope::Platform {
        return Err(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Platform scope required"
        })));
    }
    Ok(ctx)
}

// SQL fragment: normalise a subscription's interval to a monthly cents amount.
// Year → /12, week → *52/12, day → *30. Anything else (or NULL) is treated as
// already-monthly. Used by both the overview MRR and the per-row monthly view.
const SUB_MONTHLY_EXPR: &str = r#"
    CASE LOWER(COALESCE(p.billing_interval, 'month'))
        WHEN 'year'  THEN p.amount_cents / 12
        WHEN 'week'  THEN (p.amount_cents * 52) / 12
        WHEN 'day'   THEN p.amount_cents * 30
        ELSE p.amount_cents
    END
"#;

// SQL fragment: normalise an employee's pay frequency to a monthly cost.
const EMP_MONTHLY_EXPR: &str = r#"
    CASE pay_frequency
        WHEN 'monthly'  THEN base_salary_cents
        WHEN 'biweekly' THEN (base_salary_cents * 26) / 12
        WHEN 'weekly'   THEN (base_salary_cents * 52) / 12
        WHEN 'annual'   THEN base_salary_cents / 12
        ELSE base_salary_cents
    END
"#;

// ──────────────────────────────────────────────────────────────────────
// Overview: totals + revenue
// ──────────────────────────────────────────────────────────────────────

#[get("/platform-billing/overview")]
#[instrument(target = "http", skip(req, pool))]
pub async fn get_overview(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    if let Err(resp) = gate(&req, pool.get_ref(), Permission::BillingRead).await {
        return Ok(resp);
    }

    let totals = sqlx::query(
        r#"
        SELECT
          (SELECT COUNT(*) FROM users)::BIGINT AS users_total,
          (SELECT COUNT(*) FROM organizations)::BIGINT AS orgs_total,
          (SELECT COUNT(*) FROM subscriptions
            WHERE status IN ('active','trialing') AND user_id IS NOT NULL)::BIGINT
              AS active_user_subs,
          (SELECT COUNT(*) FROM subscriptions
            WHERE status IN ('active','trialing') AND organization_id IS NOT NULL)::BIGINT
              AS active_org_subs,
          (SELECT COUNT(*) FROM employees WHERE status = 'active')::BIGINT
              AS active_employees,
          (SELECT COUNT(*) FROM employees)::BIGINT AS total_employees
        "#,
    )
    .fetch_one(pool.get_ref())
    .await?;

    let mrr_row = sqlx::query(&format!(
        r#"
        SELECT COALESCE(SUM({SUB_MONTHLY_EXPR}), 0)::BIGINT AS mrr_cents
          FROM subscriptions s
          JOIN plans p ON p.id = s.plan_id
         WHERE s.status IN ('active','trialing')
        "#,
    ))
    .fetch_one(pool.get_ref())
    .await?;

    let paid_30d = sqlx::query(
        r#"
        SELECT COALESCE(SUM(amount_paid_cents), 0)::BIGINT AS paid_cents,
               COUNT(*)::BIGINT AS paid_count
          FROM invoices
         WHERE status = 'paid'
           AND created_at >= NOW() - INTERVAL '30 days'
        "#,
    )
    .fetch_one(pool.get_ref())
    .await?;

    let payroll = sqlx::query(&format!(
        r#"
        SELECT COALESCE(SUM({EMP_MONTHLY_EXPR}), 0)::BIGINT AS monthly_cost_cents
          FROM employees
         WHERE status = 'active'
        "#,
    ))
    .fetch_one(pool.get_ref())
    .await?;

    let mrr_cents: i64 = mrr_row.try_get("mrr_cents").unwrap_or(0);
    let payroll_monthly: i64 = payroll.try_get("monthly_cost_cents").unwrap_or(0);

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "users_total": totals.try_get::<i64, _>("users_total").unwrap_or(0),
        "organizations_total": totals.try_get::<i64, _>("orgs_total").unwrap_or(0),
        "active_user_subscriptions": totals.try_get::<i64, _>("active_user_subs").unwrap_or(0),
        "active_organization_subscriptions": totals.try_get::<i64, _>("active_org_subs").unwrap_or(0),
        "active_employees": totals.try_get::<i64, _>("active_employees").unwrap_or(0),
        "total_employees": totals.try_get::<i64, _>("total_employees").unwrap_or(0),
        "mrr_cents": mrr_cents,
        "arr_cents": mrr_cents * 12,
        "paid_invoices_30d_cents": paid_30d.try_get::<i64, _>("paid_cents").unwrap_or(0),
        "paid_invoices_30d_count": paid_30d.try_get::<i64, _>("paid_count").unwrap_or(0),
        "payroll_monthly_cost_cents": payroll_monthly,
        "payroll_annual_cost_cents": payroll_monthly * 12,
        "currency": "USD",
    })))
}

// ──────────────────────────────────────────────────────────────────────
// Per-user subscriptions
// ──────────────────────────────────────────────────────────────────────

#[get("/platform-billing/user-subscriptions")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_user_subscriptions(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    if let Err(resp) = gate(&req, pool.get_ref(), Permission::BillingRead).await {
        return Ok(resp);
    }

    let rows = sqlx::query(&format!(
        r#"
        SELECT u.id AS user_id, u.email, u.username, u.account_type,
               COALESCE(s.status, 'free') AS status,
               p.code AS plan_code, p.name AS plan_name,
               p.amount_cents, p.currency, p.billing_interval,
               {SUB_MONTHLY_EXPR} AS monthly_cents,
               s.current_period_end, s.cancel_at_period_end
          FROM users u
          LEFT JOIN subscriptions s
                 ON s.user_id = u.id
                AND s.status IN ('active','trialing','past_due')
          LEFT JOIN plans p ON p.id = s.plan_id
         WHERE u.organization_id IS NULL
         ORDER BY (s.id IS NULL), s.updated_at DESC NULLS LAST, u.id DESC
         LIMIT 200
        "#,
    ))
    .fetch_all(pool.get_ref())
    .await?;

    let items: Vec<_> = rows
        .into_iter()
        .map(|row| {
            let period_end: Option<DateTime<Utc>> =
                row.try_get("current_period_end").ok().flatten();
            serde_json::json!({
                "user_id": row.try_get::<i32, _>("user_id").unwrap_or(0),
                "email": row.try_get::<String, _>("email").unwrap_or_default(),
                "username": row.try_get::<Option<String>, _>("username").ok().flatten(),
                "account_type": row.try_get::<String, _>("account_type").unwrap_or_default(),
                "status": row.try_get::<String, _>("status").unwrap_or_default(),
                "plan_code": row.try_get::<Option<String>, _>("plan_code").ok().flatten(),
                "plan_name": row.try_get::<Option<String>, _>("plan_name").ok().flatten(),
                "amount_cents": row.try_get::<Option<i64>, _>("amount_cents").ok().flatten(),
                "monthly_cents": row.try_get::<Option<i64>, _>("monthly_cents").ok().flatten(),
                "currency": row.try_get::<Option<String>, _>("currency").ok().flatten(),
                "billing_interval": row.try_get::<Option<String>, _>("billing_interval").ok().flatten(),
                "current_period_end": period_end,
                "cancel_at_period_end": row.try_get::<Option<bool>, _>("cancel_at_period_end").ok().flatten().unwrap_or(false),
            })
        })
        .collect();
    Ok(HttpResponse::Ok().json(items))
}

// ──────────────────────────────────────────────────────────────────────
// Per-organization subscriptions
// ──────────────────────────────────────────────────────────────────────

#[get("/platform-billing/organization-subscriptions")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_organization_subscriptions(
    req: HttpRequest,
    pool: web::Data<PgPool>,
) -> AppResult {
    if let Err(resp) = gate(&req, pool.get_ref(), Permission::BillingRead).await {
        return Ok(resp);
    }

    let rows = sqlx::query(&format!(
        r#"
        SELECT o.id AS organization_id, o.name, o.slug,
               (SELECT COUNT(*) FROM users WHERE organization_id = o.id)::BIGINT AS seats_used,
               COALESCE(s.status, 'free') AS status,
               p.code AS plan_code, p.name AS plan_name,
               p.amount_cents, p.currency, p.billing_interval,
               p.seat_limit,
               {SUB_MONTHLY_EXPR} AS monthly_cents,
               s.current_period_end, s.cancel_at_period_end
          FROM organizations o
          LEFT JOIN subscriptions s
                 ON s.organization_id = o.id
                AND s.status IN ('active','trialing','past_due')
          LEFT JOIN plans p ON p.id = s.plan_id
         ORDER BY (s.id IS NULL), s.updated_at DESC NULLS LAST, o.id DESC
         LIMIT 200
        "#,
    ))
    .fetch_all(pool.get_ref())
    .await?;

    let items: Vec<_> = rows
        .into_iter()
        .map(|row| {
            let period_end: Option<DateTime<Utc>> =
                row.try_get("current_period_end").ok().flatten();
            serde_json::json!({
                "organization_id": row.try_get::<i32, _>("organization_id").unwrap_or(0),
                "name": row.try_get::<String, _>("name").unwrap_or_default(),
                "slug": row.try_get::<Option<String>, _>("slug").ok().flatten(),
                "seats_used": row.try_get::<i64, _>("seats_used").unwrap_or(0),
                "seat_limit": row.try_get::<Option<i32>, _>("seat_limit").ok().flatten(),
                "status": row.try_get::<String, _>("status").unwrap_or_default(),
                "plan_code": row.try_get::<Option<String>, _>("plan_code").ok().flatten(),
                "plan_name": row.try_get::<Option<String>, _>("plan_name").ok().flatten(),
                "amount_cents": row.try_get::<Option<i64>, _>("amount_cents").ok().flatten(),
                "monthly_cents": row.try_get::<Option<i64>, _>("monthly_cents").ok().flatten(),
                "currency": row.try_get::<Option<String>, _>("currency").ok().flatten(),
                "billing_interval": row.try_get::<Option<String>, _>("billing_interval").ok().flatten(),
                "current_period_end": period_end,
                "cancel_at_period_end": row.try_get::<Option<bool>, _>("cancel_at_period_end").ok().flatten().unwrap_or(false),
            })
        })
        .collect();
    Ok(HttpResponse::Ok().json(items))
}

// ──────────────────────────────────────────────────────────────────────
// Recent invoices
// ──────────────────────────────────────────────────────────────────────

#[get("/platform-billing/invoices")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_recent_invoices(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    if let Err(resp) = gate(&req, pool.get_ref(), Permission::BillingRead).await {
        return Ok(resp);
    }

    let rows = sqlx::query(
        r#"
        SELECT i.id, i.amount_paid_cents, i.amount_due_cents, i.currency,
               i.status, i.created_at, i.hosted_invoice_url,
               bc.user_id, bc.organization_id,
               u.email AS user_email,
               o.name AS organization_name
          FROM invoices i
          LEFT JOIN billing_customers bc ON bc.stripe_customer_id = i.stripe_customer_id
          LEFT JOIN users u ON u.id = bc.user_id
          LEFT JOIN organizations o ON o.id = bc.organization_id
         ORDER BY i.created_at DESC
         LIMIT 100
        "#,
    )
    .fetch_all(pool.get_ref())
    .await?;

    let items: Vec<_> = rows
        .into_iter()
        .map(|row| {
            let created_at: Option<DateTime<Utc>> = row.try_get("created_at").ok();
            serde_json::json!({
                "id": row.try_get::<i32, _>("id").unwrap_or(0),
                "amount_paid_cents": row.try_get::<Option<i64>, _>("amount_paid_cents").ok().flatten(),
                "amount_due_cents": row.try_get::<Option<i64>, _>("amount_due_cents").ok().flatten(),
                "currency": row.try_get::<Option<String>, _>("currency").ok().flatten(),
                "status": row.try_get::<String, _>("status").unwrap_or_default(),
                "created_at": created_at,
                "hosted_invoice_url": row.try_get::<Option<String>, _>("hosted_invoice_url").ok().flatten(),
                "user_email": row.try_get::<Option<String>, _>("user_email").ok().flatten(),
                "organization_name": row.try_get::<Option<String>, _>("organization_name").ok().flatten(),
            })
        })
        .collect();
    Ok(HttpResponse::Ok().json(items))
}

// ──────────────────────────────────────────────────────────────────────
// Employee CRUD
// ──────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct EmployeeInput {
    pub full_name: String,
    pub email: String,
    pub job_title: Option<String>,
    pub department: Option<String>,
    pub employment_type: Option<String>,
    pub status: Option<String>,
    pub base_salary_cents: Option<i64>,
    pub currency: Option<String>,
    pub pay_frequency: Option<String>,
    pub hire_date: Option<NaiveDate>,
}

fn normalize_employment_type(value: Option<&str>) -> &'static str {
    match value.map(str::trim) {
        Some("part_time") => "part_time",
        Some("contractor") => "contractor",
        _ => "full_time",
    }
}

fn normalize_status(value: Option<&str>) -> &'static str {
    match value.map(str::trim) {
        Some("on_leave") => "on_leave",
        Some("terminated") => "terminated",
        _ => "active",
    }
}

fn normalize_pay_frequency(value: Option<&str>) -> &'static str {
    match value.map(str::trim) {
        Some("biweekly") => "biweekly",
        Some("weekly") => "weekly",
        Some("annual") => "annual",
        _ => "monthly",
    }
}

fn employee_json(row: &sqlx::postgres::PgRow) -> serde_json::Value {
    let hire_date: Option<NaiveDate> = row.try_get("hire_date").ok().flatten();
    let created_at: Option<DateTime<Utc>> = row.try_get("created_at").ok();
    serde_json::json!({
        "id": row.try_get::<i32, _>("id").unwrap_or(0),
        "user_id": row.try_get::<Option<i32>, _>("user_id").ok().flatten(),
        "full_name": row.try_get::<String, _>("full_name").unwrap_or_default(),
        "email": row.try_get::<String, _>("email").unwrap_or_default(),
        "job_title": row.try_get::<Option<String>, _>("job_title").ok().flatten(),
        "department": row.try_get::<Option<String>, _>("department").ok().flatten(),
        "employment_type": row.try_get::<String, _>("employment_type").unwrap_or_default(),
        "status": row.try_get::<String, _>("status").unwrap_or_default(),
        "base_salary_cents": row.try_get::<i64, _>("base_salary_cents").unwrap_or(0),
        "currency": row.try_get::<String, _>("currency").unwrap_or_else(|_| "USD".into()),
        "pay_frequency": row.try_get::<String, _>("pay_frequency").unwrap_or_default(),
        "monthly_cost_cents": row.try_get::<Option<i64>, _>("monthly_cost_cents").ok().flatten().unwrap_or(0),
        "hire_date": hire_date,
        "created_at": created_at,
    })
}

#[get("/platform-billing/employees")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_employees(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    if let Err(resp) = gate(&req, pool.get_ref(), Permission::BillingRead).await {
        return Ok(resp);
    }

    let rows = sqlx::query(&format!(
        r#"
        SELECT id, user_id, full_name, email, job_title, department,
               employment_type, status, base_salary_cents, currency,
               pay_frequency, hire_date, created_at,
               {EMP_MONTHLY_EXPR} AS monthly_cost_cents
          FROM employees
         ORDER BY status, department NULLS LAST, full_name
        "#,
    ))
    .fetch_all(pool.get_ref())
    .await?;

    let items: Vec<_> = rows.iter().map(employee_json).collect();
    Ok(HttpResponse::Ok().json(items))
}

#[post("/platform-billing/employees")]
#[instrument(target = "http", skip(req, pool, data))]
pub async fn create_employee(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<EmployeeInput>,
) -> AppResult {
    if let Err(resp) = gate(&req, pool.get_ref(), Permission::BillingManage).await {
        return Ok(resp);
    }

    let full_name = data.full_name.trim();
    let email = data.email.trim().to_lowercase();
    if full_name.is_empty() || email.is_empty() {
        return Err(AppError::BadRequest(
            "full_name and email are required".into(),
        ));
    }
    let employment_type = normalize_employment_type(data.employment_type.as_deref());
    let status = normalize_status(data.status.as_deref());
    let pay_frequency = normalize_pay_frequency(data.pay_frequency.as_deref());
    let base_salary_cents = data.base_salary_cents.unwrap_or(0).max(0);
    let currency = data
        .currency
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("USD")
        .to_uppercase();

    let row = sqlx::query(&format!(
        r#"
        INSERT INTO employees
          (full_name, email, job_title, department, employment_type, status,
           base_salary_cents, currency, pay_frequency, hire_date)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, user_id, full_name, email, job_title, department,
                  employment_type, status, base_salary_cents, currency,
                  pay_frequency, hire_date, created_at,
                  {EMP_MONTHLY_EXPR} AS monthly_cost_cents
        "#,
    ))
    .bind(full_name)
    .bind(&email)
    .bind(data.job_title.as_deref().map(str::trim))
    .bind(data.department.as_deref().map(str::trim))
    .bind(employment_type)
    .bind(status)
    .bind(base_salary_cents)
    .bind(&currency)
    .bind(pay_frequency)
    .bind(data.hire_date)
    .fetch_one(pool.get_ref())
    .await?;

    Ok(HttpResponse::Ok().json(employee_json(&row)))
}

#[put("/platform-billing/employees/{id}")]
#[instrument(target = "http", skip(req, pool, path, data))]
pub async fn update_employee(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    data: web::Json<EmployeeInput>,
) -> AppResult {
    if let Err(resp) = gate(&req, pool.get_ref(), Permission::BillingManage).await {
        return Ok(resp);
    }
    let id = path.into_inner();

    let full_name = data.full_name.trim();
    let email = data.email.trim().to_lowercase();
    if full_name.is_empty() || email.is_empty() {
        return Err(AppError::BadRequest(
            "full_name and email are required".into(),
        ));
    }
    let employment_type = normalize_employment_type(data.employment_type.as_deref());
    let status = normalize_status(data.status.as_deref());
    let pay_frequency = normalize_pay_frequency(data.pay_frequency.as_deref());
    let base_salary_cents = data.base_salary_cents.unwrap_or(0).max(0);
    let currency = data
        .currency
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("USD")
        .to_uppercase();

    let row = sqlx::query(&format!(
        r#"
        UPDATE employees SET
          full_name = $1, email = $2, job_title = $3, department = $4,
          employment_type = $5, status = $6, base_salary_cents = $7,
          currency = $8, pay_frequency = $9, hire_date = $10,
          updated_at = NOW()
        WHERE id = $11
        RETURNING id, user_id, full_name, email, job_title, department,
                  employment_type, status, base_salary_cents, currency,
                  pay_frequency, hire_date, created_at,
                  {EMP_MONTHLY_EXPR} AS monthly_cost_cents
        "#,
    ))
    .bind(full_name)
    .bind(&email)
    .bind(data.job_title.as_deref().map(str::trim))
    .bind(data.department.as_deref().map(str::trim))
    .bind(employment_type)
    .bind(status)
    .bind(base_salary_cents)
    .bind(&currency)
    .bind(pay_frequency)
    .bind(data.hire_date)
    .bind(id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or(AppError::NotFound("employee"))?;

    Ok(HttpResponse::Ok().json(employee_json(&row)))
}

#[delete("/platform-billing/employees/{id}")]
#[instrument(target = "http", skip(req, pool, path))]
pub async fn delete_employee(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    if let Err(resp) = gate(&req, pool.get_ref(), Permission::BillingManage).await {
        return Ok(resp);
    }
    let id = path.into_inner();

    // ON DELETE RESTRICT on payroll_run_items.employee_id intentionally
    // blocks deletion once an employee has been paid — terminating someone
    // is what the `status = 'terminated'` flag is for, not row deletion.
    let result = sqlx::query("DELETE FROM employees WHERE id = $1")
        .bind(id)
        .execute(pool.get_ref())
        .await;

    match result {
        Ok(done) if done.rows_affected() == 0 => Err(AppError::NotFound("employee")),
        Ok(_) => Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true }))),
        Err(sqlx::Error::Database(db_err)) if db_err.constraint().is_some() => {
            Err(AppError::BadRequest(
                "Cannot delete employee with payroll history — set status to 'terminated' instead".into(),
            ))
        }
        Err(e) => Err(AppError::Db(e)),
    }
}

// ──────────────────────────────────────────────────────────────────────
// Payroll runs
// ──────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct PayrollRunInput {
    pub period_start: NaiveDate,
    pub period_end: NaiveDate,
    pub notes: Option<String>,
    /// Tax rate as a percentage (e.g. 20.0 = 20%). Defaults to 20.
    pub tax_rate_pct: Option<f64>,
}

#[derive(Deserialize)]
pub struct PayrollStatusInput {
    pub status: String,
}

fn normalize_payroll_status(value: &str) -> Option<&'static str> {
    match value.trim() {
        "draft" => Some("draft"),
        "approved" => Some("approved"),
        "paid" => Some("paid"),
        "cancelled" => Some("cancelled"),
        _ => None,
    }
}

#[get("/platform-billing/payroll-runs")]
#[instrument(target = "http", skip(req, pool))]
pub async fn list_payroll_runs(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    if let Err(resp) = gate(&req, pool.get_ref(), Permission::BillingRead).await {
        return Ok(resp);
    }

    let rows = sqlx::query(
        r#"
        SELECT r.id, r.period_start, r.period_end, r.status,
               r.total_gross_cents, r.total_tax_cents, r.total_net_cents,
               r.currency, r.notes, r.created_at, r.paid_at,
               (SELECT COUNT(*) FROM payroll_run_items WHERE payroll_run_id = r.id)::BIGINT
                 AS item_count
          FROM payroll_runs r
         ORDER BY r.period_end DESC, r.id DESC
         LIMIT 100
        "#,
    )
    .fetch_all(pool.get_ref())
    .await?;

    let items: Vec<_> = rows
        .into_iter()
        .map(|row| {
            let period_start: Option<NaiveDate> = row.try_get("period_start").ok();
            let period_end: Option<NaiveDate> = row.try_get("period_end").ok();
            let created_at: Option<DateTime<Utc>> = row.try_get("created_at").ok();
            let paid_at: Option<DateTime<Utc>> = row.try_get("paid_at").ok().flatten();
            serde_json::json!({
                "id": row.try_get::<i32, _>("id").unwrap_or(0),
                "period_start": period_start,
                "period_end": period_end,
                "status": row.try_get::<String, _>("status").unwrap_or_default(),
                "total_gross_cents": row.try_get::<i64, _>("total_gross_cents").unwrap_or(0),
                "total_tax_cents": row.try_get::<i64, _>("total_tax_cents").unwrap_or(0),
                "total_net_cents": row.try_get::<i64, _>("total_net_cents").unwrap_or(0),
                "currency": row.try_get::<String, _>("currency").unwrap_or_else(|_| "USD".into()),
                "item_count": row.try_get::<i64, _>("item_count").unwrap_or(0),
                "notes": row.try_get::<Option<String>, _>("notes").ok().flatten(),
                "created_at": created_at,
                "paid_at": paid_at,
            })
        })
        .collect();
    Ok(HttpResponse::Ok().json(items))
}

#[post("/platform-billing/payroll-runs")]
#[instrument(target = "http", skip(req, pool, data))]
pub async fn create_payroll_run(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<PayrollRunInput>,
) -> AppResult {
    let ctx = match gate(&req, pool.get_ref(), Permission::BillingManage).await {
        Ok(ctx) => ctx,
        Err(resp) => return Ok(resp),
    };

    if data.period_end < data.period_start {
        return Err(AppError::BadRequest(
            "period_end must be on or after period_start".into(),
        ));
    }
    let tax_rate = data.tax_rate_pct.unwrap_or(20.0).clamp(0.0, 100.0);

    // Snapshot active employees and their monthly-normalised cost. The same
    // monthly figure becomes this run's gross — a v1 simplification that
    // matches a single monthly pay cycle. A future iteration that supports
    // mid-period hires can prorate from hire_date here.
    let employees = sqlx::query(&format!(
        r#"
        SELECT id, full_name, {EMP_MONTHLY_EXPR} AS monthly_cost_cents
          FROM employees
         WHERE status = 'active'
        "#,
    ))
    .fetch_all(pool.get_ref())
    .await?;

    if employees.is_empty() {
        return Err(AppError::BadRequest(
            "No active employees to include in payroll".into(),
        ));
    }

    let mut tx = pool.begin().await?;

    let run_row = sqlx::query(
        r#"
        INSERT INTO payroll_runs (period_start, period_end, notes, created_by)
        VALUES ($1, $2, $3, $4)
        RETURNING id
        "#,
    )
    .bind(data.period_start)
    .bind(data.period_end)
    .bind(data.notes.as_deref().map(str::trim))
    .bind(ctx.user_id)
    .fetch_one(&mut *tx)
    .await?;
    let run_id: i32 = run_row.get("id");

    let mut total_gross: i64 = 0;
    let mut total_tax: i64 = 0;
    for emp in &employees {
        let employee_id: i32 = emp.try_get("id").unwrap_or(0);
        let name: String = emp.try_get("full_name").unwrap_or_default();
        let gross: i64 = emp.try_get("monthly_cost_cents").unwrap_or(0);
        let tax = ((gross as f64) * (tax_rate / 100.0)).round() as i64;
        let net = gross - tax;
        total_gross += gross;
        total_tax += tax;

        sqlx::query(
            r#"
            INSERT INTO payroll_run_items
              (payroll_run_id, employee_id, employee_name, gross_cents, tax_cents, net_cents)
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(run_id)
        .bind(employee_id)
        .bind(&name)
        .bind(gross)
        .bind(tax)
        .bind(net)
        .execute(&mut *tx)
        .await?;
    }
    let total_net = total_gross - total_tax;

    sqlx::query(
        r#"
        UPDATE payroll_runs
           SET total_gross_cents = $1, total_tax_cents = $2, total_net_cents = $3
         WHERE id = $4
        "#,
    )
    .bind(total_gross)
    .bind(total_tax)
    .bind(total_net)
    .bind(run_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "id": run_id,
        "period_start": data.period_start,
        "period_end": data.period_end,
        "status": "draft",
        "total_gross_cents": total_gross,
        "total_tax_cents": total_tax,
        "total_net_cents": total_net,
        "item_count": employees.len() as i64,
    })))
}

#[patch("/platform-billing/payroll-runs/{id}")]
#[instrument(target = "http", skip(req, pool, path, data))]
pub async fn update_payroll_run_status(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
    data: web::Json<PayrollStatusInput>,
) -> AppResult {
    if let Err(resp) = gate(&req, pool.get_ref(), Permission::BillingManage).await {
        return Ok(resp);
    }
    let id = path.into_inner();
    let next_status = normalize_payroll_status(&data.status)
        .ok_or_else(|| AppError::BadRequest("Unknown payroll status".into()))?;

    // paid_at is stamped on first transition to 'paid'. Re-saving a status
    // that's already 'paid' is a no-op for paid_at to keep audit history.
    let row = sqlx::query(
        r#"
        UPDATE payroll_runs SET
          status = $1,
          paid_at = CASE
            WHEN $1 = 'paid' AND paid_at IS NULL THEN NOW()
            WHEN $1 = 'paid' THEN paid_at
            ELSE NULL
          END
        WHERE id = $2
        RETURNING id, status, paid_at
        "#,
    )
    .bind(next_status)
    .bind(id)
    .fetch_optional(pool.get_ref())
    .await?
    .ok_or(AppError::NotFound("payroll run"))?;

    let paid_at: Option<DateTime<Utc>> = row.try_get("paid_at").ok().flatten();
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "id": row.try_get::<i32, _>("id").unwrap_or(0),
        "status": row.try_get::<String, _>("status").unwrap_or_default(),
        "paid_at": paid_at,
    })))
}
