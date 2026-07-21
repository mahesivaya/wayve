//! Organization + user provisioning endpoints (platform-admin and self-serve):
//! `/admin/organizations`, `/organizations`, `/organizations/me`,
//! `/admin/users`.

use super::shared::{
    default_role_for_account_type, invalidate_profile_cache, normalized_account_type,
};
use crate::billing::entitlements::{effective_entitlements, refresh_entitlements};
use crate::billing::models::BillingOwner;
use crate::billing::provider;
use crate::email::profile::invalidate_me_cache;
use crate::organization;
use crate::prelude::*;
use crate::routes::auth::{CODE_TTL_MINUTES, MAX_VERIFY_ATTEMPTS, random_code};
use actix_web::{delete, patch};
use tracing::{error, info, instrument, warn};
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::password::hash_password;
use wayve_security::rbac::{self, Permission, Role, Scope};

#[derive(Deserialize)]
pub struct AdminCreateUserInput {
    /// Omitted for the email-only admin flow: derived from the email local-part,
    /// with a server-generated password returned once as `temp_password`.
    #[serde(default)]
    pub username: Option<String>,
    pub email: String,
    #[serde(default)]
    pub password: Option<String>,
    pub account_type: Option<String>,
    pub organization_name: Option<String>,
    /// Role override. The DB CHECK constraint on the members tables is the final
    /// filter for invalid strings.
    #[serde(default)]
    pub role: Option<String>,
    /// The 6-digit code mailed by `/admin/users/send-code`. An absent or wrong
    /// code is rejected before anything is written.
    #[serde(default)]
    pub verification_code: Option<String>,
}

#[derive(Deserialize)]
pub struct CreateOrganizationInput {
    pub name: String,
    /// Optional organization admin to provision together with the organization. When
    /// any of the three fields is supplied, all three are required.
    pub admin_username: Option<String>,
    pub admin_email: Option<String>,
    pub admin_password: Option<String>,
    /// `"enterprise"` attaches an active enterprise subscription in the same
    /// transaction so the org is enterprise-tier at once.
    #[serde(default)]
    pub tier: Option<String>,
}

/// Require platform-scope staff holding `members:manage`, the gate for
/// platform-only actions such as provisioning organizations.
async fn require_platform_admin(req: &HttpRequest, pool: &PgPool) -> Result<i32, HttpResponse> {
    let ctx = rbac::require_permission(req, pool, Permission::MembersManage).await?;
    if ctx.scope != Scope::Platform {
        return Err(HttpResponse::Forbidden()
            .json(serde_json::json!({ "message": "Platform staff access required" })));
    }
    Ok(ctx.user_id)
}

#[get("/admin/organizations")]
#[instrument(target = "http", skip(req, pool))]
pub async fn admin_list_organizations(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let list_ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::MembersRead)
        .await
    {
        Ok(ctx) => Ok(ctx),
        Err(_) => rbac::require_permission(&req, pool.get_ref(), Permission::ApiKeysManage).await,
    };

    match list_ctx {
        Ok(ctx) if ctx.scope == Scope::Platform => {}
        Ok(_) => {
            return Ok(HttpResponse::Forbidden()
                .json(serde_json::json!({ "message": "Platform staff access required" })));
        }
        Err(response) => return Ok(response),
    }

    // This platform-staff query SUMs storage across all orgs, so it needs the RLS
    // bypass GUC for the RLS-enabled `notes`.
    let mut tx = pool.begin().await?;
    crate::db::apply_rls_bypass(&mut tx).await?;
    let rows = sqlx::query(
        r#"
        SELECT
            o.id,
            o.name,
            o.slug,
            o.created_at,
            COUNT(u.id) AS user_count,
            (SELECT COUNT(*)::BIGINT FROM email_accounts ea
             JOIN users eu ON eu.id = ea.user_id
             WHERE eu.organization_id = o.id) AS email_account_count,
            (
              (SELECT COALESCE(SUM(f.size), 0)::BIGINT FROM drive_files f
               JOIN users fu ON fu.id = f.user_id WHERE fu.organization_id = o.id)
            + (SELECT COALESCE(SUM(octet_length(e.body_encrypted)), 0)::BIGINT FROM emails e
               JOIN email_accounts ea ON ea.id = e.account_id
               JOIN users eu ON eu.id = ea.user_id WHERE eu.organization_id = o.id)
            + (SELECT COALESCE(SUM(octet_length(m.content_encrypted)), 0)::BIGINT FROM messages m
               JOIN users mu ON mu.id = m.sender_id WHERE mu.organization_id = o.id)
            + (SELECT COALESCE(SUM(octet_length(coalesce(n.content_encrypted, n.content, ''))), 0)::BIGINT FROM notes n
               JOIN users nu ON nu.id = n.user_id WHERE nu.organization_id = o.id)
            )::BIGINT AS storage_used_bytes,
            (SELECT json_build_object('id', u2.id, 'email', u2.email)
             FROM users u2
             WHERE u2.organization_id = o.id AND u2.account_type = 'organization_admin'
             LIMIT 1) as admin,
            sub.plan_code AS plan_code,
            sub.tier AS tier
        FROM organizations o
        LEFT JOIN users u ON u.organization_id = o.id
        -- The org's active subscription plan, if any, so the platform UI can
        -- split Business from Enterprise. No active sub → plan_code/tier NULL.
        LEFT JOIN LATERAL (
            SELECT p.code AS plan_code, p.tier AS tier
            FROM subscriptions s
            JOIN plans p ON p.id = s.plan_id
            WHERE s.organization_id = o.id AND s.status = 'active'
            ORDER BY s.id DESC
            LIMIT 1
        ) sub ON true
        GROUP BY o.id, o.name, o.slug, o.created_at, sub.plan_code, sub.tier
        ORDER BY o.name
        "#,
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;

    let organizations: Vec<_> = rows
        .into_iter()
        .map(|row| {
            let id: i32 = row.get("id");
            let name: String = row.get("name");
            let slug: Option<String> = row.get("slug");
            let user_count: i64 = row.get("user_count");
            let email_account_count: i64 = row.try_get("email_account_count").unwrap_or(0);
            let storage_used_bytes: i64 = row.try_get("storage_used_bytes").unwrap_or(0);
            let created_at: Option<chrono::NaiveDateTime> =
                row.try_get("created_at").unwrap_or(None);
            let admin: Option<serde_json::Value> = row.get("admin");
            let plan_code: Option<String> = row.try_get("plan_code").unwrap_or(None);
            // No active subscription means no tier, so "none" keeps the org
            // visible on the Business page, which filters tier != enterprise.
            let tier: String = row
                .try_get::<Option<String>, _>("tier")
                .unwrap_or(None)
                .unwrap_or_else(|| "none".to_string());

            serde_json::json!({
                "id": id,
                "name": name,
                "slug": slug,
                "user_count": user_count,
                "email_account_count": email_account_count,
                "storage_used_bytes": storage_used_bytes,
                "created_at": created_at,
                "admin": admin,
                "plan_code": plan_code,
                "tier": tier
            })
        })
        .collect();

    Ok(HttpResponse::Ok().json(organizations))
}

#[post("/admin/organizations")]
#[instrument(target = "auth", skip(req, pool, data), fields(name = %data.name))]
pub async fn admin_create_organization(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<CreateOrganizationInput>,
) -> AppResult {
    let admin_id = match require_platform_admin(&req, pool.get_ref()).await {
        Ok(id) => id,
        Err(response) => return Ok(response),
    };

    let name = data.name.trim();
    if name.is_empty() {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Organization name is required" })));
    }

    let admin_username = data
        .admin_username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let admin_email = data
        .admin_email
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase);
    let admin_password = data
        .admin_password
        .as_deref()
        .filter(|value| !value.is_empty());

    let organization_admin =
        if admin_username.is_some() || admin_email.is_some() || admin_password.is_some() {
            match (admin_username, admin_email.as_deref(), admin_password) {
                (Some(username), Some(email), Some(password)) => {
                    if password.len() < 6 {
                        return Ok(HttpResponse::BadRequest().json(serde_json::json!({
                            "message": "Password must be at least 6 characters"
                        })));
                    }
                    Some((
                        username.to_string(),
                        email.to_string(),
                        password.to_string(),
                    ))
                }
                _ => {
                    return Ok(HttpResponse::BadRequest().json(serde_json::json!({
                    "message": "Organization admin username, email, and password are all required"
                })));
                }
            }
        } else {
            None
        };

    let mut tx = pool.begin().await?;

    // The slug expression must stay in sync with the init.sql backfill. A name
    // conflict heals a missing slug but never overwrites one, so slugs are stable.
    let org_row = match sqlx::query(
        r#"
        INSERT INTO organizations (name, slug)
        VALUES ($1, lower(regexp_replace($1, '[^a-zA-Z0-9]+', '', 'g')))
        ON CONFLICT (name) DO UPDATE
            SET slug = COALESCE(organizations.slug, EXCLUDED.slug)
        RETURNING id, name, slug
        "#,
    )
    .bind(name)
    .fetch_one(&mut *tx)
    .await
    {
        Ok(row) => row,
        Err(e) => {
            if e.to_string().contains("duplicate key") {
                return Ok(HttpResponse::Conflict().json(serde_json::json!({
                    "message": "Another organization already uses that URL slug"
                })));
            }
            return Err(AppError::Db(e));
        }
    };

    let organization_id: i32 = org_row.get("id");
    let organization_name: String = org_row.get("name");
    let organization_slug: Option<String> = org_row.get("slug");

    let mut admin_json = serde_json::Value::Null;

    if let Some((username, email, password)) = organization_admin {
        let hashed = hash_password(&password).await?;

        // The plaintext private key never leaves this blocking task: it is wrapped
        // under PBKDF2(password) and zeroed before it returns. There is no org-escrow
        // wrap yet — the owner bootstraps the org master key on first login.
        let password_for_gen = password.clone();
        let provisioned = tokio::task::spawn_blocking(move || {
            wayve_security::encryption::provision_org_owner_keypair(&password_for_gen)
        })
        .await
        .map_err(|e| AppError::Internal(format!("owner keypair spawn_blocking failed: {e}")))?
        .map_err(|e| AppError::Internal(format!("org owner keypair provisioning failed: {e}")))?;

        match sqlx::query(
            r#"
            INSERT INTO users (username, email, password, auth_provider, account_type, organization_id, public_key)
            VALUES ($1, $2, $3, 'local', $4, $5, $6)
            RETURNING id, username, email, account_type, organization_id
            "#,
        )
        .bind(&username)
        .bind(&email)
        .bind(&hashed)
        .bind("organization_admin")
        .bind(organization_id)
        .bind(&provisioned.public_key_json)
        .fetch_one(&mut *tx)
        .await
        {
            Ok(row) => {
                let id: i32 = row.get("id");
                let username: Option<String> = row.try_get("username").ok();
                let email: String = row.get("email");
                let account_type: String = row.get("account_type");
                let org_id: Option<i32> = row.try_get("organization_id").ok().flatten();
                admin_json = serde_json::json!({
                    "id": id,
                    "username": username,
                    "email": email,
                    "account_type": account_type,
                    "organization_id": org_id
                });

                sqlx::query(
                    r#"
                    INSERT INTO organization_members (organization_id, user_id, role)
                    VALUES ($1, $2, 'owner')
                    ON CONFLICT (organization_id, user_id) DO UPDATE
                    SET role = EXCLUDED.role, updated_at = NOW()
                    "#,
                )
                .bind(organization_id)
                .bind(id)
                .execute(&mut *tx)
                .await?;

                // The login response carries this `login_wrap`, and the frontend
                // derives PBKDF2(password) to unwrap it into IndexedDB.
                sqlx::query(
                    "INSERT INTO member_login_wrapped_keys (user_id, iv, ct, salt, iterations)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (user_id) DO UPDATE
                     SET iv = EXCLUDED.iv,
                         ct = EXCLUDED.ct,
                         salt = EXCLUDED.salt,
                         iterations = EXCLUDED.iterations,
                         updated_at = NOW()",
                )
                .bind(id)
                .bind(&provisioned.login_wrap.iv_b64)
                .bind(&provisioned.login_wrap.ct_b64)
                .bind(&provisioned.login_wrap.salt_b64)
                .bind(provisioned.login_wrap.iterations as i32)
                .execute(&mut *tx)
                .await?;
            }
            Err(e) => {
                if e.to_string().contains("duplicate key") {
                    return Ok(HttpResponse::Conflict().json(serde_json::json!({
                        "message": "A user with that username or email already exists"
                    })));
                }
                return Err(AppError::Db(e));
            }
        }
    }

    let make_enterprise = data.tier.as_deref() == Some("enterprise");
    if make_enterprise {
        let plan_id: Option<i32> =
            sqlx::query_scalar("SELECT id FROM plans WHERE code = 'enterprise'")
                .fetch_optional(&mut *tx)
                .await?;
        let Some(plan_id) = plan_id else {
            return Err(AppError::Internal(
                "enterprise plan missing from plans table".into(),
            ));
        };
        sqlx::query(
            "INSERT INTO subscriptions (organization_id, plan_id, status) VALUES ($1, $2, 'active')",
        )
        .bind(organization_id)
        .bind(plan_id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    // Post-commit so the refresh sees the committed subscription row. Best-effort.
    if make_enterprise
        && let Err(e) =
            refresh_entitlements(pool.get_ref(), BillingOwner::Organization(organization_id)).await
    {
        error!(target: "auth", organization_id, error = %e, "enterprise entitlement refresh failed");
    }

    let user_count = if admin_json.is_null() { 0 } else { 1 };
    info!(target: "auth", admin_id, organization_id, "platform admin created organization");
    Ok(HttpResponse::Created().json(serde_json::json!({
        "id": organization_id,
        "name": organization_name,
        "slug": organization_slug,
        "user_count": user_count,
        "tier": if make_enterprise { Some("enterprise") } else { None::<&str> },
        "admin": admin_json
    })))
}

// Starter headroom seeded at org creation, so a new org can add members before
// refresh_entitlements() materializes its subscription's seat_limit. The basic_user
// baseline grants one seat, which would block the owner from inviting anybody.
const STARTER_SEAT_LIMIT: i32 = 100;
const STARTER_STORAGE_BYTES: i64 = 1_073_741_824; // 1 GiB

/// Insert the `organizations` row, promote the user to `organization_admin` + owner
/// member, and seed the starter entitlement, all in the caller's transaction.
/// Returns `Ok(None)` on a name conflict so the caller can 409 and roll back.
pub(crate) async fn create_org_for_user(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: i32,
    name: &str,
    place: Option<&str>,
    admin_email: Option<&str>,
) -> std::result::Result<Option<i32>, AppError> {
    let org_row = match sqlx::query(
        r#"
        INSERT INTO organizations (name, slug, place, admin_email)
        VALUES (
            $1,
            lower(regexp_replace($1, '[^a-zA-Z0-9]+', '', 'g')),
            $2,
            $3
        )
        RETURNING id, name, slug, place
        "#,
    )
    .bind(name)
    .bind(place)
    .bind(admin_email)
    .fetch_one(&mut **tx)
    .await
    {
        Ok(row) => row,
        Err(e) => {
            if e.to_string().contains("duplicate key") {
                return Ok(None);
            }
            return Err(AppError::Db(e));
        }
    };

    let organization_id: i32 = org_row.get("id");

    sqlx::query(
        r#"
        UPDATE users
           SET account_type = 'organization_admin',
               organization_id = $1
         WHERE id = $2
        "#,
    )
    .bind(organization_id)
    .bind(user_id)
    .execute(&mut **tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO organization_members (organization_id, user_id, role)
        VALUES ($1, $2, 'owner')
        ON CONFLICT (organization_id, user_id) DO UPDATE
        SET role = EXCLUDED.role, updated_at = NOW()
        "#,
    )
    .bind(organization_id)
    .bind(user_id)
    .execute(&mut **tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO entitlements
            (organization_id, plan_code, storage_limit_bytes,
             seat_limit, features, active)
        VALUES ($1, 'basic_user', $2, $3, '{}'::jsonb, false)
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(organization_id)
    .bind(STARTER_STORAGE_BYTES)
    .bind(STARTER_SEAT_LIMIT)
    .execute(&mut **tx)
    .await?;

    Ok(Some(organization_id))
}

/// Create the organization for a *paid* pending signup. Idempotent and
/// concurrency-safe (FOR UPDATE on the pending row), so the client confirm and
/// the Stripe webhook can both call it. Returns `Ok(None)` on a name conflict.
/// Callers MUST have verified the subscription is paid first.
pub(crate) async fn finalize_org_signup_inner(
    pool: &PgPool,
    pending_id: i32,
) -> std::result::Result<Option<i32>, AppError> {
    let mut tx = pool.begin().await?;

    let pending = sqlx::query_as::<
        _,
        (
            i32,
            String,
            Option<String>,
            Option<String>,
            String,
            String,
            Option<String>,
            String,
            Option<i32>,
        ),
    >(
        "SELECT user_id, name, place, admin_email, plan_code, stripe_customer_id, \
                stripe_subscription_id, status, organization_id \
         FROM pending_org_signups WHERE id = $1 FOR UPDATE",
    )
    .bind(pending_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some((
        owner_id,
        name,
        place,
        admin_email,
        plan_code,
        stripe_customer_id,
        stripe_subscription_id,
        status,
        organization_id,
    )) = pending
    else {
        return Ok(None);
    };

    // Already done by a racing caller (client confirm vs webhook).
    if status == "finalized" {
        tx.commit().await?;
        return Ok(organization_id);
    }

    let created = match create_org_for_user(
        &mut tx,
        owner_id,
        &name,
        place.as_deref(),
        admin_email.as_deref(),
    )
    .await?
    {
        Some(id) => id,
        None => {
            // Name taken between intent and finalize. The caller turns this into
            // a 409 and the charge is refunded out of band.
            sqlx::query("UPDATE pending_org_signups SET status = 'failed' WHERE id = $1")
                .bind(pending_id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            return Ok(None);
        }
    };
    let org_id = created;

    // Link the founder's Stripe customer to the org so org-scoped billing
    // (portal, plan changes) resolves the same customer.
    sqlx::query(
        "INSERT INTO billing_customers (organization_id, stripe_customer_id) \
         VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(org_id)
    .bind(&stripe_customer_id)
    .execute(&mut *tx)
    .await?;

    let plan_id: Option<i32> = sqlx::query_scalar("SELECT id FROM plans WHERE code = $1")
        .bind(&plan_code)
        .fetch_optional(&mut *tx)
        .await?;

    if let Some(sub_id) = stripe_subscription_id.filter(|s| !s.is_empty()) {
        sqlx::query(
            r#"
            INSERT INTO subscriptions
                (organization_id, plan_id, stripe_subscription_id, stripe_customer_id, status)
            VALUES ($1, $2, $3, $4, 'active')
            ON CONFLICT (stripe_subscription_id) DO UPDATE SET
                status = 'active',
                organization_id = EXCLUDED.organization_id,
                plan_id = EXCLUDED.plan_id,
                stripe_customer_id = EXCLUDED.stripe_customer_id,
                updated_at = NOW()
            "#,
        )
        .bind(org_id)
        .bind(plan_id)
        .bind(&sub_id)
        .bind(&stripe_customer_id)
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query(
        "UPDATE pending_org_signups SET status = 'finalized', organization_id = $1 WHERE id = $2",
    )
    .bind(org_id)
    .bind(pending_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    refresh_entitlements(pool, BillingOwner::Organization(org_id))
        .await
        .map_err(|e| AppError::Internal(format!("entitlement refresh failed: {e}")))?;
    invalidate_profile_cache(owner_id).await;
    invalidate_me_cache(owner_id).await;
    rbac::invalidate_role_context(owner_id).await;

    Ok(Some(org_id))
}

/// Self-serve org teardown: in one transaction, the owner deletes the organization
/// and every invitee account they provisioned, and reverts to personal. Refuses
/// while an active subscription exists, so no zombie Stripe customer keeps charging
/// a user whose org no longer exists locally.
#[delete("/organizations/me")]
#[instrument(target = "auth", skip(req, pool))]
pub async fn delete_my_organization(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => {
            return Ok(HttpResponse::Unauthorized()
                .json(serde_json::json!({ "message": "Authentication required" })));
        }
    };

    // Scope and role are computed from the DB per request, never trusted from the
    // JWT, so a role change takes effect on the next request. Only an org owner in
    // admin mode may tear down the org; a normal-mode owner is downscoped to member.
    let ctx = match rbac::resolve_role_context_moded(&req, pool.get_ref(), user_id).await {
        Ok(ctx) => ctx,
        Err(sqlx::Error::RowNotFound) => {
            return Ok(HttpResponse::Unauthorized()
                .json(serde_json::json!({ "message": "Account not found" })));
        }
        Err(e) => return Err(AppError::Db(e)),
    };
    if ctx.scope != Scope::Organization {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Only an organization owner can delete an organization"
        })));
    }
    if ctx.role != Role::Owner {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Only the organization owner can delete it"
        })));
    }
    let organization_id = match ctx.organization_id {
        Some(id) => id,
        None => {
            return Ok(HttpResponse::Conflict().json(serde_json::json!({
                "message": "Your account is not bound to an organization"
            })));
        }
    };

    // Deleting never silently kills billing: the owner must already have set
    // cancel_at_period_end on the Billing page. Given that, cancel in Stripe
    // immediately — the local row is about to be cascade-deleted, and running to
    // period end would orphan the charge.
    let active_sub: Option<(i32, Option<String>, bool)> = sqlx::query_as(
        r#"
        SELECT id, stripe_subscription_id, cancel_at_period_end
          FROM subscriptions
         WHERE organization_id = $1
           AND status IN ('active', 'trialing')
         LIMIT 1
        "#,
    )
    .bind(organization_id)
    .fetch_optional(pool.get_ref())
    .await?;

    if let Some((_, stripe_id, cancel_at_period_end)) = active_sub {
        if !cancel_at_period_end {
            return Ok(HttpResponse::Conflict().json(serde_json::json!({
                "message": "Cancel the organization's subscription on the Billing page before deleting the organization."
            })));
        }
        if let Some(stripe_id) = stripe_id.filter(|s| !s.is_empty())
            && let Err(e) = provider::cancel_now(&stripe_id).await
        {
            error!(target: "billing", error = ?e, "stripe immediate-cancel on org delete failed");
            return Ok(HttpResponse::BadGateway().json(serde_json::json!({
                "message": "Could not cancel the subscription with the payment provider. Try again."
            })));
        }
    }

    // Snapshot the invitees first: ON DELETE SET NULL on users.organization_id
    // would null them out, losing the cohort to delete.
    let invitee_ids: Vec<i32> =
        sqlx::query_scalar("SELECT id FROM users WHERE organization_id = $1 AND id <> $2")
            .bind(organization_id)
            .bind(user_id)
            .fetch_all(pool.get_ref())
            .await?;

    let mut tx = pool.begin().await?;
    // This authorized teardown removes other users' RLS-enabled rows.
    crate::db::apply_rls_bypass(&mut tx).await?;

    // notes.user_id has no FK, so it does not ride the cascade on `users`.
    if !invitee_ids.is_empty() {
        sqlx::query("DELETE FROM notes WHERE user_id = ANY($1)")
            .bind(&invitee_ids)
            .execute(&mut *tx)
            .await?;

        sqlx::query("DELETE FROM users WHERE id = ANY($1)")
            .bind(&invitee_ids)
            .execute(&mut *tx)
            .await?;
    }

    // ON DELETE SET NULL clears organization_id, but account_type must also flip
    // back to 'personal' so the owner leaves the org-admin RBAC scope.
    sqlx::query(
        r#"
        UPDATE users
           SET account_type = 'personal',
               organization_id = NULL
         WHERE id = $1
        "#,
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await?;

    // The reverted owner lands on a comped personal "Most Advance" grant with no
    // Stripe id, which `current_plan_for_user` resolves live from this active row.
    sqlx::query(
        "UPDATE subscriptions SET status = 'canceled', updated_at = NOW() \
         WHERE user_id = $1 AND status IN ('active', 'trialing')",
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO subscriptions (user_id, plan_id, status) \
         SELECT $1, id, 'active' FROM plans WHERE code = 'most_advance_user'",
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await?;

    // Every table referencing organizations.id is ON DELETE CASCADE in init.sql, so
    // members, entitlements, billing, shares and shared inboxes go with it.
    let deleted = sqlx::query("DELETE FROM organizations WHERE id = $1")
        .bind(organization_id)
        .execute(&mut *tx)
        .await?;
    if deleted.rows_affected() == 0 {
        return Ok(HttpResponse::NotFound()
            .json(serde_json::json!({ "message": "Organization not found" })));
    }

    tx.commit().await?;

    invalidate_profile_cache(user_id).await;
    invalidate_me_cache(user_id).await;
    rbac::invalidate_role_context(user_id).await;
    for invitee_id in &invitee_ids {
        invalidate_profile_cache(*invitee_id).await;
        invalidate_me_cache(*invitee_id).await;
        rbac::invalidate_role_context(*invitee_id).await;
    }

    info!(
        target: "auth",
        user_id,
        organization_id,
        invitee_count = invitee_ids.len(),
        "organization owner reverted to personal — org deleted"
    );

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "deleted_organization_id": organization_id,
        "deleted_member_count": invitee_ids.len(),
        "account_type": "personal"
    })))
}

#[derive(Deserialize)]
pub struct UpdateOrganizationInput {
    pub name: String,
}

/// Rename the caller's organization. Owner-only, mirroring the gate on
/// [`delete_my_organization`]. The name is denormalized into every member's
/// `/api/me` and profile payloads, so those caches are busted org-wide.
#[patch("/organizations/me")]
#[instrument(target = "auth", skip(req, pool, data))]
pub async fn update_my_organization(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<UpdateOrganizationInput>,
) -> AppResult {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => {
            return Ok(HttpResponse::Unauthorized()
                .json(serde_json::json!({ "message": "Authentication required" })));
        }
    };

    // Renaming is an admin action, so a normal-mode owner (downscoped to member)
    // is refused.
    let ctx = match rbac::resolve_role_context_moded(&req, pool.get_ref(), user_id).await {
        Ok(ctx) => ctx,
        Err(sqlx::Error::RowNotFound) => {
            return Ok(HttpResponse::Unauthorized()
                .json(serde_json::json!({ "message": "Account not found" })));
        }
        Err(e) => return Err(AppError::Db(e)),
    };
    if ctx.scope != Scope::Organization || ctx.role != Role::Owner {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Only the organization owner can rename the organization"
        })));
    }
    let organization_id = match ctx.organization_id {
        Some(id) => id,
        None => {
            return Ok(HttpResponse::Conflict().json(serde_json::json!({
                "message": "Your account is not bound to an organization"
            })));
        }
    };

    let name = data.name.trim();
    if name.is_empty() {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Organization name is required" })));
    }
    if name.chars().count() > 120 {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Organization name is too long" })));
    }

    // Same slug expression as at creation; a unique violation means another
    // organization already holds the name or slug.
    let updated = match sqlx::query(
        r#"
        UPDATE organizations
           SET name = $1,
               slug = lower(regexp_replace($1, '[^a-zA-Z0-9]+', '', 'g'))
         WHERE id = $2
        RETURNING id, name, slug
        "#,
    )
    .bind(name)
    .bind(organization_id)
    .fetch_optional(pool.get_ref())
    .await
    {
        Ok(row) => row,
        Err(sqlx::Error::Database(db)) if db.is_unique_violation() => {
            return Ok(HttpResponse::Conflict().json(serde_json::json!({
                "message": "Another organization already uses that name"
            })));
        }
        Err(e) => return Err(AppError::Db(e)),
    };

    let Some(row) = updated else {
        return Ok(HttpResponse::NotFound()
            .json(serde_json::json!({ "message": "Organization not found" })));
    };

    let new_name: String = row.get("name");
    let new_slug: Option<String> = row.get("slug");

    let member_ids: Vec<i32> =
        sqlx::query_scalar("SELECT id FROM users WHERE organization_id = $1")
            .bind(organization_id)
            .fetch_all(pool.get_ref())
            .await?;
    for member_id in &member_ids {
        invalidate_profile_cache(*member_id).await;
        invalidate_me_cache(*member_id).await;
    }

    info!(target: "auth", user_id, organization_id, "organization renamed");

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "id": organization_id,
        "name": new_name,
        "slug": new_slug,
    })))
}

#[derive(Deserialize)]
pub struct UpdateSprintDaysInput {
    pub days: i16,
}

/// Set the organization's sprint (cycle) length in days, 1–90. Feeds the
/// user-stories burnup. Gated on `org:settings` so any org admin (not only the
/// owner) can change it. The value is read through every member's `/api/me`, so
/// those caches are busted org-wide.
#[patch("/organizations/me/sprint-days")]
#[instrument(target = "auth", skip(req, pool, data))]
pub async fn update_org_sprint_days(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<UpdateSprintDaysInput>,
) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::OrgSettings).await {
        Ok(c) => c,
        Err(resp) => return Ok(resp),
    };
    if ctx.scope != Scope::Organization {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Organization scope required"
        })));
    }
    let organization_id = match ctx.organization_id {
        Some(id) => id,
        None => {
            return Ok(HttpResponse::Conflict().json(serde_json::json!({
                "message": "Your account is not bound to an organization"
            })));
        }
    };

    let days = data.days;
    if !(1..=90).contains(&days) {
        return Ok(HttpResponse::BadRequest().json(serde_json::json!({
            "message": "Sprint length must be between 1 and 90 days"
        })));
    }

    let updated = sqlx::query("UPDATE organizations SET sprint_total_days = $1 WHERE id = $2")
        .bind(days)
        .bind(organization_id)
        .execute(pool.get_ref())
        .await?;
    if updated.rows_affected() == 0 {
        return Ok(HttpResponse::NotFound()
            .json(serde_json::json!({ "message": "Organization not found" })));
    }

    // The number rides on every member's /api/me, so bust those caches org-wide.
    let member_ids: Vec<i32> =
        sqlx::query_scalar("SELECT id FROM users WHERE organization_id = $1")
            .bind(organization_id)
            .fetch_all(pool.get_ref())
            .await?;
    for member_id in &member_ids {
        invalidate_profile_cache(*member_id).await;
        invalidate_me_cache(*member_id).await;
    }

    info!(target: "auth", organization_id, days, "organization sprint length updated");

    Ok(HttpResponse::Ok().json(serde_json::json!({ "sprint_total_days": days })))
}

/// Permanently delete the caller's own account and everything that cascades from
/// `users.id`. An organization owner must delete the organization first, because
/// their user row anchors its members, shared inboxes, and billing. An active or
/// trialing subscription must be cancelled first so no Stripe charge is orphaned.
#[delete("/me")]
#[instrument(target = "auth", skip(req, pool))]
pub async fn delete_my_account(req: HttpRequest, pool: web::Data<PgPool>) -> AppResult {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => {
            return Ok(HttpResponse::Unauthorized()
                .json(serde_json::json!({ "message": "Authentication required" })));
        }
    };

    let ctx = match rbac::resolve_role_context(pool.get_ref(), user_id).await {
        Ok(ctx) => ctx,
        Err(sqlx::Error::RowNotFound) => {
            return Ok(HttpResponse::Unauthorized()
                .json(serde_json::json!({ "message": "Account not found" })));
        }
        Err(e) => return Err(AppError::Db(e)),
    };

    // Personal accounts only: team members must be removed by an owner or admin, and
    // an org owner deletes the org first, which reverts them to personal.
    match ctx.scope {
        Scope::Personal => {}
        Scope::Organization if ctx.role == Role::Owner => {
            return Ok(HttpResponse::Conflict().json(serde_json::json!({
                "message": "Delete your organization first (Settings → Danger zone), then delete your account."
            })));
        }
        _ => {
            return Ok(HttpResponse::Forbidden().json(serde_json::json!({
                "message": "Team members can't delete their own account. Ask your organization or platform owner to remove you."
            })));
        }
    }

    let active_sub: Option<i32> = sqlx::query_scalar(
        r#"
        SELECT id FROM subscriptions
         WHERE user_id = $1
           AND status IN ('active', 'trialing')
         LIMIT 1
        "#,
    )
    .bind(user_id)
    .fetch_optional(pool.get_ref())
    .await?;
    if active_sub.is_some() {
        return Ok(HttpResponse::Conflict().json(serde_json::json!({
            "message": "Cancel your subscription on the Billing page before deleting your account."
        })));
    }

    // `audit_logs.actor_user_id` is ON DELETE SET NULL, so the email in metadata is
    // the only thing keeping this event attributable afterwards.
    let email: Option<String> = sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool.get_ref())
        .await?;

    // Must run before the delete: record_action reads users.organization_id and
    // inserts actor_user_id, both of which need the row to still exist.
    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: user_id,
            action: "account_delete",
            resource_type: "user",
            resource_id: Some(user_id.to_string()),
            metadata: Some(serde_json::json!({ "email": email })),
        },
    )
    .await;

    let mut tx = pool.begin().await?;
    crate::db::apply_rls_bypass(&mut tx).await?;
    // notes.user_id has no FK, so it does not ride the cascade on `users`.
    sqlx::query("DELETE FROM notes WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    let deleted = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    if deleted.rows_affected() == 0 {
        return Ok(
            HttpResponse::NotFound().json(serde_json::json!({ "message": "Account not found" }))
        );
    }
    tx.commit().await?;

    invalidate_profile_cache(user_id).await;
    invalidate_me_cache(user_id).await;
    rbac::invalidate_role_context(user_id).await;

    info!(target: "auth", user_id, "user self-deleted account");

    Ok(HttpResponse::Ok().json(serde_json::json!({ "deleted": true })))
}

#[derive(Deserialize)]
pub struct AdminSendCreateCodeInput {
    /// The login address the account will be created with.
    pub account_email: String,
    /// Where to mail the code; defaults to `account_email`. The two differ for org
    /// accounts on synthetic `<user>@<org-slug>.com` domains with no real inbox: the
    /// code goes to a reachable mailbox while the account keeps the org address as
    /// its login identity.
    #[serde(default)]
    pub delivery_email: Option<String>,
}

/// Seconds an admin must wait before re-requesting a code for the same address.
const CREATE_CODE_RESEND_COOLDOWN_SECS: i64 = 60;

fn normalize_email(value: &str) -> String {
    value.trim().to_lowercase()
}

/// Mail the 6-digit code that `admin_create_user` requires. Nothing is written to
/// `users` here: the code proves the address reachable, so a typo fails now rather
/// than creating an account nobody can log into.
#[post("/admin/users/send-code")]
#[instrument(target = "auth", skip(req, pool, data), fields(account_email = %data.account_email))]
pub async fn admin_send_create_code(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<AdminSendCreateCodeInput>,
) -> AppResult {
    // Same gate as admin_create_user: whoever may not create the account may not
    // make the server send mail on its behalf either.
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::MembersManage).await
    {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };
    let admin_id = ctx.user_id;

    let account_email = normalize_email(&data.account_email);
    let delivery_email = data
        .delivery_email
        .as_deref()
        .map(normalize_email)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| account_email.clone());

    if !account_email.contains('@') || !delivery_email.contains('@') {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "A valid email address is required" })));
    }

    let taken: Option<i32> = sqlx::query_scalar("SELECT id FROM users WHERE email = $1")
        .bind(&account_email)
        .fetch_optional(pool.get_ref())
        .await?;
    if taken.is_some() {
        return Ok(HttpResponse::Conflict()
            .json(serde_json::json!({ "message": "An account with that email already exists" })));
    }

    // Resend cooldown, so the button can't be used to hammer someone's inbox.
    let recent: Option<i32> = sqlx::query_scalar(
        "SELECT id FROM admin_create_verifications \
         WHERE requested_by = $1 AND account_email = $2 AND used_at IS NULL \
           AND created_at > NOW() - ($3 || ' seconds')::INTERVAL \
         LIMIT 1",
    )
    .bind(admin_id)
    .bind(&account_email)
    .bind(CREATE_CODE_RESEND_COOLDOWN_SECS.to_string())
    .fetch_optional(pool.get_ref())
    .await?;
    if recent.is_some() {
        return Ok(HttpResponse::TooManyRequests().json(serde_json::json!({
            "message": format!(
                "A code was just sent. Wait {CREATE_CODE_RESEND_COOLDOWN_SECS}s before requesting another."
            )
        })));
    }

    // Only the newest code stays valid, mirroring issue_verification_code_and_email.
    sqlx::query(
        "UPDATE admin_create_verifications SET used_at = NOW() \
         WHERE requested_by = $1 AND account_email = $2 AND used_at IS NULL",
    )
    .bind(admin_id)
    .bind(&account_email)
    .execute(pool.get_ref())
    .await?;

    let code = random_code();
    let expires_at = chrono::Utc::now() + chrono::Duration::minutes(CODE_TTL_MINUTES);
    sqlx::query(
        "INSERT INTO admin_create_verifications \
           (requested_by, account_email, delivery_email, code, expires_at) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(admin_id)
    .bind(&account_email)
    .bind(&delivery_email)
    .bind(&code)
    .bind(expires_at)
    .execute(pool.get_ref())
    .await?;

    let body = format!(
        "Hi,\n\nAn administrator is creating a Fluxze account for {account_email}.\n\n\
         Your verification code is:\n\n    {code}\n\n\
         Give it to the administrator within {CODE_TTL_MINUTES} minutes to finish creating the account.\n\
         If you weren't expecting this, you can safely ignore this email — no account is created \
         until the code is entered.\n"
    );
    crate::email::sender::send_mail(
        &delivery_email,
        "Your Fluxze account verification code",
        &body,
    )
    .await
    .map_err(|e| AppError::Internal(format!("admin create code send: {e}")))?;

    info!(
        target: "auth",
        admin_id,
        account_email = %account_email,
        delivery_email = %delivery_email,
        "admin account-creation code sent"
    );

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "sent": true,
        "delivery_email": delivery_email,
        "expires_in_minutes": CODE_TTL_MINUTES,
    })))
}

/// Consume the code mailed by `admin_send_create_code`. Must run before any mutation
/// in `admin_create_user`, so a bad code leaves no partial org, seat, or keypair
/// state. `Err(resp)` is the response to return to the admin.
async fn consume_create_code(
    pool: &PgPool,
    admin_id: i32,
    email: &str,
    supplied: Option<&str>,
) -> std::result::Result<(), HttpResponse> {
    let supplied = supplied.map(str::trim).filter(|value| !value.is_empty());

    let row = sqlx::query(
        "SELECT id, code, attempts, expires_at FROM admin_create_verifications \
         WHERE requested_by = $1 AND account_email = $2 AND used_at IS NULL \
         ORDER BY id DESC LIMIT 1",
    )
    .bind(admin_id)
    .bind(email)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        error!(target: "auth", error = %e, "create-code lookup failed");
        HttpResponse::InternalServerError()
            .json(serde_json::json!({ "message": "Verification lookup failed" }))
    })?;

    let Some(row) = row else {
        return Err(HttpResponse::BadRequest().json(serde_json::json!({
            "error": "verification_required",
            "message": "Send a verification code to this email first"
        })));
    };

    let id: i32 = row.get("id");
    let expected: String = row.get("code");
    let attempts: i32 = row.get("attempts");
    let expires_at: chrono::DateTime<chrono::Utc> = row.get("expires_at");

    let burn = |reason: &'static str| async move {
        let _ = sqlx::query("UPDATE admin_create_verifications SET used_at = NOW() WHERE id = $1")
            .bind(id)
            .execute(pool)
            .await;
        warn!(target: "auth", admin_id, id, reason, "admin create code burned");
    };

    if expires_at < chrono::Utc::now() {
        burn("expired").await;
        return Err(HttpResponse::BadRequest().json(serde_json::json!({
            "error": "verification_expired",
            "message": "Verification code expired — send a new one"
        })));
    }

    if attempts >= MAX_VERIFY_ATTEMPTS {
        burn("too_many_attempts").await;
        return Err(HttpResponse::TooManyRequests().json(serde_json::json!({
            "error": "too_many_attempts",
            "message": "Too many incorrect attempts — send a new code"
        })));
    }

    let Some(supplied) = supplied else {
        return Err(HttpResponse::BadRequest().json(serde_json::json!({
            "error": "verification_required",
            "message": "Enter the verification code that was emailed"
        })));
    };

    if supplied != expected {
        let _ = sqlx::query(
            "UPDATE admin_create_verifications SET attempts = attempts + 1 WHERE id = $1",
        )
        .bind(id)
        .execute(pool)
        .await;
        return Err(HttpResponse::BadRequest().json(serde_json::json!({
            "error": "verification_invalid",
            "message": "Incorrect verification code"
        })));
    }

    sqlx::query("UPDATE admin_create_verifications SET used_at = NOW() WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| {
            error!(target: "auth", error = %e, "create-code burn failed");
            HttpResponse::InternalServerError()
                .json(serde_json::json!({ "message": "Verification failed" }))
        })?;

    Ok(())
}

#[post("/admin/users")]
#[instrument(target = "auth", skip(req, pool, data), fields(email = %data.email))]
pub async fn admin_create_user(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<AdminCreateUserInput>,
) -> AppResult {
    // Gated on `members:manage` rather than account_type, which is what lets an
    // organization `admin` — not just an owner — add members.
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::MembersManage).await
    {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };
    let admin_id = ctx.user_id;

    let email = data.email.trim().to_lowercase();
    let username_owned = data
        .username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            email
                .split('@')
                .next()
                .filter(|value| !value.is_empty())
                .unwrap_or(&email)
                .to_string()
        });
    let username = username_owned.as_str();
    let requested_account_type = data
        .account_type
        .as_deref()
        .map(normalized_account_type)
        .unwrap_or("personal");

    // Platform staff may provision any account type; an organization manager
    // may only add "organization" members to their own organization.
    let account_type: &str = match ctx.scope {
        Scope::Platform => match requested_account_type {
            "organization_admin" | "platform_admin" | "organization" | "personal" => {
                requested_account_type
            }
            _ => "personal",
        },
        Scope::Organization => "organization",
        Scope::Personal => "personal",
    };

    if username.is_empty() || email.is_empty() {
        return Ok(
            HttpResponse::BadRequest().json(serde_json::json!({ "message": "Email is required" }))
        );
    }

    // Everything below this line mutates (organizations upsert, seat accounting,
    // keypair provisioning, the users insert), so a bad code must fail here and
    // leave no partial state.
    if let Err(response) = consume_create_code(
        pool.get_ref(),
        admin_id,
        &email,
        data.verification_code.as_deref(),
    )
    .await
    {
        return Ok(response);
    }

    // Without a supplied password, generate a temp one and return it in the
    // response so the admin can share it once.
    let supplied_password = data
        .password
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let (plaintext_password, generated) = match supplied_password {
        Some(value) if value.len() < 6 => {
            return Ok(HttpResponse::BadRequest()
                .json(serde_json::json!({ "message": "Password must be at least 6 characters" })));
        }
        Some(value) => (value.to_string(), false),
        None => (generate_temp_password(), true),
    };

    let organization_id: Option<i32> = if account_type == "organization_admin" {
        let organization_name = data
            .organization_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());

        let Some(organization_name) = organization_name else {
            return Ok(HttpResponse::BadRequest()
                .json(serde_json::json!({ "message": "Organization name is required for organization admin accounts" })));
        };

        match sqlx::query(
            r#"
            INSERT INTO organizations (name, slug)
            VALUES ($1, lower(regexp_replace($1, '[^a-zA-Z0-9]+', '', 'g')))
            ON CONFLICT (name) DO UPDATE
                SET slug = COALESCE(organizations.slug, EXCLUDED.slug)
            RETURNING id
            "#,
        )
        .bind(organization_name)
        .fetch_one(pool.get_ref())
        .await
        {
            Ok(row) => Some(row.get("id")),
            Err(e) => {
                if e.to_string().contains("duplicate key") {
                    return Ok(HttpResponse::Conflict().json(serde_json::json!({
                        "message": "Another organization already uses that URL slug"
                    })));
                }
                return Err(AppError::Db(e));
            }
        }
    } else if ctx.scope == Scope::Organization {
        match ctx.organization_id {
            Some(id) => Some(id),
            None => {
                return Ok(HttpResponse::BadRequest().json(serde_json::json!({
                    "message": "Organization manager is not assigned to an organization"
                })));
            }
        }
    } else {
        None
    };

    if let Some(org_id) = organization_id {
        let entitlements =
            effective_entitlements(pool.get_ref(), BillingOwner::Organization(org_id)).await;
        if entitlements.seat_limit >= 0 {
            let seats_used = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*)::BIGINT FROM users WHERE organization_id = $1",
            )
            .bind(org_id)
            .fetch_one(pool.get_ref())
            .await?;
            if seats_used >= i64::from(entitlements.seat_limit) {
                return Ok(HttpResponse::PaymentRequired().json(serde_json::json!({
                    "message": "Organization seat limit reached. Upgrade the plan before adding more members.",
                    "seat_limit": entitlements.seat_limit,
                    "seats_used": seats_used
                })));
            }
        }
    }

    // Domain gate for org members. Founders (organization_admin) and personal
    // users are exempt: they bootstrap the org before members exist.
    if account_type == "organization"
        && let Some(org_id) = organization_id
    {
        let domain = match email.rsplit_once('@') {
            Some((_, d)) if !d.is_empty() => d.to_lowercase(),
            _ => {
                return Ok(HttpResponse::BadRequest()
                    .json(serde_json::json!({ "message": "Invalid email address" })));
            }
        };
        // Domain *ownership* is deliberately not verified: an org may create
        // accounts on any non-public domain. A platform owner can set
        // `allow_unverified_email_domains` to also permit public-provider domains.
        let allow_unverified: bool = sqlx::query_scalar::<_, bool>(
            "SELECT allow_unverified_email_domains FROM organizations WHERE id = $1",
        )
        .bind(org_id)
        .fetch_optional(pool.get_ref())
        .await?
        .unwrap_or(false);

        if !allow_unverified && organization::domains::is_public_provider_domain(&domain) {
            return Ok(HttpResponse::BadRequest().json(serde_json::json!({
                "message": format!("'{domain}' is a public email provider and can't be used for organization accounts")
            })));
        }
    }

    // Org members need a bootstrapped org master key so the server can escrow their
    // keypair; failing early beats creating a user who cannot do crypto. Founders and
    // personal users take the client-side mnemonic path and are exempt.
    let needs_provisioned_keypair = account_type == "organization" && organization_id.is_some();
    let org_pubkey_spki: Option<Vec<u8>> = if needs_provisioned_keypair {
        let org_id = organization_id.expect("checked is_some above");
        match organization::keys::fetch_org_public_key(pool.get_ref(), org_id).await? {
            Some(pub_json) => {
                let bytes: Vec<u8> = serde_json::from_str(&pub_json).map_err(|e| {
                    AppError::Internal(format!("org {org_id} public_key JSON malformed: {e}"))
                })?;
                Some(bytes)
            }
            None => {
                return Ok(HttpResponse::BadRequest().json(serde_json::json!({
                    "message": "Organization master key not bootstrapped yet. \
                                The owner must visit /organization/recovery-key/bootstrap \
                                before members can be added."
                })));
            }
        }
    } else {
        None
    };

    let hashed = hash_password(&plaintext_password).await?;

    // `email_verified` is true because the code proved the address reachable, so
    // the new user can log in without tripping the unverified-login gate.
    let result = sqlx::query(
        r#"
        INSERT INTO users (username, email, password, auth_provider, account_type, email_verified)
        VALUES ($1, $2, $3, 'local', $4, true)
        RETURNING id, username, email, account_type, organization_id
        "#,
    )
    .bind(username)
    .bind(&email)
    .bind(&hashed)
    .bind(account_type)
    .fetch_one(pool.get_ref())
    .await;

    let result = if let (Ok(row), Some(organization_id)) = (&result, organization_id) {
        sqlx::query(
            "UPDATE users SET organization_id = $1 WHERE id = $2 RETURNING id, username, email, account_type, organization_id",
        )
        .bind(organization_id)
        .bind(row.get::<i32, _>("id"))
        .fetch_one(pool.get_ref())
        .await
    } else {
        result
    };

    match result {
        Ok(row) => {
            let id: i32 = row.get("id");
            let username: Option<String> = row.try_get("username").ok();
            let email: String = row.get("email");
            let account_type: String = row.get("account_type");
            let organization_id: Option<i32> = row.try_get("organization_id").ok().flatten();
            // The members-table CHECK constraints reject anything outside the 9-role
            // catalog, so a bad string surfaces as a 500 rather than a silent default.
            // The frontend dropdown offers only guest/developer/member/support.
            let role_owned = data
                .role
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let role: &str = role_owned
                .as_deref()
                .unwrap_or_else(|| default_role_for_account_type(&account_type));

            if normalized_account_type(&account_type) == "platform_admin" {
                sqlx::query(
                    r#"
                    INSERT INTO platform_members (user_id, role)
                    VALUES ($1, $2)
                    ON CONFLICT (user_id) DO UPDATE
                    SET role = EXCLUDED.role, updated_at = NOW()
                    "#,
                )
                .bind(id)
                .bind(role)
                .execute(pool.get_ref())
                .await?;
            }

            if let Some(org_id) = organization_id {
                sqlx::query(
                    r#"
                    INSERT INTO organization_members (organization_id, user_id, role)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (organization_id, user_id) DO UPDATE
                    SET role = EXCLUDED.role, updated_at = NOW()
                    "#,
                )
                .bind(org_id)
                .bind(id)
                .bind(role)
                .execute(pool.get_ref())
                .await?;
            }

            // The member keypair never leaves this process unwrapped: the blocking
            // task wraps it under the org pubkey (owner recovery) and PBKDF2(password)
            // (member login), then zeroes the plaintext. Keygen needs spawn_blocking.
            if let (Some(spki), Some(org_id)) = (org_pubkey_spki, organization_id) {
                let password_for_gen = plaintext_password.clone();
                let provisioned = tokio::task::spawn_blocking(move || {
                    wayve_security::encryption::provision_org_member_keypair(
                        &password_for_gen,
                        &spki,
                    )
                })
                .await
                .map_err(|e| AppError::Internal(format!("keypair spawn_blocking failed: {e}")))?
                .map_err(|e| {
                    AppError::Internal(format!("org member keypair provisioning failed: {e}"))
                })?;

                organization::keys::persist_provisioned_keys(
                    pool.get_ref(),
                    id,
                    org_id,
                    &provisioned.public_key_json,
                    &provisioned.member_escrow_envelope,
                    &provisioned.login_wrap,
                )
                .await?;

                info!(
                    target: "auth",
                    admin_id,
                    user_id = id,
                    organization_id = org_id,
                    "org member keypair provisioned + escrowed"
                );
            }

            info!(target: "auth", admin_id, user_id = id, "admin created user");
            // `temp_password` is present only when the server generated it; a
            // supplied password is never echoed back.
            let mut body = serde_json::json!({
                "id": id,
                "username": username,
                "email": email,
                "account_type": account_type,
                "organization_id": organization_id,
                "role": role,
            });
            if generated {
                body["temp_password"] = serde_json::Value::String(plaintext_password);
            }
            Ok(HttpResponse::Created().json(body))
        }
        Err(e) => {
            if e.to_string().contains("duplicate key") {
                return Ok(HttpResponse::Conflict()
                    .json(serde_json::json!({ "message": "Username or email already exists" })));
            }
            Err(AppError::Db(e))
        }
    }
}

fn generate_temp_password() -> String {
    use rand::{Rng, distributions::Alphanumeric};
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(16)
        .map(char::from)
        .collect()
}

/// Hard-delete a user account. Gated on `members:manage` and additionally on
/// `can_assign_role` for the target's role: without that check an admin or security
/// member could delete the org owner, a privilege escalation. Self-delete is blocked
/// because the actor's JWT stays valid until expiry and would strand them
/// mid-session.
#[delete("/admin/users/{id}")]
#[instrument(target = "auth", skip(req, pool))]
pub async fn admin_delete_user(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    path: web::Path<i32>,
) -> AppResult {
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::MembersManage).await
    {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };
    let target_user_id = path.into_inner();

    if ctx.user_id == target_user_id {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "You cannot delete your own account" })));
    }

    let target_ctx = match rbac::resolve_role_context(pool.get_ref(), target_user_id).await {
        Ok(target_ctx) => target_ctx,
        Err(sqlx::Error::RowNotFound) => {
            return Ok(
                HttpResponse::NotFound().json(serde_json::json!({ "message": "User not found" }))
            );
        }
        Err(e) => return Err(AppError::Db(e)),
    };

    // Org admins cannot reach across orgs or into the platform tenant, and get a
    // 404 rather than a 403 so they cannot probe for users outside their org.
    match ctx.scope {
        Scope::Organization => {
            if target_ctx.scope != Scope::Organization
                || target_ctx.organization_id != ctx.organization_id
            {
                return Ok(HttpResponse::NotFound().json(serde_json::json!({
                    "message": "User is not a member of your organization"
                })));
            }
        }
        Scope::Platform => {}
        Scope::Personal => {
            return Ok(HttpResponse::Forbidden().json(serde_json::json!({
                "message": "Personal accounts cannot delete other users"
            })));
        }
    }

    // Same predicate as role assignment: RolesManage holders can delete anyone,
    // RolesAssignLimited only users whose current role is below admin.
    if !rbac::can_assign_role(&ctx, target_ctx.role, target_ctx.role) {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Your role cannot manage that account"
        })));
    }

    if target_ctx.role == Role::Owner {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "An owner cannot delete another owner"
        })));
    }

    let mut tx = pool.begin().await?;
    crate::db::apply_rls_bypass(&mut tx).await?;

    // notes.user_id has no FK, so it does not ride the cascade on `users`.
    sqlx::query("DELETE FROM notes WHERE user_id = $1")
        .bind(target_user_id)
        .execute(&mut *tx)
        .await?;

    let result = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(target_user_id)
        .execute(&mut *tx)
        .await?;

    if result.rows_affected() == 0 {
        // Race: target existed at resolve_role_context time, gone now.
        return Ok(
            HttpResponse::NotFound().json(serde_json::json!({ "message": "User not found" }))
        );
    }

    tx.commit().await?;

    invalidate_me_cache(target_user_id).await;
    invalidate_profile_cache(target_user_id).await;
    rbac::invalidate_role_context(target_user_id).await;
    info!(
        target: "auth",
        actor = ctx.user_id,
        target_user_id,
        scope = ?target_ctx.scope,
        "admin deleted user"
    );
    crate::audit::record_action(
        pool.get_ref(),
        &req,
        crate::audit::AuditEvent {
            actor_user_id: ctx.user_id,
            action: "user_delete",
            resource_type: "user",
            resource_id: Some(target_user_id.to_string()),
            metadata: Some(serde_json::json!({ "scope": format!("{:?}", target_ctx.scope) })),
        },
    )
    .await;

    Ok(HttpResponse::NoContent().finish())
}
