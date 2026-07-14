//! Backfill chat E2E keypairs for members that lack one. Accounts created by SQL
//! seed or import never ran the client-side key setup, so `users.public_key` is
//! NULL and chatting with them fails.
//!
//! This platform-owner-only endpoint provisions the keypair server-side by the
//! same path as org-member provisioning, and writes a `member_login_wrapped_keys`
//! row so the private key is restored on the member's next login. A per-user
//! bcrypt verify against the supplied password is required, so an account on a
//! different password is skipped rather than given a wrap it cannot open.

use crate::prelude::*;
use tracing::{info, instrument, warn};
use wayve_security::encryption::provision_org_owner_keypair;
use wayve_security::password::verify_password;
use wayve_security::rbac::{self, Permission, Role, Scope};

// Must match the password scripts/seed_rbac_users.sh seeds with. The caller can
// override it per request for a different shared password.
const DEFAULT_SEED_PASSWORD: &str = "Mahesh";

#[derive(Deserialize)]
pub struct ProvisionInput {
    pub password: Option<String>,
}

#[derive(sqlx::FromRow)]
struct Candidate {
    id: i32,
    email: String,
    password: Option<String>,
}

#[post("/platform/provision-chat-keys")]
#[instrument(target = "http", skip(req, pool, body))]
pub async fn provision_chat_keys(
    req: HttpRequest,
    pool: web::Data<PgPool>,
    body: web::Json<ProvisionInput>,
) -> AppResult {
    // Platform owner only, because this mints keypairs for other users.
    let ctx = match rbac::require_permission(&req, pool.get_ref(), Permission::MembersManage).await
    {
        Ok(ctx) => ctx,
        Err(response) => return Ok(response),
    };
    if ctx.scope != Scope::Platform || ctx.role != Role::Owner {
        return Ok(
            HttpResponse::Forbidden().json(serde_json::json!({ "message": "Platform owner only" }))
        );
    }

    let password = body
        .password
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_SEED_PASSWORD)
        .to_string();

    // OAuth-only accounts have no local password to verify against, so they are
    // excluded here.
    let candidates = sqlx::query_as::<_, Candidate>(
        r#"
        SELECT id, email, password
        FROM users
        WHERE (public_key IS NULL OR public_key = '')
          AND password IS NOT NULL
        ORDER BY id
        "#,
    )
    .fetch_all(pool.get_ref())
    .await?;

    let total = candidates.len();
    let mut provisioned: Vec<String> = Vec::new();
    let mut skipped: u32 = 0;

    for c in candidates {
        let Some(hashed) = c.password.as_deref() else {
            skipped += 1;
            continue;
        };
        // Only accounts actually on the supplied password are provisioned, so no
        // member is ever given a wrap they cannot unwrap.
        let matches = verify_password(&password, hashed).await.unwrap_or(false);
        if !matches {
            skipped += 1;
            continue;
        }

        // RSA-2048 keygen is CPU-heavy and holds the plaintext key, so it stays off
        // the async executor.
        let pw = password.clone();
        let provisioned_keys = match tokio::task::spawn_blocking(move || {
            provision_org_owner_keypair(&pw)
        })
        .await
        {
            Ok(Ok(keys)) => keys,
            Ok(Err(err)) => {
                warn!(target: "auth", user_id = c.id, error = ?err, "keypair provision failed");
                skipped += 1;
                continue;
            }
            Err(err) => {
                warn!(target: "auth", user_id = c.id, error = ?err, "provision task join failed");
                skipped += 1;
                continue;
            }
        };

        sqlx::query("UPDATE users SET public_key = $1 WHERE id = $2")
            .bind(&provisioned_keys.public_key_json)
            .bind(c.id)
            .execute(pool.get_ref())
            .await?;

        let wrap = &provisioned_keys.login_wrap;
        sqlx::query(
            r#"
            INSERT INTO member_login_wrapped_keys (user_id, iv, ct, salt, iterations)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (user_id) DO UPDATE
            SET iv = EXCLUDED.iv,
                ct = EXCLUDED.ct,
                salt = EXCLUDED.salt,
                iterations = EXCLUDED.iterations,
                updated_at = NOW()
            "#,
        )
        .bind(c.id)
        .bind(&wrap.iv_b64)
        .bind(&wrap.ct_b64)
        .bind(&wrap.salt_b64)
        .bind(wrap.iterations as i32)
        .execute(pool.get_ref())
        .await?;

        provisioned.push(c.email);
    }

    info!(
        target: "auth",
        actor = ctx.user_id,
        provisioned = provisioned.len(),
        skipped,
        "backfilled chat keypairs"
    );

    Ok(HttpResponse::Ok().json(serde_json::json!({
        "total_missing": total,
        "provisioned": provisioned.len(),
        "provisioned_emails": provisioned,
        "skipped": skipped,
    })))
}

pub fn routes(cfg: &mut actix_web::web::ServiceConfig) {
    cfg.service(provision_chat_keys);
}
