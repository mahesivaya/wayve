//! Organization + user provisioning endpoints (platform-admin and self-serve):
//! `/admin/organizations`, `/organizations`, `/organizations/me`,
//! `/admin/users`.

use super::shared::{
    default_role_for_account_type, invalidate_profile_cache, normalized_account_type,
};
use crate::billing::checkout::ensure_customer;
use crate::billing::entitlements::{effective_entitlements, refresh_entitlements};
use crate::billing::models::BillingOwner;
use crate::billing::provider;
use crate::email::profile::invalidate_me_cache;
use crate::organization;
use crate::prelude::*;
use actix_web::{delete, patch};
use tracing::{error, info, instrument, warn};
use wayve_security::jwt::get_user_id_from_request;
use wayve_security::password::hash_password;
use wayve_security::rbac::{self, Permission, Role, Scope};

#[derive(Deserialize)]
pub struct AdminCreateUserInput {
    // Both username and password are now optional. When the caller is using
    // the simple "Create user" admin flow (provide an email + role), we
    // derive `username` from the email's local-part and generate a strong
    // random `password` on the server. The plaintext is returned to the
    // admin exactly once in the response so they can share it with the new
    // user out-of-band.
    #[serde(default)]
    pub username: Option<String>,
    pub email: String,
    #[serde(default)]
    pub password: Option<String>,
    pub account_type: Option<String>,
    pub organization_name: Option<String>,
    // Optional role override. When omitted, the existing
    // `default_role_for_account_type` rules apply (owner for admin scopes,
    // member for organization). The DB CHECK constraint on
    // organization_members.role / platform_members.role is the final filter
    // for invalid strings.
    #[serde(default)]
    pub role: Option<String>,
}

#[derive(Deserialize)]
pub struct CreateOrganizationInput {
    pub name: String,
    /// Optional organization admin to provision together with the organization. When
    /// any of the three fields is supplied, all three are required.
    pub admin_username: Option<String>,
    pub admin_email: Option<String>,
    pub admin_password: Option<String>,
}

#[derive(Deserialize)]
pub struct CreateMyOrganizationInput {
    pub name: String,
    /// Free-form locale (city, country, address) shown in the org setup page
    /// and on the organization home. Optional — empty/missing is stored as
    /// NULL.
    #[serde(default)]
    pub place: Option<String>,
}

/// Require the caller to be platform-scope staff holding `members:manage` — the
/// gate for platform-only actions such as provisioning organizations. Platform
/// `owner`, `super_admin`, and `admin` qualify. Returns the caller's user id.
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
             LIMIT 1) as admin
        FROM organizations o
        LEFT JOIN users u ON u.organization_id = o.id
        GROUP BY o.id, o.name, o.slug, o.created_at
        ORDER BY o.name
        "#,
    )
    .fetch_all(pool.get_ref())
    .await?;

    let organizations: Vec<_> = rows
        .into_iter()
        .map(|row| {
            let id: i32 = row.get("id");
            let name: String = row.get("name");
            let slug: Option<String> = row.get("slug");
            let user_count: i64 = row.get("user_count");
            let email_account_count: i64 = row.try_get("email_account_count").unwrap_or(0);
            let storage_used_bytes: i64 = row.try_get("storage_used_bytes").unwrap_or(0);
            let admin: Option<serde_json::Value> = row.get("admin");

            serde_json::json!({
                "id": id,
                "name": name,
                "slug": slug,
                "user_count": user_count,
                "email_account_count": email_account_count,
                "storage_used_bytes": storage_used_bytes,
                "admin": admin
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

    // The organization admin block is optional, but if any field is supplied the
    // whole set (username, email, password) must be present.
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

    // The slug is derived from the name at insert time (same expression as the
    // init.sql backfill) so runtime-created orgs are never left slug-less.
    // On a name conflict it heals a missing slug but never overwrites one,
    // keeping existing slugs stable.
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

        // Generate the owner's personal RSA-2048 keypair server-side
        // BEFORE we touch the tx. Same security-boundary discipline as
        // org-member provisioning: the plaintext private key only exists
        // inside this blocking task, gets wrapped under PBKDF2(password)
        // before the task returns, and is zeroed in encryption.rs. No
        // org-escrow wrap because the org has no master key yet — the
        // owner will bootstrap that from their browser on first login,
        // and the wrap-under-owner-pubkey step there works because we
        // store the SPKI in users.public_key below.
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
                    "account_type": account_type, // Use the enum directly
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

                // Password-wrapped private key — owner unwraps on first
                // login using the same flow org members already use
                // (login response carries `login_wrap`, frontend derives
                // PBKDF2(password) and decrypts into IndexedDB).
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

    tx.commit().await?;

    let user_count = if admin_json.is_null() { 0 } else { 1 };
    info!(target: "auth", admin_id, organization_id, "platform admin created organization");
    Ok(HttpResponse::Created().json(serde_json::json!({
        "id": organization_id,
        "name": organization_name,
        "slug": organization_slug,
        "user_count": user_count,
        "admin": admin_json
    })))
}

// Starter entitlement headroom seeded at org creation so a brand-new org can
// add up to 100 members before its subscription's seat_limit is materialized
// by refresh_entitlements(). The basic_user free baseline grants only one
// seat, which would block the owner from inviting anybody.
const STARTER_SEAT_LIMIT: i32 = 100;
const STARTER_STORAGE_BYTES: i64 = 1_073_741_824; // 1 GiB

pub(crate) struct CreatedOrg {
    pub id: i32,
    pub name: String,
    pub slug: Option<String>,
    pub place: Option<String>,
}

/// The core org-creation side effects, in the caller's transaction: insert the
/// `organizations` row, promote the user to `organization_admin` + owner
/// member, and seed the starter entitlement. Shared by the free path
/// (`create_my_organization`) and the payment-gated finalize path
/// (`finalize_org_signup_inner`). Returns `Ok(None)` on a name conflict so the
/// caller can surface a 409 and roll back.
pub(crate) async fn create_org_for_user(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: i32,
    name: &str,
    place: Option<&str>,
    admin_email: Option<&str>,
) -> std::result::Result<Option<CreatedOrg>, AppError> {
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

    Ok(Some(CreatedOrg {
        id: organization_id,
        name: org_row.get("name"),
        slug: org_row.get("slug"),
        place: org_row.get("place"),
    }))
}

/// Self-serve org creation (free / no-payment path, kept for internal use):
/// a personal user creates an organization and is promoted to its owner.
/// `account_type` flips from 'personal' to 'organization_admin', they become an
/// 'owner' member, and subsequent /api/me reflects the new scope. The JWT is
/// untouched because RBAC is computed per request from the DB.
///
/// NOTE: the self-serve UI now drives the payment-gated flow
/// (`/organizations/signup-intent` → `/organizations/finalize`); this endpoint
/// remains for compatibility and internal callers.
#[post("/organizations")]
#[instrument(target = "auth", skip(req, pool, data), fields(name = %data.name))]
pub async fn create_my_organization(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<CreateMyOrganizationInput>,
) -> AppResult {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => {
            return Ok(HttpResponse::Unauthorized()
                .json(serde_json::json!({ "message": "Authentication required" })));
        }
    };

    let name = data.name.trim();
    if name.is_empty() {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Organization name is required" })));
    }
    if name.len() > 120 {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Organization name is too long" })));
    }

    let place = data
        .place
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if place.as_deref().is_some_and(|p| p.len() > 200) {
        return Ok(
            HttpResponse::BadRequest().json(serde_json::json!({ "message": "Place is too long" }))
        );
    }

    // Only personal users may self-serve.
    if let Some(resp) = reject_non_personal(pool.get_ref(), user_id).await? {
        return Ok(resp);
    }

    let mut tx = pool.begin().await?;
    let created = match create_org_for_user(&mut tx, user_id, name, place.as_deref(), None).await? {
        Some(org) => org,
        None => {
            return Ok(HttpResponse::Conflict().json(serde_json::json!({
                "message": "An organization with that name already exists"
            })));
        }
    };
    tx.commit().await?;

    invalidate_profile_cache(user_id).await;
    invalidate_me_cache(user_id).await;
    rbac::invalidate_role_context(user_id).await;

    info!(target: "auth", user_id, organization_id = created.id, "personal user created organization");
    Ok(HttpResponse::Created().json(serde_json::json!({
        "id": created.id,
        "name": created.name,
        "slug": created.slug,
        "place": created.place,
        "account_type": "organization_admin",
        "organization_id": created.id,
        "role": "owner",
        "seat_limit": STARTER_SEAT_LIMIT
    })))
}

/// Return `Some(409 response)` if the user isn't a plain personal account (so
/// they can't escalate their own scope or orphan themselves), `None` if OK.
async fn reject_non_personal(
    pool: &PgPool,
    user_id: i32,
) -> std::result::Result<Option<HttpResponse>, AppError> {
    let account_type: Option<String> =
        sqlx::query_scalar("SELECT account_type FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    match account_type {
        None => Ok(Some(
            HttpResponse::Unauthorized()
                .json(serde_json::json!({ "message": "Account not found" })),
        )),
        Some(t) if t != "personal" => Ok(Some(HttpResponse::Conflict().json(serde_json::json!({
            "message": "Your account already belongs to an organization or platform scope"
        })))),
        Some(_) => Ok(None),
    }
}

#[derive(Deserialize)]
pub struct OrgSignupIntentInput {
    pub name: String,
    #[serde(default)]
    pub place: Option<String>,
    #[serde(default)]
    pub admin_email: Option<String>,
    /// "saved" → charge the founder's saved default card now; "new" (default)
    /// → return a client_secret the frontend confirms with a Payment Element.
    #[serde(default)]
    pub payment_choice: Option<String>,
}

/// Step 1 of payment-gated org creation. Validates the form, ensures the
/// founder's *personal* Stripe customer, and starts the organization-plan
/// subscription on it. **No organization is created here** — the org details
/// are parked in `pending_org_signups` keyed by the subscription that must be
/// paid first.
///
///   * `payment_choice = "saved"` → charges the saved card off-session; if it
///     clears we finalize immediately and return the created org.
///   * otherwise → returns `{ pending_id, client_secret, publishable_key }` for
///     the frontend to confirm, then call `/organizations/finalize`.
#[post("/organizations/signup-intent")]
#[instrument(target = "auth", skip(req, pool, data), fields(name = %data.name))]
pub async fn org_signup_intent(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<OrgSignupIntentInput>,
) -> AppResult {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => {
            return Ok(HttpResponse::Unauthorized()
                .json(serde_json::json!({ "message": "Authentication required" })));
        }
    };

    let name = data.name.trim();
    if name.is_empty() || name.len() > 120 {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Enter an organization name (max 120 chars)" })));
    }
    let place = data
        .place
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    if place.as_deref().is_some_and(|p| p.len() > 200) {
        return Ok(
            HttpResponse::BadRequest().json(serde_json::json!({ "message": "Place is too long" }))
        );
    }

    if let Some(resp) = reject_non_personal(pool.get_ref(), user_id).await? {
        return Ok(resp);
    }
    if !provider::is_configured() {
        return Ok(HttpResponse::ServiceUnavailable()
            .json(serde_json::json!({ "message": "Billing is not configured" })));
    }

    // Founder's email is the Stripe contact + the admin_email default.
    let founder_email: String = match sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool.get_ref())
        .await?
    {
        Some(email) => email,
        None => {
            return Ok(HttpResponse::Unauthorized()
                .json(serde_json::json!({ "message": "Account not found" })));
        }
    };
    let admin_email = data
        .admin_email
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_lowercase)
        .unwrap_or_else(|| founder_email.to_lowercase());
    if !admin_email.contains('@') || admin_email.len() > 254 {
        return Ok(HttpResponse::BadRequest()
            .json(serde_json::json!({ "message": "Enter a valid admin email address" })));
    }

    // Resolve the organization plan + its Stripe price.
    let plan = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT code, stripe_price_id FROM plans \
         WHERE code = 'organization' AND is_active = true",
    )
    .fetch_optional(pool.get_ref())
    .await?;
    let Some((plan_code, price_id)) = plan else {
        return Ok(HttpResponse::ServiceUnavailable()
            .json(serde_json::json!({ "message": "The organization plan is not available" })));
    };
    let Some(price_id) = price_id.filter(|p| !p.is_empty()) else {
        return Ok(HttpResponse::ServiceUnavailable().json(
            serde_json::json!({ "message": "The organization plan is not linked to a price yet" }),
        ));
    };

    // Bill the founder's personal customer (reused as the org's on finalize).
    let customer_id =
        match ensure_customer(pool.get_ref(), BillingOwner::User(user_id), &founder_email).await {
            Ok(id) => id,
            Err(resp) => return Ok(resp),
        };

    // For "saved", resolve the default card up front so we can reject early
    // when there's nothing on file.
    let use_saved = data.payment_choice.as_deref() == Some("saved");
    let saved_pm = if use_saved {
        match provider::get_default_payment_method(&customer_id).await {
            Ok(Some(card)) => Some(card.payment_method_id),
            Ok(None) => {
                return Ok(HttpResponse::BadRequest().json(serde_json::json!({
                    "message": "No saved card on file. Add a new payment method instead."
                })));
            }
            Err(e) => {
                error!(target: "billing", error = ?e, "saved card lookup failed");
                return Ok(HttpResponse::BadGateway().json(
                    serde_json::json!({ "message": "Could not reach the payment provider" }),
                ));
            }
        }
    } else {
        None
    };

    // Park the org details, then create the subscription tagged with this row
    // id so the webhook can finalize too. The subscription id is filled in
    // immediately after creation.
    let pending_id: i32 = sqlx::query_scalar(
        r#"
        INSERT INTO pending_org_signups
            (user_id, name, place, admin_email, plan_code, stripe_customer_id, status)
        VALUES ($1, $2, $3, $4, $5, $6, 'pending')
        RETURNING id
        "#,
    )
    .bind(user_id)
    .bind(name)
    .bind(place.as_deref())
    .bind(&admin_email)
    .bind(&plan_code)
    .bind(&customer_id)
    .fetch_one(pool.get_ref())
    .await?;

    let sub = match provider::create_org_signup_subscription(
        &customer_id,
        &price_id,
        pending_id,
        saved_pm.as_deref(),
    )
    .await
    {
        Ok(sub) => sub,
        Err(e) => {
            warn!(target: "billing", user_id, pending_id, error = ?e, "org signup subscription create failed");
            let _ = sqlx::query("UPDATE pending_org_signups SET status = 'failed' WHERE id = $1")
                .bind(pending_id)
                .execute(pool.get_ref())
                .await;
            return Ok(HttpResponse::BadGateway().json(serde_json::json!({
                "message": "Could not start the subscription. Check the card and try again."
            })));
        }
    };

    sqlx::query("UPDATE pending_org_signups SET stripe_subscription_id = $1 WHERE id = $2")
        .bind(&sub.subscription_id)
        .bind(pending_id)
        .execute(pool.get_ref())
        .await?;

    let paid = sub.status == "active" || sub.status == "trialing";

    // Saved-card path that cleared synchronously: finalize now and return the
    // org so the client skips the confirm round-trip.
    if use_saved {
        if paid {
            return finalize_and_respond(pool.get_ref(), pending_id, user_id).await;
        }
        return Ok(HttpResponse::PaymentRequired().json(serde_json::json!({
            "message": "Couldn't charge your saved card. Choose \"New payment method\" instead."
        })));
    }

    // New-card path: hand back the client_secret to confirm.
    let Some(client_secret) = sub.client_secret else {
        return Ok(HttpResponse::BadGateway().json(serde_json::json!({
            "message": "Payment could not be initialized. Please try again."
        })));
    };
    Ok(HttpResponse::Ok().json(serde_json::json!({
        "pending_id": pending_id,
        "client_secret": client_secret,
        "publishable_key": provider::publishable_key(),
    })))
}

#[derive(Deserialize)]
pub struct FinalizeOrgInput {
    pub pending_id: i32,
}

/// Step 2 of payment-gated org creation. Called by the frontend after it
/// confirms the PaymentIntent. Verifies the subscription is paid **server-side**
/// (never trusting the client), then creates the organization. Idempotent — a
/// second call (or the Stripe webhook) returns the same org.
#[post("/organizations/finalize")]
#[instrument(target = "auth", skip(req, pool, data))]
pub async fn finalize_org_signup(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<FinalizeOrgInput>,
) -> AppResult {
    let user_id = match get_user_id_from_request(&req) {
        Some(id) => id,
        None => {
            return Ok(HttpResponse::Unauthorized()
                .json(serde_json::json!({ "message": "Authentication required" })));
        }
    };
    let pending_id = data.pending_id;

    let row = sqlx::query_as::<_, (i32, Option<String>, String, Option<i32>)>(
        "SELECT user_id, stripe_subscription_id, status, organization_id \
         FROM pending_org_signups WHERE id = $1",
    )
    .bind(pending_id)
    .fetch_optional(pool.get_ref())
    .await?;

    let Some((owner_id, sub_id, status, organization_id)) = row else {
        return Ok(
            HttpResponse::NotFound().json(serde_json::json!({ "message": "Signup not found" }))
        );
    };
    if owner_id != user_id {
        return Ok(
            HttpResponse::Forbidden().json(serde_json::json!({ "message": "Not your signup" }))
        );
    }

    // Already finalized — return the existing org (idempotent).
    if status == "finalized"
        && let Some(org_id) = organization_id
    {
        return org_response(pool.get_ref(), org_id).await;
    }

    let Some(sub_id) = sub_id.filter(|s| !s.is_empty()) else {
        return Ok(HttpResponse::Conflict()
            .json(serde_json::json!({ "message": "No subscription on this signup" })));
    };

    // Verify the charge succeeded with Stripe before creating anything.
    let sub_status = match provider::get_subscription_status(&sub_id).await {
        Ok(status) => status,
        Err(e) => {
            error!(target: "billing", pending_id, error = ?e, "subscription status lookup failed");
            return Ok(HttpResponse::BadGateway()
                .json(serde_json::json!({ "message": "Could not verify payment" })));
        }
    };
    if sub_status != "active" && sub_status != "trialing" {
        return Ok(HttpResponse::PaymentRequired()
            .json(serde_json::json!({ "message": "Payment is not complete yet" })));
    }

    finalize_and_respond(pool.get_ref(), pending_id, user_id).await
}

/// Run `finalize_org_signup_inner` and shape an HTTP response.
async fn finalize_and_respond(pool: &PgPool, pending_id: i32, user_id: i32) -> AppResult {
    match finalize_org_signup_inner(pool, pending_id).await {
        Ok(Some(org_id)) => {
            info!(target: "auth", user_id, organization_id = org_id, "org signup finalized (paid)");
            org_response(pool, org_id).await
        }
        Ok(None) => Ok(HttpResponse::Conflict().json(serde_json::json!({
            "message": "An organization with that name already exists. Pick a different name."
        }))),
        Err(e) => {
            error!(target: "auth", pending_id, error = ?e, "org finalize failed");
            Ok(HttpResponse::InternalServerError()
                .json(serde_json::json!({ "message": "Could not create the organization" })))
        }
    }
}

/// Create the organization for a *paid* pending signup. Idempotent and
/// concurrency-safe (FOR UPDATE on the pending row), so the client confirm and
/// the Stripe webhook can both call it. Returns the org id, or `Ok(None)` on a
/// name conflict (the caller surfaces a 409). Callers MUST have verified the
/// subscription is paid first.
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
        Some(org) => org,
        None => {
            // Name taken between intent and finalize. Mark failed; the
            // caller turns this into a 409 and the charge can be refunded
            // out of band.
            sqlx::query("UPDATE pending_org_signups SET status = 'failed' WHERE id = $1")
                .bind(pending_id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            return Ok(None);
        }
    };
    let org_id = created.id;

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

    // Materialize the paid entitlement from the org plan + drop stale caches.
    refresh_entitlements(pool, BillingOwner::Organization(org_id))
        .await
        .map_err(|e| AppError::Internal(format!("entitlement refresh failed: {e}")))?;
    invalidate_profile_cache(owner_id).await;
    invalidate_me_cache(owner_id).await;
    rbac::invalidate_role_context(owner_id).await;

    Ok(Some(org_id))
}

/// Build the standard created-org response payload from a finalized org id.
async fn org_response(pool: &PgPool, org_id: i32) -> AppResult {
    let row = sqlx::query_as::<_, (i32, String, Option<String>, Option<String>)>(
        "SELECT id, name, slug, place FROM organizations WHERE id = $1",
    )
    .bind(org_id)
    .fetch_optional(pool)
    .await?;
    let Some((id, name, slug, place)) = row else {
        return Ok(HttpResponse::NotFound()
            .json(serde_json::json!({ "message": "Organization not found" })));
    };
    Ok(HttpResponse::Created().json(serde_json::json!({
        "id": id,
        "name": name,
        "slug": slug,
        "place": place,
        "account_type": "organization_admin",
        "organization_id": id,
        "role": "owner",
        "seat_limit": STARTER_SEAT_LIMIT
    })))
}

/// Self-serve org teardown. The org owner deletes the organization, all of
/// the invitee accounts they provisioned, and reverts themselves to a
/// personal account. Used by the /organizations/new "revert to personal"
/// affordance — every artifact created in the setup flow goes away in one
/// transaction.
///
/// Refuses when an active subscription exists so we never leave a zombie
/// Stripe customer charging the user after the local org disappears. The
/// owner must cancel from /billing first in that case.
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

    // Resolve scope + role from the DB. Only an organization owner may
    // tear down their own organization.
    let ctx = match rbac::resolve_role_context(pool.get_ref(), user_id).await {
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

    // If there's an active/trialing Stripe subscription, the owner must
    // first express cancel intent (cancel_at_period_end) on the Billing
    // page — we don't silently kill billing on org delete. Once they have,
    // we cancel it *immediately* in Stripe here: the local subscription row
    // is about to be cascade-deleted, so leaving the Stripe subscription
    // running to period end would orphan a charge against a customer with
    // no local record.
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

    // Snapshot invitee user ids (everyone in the org except the owner).
    // Once we drop the organization the FK ON DELETE SET NULL on
    // users.organization_id would null them out, so we'd lose the ability
    // to identify the cohort to delete.
    let invitee_ids: Vec<i32> =
        sqlx::query_scalar("SELECT id FROM users WHERE organization_id = $1 AND id <> $2")
            .bind(organization_id)
            .bind(user_id)
            .fetch_all(pool.get_ref())
            .await?;

    let mut tx = pool.begin().await?;

    // Notes has user_id with no FK constraint (see init.sql:469), so it
    // doesn't ride the cascade on `users`. Wipe it explicitly for every
    // invitee being deleted before the cascade runs.
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

    // Revert the owner to a personal account. The organizations DELETE
    // below would null out organization_id via FK ON DELETE SET NULL, but
    // we also need to flip account_type back to 'personal' so they leave
    // the org-admin RBAC scope.
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

    // Cascades clean up organization_members, entitlements,
    // billing_customers, subscriptions, drive_shares, siem_webhook_configs,
    // shared inboxes, etc. — every table that referenced organizations.id
    // is declared ON DELETE CASCADE in init.sql.
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

/// `PATCH /organizations/me` — rename the caller's organization. Owner-only,
/// mirroring the gate on [`delete_my_organization`]. The slug is re-derived
/// from the new name with the same expression used at creation. The org name
/// is denormalized into every member's `/api/me` + profile payloads, so those
/// caches are busted for the whole org on success.
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

    let ctx = match rbac::resolve_role_context(pool.get_ref(), user_id).await {
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

    // Re-derive the slug from the new name with the same expression used at
    // creation (see create_my_organization). A unique violation on name/slug
    // means another organization already uses it.
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

    // The org name is denormalized into every member's /api/me + profile
    // payloads — bust those caches for the whole org.
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

/// `DELETE /me` — self-service account deletion. The caller permanently
/// deletes their OWN account and everything that cascades from `users.id`.
///
/// Guards mirror the organization teardown:
///   - An organization OWNER must delete the organization first — their user
///     row is the org's anchor (members, shared inboxes, billing all hang off
///     it). See `delete_my_organization`.
///   - An active / trialing subscription must be cancelled on /billing first
///     so we never orphan live Stripe charges.
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

    // Self-service account deletion is personal-accounts only. Business
    // (organization) and platform team members can't delete their own account
    // — an owner/admin must remove them. An org owner deletes the whole org
    // first (which reverts them to a personal account), then can self-delete.
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

    // Capture the email for the audit trail. `audit_logs.actor_user_id` is
    // ON DELETE SET NULL, so once the row is gone the deletion event would be
    // anonymized — the email in metadata is what keeps it attributable.
    let email: Option<String> = sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool.get_ref())
        .await?;

    // Record BEFORE the delete: record_action reads users.organization_id and
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
    // `notes.user_id` has no FK (see init.sql), so it doesn't ride the cascade
    // on `users`. Wipe it explicitly before the user row goes.
    sqlx::query("DELETE FROM notes WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    // Everything else referencing users.id is ON DELETE CASCADE / SET NULL.
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

#[post("/admin/users")]
#[instrument(target = "auth", skip(req, pool, data), fields(email = %data.email))]
pub async fn admin_create_user(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    data: web::Json<AdminCreateUserInput>,
) -> AppResult {
    // Creating accounts requires `members:manage` — held by org and platform
    // owner / super_admin / admin. This replaces the old account_type check, so
    // an organization `admin` (not just `organization_admin`) can add members.
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::MembersManage).await
    {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };
    let admin_id = ctx.user_id;

    let email = data.email.trim().to_lowercase();
    // Username defaults to the email local-part so admins can create a user
    // with just an email. Existing callers that still send `username` keep
    // working.
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

    // Decide the working password before hashing:
    //   - If the admin supplied a non-empty value, use it (minimum 6 chars).
    //   - Otherwise, generate a 16-char alphanumeric temp password and
    //     return it in the response so the admin can share it once.
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

    // Domain gate: an org member may only be minted on a domain the
    // organization has VERIFIED it owns. Default-deny — gmail.com, usa.com,
    // a typo, or any domain the org doesn't control is rejected, because it
    // can never appear as a verified row in organization_domains. Founders
    // (organization_admin) and personal users are exempt: they bootstrap the
    // org / verify the domain before any members can be created on it.
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
        if organization::domains::is_public_provider_domain(&domain) {
            return Ok(HttpResponse::BadRequest().json(serde_json::json!({
                "message": format!("'{domain}' is a public email provider and can't be used for organization accounts")
            })));
        }
        if !organization::domains::is_domain_verified_for_org(pool.get_ref(), org_id, &domain).await
        {
            return Ok(HttpResponse::Forbidden().json(serde_json::json!({
                "message": format!("The organization has not verified ownership of '{domain}'. Verify the domain before creating addresses on it."),
                "domain": domain
            })));
        }
    }

    // Pre-check: org members (account_type = 'organization', NOT founders)
    // need a bootstrapped org master key so the server can escrow their
    // keypair at provisioning time. Fail loud and early if the org has
    // no key yet — better than creating a user that can't crypto.
    // Founders (organization_admin) and personal users don't need this
    // and follow the client-side mnemonic path.
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

    let result = sqlx::query(
        r#"
        INSERT INTO users (username, email, password, auth_provider, account_type)
        VALUES ($1, $2, $3, 'local', $4)
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
            // Role precedence: explicit input -> account-type default. The DB
            // CHECK constraints on platform_members / organization_members
            // reject anything outside the 9-role catalog, so a bad string
            // from a misbehaving client surfaces as a 500 below rather than
            // a silent default. That's intentional — the frontend dropdown
            // is restricted to the 4 roles we expose for this flow
            // (guest/developer/member/support) and only legitimate misuse
            // would land here.
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

            // Server-side keypair generation for org members. The keypair
            // never leaves this process unwrapped — it gets wrapped twice
            // (once under the org pubkey for owner-recovery, once under
            // PBKDF2(password) for the member's own login) inside the
            // blocking task, and the plaintext is zeroed before the task
            // returns. RSA-2048 keygen is ~50-200ms, so spawn_blocking to
            // keep the Tokio runtime responsive.
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
            // `temp_password` is only present when the server generated it.
            // Existing callers that supplied a password get the same response
            // they did before, just without the plaintext echoed back.
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

// Hard-delete a user account. Almost every related table has ON DELETE
// CASCADE on its user_id FK, so the single DELETE on `users` cleans up
// memberships, messages, files, billing customers, etc. The `notes` table
// has a `user_id` column but no FK constraint (init.sql:469), so it gets
// an explicit DELETE first to avoid orphan rows after the cascade.
//
// Authorization:
//   * Gate: `members:manage` (owner, super_admin, admin, security via the
//     RBAC change in this same PR).
//   * Role-level: actor must be able to assign the target's role
//     (`can_assign_role`). Without this an admin/security could delete the
//     org owner, which would be a privilege escalation.
//   * Scope: org-scoped actors can only delete users in their own org;
//     platform-scoped actors can delete anyone subject to the role check.
//   * Self-delete blocked — an admin removing themselves mid-session is
//     almost always a mistake, and the JWT remains valid until expiry so
//     they would lock themselves out of their own session.
//   * Last-owner: cannot delete the sole owner of an org/platform.
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

    // Resolve the target's effective role + scope so we can apply the same
    // assign-role gate that the role-change endpoint uses.
    let target_ctx = match rbac::resolve_role_context(pool.get_ref(), target_user_id).await {
        Ok(target_ctx) => target_ctx,
        Err(sqlx::Error::RowNotFound) => {
            return Ok(
                HttpResponse::NotFound().json(serde_json::json!({ "message": "User not found" }))
            );
        }
        Err(e) => return Err(AppError::Db(e)),
    };

    // Scope boundary: org admins cannot reach across orgs or into the
    // platform tenant. Platform admins are unconstrained by scope (but
    // still constrained by the role check below).
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

    // Role check: same predicate as role assignment. RolesManage holders
    // can delete anyone; RolesAssignLimited can only delete users whose
    // current role is below admin.
    if !rbac::can_assign_role(&ctx, target_ctx.role, target_ctx.role) {
        return Ok(HttpResponse::Forbidden().json(serde_json::json!({
            "message": "Your role cannot manage that account"
        })));
    }

    let mut tx = pool.begin().await?;

    // Last-owner protection. Lock the owner rows with FOR UPDATE so two
    // concurrent deletes can't both pass this check.
    if target_ctx.role == Role::Owner {
        let owner_count: i64 = match target_ctx.scope {
            Scope::Organization => {
                let org_id = target_ctx.organization_id.unwrap_or(-1);
                sqlx::query_scalar(
                    "SELECT COUNT(*)::BIGINT FROM organization_members \
                     WHERE organization_id = $1 AND role = 'owner' FOR UPDATE",
                )
                .bind(org_id)
                .fetch_one(&mut *tx)
                .await?
            }
            Scope::Platform => {
                sqlx::query_scalar(
                    "SELECT COUNT(*)::BIGINT FROM platform_members \
                     WHERE role = 'owner' FOR UPDATE",
                )
                .fetch_one(&mut *tx)
                .await?
            }
            Scope::Personal => 0,
        };
        if owner_count <= 1 {
            return Ok(HttpResponse::Conflict().json(serde_json::json!({
                "message": "Cannot delete the last owner"
            })));
        }
    }

    // Notes has user_id but no FK (see init.sql:469) — clean explicitly so
    // it doesn't leave orphan rows after the users-row cascade. Every other
    // user-owned table has ON DELETE CASCADE on its FK.
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
