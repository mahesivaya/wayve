//! Organization + user provisioning endpoints (platform-admin and self-serve):
//! `/admin/organizations`, `/organizations`, `/organizations/me`,
//! `/admin/users`.

use super::shared::{
    default_role_for_account_type, invalidate_profile_cache, normalized_account_type,
};
use crate::billing::entitlements::effective_entitlements;
use crate::billing::models::BillingOwner;
use crate::email::profile::invalidate_me_cache;
use crate::organization;
use crate::prelude::*;
use actix_web::delete;
use tracing::{info, instrument};
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
            let admin: Option<serde_json::Value> = row.get("admin");

            serde_json::json!({
                "id": id,
                "name": name,
                "slug": slug,
                "user_count": user_count,
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
        .map_err(|e| {
            AppError::Internal(format!("org owner keypair provisioning failed: {e}"))
        })?;

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

/// Self-serve org creation: a personal user creates an organization and is
/// promoted to its owner. The user's account_type flips from 'personal' to
/// 'organization_admin', they become a member of the new org with role
/// 'owner', and subsequent /api/me reflects the new scope + permissions.
/// The JWT is left untouched because RBAC is computed per request from the
/// DB — the next request after this call sees the new role.
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

    // Only personal users may self-serve. Platform staff and existing org
    // members already belong to a scope and would either escalate their own
    // privileges or orphan themselves from their current org.
    let current_account_type: Option<String> =
        sqlx::query_scalar("SELECT account_type FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(pool.get_ref())
            .await?;

    let current_account_type = match current_account_type {
        Some(t) => t,
        None => {
            return Ok(HttpResponse::Unauthorized()
                .json(serde_json::json!({ "message": "Account not found" })));
        }
    };

    if current_account_type != "personal" {
        return Ok(HttpResponse::Conflict().json(serde_json::json!({
            "message": "Your account already belongs to an organization or platform scope"
        })));
    }

    let mut tx = pool.begin().await?;

    let org_row = match sqlx::query(
        r#"
        INSERT INTO organizations (name, slug, place)
        VALUES (
            $1,
            lower(regexp_replace($1, '[^a-zA-Z0-9]+', '', 'g')),
            $2
        )
        RETURNING id, name, slug, place
        "#,
    )
    .bind(name)
    .bind(place.as_deref())
    .fetch_one(&mut *tx)
    .await
    {
        Ok(row) => row,
        Err(e) => {
            if e.to_string().contains("duplicate key") {
                return Ok(HttpResponse::Conflict().json(serde_json::json!({
                    "message": "An organization with that name already exists"
                })));
            }
            return Err(AppError::Db(e));
        }
    };

    let organization_id: i32 = org_row.get("id");
    let organization_name: String = org_row.get("name");
    let organization_slug: Option<String> = org_row.get("slug");
    let organization_place: Option<String> = org_row.get("place");

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
    .execute(&mut *tx)
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
    .execute(&mut *tx)
    .await?;

    // Seed a starter entitlement so the brand-new org can add up to 100
    // members before subscribing. The basic_user free baseline grants only
    // one seat, which would block the org owner from inviting anybody. When
    // the owner later subscribes, refresh_entitlements() overwrites this
    // row from the chosen plan's seat_limit, so this is purely a free-tier
    // headroom, not a permanent override.
    const STARTER_SEAT_LIMIT: i32 = 100;
    const STARTER_STORAGE_BYTES: i64 = 1_073_741_824; // 1 GiB
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
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    invalidate_profile_cache(user_id).await;
    invalidate_me_cache(user_id).await;
    rbac::invalidate_role_context(user_id).await;

    info!(target: "auth", user_id, organization_id, "personal user created organization");
    Ok(HttpResponse::Created().json(serde_json::json!({
        "id": organization_id,
        "name": organization_name,
        "slug": organization_slug,
        "place": organization_place,
        "account_type": "organization_admin",
        "organization_id": organization_id,
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

    // Reject if there's an active/trialing Stripe subscription. Cancelling
    // it requires hitting the Stripe API, which is the user's job via the
    // /billing "Cancel subscription" affordance — surfacing that explicitly
    // is safer than deleting and orphaning charges.
    let active_sub: Option<i32> = sqlx::query_scalar(
        r#"
        SELECT id FROM subscriptions
         WHERE organization_id = $1
           AND status IN ('active', 'trialing')
         LIMIT 1
        "#,
    )
    .bind(organization_id)
    .fetch_optional(pool.get_ref())
    .await?;

    if active_sub.is_some() {
        return Ok(HttpResponse::Conflict().json(serde_json::json!({
            "message": "Cancel the organization's subscription on the Billing page before deleting the organization."
        })));
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

    Ok(HttpResponse::NoContent().finish())
}
